/**
 * Bot service verification over a real round.
 * Run the server with TIMER_SCALE=0.2 first, then: node scripts/bot-test.cjs
 *
 * Asserts the three spec points:
 *  1. population: 10–100 bots in the arena, included in arena:online;
 *  2. profiles: every bot answer carries a name and photo;
 *  3. answers: bots answer the live round, correctness ratio within the
 *     difficulty's configured accuracy band, times inside the question timer.
 */
const { io } = require("../node_modules/socket.io/client-dist/socket.io.js");
const Redis = require("ioredis");

const BASE = "http://localhost:3000";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const call = (socket, event, payload) =>
  new Promise((res) => socket.emit(event, payload, res));
const once = (socket, event, timeoutMs = 30000) =>
  new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`timeout waiting ${event}`)), timeoutMs);
    socket.once(event, (p) => {
      clearTimeout(t);
      res(p);
    });
  });

// Accuracy bands per difficulty (mirror gameConstants), widened a bit for
// binomial noise on small crowds.
const ACCURACY_BAND = { 1: [0.7, 1.0], 2: [0.5, 1.0], 3: [0.3, 0.85] };

let failures = 0;
function check(label, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
}

(async () => {
  const redis = new Redis("redis://127.0.0.1:6379");
  const arenas = await fetch(`${BASE}/api/arena-groups`).then((r) => r.json());
  const arenaId = arenas.data[0]._id;
  console.log(`arena: ${arenas.data[0].title} (${arenaId})\n`);

  const s = io(BASE, { transports: ["websocket"], forceNew: true, auth: { name: "BotProbe" } });
  const me = await new Promise((res, rej) => {
    s.once("session", res);
    s.once("connect_error", rej);
  });

  const snap = await call(s, "arena:join", { arenaGroupId: arenaId });
  check("joined the arena", snap.ok && snap.status === "running", `round ${snap.round}`);

  // Wait for a FRESH round: leftover human answers from a round another
  // client played (e.g. the e2e suite just before) would pollute the hash.
  const q = await once(s, "arena:question");
  await sleep(500); // bot answers are written right after the round starts

  // --- the round's answer hash: the whole bot crowd, and only the crowd
  // (this probe hasn't answered yet)
  const raw = await redis.hgetall(`arena:{${arenaId}}:r${q.round}:answers`);
  const answers = Object.values(raw).map((v) => JSON.parse(v));
  const bots = answers.filter((a) => a.userId !== me.userId);
  check("bot crowd within [10, 100]", bots.length >= 10 && bots.length <= 100, `${bots.length} bots`);
  check(
    "every bot has a profile (name + photo)",
    bots.every((b) => b.userName && /^https?:/.test(b.userPhoto)),
    `e.g. ${bots[0]?.userName} · ${bots[0]?.userPhoto}`
  );

  const ratio = bots.filter((b) => b.correct).length / bots.length;
  const [lo, hi] = ACCURACY_BAND[q.question.difficulty] ?? [0.3, 1.0];
  check(
    `accuracy in band for difficulty ${q.question.difficulty}`,
    ratio >= lo && ratio <= hi,
    `${Math.round(ratio * 100)}% correct (band ${lo * 100}–${hi * 100}%)`
  );
  check(
    "bot answer times inside the question timer",
    bots.every((b) => b.timeTakenMs > 0 && b.timeTakenMs <= q.durationMs),
    `min ${Math.min(...bots.map((b) => b.timeTakenMs))}ms max ${Math.max(...bots.map((b) => b.timeTakenMs))}ms of ${q.durationMs}ms`
  );

  // --- answer correctly (crib from a correct bot) → graph must rank me among bots
  const crib = bots.find((b) => b.correct);
  await call(s, "arena:answer", { round: q.round, selectedOption: crib.selectedOption });
  const result = await once(s, "arena:result");
  const botEntries = (result.graph || []).filter((g) => g.userId !== me.userId);
  check("my correct answer lands on the graph", result.outcome === "correct" && result.yourRank > 0, `rank ${result.yourRank}`);
  check(
    "graph mixes bots in, with profile fields",
    botEntries.length > 0 && botEntries.every((g) => g.name && g.photo),
    `${botEntries.length} bot entries, cap ok: ${(result.graph || []).length <= 51}`
  );

  // --- online count includes the bot crowd and drifts over time
  const counts = [];
  s.on("arena:online", (p) => counts.push(p));
  const before = await fetch(`${BASE}/api/arena-groups/${arenaId}/state`).then((r) => r.json());
  await sleep(21_000); // two drift steps
  const after = await fetch(`${BASE}/api/arena-groups/${arenaId}/state`).then((r) => r.json());
  check(
    "online count includes bots (10–100) for humans too",
    before.data.bots >= 10 && before.data.bots <= 100 && before.data.online === before.data.humans + before.data.bots,
    `humans ${before.data.humans} + bots ${before.data.bots} = ${before.data.online}`
  );
  const drifted = after.data.bots !== before.data.bots || counts.some((c) => c.bots !== before.data.bots);
  check("bot population drifts (coming/leaving)", drifted, `${before.data.bots} → ${after.data.bots}`);

  s.close();
  redis.quit();
  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error("bot-test error:", e.message);
  process.exit(1);
});
