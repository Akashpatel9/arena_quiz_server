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
const { io } = require("../node_modules/socket.io/client-dist/socket.io.js");

const A = "http://localhost:3000";
const B = "http://localhost:3001";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const call = (s, ev, p) => new Promise((res) => s.emit(ev, p, res));
const once = (s, ev, timeoutMs = 60000) =>
  new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`timeout ${ev}`)), timeoutMs);
    s.once(ev, (p) => (clearTimeout(t), res(p)));
  });
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

(async () => {
  ARENA = (await fetch(`${A}/api/arena-groups`).then((r) => r.json())).data[0]._id;

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
  const seenA = new Map(); // round -> count of question events
  const seenB = new Map();
  ca.s.on("arena:question", (q) => seenA.set(q.round, (seenA.get(q.round) || 0) + 1));
  cb.s.on("arena:question", (q) => seenB.set(q.round, (seenB.get(q.round) || 0) + 1));
  await call(ca.s, "arena:join", { arenaGroupId: ARENA });
  await call(cb.s, "arena:join", { arenaGroupId: ARENA });

  const transcript = [];
  for (let i = 0; i < 3; i++) {
    const [qa, qb] = await Promise.all([
      once(ca.s, "arena:question"),
      once(cb.s, "arena:question"),
    ]);
    transcript.push({ qa, qb });
    // both answer so results have content
    await Promise.all([
      call(ca.s, "arena:answer", { round: qa.round, selectedOption: i % 4 }),
      call(cb.s, "arena:answer", { round: qb.round, selectedOption: (i + 1) % 4 }),
    ]);
    const [ra, rb] = await Promise.all([
      once(ca.s, "arena:result"),
      once(cb.s, "arena:result"),
    ]);
    transcript[i].ra = ra;
    transcript[i].rb = rb;
  }

  check(
    "clients on both servers see identical rounds + endsAt",
    transcript.every(
      ({ qa, qb }) => qa.round === qb.round && qa.endsAt === qb.endsAt
    ),
    transcript.map(({ qa }) => qa.round).join(" → ")
  );
  check(
    "rounds advance strictly by 1 (each CAS won exactly once)",
    transcript.every(
      ({ qa }, i) => i === 0 || qa.round === transcript[i - 1].qa.round + 1
    )
  );
  check(
    "no double-announced question on either server",
    [...seenA.values()].every((n) => n === 1) &&
      [...seenB.values()].every((n) => n === 1)
  );
  check(
    "identical results across servers (correctOption matches)",
    transcript.every(({ ra, rb }) => ra.correctOption === rb.correctOption)
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
