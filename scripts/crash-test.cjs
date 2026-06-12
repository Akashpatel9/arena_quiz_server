/**
 * Crash-recovery test: clients join and answer, the server is SIGKILLed
 * mid-question, restarted, and must come back at the SAME round/phase with
 * the answer still locked in. Run the server with TIMER_SCALE=0.2 first:
 *   node scripts/crash-test.cjs
 */
const { execSync, spawn } = require("node:child_process");
const path = require("node:path");
const { io } = require("../node_modules/socket.io/client-dist/socket.io.js");

const BASE = "http://localhost:3000";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const call = (s, ev, p) => new Promise((res) => s.emit(ev, p, res));
const once = (s, ev, timeoutMs = 60000) =>
  new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`timeout ${ev}`)), timeoutMs);
    s.once(ev, (p) => (clearTimeout(t), res(p)));
  });

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
};

(async () => {
  const arenaId = (await fetch(`${BASE}/api/arena-groups`).then((r) => r.json()))
    .data[0]._id;

  // Two players in a live round; Alice answers before the crash.
  const mk = (name) =>
    new Promise((res) => {
      const s = io(BASE, { transports: ["websocket"], forceNew: true, auth: { name } });
      s.once("session", (sess) => {
        // Reconnects re-send socket.auth; carry the assigned identity.
        s.auth = { ...s.auth, userId: sess.userId };
        res({ s, userId: sess.userId });
      });
    });
  const alice = await mk("Alice");
  const bob = await mk("Bob");
  await call(alice.s, "arena:join", { arenaGroupId: arenaId });
  await call(bob.s, "arena:join", { arenaGroupId: arenaId });
  const q = await once(alice.s, "arena:question");
  const ans = await call(alice.s, "arena:answer", { round: q.round, selectedOption: 2 });
  console.log(`live: round ${q.round}, question ends ${q.endsAt - Date.now()}ms from now; Alice answered (${ans.ok})`);

  // ---- kill the server mid-question
  // -sTCP:LISTEN so we kill only the server, not this script's own sockets.
  execSync("kill -9 $(lsof -ti:3000 -sTCP:LISTEN)");
  console.log("server SIGKILLed mid-question");
  await sleep(1500);

  // ---- restart it
  spawn("npm", ["start"], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, TIMER_SCALE: "0.2" },
    detached: true,
    stdio: "ignore",
  }).unref();
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try {
      const h = await fetch(`${BASE}/health`);
      if (h.ok) break;
    } catch {}
  }
  console.log("server restarted");

  // ---- clients auto-reconnect and re-join: must land at the SAME spot
  const rejoin = (c) =>
    new Promise((res) => {
      const done = (snap) => res(snap);
      if (c.s.connected) call(c.s, "arena:join", { arenaGroupId: arenaId }).then(done);
      else
        c.s.io.once("reconnect", () =>
          call(c.s, "arena:join", { arenaGroupId: arenaId }).then(done)
        );
    });
  const [snapA, snapB] = await Promise.all([rejoin(alice), rejoin(bob)]);

  const sameRound = snapA.round === q.round && snapB.round === q.round;
  check("game resumed at the same round after SIGKILL", sameRound,
    `round ${snapA.round} (was ${q.round}), phase ${snapA.phase}`);
  check("players are not 'waiting' — they kept their seats",
    !snapA.waiting && !snapB.waiting);
  if (snapA.phase === "question") {
    check("Alice's answer survived the crash (from Redis)",
      snapA.yourAnswer?.selectedOption === 2,
      JSON.stringify(snapA.yourAnswer));
    check("timer continued on the original schedule",
      Math.abs(snapA.phaseEndsAt - q.endsAt) < 50,
      `endsAt drift ${snapA.phaseEndsAt - q.endsAt}ms`);
  } else {
    // The boundary passed during the restart window — equally valid:
    check("Alice's answer survived into the result",
      snapA.result?.yourAnswer?.selectedOption === 2);
  }

  // ---- and the loop keeps running
  const nextQ = await once(alice.s, "arena:question", 60000);
  check("loop continues after recovery", nextQ.round === q.round + 1,
    `next round ${nextQ.round}`);

  alice.s.close();
  bob.s.close();
  console.log(failures ? `\n${failures} FAILURE(S)` : "\nCRASH RECOVERY PASS");
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error("crash test error:", e.message);
  process.exit(1);
});
