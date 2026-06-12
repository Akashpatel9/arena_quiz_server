import crypto from "node:crypto";
import mongoose from "mongoose";
import AuthUser from "../models/AuthUser.js";
import ArenaGroup from "../models/ArenaGroupModel.js";
import { arenaRoom } from "../services/gameEngine.js";
import {
  REJOIN_GRACE_MS,
  JOIN_START_WINDOW_MS,
} from "../config/gameConstants.js";

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
 * Presence and online counts live in Redis (liveStore) so any server can
 * answer a reconnect; ArenaGroup.online_user_count in Mongo is updated
 * best-effort purely for lobby display.
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
            eligibleFromRound: socket.data.eligibleFromRound ?? Infinity,
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
        await leaveArena(socket, { forfeitSeat: true });
        return { ok: true };
      })
    );

    socket.on("disconnect", () => {
      // A dropped connection KEEPS its seat (rejoin grace) — only a
      // deliberate leave or arena switch forfeits it.
      leaveArena(socket, { forfeitSeat: false }).catch((e) =>
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
      // Switching arenas forfeits the old seat: coming back later means
      // joining fresh (wait for the next question), not resuming mid-round.
      await leaveArena(socket, { forfeitSeat: true });
    }
    if (!rejoinSameArena) {
      socket.join(arenaRoom(arenaGroupId));
      socket.data.arenaGroupId = String(arenaGroupId);
      await bumpOnlineCount(arenaGroupId, +1);
    }

    const { game, started, noQuestions } = await engine.ensureRunning(arenaGroupId);
    const eligibleFromRound = await resolveEligibility({
      arenaGroupId,
      userId: socket.data.userId,
      game,
      started,
    });
    socket.data.eligibleFromRound = eligibleFromRound;

    await liveStore.setPresence(arenaGroupId, socket.data.userId, {
      eligibleFromRound,
      connected: true,
      lastSeenAt: Date.now(),
    });

    const snapshot = await engine.buildSnapshot(game, socket.data);
    if (noQuestions) snapshot.noQuestions = true;
    return snapshot;
  }

  /**
   * Which round may this user play from?
   *  - they just started the game (or it started a heartbeat ago) → this round
   *  - a quick reconnect inside the same cycle → whatever they had before
   *  - everyone else (fresh joiners, long-gone users) → the next question
   */
  async function resolveEligibility({ arenaGroupId, userId, game, started }) {
    if (game.status !== "running") return game.round + 1;

    const now = Date.now();
    const candidates = [game.round + 1];

    if (
      started ||
      (game.phase === "question" &&
        now - game.phaseStartedAt.getTime() <= JOIN_START_WINDOW_MS)
    ) {
      candidates.push(game.round);
    }

    const presence = await liveStore.getPresence(arenaGroupId, userId);
    if (
      presence &&
      now - presence.lastSeenAt <= REJOIN_GRACE_MS &&
      presence.eligibleFromRound <= game.round + 1
    ) {
      candidates.push(presence.eligibleFromRound);
    }

    return Math.min(...candidates);
  }

  async function leaveArena(socket, { forfeitSeat }) {
    const arenaGroupId = socket.data.arenaGroupId;
    if (!arenaGroupId) return;
    const eligibleFromRound = socket.data.eligibleFromRound;
    socket.data.arenaGroupId = null;
    socket.data.eligibleFromRound = null;
    socket.leave(arenaRoom(arenaGroupId));
    if (forfeitSeat) {
      await liveStore.clearPresence(arenaGroupId, socket.data.userId);
    } else if (eligibleFromRound != null) {
      // Keep their seat info so a quick reconnect resumes the same round.
      await liveStore
        .setPresence(arenaGroupId, socket.data.userId, {
          eligibleFromRound,
          connected: false,
          lastSeenAt: Date.now(),
        })
        .catch(() => {});
    }
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
