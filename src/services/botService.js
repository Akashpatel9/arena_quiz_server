import {
  listActiveArenaIds,
  bulkSetOnlineCounts,
} from "../dal/arenaGroupDao.js";
import {
  upsertBotUsers,
  findBotUsersByGoogleIds,
  findUsersByGoogleIds,
} from "../dal/userDao.js";
import { arenaRoom } from "../utils/rooms.js";
import { ARENA_ONLINE } from "../constants/socketEvents.js";
import { botProfiles, toPoolEntries } from "../utils/botProfiles.js";
import {
  randomInt,
  wrongOption,
  hashSeed,
  shuffledIndices,
} from "../utils/random.js";
import {
  BOT_MIN_PER_ARENA,
  BOT_MAX_PER_ARENA,
  BOT_DRIFT_INTERVAL_MS,
  BOT_DRIFT_MAX_STEP,
  BOT_ACCURACY,
  BOT_TIME_FRACTION,
} from "../constants/bot.js";

// How often the set of active arenas is re-read from Mongo.
const ARENA_REFRESH_MS = 60_000;

/**
 * Simulated players. Every active arena holds a crowd of bots whose size
 * random-walks inside [BOT_MIN_PER_ARENA, BOT_MAX_PER_ARENA] — bots "come and
 * go" a few at a time. Each bot is a real auth_user document (isBot: true)
 * with a name and photo, so bot entries on the result graph look exactly
 * like human entries.
 *
 * What bots deliberately do NOT do:
 *  - hold sockets or presence — they are not connections, just a count in
 *    Redis plus answers in the round's answer hash;
 *  - keep a game alive — the engine's idle check reads the HUMAN online
 *    count, so an arena with only bots still goes idle;
 *  - write to Mongo on the hot path — their answers ride the same Redis
 *    hash + batch flush as human answers.
 *
 * Multi-server: bot answers are written by the server that WON the round's
 * CAS transition (the engine calls onQuestionStarted only on a won
 * transition), so each round is simulated exactly once. The drift loop runs
 * on every server — with N servers the crowd just drifts N× faster, which is
 * harmless; move it behind a Redis lock if that ever matters.
 */
export function createBotService(io, liveStore) {
  /** arenaGroupId -> bot count mirror (avoids a Redis read per join). */
  const counts = new Map();
  let pool = []; // [{ userId, name, school, photo }]
  let arenaIds = [];
  let driftTimer = null;
  let refreshTimer = null;

  // ----------------------------------------------------------------- public

  async function start() {
    pool = await loadBotPool();
    if (!pool.length) {
      console.warn(
        "[bots] no bot profiles found in Mongo — run `npm run create:bots` to create them. Arenas will run without bots until then."
      );
    }
    await refreshArenas();
    for (const id of arenaIds) {
      const initial = randomInt(BOT_MIN_PER_ARENA, BOT_MAX_PER_ARENA);
      counts.set(id, await liveStore.initBotCount(id, initial));
    }
    driftTimer = setInterval(() => {
      drift().catch((e) => console.error("[bots] drift failed:", e.message));
    }, BOT_DRIFT_INTERVAL_MS);
    refreshTimer = setInterval(() => {
      refreshArenas().catch(() => {});
    }, ARENA_REFRESH_MS);
    console.log(
      `[bots] ${pool.length} bot profiles ready; populating ${arenaIds.length} arena(s)`
    );
  }

  /**
   * Called by the engine when THIS server won a round's question transition.
   * Writes the whole crowd's answers for the round up front with randomized
   * "answer times" — clients can't observe mid-round answers, so the result
   * is indistinguishable from bots answering live, at a fraction of the cost.
   */
  async function onQuestionStarted(game, question) {
    if (!pool.length) return;
    const arenaId = String(game.arenaGroupId);
    const bots = rosterFor(arenaId, await botCount(arenaId));
    if (!bots.length) return;

    const [pLo, pHi] = BOT_ACCURACY[question.difficulty] ?? BOT_ACCURACY[2];
    const accuracy = pLo + Math.random() * (pHi - pLo);
    const durationMs = game.questionDurationMs;
    const [tLo, tHi] = BOT_TIME_FRACTION;
    const startedAt = game.phaseStartedAt.getTime();

    const answers = bots.map((bot) => {
      const correct = Math.random() < accuracy;
      const timeTakenMs = Math.round(
        durationMs * (tLo + Math.random() * (tHi - tLo))
      );
      return {
        arenaGroupId: arenaId,
        round: game.round,
        questionId: String(game.questionId),
        userId: bot.userId,
        userName: bot.name,
        userPhoto: bot.photo,
        selectedOption: correct
          ? question.correctOption
          : wrongOption(question.correctOption),
        correct,
        timeTakenMs,
        answeredAt: new Date(startedAt + timeTakenMs).toISOString(),
      };
    });
    await liveStore.saveAnswers(arenaId, game.round, answers);
  }

  /** Bots currently "in" an arena — added to every displayed online count. */
  async function botCount(arenaGroupId) {
    const key = String(arenaGroupId);
    if (counts.has(key)) return counts.get(key);
    const count = await liveStore.getBotCount(key);
    counts.set(key, count);
    return count;
  }

  function stop() {
    clearInterval(driftTimer);
    clearInterval(refreshTimer);
  }

  // ------------------------------------------------------------- population

  /** One random-walk step for every arena's crowd. */
  async function drift() {
    if (!liveStore.isHealthy()) return;
    const lobbyUpdates = [];
    for (const id of arenaIds) {
      const step = randomInt(-BOT_DRIFT_MAX_STEP, BOT_DRIFT_MAX_STEP);
      if (!step) continue;
      const current = await botCount(id);
      const next = Math.min(
        BOT_MAX_PER_ARENA,
        Math.max(BOT_MIN_PER_ARENA, current + step)
      );
      if (next === current) continue;
      counts.set(id, next);
      await liveStore.setBotCount(id, next);

      const humans = await liveStore.getOnline(id);
      io.to(arenaRoom(id)).emit(ARENA_ONLINE, {
        count: humans + next,
        humans,
        bots: next,
      });
      lobbyUpdates.push({
        updateOne: {
          filter: { _id: id },
          update: { $set: { online_user_count: humans + next } },
        },
      });
    }
    // Lobby display only — Redis stays authoritative.
    if (lobbyUpdates.length) {
      await bulkSetOnlineCounts(lobbyUpdates).catch(() => {});
    }
  }

  async function refreshArenas() {
    arenaIds = await listActiveArenaIds();
  }

  /**
   * The arena's current crowd: a per-arena shuffle of the shared pool, cut
   * at `count`. The shuffle is seeded by the arena id, so rosters differ
   * between arenas but stay stable as the count drifts (growing the count
   * means "new bots joined", not a brand-new crowd) — and every server
   * derives the same roster from the count alone.
   */
  function rosterFor(arenaId, count) {
    const order = shuffledIndices(pool.length, hashSeed(arenaId));
    return order.slice(0, Math.min(count, pool.length)).map((i) => pool[i]);
  }

  return { start, stop, onQuestionStarted, botCount };
}

// ------------------------------------------------------------ provisioning

/**
 * Create (upsert) the shared pool of bot users in Mongo. This is a deliberate
 * one-off provisioning step — run it from the create:bots script, NOT on every
 * server start. Returns the resulting pool entries.
 */
export async function createBotPool() {
  const profiles = botProfiles();
  await upsertBotUsers(profiles);
  const docs = await findUsersByGoogleIds(profiles.map((p) => p.googleId));
  return toPoolEntries(profiles, docs);
}

/**
 * Load the bot pool that already exists in Mongo (created by create:bots).
 * Read-only — never creates bots — so the server start path makes no decision
 * about provisioning. Returns whatever subset currently exists (possibly empty).
 */
async function loadBotPool() {
  const profiles = botProfiles();
  const docs = await findBotUsersByGoogleIds(profiles.map((p) => p.googleId));
  return toPoolEntries(profiles, docs);
}
