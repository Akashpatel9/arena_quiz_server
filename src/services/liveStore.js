import Redis from "ioredis";
import { REDIS_URL } from "../config/env.js";

// Live-round answers expire on their own if a flush never happens
// (e.g. the arena went idle, or every server died mid-round).
const ANSWER_TTL_MS = 30 * 60 * 1000;
// Bot counts are touched on every drift step; arenas that stop drifting
// (deactivated, server gone) age out instead of leaking keys.
const BOTS_TTL_MS = 24 * 60 * 60 * 1000;
// When an arena empties of real users the game goes idle; the idle key then
// ages out after this window so abandoned arenas don't keep state in Redis
// forever. A player returning within the window resumes the same game (round
// continuity); after it, a fresh game starts from round 0. The bots key is
// independent and untouched.
const IDLE_GAME_TTL_MS = 10 * 60 * 1000;

/**
 * Redis is the database for everything LIVE; Mongo keeps durable history.
 *
 *  - Game state (status/phase/round/timers): one JSON key per arena. Phase
 *    transitions are a Lua compare-and-swap — the script atomically compares
 *    the expected (status, phase, round) and swaps in the new state, so
 *    several servers can race a transition and exactly one wins. This is the
 *    Redis equivalent of the guarded findOneAndUpdate we used in Mongo.
 *  - Live answers: one hash per arena+round, HSETNX per answer ("one answer
 *    per user" with no locks). Batch-flushed to Mongo when the round ends.
 *  - Online count: a plain integer key per arena.
 *
 * Durability: game keys survive a Node crash because they live outside the
 * process. A Redis restart relies on Redis persistence — RDB snapshots by
 * default; run Redis with --appendonly yes to shrink the loss window to ~1s.
 */
export function createLiveStore() {
  const redis = new Redis(REDIS_URL, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    retryStrategy: (times) => Math.min(times * 500, 5000),
  });

  // Atomic compare-and-swap of the game-state JSON.
  // KEYS[1] game key · ARGV[1..3] expected status/phase/round · ARGV[4] next
  redis.defineCommand("casgame", {
    numberOfKeys: 1,
    lua: `
      local cur = redis.call('GET', KEYS[1])
      if not cur then return {0, ''} end
      local t = cjson.decode(cur)
      local phase = t.phase
      if phase == nil or phase == cjson.null then phase = '' end
      if t.status == ARGV[1] and phase == ARGV[2] and tonumber(t.round) == tonumber(ARGV[3]) then
        redis.call('SET', KEYS[1], ARGV[4])
        return {1, ARGV[4]}
      end
      return {0, cur}
    `,
  });

  let healthy = false;
  redis.on("ready", () => {
    healthy = true;
    console.log("[redis] connected — live game state and answers in Redis");
  });
  redis.on("error", (e) => {
    if (healthy) console.error("[redis] error:", e.message);
    healthy = false;
  });
  redis.on("end", () => {
    healthy = false;
  });

  const gameKey = (arenaGroupId) => `arena:{${arenaGroupId}}:game`;
  const onlineKey = (arenaGroupId) => `arena:{${arenaGroupId}}:online`;
  const botsKey = (arenaGroupId) => `arena:{${arenaGroupId}}:bots`;
  const answersKey = (arenaGroupId, round) =>
    `arena:{${arenaGroupId}}:r${round}:answers`;

  // Stored JSON keeps timestamps as epoch-ms; hydrated objects expose Dates
  // so the engine can keep using .getTime() everywhere.
  const hydrateGame = (t) => ({
    ...t,
    phase: t.phase ?? null,
    phaseStartedAt: t.phaseStartedAt ? new Date(t.phaseStartedAt) : null,
    phaseEndsAt: t.phaseEndsAt ? new Date(t.phaseEndsAt) : null,
  });
  const dehydrateGame = (g) => ({
    ...g,
    phase: g.phase ?? null,
    phaseStartedAt: g.phaseStartedAt
      ? new Date(g.phaseStartedAt).getTime()
      : null,
    phaseEndsAt: g.phaseEndsAt ? new Date(g.phaseEndsAt).getTime() : null,
  });

  return {
    isHealthy: () => healthy,

    /** Resolves true once connected (or false after the timeout). */
    ready(timeoutMs = 5000) {
      if (healthy) return Promise.resolve(true);
      return new Promise((resolve) => {
        const t = setTimeout(() => resolve(false), timeoutMs);
        redis.once("ready", () => {
          clearTimeout(t);
          resolve(true);
        });
      });
    },

    // ------------------------------------------------------------- game

    /** Create the idle game key if missing, then return the current state. */
    async ensureGame(arenaGroupId) {
      const idle = JSON.stringify({
        arenaGroupId: String(arenaGroupId),
        status: "idle",
        phase: null,
        round: 0,
        questionId: null,
        questionDurationMs: null,
        phaseStartedAt: null,
        phaseEndsAt: null,
      });
      await redis.set(gameKey(arenaGroupId), idle, "NX");
      return this.getGame(arenaGroupId);
    },

    async getGame(arenaGroupId) {
      const raw = await redis.get(gameKey(arenaGroupId));
      return raw ? hydrateGame(JSON.parse(raw)) : null;
    },

    /**
     * Atomic transition: writes `nextState` only if the stored game still
     * matches `expected` {status, phase, round}. Returns { won, game } where
     * `game` is the post-call state either way (next state if won, the
     * conflicting current state if lost).
     */
    async casGame(arenaGroupId, expected, nextState) {
      const [won, raw] = await redis.casgame(
        gameKey(arenaGroupId),
        expected.status,
        expected.phase ?? "",
        expected.round,
        JSON.stringify(dehydrateGame(nextState))
      );
      return {
        won: won === 1,
        game: raw ? hydrateGame(JSON.parse(raw)) : null,
      };
    },

    /** All game keys — used on boot to resume running games. */
    async scanGames() {
      const keys = [];
      let cursor = "0";
      do {
        const [next, batch] = await redis.scan(
          cursor,
          "MATCH",
          "arena:*:game",
          "COUNT",
          100
        );
        cursor = next;
        keys.push(...batch);
      } while (cursor !== "0");
      if (!keys.length) return [];
      const raws = await redis.mget(keys);
      return raws.filter(Boolean).map((r) => hydrateGame(JSON.parse(r)));
    },

    /** Wipe an arena's live keys. */
    async clearArena(arenaGroupId) {
      await redis.del(
        gameKey(arenaGroupId),
        onlineKey(arenaGroupId),
        botsKey(arenaGroupId)
      );
    },

    /**
     * The arena emptied of humans and went idle — let the idle game key age
     * out so abandoned arenas don't keep state in Redis forever. The next
     * phase transition or a player's restart re-SETs the key without a TTL, so
     * an active game never expires mid-play; the bots key is left untouched.
     */
    async expireIdleGame(arenaGroupId) {
      await redis
        .pexpire(gameKey(arenaGroupId), IDLE_GAME_TTL_MS)
        .catch(() => {});
    },

    // ----------------------------------------------------------- online

    async bumpOnline(arenaGroupId, delta) {
      const count = await redis.incrby(onlineKey(arenaGroupId), delta);
      if (count < 0) {
        await redis.set(onlineKey(arenaGroupId), 0).catch(() => {});
        return 0;
      }
      return count;
    },

    async getOnline(arenaGroupId) {
      const raw = await redis.get(onlineKey(arenaGroupId));
      return Number(raw) || 0;
    },

    /** Zero all online counters (single-server boot cleanup). */
    async resetOnlineCounts() {
      let cursor = "0";
      do {
        const [next, batch] = await redis.scan(
          cursor,
          "MATCH",
          "arena:*:online",
          "COUNT",
          100
        );
        cursor = next;
        if (batch.length) await redis.del(...batch);
      } while (cursor !== "0");
    },

    // --------------------------------------------------------------- bots

    /** Current bot population of an arena (0 when unset / Redis down). */
    async getBotCount(arenaGroupId) {
      if (!healthy) return 0;
      try {
        const raw = await redis.get(botsKey(arenaGroupId));
        return Number(raw) || 0;
      } catch {
        return 0;
      }
    },

    async setBotCount(arenaGroupId, count) {
      await redis.set(botsKey(arenaGroupId), count, "PX", BOTS_TTL_MS);
    },

    /**
     * Set the bot count only if the arena doesn't have one yet (so several
     * servers initialize each arena exactly once). Returns the stored count.
     */
    async initBotCount(arenaGroupId, count) {
      const key = botsKey(arenaGroupId);
      const set = await redis.set(key, count, "PX", BOTS_TTL_MS, "NX");
      if (set) return count;
      return Number(await redis.get(key)) || count;
    },

    // ---------------------------------------------------------- answers

    /** Returns true if stored, false if the user already answered. */
    async saveAnswer(arenaGroupId, round, answer) {
      const key = answersKey(arenaGroupId, round);
      const added = await redis.hsetnx(
        key,
        String(answer.userId),
        JSON.stringify(answer)
      );
      if (added) await redis.pexpire(key, ANSWER_TTL_MS);
      return added === 1;
    },

    /**
     * Batch-store many answers (bot rounds) in one pipeline. HSETNX per
     * entry, so a bot can never displace a real user's answer. No-op when
     * Redis is down — bot answers are decoration, never worth a Mongo write.
     */
    async saveAnswers(arenaGroupId, round, answers) {
      if (!healthy || !answers.length) return;
      const key = answersKey(arenaGroupId, round);
      const pipe = redis.pipeline();
      for (const a of answers) {
        pipe.hsetnx(key, String(a.userId), JSON.stringify(a));
      }
      pipe.pexpire(key, ANSWER_TTL_MS);
      await pipe.exec();
    },

    /** All answers of a round, or null when Redis is unavailable. */
    async getAnswers(arenaGroupId, round) {
      if (!healthy) return null;
      try {
        const raw = await redis.hgetall(answersKey(arenaGroupId, round));
        return Object.values(raw).map((v) => JSON.parse(v));
      } catch {
        return null;
      }
    },

    /** One user's answer in the live round, or null. */
    async getAnswer(arenaGroupId, round, userId) {
      if (!healthy) return null;
      try {
        const raw = await redis.hget(
          answersKey(arenaGroupId, round),
          String(userId)
        );
        return raw ? JSON.parse(raw) : null;
      } catch {
        return null;
      }
    },

    async clearRound(arenaGroupId, round) {
      if (!healthy) return;
      await redis.del(answersKey(arenaGroupId, round)).catch(() => {});
    },

    async close() {
      try {
        await redis.quit();
      } catch {
        redis.disconnect();
      }
    },
  };
}
