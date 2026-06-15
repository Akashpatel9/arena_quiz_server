import crypto from "node:crypto";
import mongoose from "mongoose";
import AuthUser from "../models/AuthUser.js";
import ArenaGroup from "../models/ArenaGroupModel.js";
import { arenaRoom } from "../services/gameEngine.js";

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
  io.use(authMiddleware);

  io.on("connection", (socket) => {
    socket.emit("session", {
      userId: socket.data.userId,
      name: socket.data.name,
    });

    socket.on("arena:join", (payload, ack) =>
      safeHandler(ack, () => handleJoin(socket, payload))
    );

    socket.on("arena:answer", (payload, ack) =>
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

    socket.on("arena:sync", (_payload, ack) =>
      safeHandler(ack, async () => {
        const arenaGroupId = socket.data.arenaGroupId;
        if (!arenaGroupId) throw expected("NOT_IN_ARENA", "Join an arena first");
        const game = await engine.getGame(arenaGroupId);
        return engine.buildSnapshot(game, socket.data);
      })
    );

    socket.on("arena:leave", (_payload, ack) =>
      safeHandler(ack, async () => {
        await leaveArena(socket);
        return { ok: true };
      })
    );

    socket.on("disconnect", () => {
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
    const group = await ArenaGroup.findById(arenaGroupId);
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
    io.to(arenaRoom(arenaGroupId)).emit("arena:online", {
      count,
      humans,
      bots,
    });
    // Lobby display only — Redis is the authoritative count.
    ArenaGroup.updateOne(
      { _id: arenaGroupId },
      { $set: { online_user_count: count } }
    ).catch(() => {});
  }
}

/**
 * Resolve the player for this connection. Clients pass { userId, name } in
 * `socket.handshake.auth`; an unknown/missing userId gets a guest account
 * (the client must persist the userId from the `session` event to stay the
 * same player across reconnects).
 *
 * NOTE: this is intentionally permissive for development. Production should
 * verify a signed token (e.g. the Google-login JWT) here instead.
 */
async function authMiddleware(socket, next) {
  try {
    const { userId, name } = socket.handshake.auth || {};
    let user = null;
    if (userId && mongoose.isValidObjectId(userId)) {
      user = await AuthUser.findById(userId);
    }
    if (!user) {
      const uid = crypto.randomUUID();
      user = await AuthUser.create({
        googleId: `guest-${uid}`,
        email: `guest-${uid}@arena.local`,
        name: name?.trim() || `Guest-${uid.slice(0, 5)}`,
      });
    }
    socket.data.userId = String(user._id);
    socket.data.name = user.name || "Player";
    socket.data.photo = user.profilePicture || "";
    next();
  } catch (e) {
    next(e);
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

function expected(code, message) {
  const e = new Error(message);
  e.code = code;
  e.expected = true;
  return e;
}
