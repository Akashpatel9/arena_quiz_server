/**
 * Concurrency/race-condition test. Run server A with TIMER_SCALE=0.2 first:
 *   node tests/concurrency-test.cjs
 *
 * Covers:
 *  1. N simultaneous joins to an EMPTY arena → exactly one game start,
 *     everyone seated in the same round.
 *  2. Same user answering from two sockets at the same instant → exactly
 *     one answer accepted (Redis HSETNX dedupe).
 *  3. TWO server instances sharing Redis/Mongo, both running the loop →
 *     every phase transition won exactly once (rounds advance strictly by
 *     1, identical state on clients of both servers, no double-announce).
 *  4. Join/leave churn → online counter returns exactly to baseline.
 */
const { execSync, spawn } = require("node:child_process");
const path = require("node:path");
const Redis = require("../node_modules/ioredis");
const { io } = require("../node_modules/socket.io/client-dist/socket.io.js");

const A = "http://localhost:3000";
const B = "http://localhost:3001";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const call = (s, ev, p) => new Promise((res) => s.emit(ev, p, res));
const state = (base) =>
  fetch(`${base}/api/arena-groups/${ARENA}/state`).then((r) => r.json());

let ARENA;
let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
};

const mk = (base, name, userId) =>
  new Promise((res, rej) => {
    const s = io(base, {
      transports: ["websocket"],
      forceNew: true,
      auth: { name, userId },
    });
    s.once("session", (sess) => {
      s.auth = { ...s.auth, userId: sess.userId };
      res({ s, userId: sess.userId });
    });
    s.once("connect_error", rej);
  });

// Wipe an arena's live keys straight from Redis so the suite starts from a
// known idle state — the server exposes no reset endpoint, and back-to-back
// runs would otherwise see the arena still running from the previous run.
async function clearArena(id) {
  const redis = new Redis(process.env.REDIS_URL || "redis://127.0.0.1:6379", {
    maxRetriesPerRequest: 1,
    lazyConnect: true,
  });
  await redis.connect();
  const keys = [`arena:{${id}}:game`, `arena:{${id}}:online`];
  let cursor = "0";
  do {
    const [next, batch] = await redis.scan(
      cursor,
      "MATCH",
      `arena:{${id}}:r*:answers`,
      "COUNT",
      100
    );
    cursor = next;
    keys.push(...batch);
  } while (cursor !== "0");
  if (keys.length) await redis.del(...keys);
  await redis.quit();
}

(async () => {
  ARENA = (await fetch(`${A}/api/arena-groups`).then((r) => r.json())).data[0]._id;
  await clearArena(ARENA);

  // ---- 1. simultaneous first joins on an empty arena -------------------
  const before = (await state(A)).data;
  check("arena starts idle", before.status === "idle", `round ${before.round}`);

  const racers = await Promise.all(
    Array.from({ length: 20 }, (_, i) => mk(A, `Racer${i}`))
  );
  const snaps = await Promise.all(
    racers.map((c) => call(c.s, "arena:join", { arenaGroupId: ARENA }))
  );
  const rounds = new Set(snaps.map((x) => x.round));
  check(
    "20 simultaneous joins → game started exactly once",
    rounds.size === 1 && [...rounds][0] === before.round + 1,
    `all in round ${[...rounds].join(",")}`
  );
  check(
    "nobody left waiting by the start race",
    snaps.every((x) => x.ok && !x.waiting && x.phase === "question")
  );

  // ---- 2. same user, two sockets, simultaneous answers -----------------
  const round = snaps[0].round;
  const twin = await mk(A, "Racer0-twin", racers[0].userId);
  await call(twin.s, "arena:join", { arenaGroupId: ARENA });
  const [r1, r2] = await Promise.all([
    call(racers[0].s, "arena:answer", { round, selectedOption: 0 }),
    call(twin.s, "arena:answer", { round, selectedOption: 3 }),
  ]);
  const okCount = [r1, r2].filter((r) => r.ok).length;
  const dupRejected = [r1, r2].some((r) => !r.ok && r.code === "ALREADY_ANSWERED");
  check(
    "same user racing two answers → exactly one accepted",
    okCount === 1 && dupRejected,
    `accepted ${okCount}, other ${(r1.ok ? r2 : r1).code}`
  );
  twin.s.close();
  racers.forEach((c) => c.s.close()); // arena will idle out after this round

  // ---- 3. two servers, one game ----------------------------------------
  spawn("npm", ["start"], {
    cwd: path.join(__dirname, ".."),
    env: {
      ...process.env,
      PORT: "3001",
      TIMER_SCALE: "0.2",
      RESET_ONLINE_COUNTS: "false", // must not wipe live counters mid-test
    },
    detached: true,
    stdio: "ignore",
  }).unref();
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try {
      if ((await fetch(`${B}/health`)).ok) break;
    } catch {}
  }
  console.log("server B up on :3001 (same Redis + Mongo)");

  const ca = await mk(A, "OnServerA");
  const cb = await mk(B, "OnServerB");

  // Record EVERY broadcast with persistent listeners — no `once` re-arm gap
  // between phases that could silently drop a question event and make the
  // engine look like it skipped a round. qX: first question payload per round;
  // seenX: raw event count per round (to catch a genuine double-announce);
  // rX: result payload per round. Each client auto-answers every question it
  // sees, so results have content.
  const qA = new Map(), qB = new Map(), rA = new Map(), rB = new Map();
  const seenA = new Map(), seenB = new Map();
  const onQuestion = (qMap, seen, sock, opt) => (q) => {
    seen.set(q.round, (seen.get(q.round) || 0) + 1);
    if (!qMap.has(q.round)) {
      qMap.set(q.round, q);
      sock.emit("arena:answer", { round: q.round, selectedOption: opt(q.round) });
    }
  };
  ca.s.on("arena:question", onQuestion(qA, seenA, ca.s, (r) => r % 4));
  cb.s.on("arena:question", onQuestion(qB, seenB, cb.s, (r) => (r + 1) % 4));
  ca.s.on("arena:result", (r) => rA.set(r.round, r));
  cb.s.on("arena:result", (r) => rB.set(r.round, r));

  await call(ca.s, "arena:join", { arenaGroupId: ARENA });
  await call(cb.s, "arena:join", { arenaGroupId: ARENA });

  // Wait for a run of 3 consecutive rounds with results on BOTH servers. One
  // cycle is question(12s)+result(3s)=15s under TIMER_SCALE=0.2.
  const commonRounds = () =>
    [...qA.keys()]
      .filter((r) => qB.has(r) && rA.has(r) && rB.has(r))
      .sort((a, b) => a - b);
  const consecutive = (xs, n) => {
    for (let i = 0; i + n <= xs.length; i++) {
      const w = xs.slice(i, i + n);
      if (w.every((v, j) => j === 0 || v === w[j - 1] + 1)) return w;
    }
    return null;
  };
  let window = null;
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline && !(window = consecutive(commonRounds(), 3))) {
    await sleep(500);
  }
  if (!window) throw new Error("never saw 3 consecutive rounds on both servers");

  check(
    "clients on both servers see identical rounds + endsAt",
    window.every((r) => qA.get(r).endsAt === qB.get(r).endsAt),
    window.join(" → ")
  );
  // Server A sees every broadcast (persistent listener), so its captured
  // rounds must be a gap-free run — the engine never skips a round.
  const roundsA = [...qA.keys()].sort((a, b) => a - b);
  check(
    "rounds advance strictly by 1 (each CAS won exactly once)",
    roundsA.every((v, i) => i === 0 || v === roundsA[i - 1] + 1),
    roundsA.join(" → ")
  );
  check(
    "no double-announced question on either server",
    [...seenA.values()].every((n) => n === 1) &&
      [...seenB.values()].every((n) => n === 1)
  );
  check(
    "identical results across servers (correctOption matches)",
    window.every((r) => rA.get(r).correctOption === rB.get(r).correctOption)
  );

  // ---- 4. join/leave churn keeps the online counter honest -------------
  // Compare the human-only counter: the displayed `online` also includes
  // the bot crowd, which drifts on its own between the two reads.
  const humansOf = (st) => st.data.humans ?? st.data.online;
  const baseline = humansOf(await state(A));
  const churners = await Promise.all(
    Array.from({ length: 30 }, (_, i) => mk(A, `Churn${i}`))
  );
  await Promise.all(
    churners.map(async (c, i) => {
      await call(c.s, "arena:join", { arenaGroupId: ARENA });
      await sleep(Math.random() * 500);
      if (i % 2) await call(c.s, "arena:leave", {});
      c.s.close();
    })
  );
  await sleep(1500);
  const after = humansOf(await state(A));
  check(
    "online count returns to baseline after 30 join/leave churners",
    after === baseline,
    `baseline ${baseline}, after ${after}`
  );

  ca.s.close();
  cb.s.close();
  try {
    execSync("kill $(lsof -ti:3001 -sTCP:LISTEN)");
  } catch {}
  console.log(failures ? `\n${failures} FAILURE(S)` : "\nCONCURRENCY TEST PASS");
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error("concurrency test error:", e.message);
  try { execSync("kill $(lsof -ti:3001 -sTCP:LISTEN)"); } catch {}
  process.exit(1);
});
