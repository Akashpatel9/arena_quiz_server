/**
 * End-to-end test of the live arena over real sockets.
 * Run the server with TIMER_SCALE=0.2 first, then: node scripts/e2e.cjs
 * Uses the socket.io client bundle that ships inside the socket.io package.
 */
const { io } = require("../node_modules/socket.io/client-dist/socket.io.js");

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

function connect(name, userId) {
  const s = io(BASE, {
    transports: ["websocket"],
    forceNew: true,
    auth: { name, userId },
  });
  return new Promise((res, rej) => {
    s.once("session", (sess) => res({ socket: s, ...sess }));
    s.once("connect_error", rej);
  });
}

let failures = 0;
function check(label, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
}

(async () => {
  const arenas = await fetch(`${BASE}/api/arena-groups`).then((r) => r.json());
  const arenaId = arenas.data[0]._id;
  console.log(`arena: ${arenas.data[0].title} (${arenaId})\n`);

  // --- Alice joins an empty arena: game must start immediately
  const A = await connect("Alice");
  const snapA = await call(A.socket, "arena:join", { arenaGroupId: arenaId });
  check(
    "empty arena starts immediately for first joiner",
    snapA.ok && snapA.phase === "question" && !snapA.waiting && snapA.question,
    `round ${snapA.round}`
  );

  // --- Alice answers; second answer must be rejected
  const ans = await call(A.socket, "arena:answer", {
    round: snapA.round,
    selectedOption: 1,
  });
  check("answer accepted and locked", ans.ok && ans.locked, `${ans.timeTakenMs}ms`);
  const dup = await call(A.socket, "arena:answer", {
    round: snapA.round,
    selectedOption: 2,
  });
  check("second answer rejected", !dup.ok && dup.code === "ALREADY_ANSWERED");

  // --- Bob joins mid-question: must wait for the next question
  await sleep(2500); // past the join-start grace window
  const B = await connect("Bob");
  const snapB = await call(B.socket, "arena:join", { arenaGroupId: arenaId });
  check(
    "mid-game joiner waits for next question",
    snapB.ok && snapB.waiting && snapB.waitMs > 0 && !snapB.question,
    `waitMs ${snapB.waitMs}`
  );

  // --- Result reaches Alice with explanation; graph only if correct
  const resA = await once(A.socket, "arena:result");
  const graphOk =
    resA.outcome === "correct"
      ? Array.isArray(resA.graph) && resA.graph.some((g) => g.userId === A.userId)
      : resA.graph === null;
  check(
    "result has correct answer + explanation",
    Number.isInteger(resA.correctOption) && typeof resA.explanation === "string",
    `outcome ${resA.outcome}`
  );
  check("graph only for correct answers (and contains you)", graphOk);

  // --- Next question reaches both; Bob is now in
  const [qA, qB] = await Promise.all([
    once(A.socket, "arena:question"),
    once(B.socket, "arena:question"),
  ]);
  check(
    "next round broadcast to everyone in sync",
    qA.round === snapA.round + 1 && qB.round === qA.round && qA.endsAt === qB.endsAt
  );
  const ansB = await call(B.socket, "arena:answer", {
    round: qB.round,
    selectedOption: 0,
  });
  check("waiting user can answer once let in", ansB.ok === true);

  // --- Alice's connection drops and she reconnects: lands exactly in place
  A.socket.close();
  await sleep(1000);
  const A2 = await connect("Alice", A.userId);
  const snapA2 = await call(A2.socket, "arena:join", { arenaGroupId: arenaId });
  const landed =
    snapA2.ok &&
    !snapA2.waiting &&
    snapA2.round === qA.round &&
    (snapA2.phase === "question" ? !!snapA2.question : !!snapA2.result);
  check(
    "reconnect lands exactly where the game is",
    landed,
    `phase ${snapA2.phase}, round ${snapA2.round}, remaining ${snapA2.remainingMs}ms`
  );

  A2.socket.close();
  B.socket.close();
  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error("E2E error:", e.message);
  process.exit(1);
});
