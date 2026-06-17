import mongoose from "mongoose";
import { findArenaById, setOnlineCount } from "../dal/arenaGroupDao.js";
import { arenaRoom } from "../utils/rooms.js";
import { expectedError as expected } from "../utils/expectedError.js";
import { socketAuth } from "../middleware/socketAuth.js";
import {
  CONNECTION,
  DISCONNECT,
  SESSION,
  ARENA_ONLINE,
  ARENA_JOIN,
  ARENA_ANSWER,
  ARENA_SYNC,
  ARENA_LEAVE,
} from "../constants/socketEvents.js";

/**
 * Socket protocol (all client→server events take an ack callback):
 *
 *  client → server
 *   arena:join   { arenaGroupId }            → ack(snapshot)
 *   arena:answer { round, selectedOption }   → ack({ok, ...})
 *   arena:sync   {}                          → ack(snapshot)   (manual resync)
 *   arena:leave  {}                          → ack({ok})
 *
 *  server → client
 *   session        { userId, name }            on connect
 *   arena:question { round, question, durationMs, endsAt, serverTime }
 *   arena:result   personalized result payload (graph only when correct)
 *   arena:online   { count }
 *
 * Reconnection: the client reconnects and re-emits arena:join; the snapshot
 * in the ack puts it exactly where the game is now.
 *
 * Online counts live in Redis (liveStore) so any server can answer a
 * reconnect; ArenaGroup.online_user_count in Mongo is updated best-effort
 * purely for lobby display.
 */
export function registerArenaSockets(io, engine, liveStore) {
  io.use(socketAuth);

  io.on(CONNECTION, (socket) => {
    socket.emit(SESSION, {
      userId: socket.data.userId,
      name: socket.data.name,
    });

    socket.on(ARENA_JOIN, (payload, ack) =>
      safeHandler(ack, () => handleJoin(socket, payload))
    );

    socket.on(ARENA_ANSWER, (payload, ack) =>
      safeHandler(ack, async () => {
        if (!socket.data.arenaGroupId) {
          throw expected("NOT_IN_ARENA", "Join an arena first");
        }
        return engine.submitAnswer({
          arenaGroupId: socket.data.arenaGroupId,
          user: {
            userId: socket.data.userId,
            name: socket.data.name,
            photo: socket.data.photo,
          },
          round: payload?.round,
          selectedOption: payload?.selectedOption,
        });
      })
    );

    socket.on(ARENA_SYNC, (_payload, ack) =>
      safeHandler(ack, async () => {
        const arenaGroupId = socket.data.arenaGroupId;
        if (!arenaGroupId) throw expected("NOT_IN_ARENA", "Join an arena first");
        const game = await engine.getGame(arenaGroupId);
        return engine.buildSnapshot(game, socket.data);
      })
    );

    socket.on(ARENA_LEAVE, (_payload, ack) =>
      safeHandler(ack, async () => {
        await leaveArena(socket);
        return { ok: true };
      })
    );

    socket.on(DISCONNECT, () => {
      leaveArena(socket).catch((e) =>
        console.error("[socket] disconnect cleanup failed:", e.message)
      );
    });
  });

  async function handleJoin(socket, payload) {
    const arenaGroupId = payload?.arenaGroupId;
    if (!mongoose.isValidObjectId(arenaGroupId)) {
      throw expected("BAD_ARENA", "arenaGroupId is not a valid id");
    }
    const group = await findArenaById(arenaGroupId);
    if (!group || group.status !== 1) {
      throw expected("BAD_ARENA", "Arena not found or not active");
    }

    const rejoinSameArena = socket.data.arenaGroupId === String(arenaGroupId);
    if (socket.data.arenaGroupId && !rejoinSameArena) {
      await leaveArena(socket);
    }
    if (!rejoinSameArena) {
      socket.join(arenaRoom(arenaGroupId));
      socket.data.arenaGroupId = String(arenaGroupId);
      await bumpOnlineCount(arenaGroupId, +1);
    }

    const { game, noQuestions } = await engine.ensureRunning(arenaGroupId);

    // No waiting phase: the snapshot drops the joiner straight onto the live
    // phase — the current question (which they can answer) or its result.
    const snapshot = await engine.buildSnapshot(game, socket.data);
    if (noQuestions) snapshot.noQuestions = true;
    return snapshot;
  }

  async function leaveArena(socket) {
    const arenaGroupId = socket.data.arenaGroupId;
    if (!arenaGroupId) return;
    socket.data.arenaGroupId = null;
    socket.leave(arenaRoom(arenaGroupId));
    await bumpOnlineCount(arenaGroupId, -1);
  }

  async function bumpOnlineCount(arenaGroupId, delta) {
    const humans = await liveStore.bumpOnline(arenaGroupId, delta);
    // Displayed counts include the arena's bot crowd; the engine's idle
    // check keeps reading the human-only counter.
    const bots = await liveStore.getBotCount(arenaGroupId);
    const count = humans + bots;
    io.to(arenaRoom(arenaGroupId)).emit(ARENA_ONLINE, {
      count,
      humans,
      bots,
    });
    // Lobby display only — Redis is the authoritative count.
    setOnlineCount(arenaGroupId, count).catch(() => {});
  }
}

async function safeHandler(ack, fn) {
  const reply = typeof ack === "function" ? ack : () => {};
  try {
    const data = await fn();
    reply({ ok: true, ...data });
  } catch (e) {
    if (!e.expected) console.error("[socket] handler error:", e);
    reply({
      ok: false,
      code: e.expected ? e.code : "INTERNAL",
      message: e.expected ? e.message : "Something went wrong",
    });
  }
}
