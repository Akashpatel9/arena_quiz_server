import AuthUser from "../models/AuthUser.js";
import ArenaGroup from "../models/ArenaGroupModel.js";
import { arenaRoom } from "./gameEngine.js";
import {
  BOT_MIN_PER_ARENA,
  BOT_MAX_PER_ARENA,
  BOT_DRIFT_INTERVAL_MS,
  BOT_DRIFT_MAX_STEP,
  BOT_ACCURACY,
  BOT_TIME_FRACTION,
  BOT_POOL_SIZE,
} from "../config/gameConstants.js";

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
      io.to(arenaRoom(id)).emit("arena:online", {
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
      await ArenaGroup.bulkWrite(lobbyUpdates, { ordered: false }).catch(
        () => {}
      );
    }
  }

  async function refreshArenas() {
    const groups = await ArenaGroup.find({ status: 1 }).select("_id").lean();
    arenaIds = groups.map((g) => String(g._id));
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

// ------------------------------------------------------------ bot profiles

const FIRST_NAMES = [
  "Aarav", "Vivaan", "Aditya", "Arjun", "Reyansh", "Krishna", "Ishaan",
  "Shaurya", "Atharv", "Kabir", "Ananya", "Diya", "Aadhya", "Saanvi",
  "Pari", "Anika", "Navya", "Myra", "Ira", "Riya", "Rohan", "Karan",
  "Nikhil", "Siddharth", "Pranav", "Tanvi", "Sneha", "Pooja", "Kavya",
  "Meera", "Dev", "Yash",
];
const LAST_NAMES = [
  "Sharma", "Verma", "Gupta", "Patel", "Singh", "Kumar", "Reddy", "Nair",
  "Iyer", "Joshi", "Mehta", "Agarwal", "Chauhan", "Mishra", "Das", "Bose",
  "Kulkarni", "Rao", "Pandey", "Malhotra",
];
/**
 * The deterministic list of bot identities — generated from a fixed seed, so
 * the script and the server always agree on the same googleIds/names/photos.
 * This touches no database.
 */
function botProfiles() {
  const rand = mulberry32(0xb07_5eed);
  return Array.from({ length: BOT_POOL_SIZE }, (_, i) => {
    const name = `${pick(FIRST_NAMES, rand)} ${pick(LAST_NAMES, rand)}`;
    return {
      googleId: `arena-bot-${i}`,
      email: `arena-bot-${i}@bots.arena.local`,
      name,
      photo: `https://i.pravatar.cc/150?img=${(i % 70) + 1}`,
    };
  });
}

/** Map auth_user docs to the lightweight pool entries the service uses. */
function toPoolEntries(profiles, docs) {
  const byGoogleId = new Map(docs.map((d) => [d.googleId, d]));
  return profiles
    .map((p) => {
      const doc = byGoogleId.get(p.googleId);
      if (!doc) return null;
      return {
        userId: String(doc._id),
        name: doc.name || p.name,
        photo: doc.profilePicture || p.photo,
      };
    })
    .filter(Boolean);
}

/**
 * Create (upsert) the shared pool of bot users in Mongo. This is a deliberate
 * one-off provisioning step — run it from the create:bots script, NOT on every
 * server start. Returns the resulting pool entries.
 */
export async function createBotPool() {
  const profiles = botProfiles();
  await AuthUser.bulkWrite(
    profiles.map((p) => ({
      updateOne: {
        filter: { googleId: p.googleId },
        update: {
          $setOnInsert: {
            googleId: p.googleId,
            email: p.email,
            name: p.name,
            profilePicture: p.photo,
            isBot: true,
          },
        },
        upsert: true,
      },
    })),
    { ordered: false }
  );

  const docs = await AuthUser.find({
    googleId: { $in: profiles.map((p) => p.googleId) },
  })
    .select("_id googleId name profilePicture")
    .lean();
  return toPoolEntries(profiles, docs);
}

/**
 * Load the bot pool that already exists in Mongo (created by create:bots).
 * Read-only — never creates bots — so the server start path makes no decision
 * about provisioning. Returns whatever subset currently exists (possibly empty).
 */
async function loadBotPool() {
  const profiles = botProfiles();
  const docs = await AuthUser.find({
    isBot: true,
    googleId: { $in: profiles.map((p) => p.googleId) },
  })
    .select("_id googleId name profilePicture")
    .lean();
  return toPoolEntries(profiles, docs);
}

// ----------------------------------------------------------------- helpers

const randomInt = (min, max) =>
  Math.floor(Math.random() * (max - min + 1)) + min;

const pick = (arr, rand) => arr[Math.floor(rand() * arr.length)];

function wrongOption(correctOption) {
  const wrong = [0, 1, 2, 3].filter((o) => o !== correctOption);
  return wrong[Math.floor(Math.random() * wrong.length)];
}

/** Deterministic seedable PRNG — same seed, same sequence, on any server. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Fisher–Yates with a seeded PRNG: a stable per-arena ordering. */
function shuffledIndices(n, seed) {
  const rand = mulberry32(seed);
  const order = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}
