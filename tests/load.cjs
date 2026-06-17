/**
 * Load test: N real socket clients join one arena, answer, and receive the
 * result — plus a late-joiner wave that lands directly on the live question
 * mid-round (no waiting phase) and answers it too. Measures ack latencies and
 * fan-out spread.
 * Run the server with TIMER_SCALE=0.2 first, then:
 *   node tests/load.cjs [N=300]
 * (All clients share this one Node process, so the numbers are conservative —
 * the test client itself becomes a bottleneck before the server does.)
 */
const { io } = require("../node_modules/socket.io/client-dist/socket.io.js");

const BASE = "http://localhost:3000";
const N = Number(process.argv[2] || 300);
const LATE = Math.max(50, Math.floor(N / 10));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const call = (s, ev, p) => new Promise((res) => s.emit(ev, p, res));
const once = (s, ev, timeoutMs = 90000) =>
  new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`timeout ${ev}`)), timeoutMs);
    s.once(ev, (p) => (clearTimeout(t), res(p)));
  });
const pct = (arr, p) =>
  [...arr].sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor((p / 100) * arr.length))];
const stats = (arr) =>
  `p50 ${pct(arr, 50)}ms · p95 ${pct(arr, 95)}ms · max ${Math.max(...arr)}ms`;

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
};

async function spawnClients(count, namePrefix, arenaId, latencies) {
  const out = [];
  for (let i = 0; i < count; i += 50) {
    await Promise.all(
      Array.from({ length: Math.min(50, count - i) }, async (_, j) => {
        const s = io(BASE, {
          transports: ["websocket"],
          forceNew: true,
          auth: { name: `${namePrefix}${i + j}` },
        });
        await once(s, "session", 15000);
        const t = Date.now();
        const snap = await call(s, "arena:join", { arenaGroupId: arenaId });
        if (!snap.ok) throw new Error("join failed: " + snap.message);
        latencies?.push(Date.now() - t);
        out.push({ s, snap });
      })
    );
  }
  return out;
}

(async () => {
  const arenaId = (await fetch(`${BASE}/api/arena-groups`).then((r) => r.json()))
    .data[0]._id;
  console.log(`spawning ${N} clients (+${LATE} late joiners) against arena ${arenaId}…\n`);

  // --- main cohort joins
  const joinLat = [];
  const t0 = Date.now();
  const main = await spawnClients(N, "Load", arenaId, joinLat);
  const clients = main.map((c) => c.s);
  console.log(`all joined in ${Date.now() - t0}ms · join ack ${stats(joinLat)}`);

  // Wait for the next question so every client is eligible for the same round.
  const questions = await Promise.all(clients.map((s) => once(s, "arena:question")));
  const round = questions[0].round;
  check(
    `question broadcast to all ${N}: identical round+endsAt`,
    questions.every((q) => q.round === round && q.endsAt === questions[0].endsAt),
    `round ${round}`
  );

  // --- LATE WAVE under load: a wave joins mid-question and lands directly
  // on the live question — no waiting phase --------------------------------
  await sleep(2500);
  const late = await spawnClients(LATE, "Late", arenaId);
  check(
    `${LATE} late joiners land directly on the live question (round ${round})`,
    late.every(
      (c) =>
        c.snap.phase === "question" &&
        c.snap.question &&
        c.snap.round === round &&
        !c.snap.waiting
    )
  );

  // --- everyone in the round (main + late) answers at a random moment ----
  const answerers = [...clients, ...late.map((c) => c.s)];
  const TOTAL = answerers.length;
  const dur = questions[0].durationMs;
  const ansLat = [];
  let accepted = 0;
  await Promise.all(
    answerers.map(async (s, i) => {
      await sleep(Math.random() * (dur - (Date.now() - (questions[0].endsAt - dur))) * 0.6);
      const t = Date.now();
      const r = await call(s, "arena:answer", { round, selectedOption: i % 4 });
      ansLat.push(Date.now() - t);
      if (r.ok) accepted++;
    })
  );
  console.log(`answers: ${accepted}/${TOTAL} accepted · ack ${stats(ansLat)}`);

  // --- result fan-out (main + late all played this round) ----------------
  const recv = await Promise.all(
    answerers.map((s) => once(s, "arena:result").then((p) => ({ at: Date.now(), p })))
  );
  const times = recv.map((r) => r.at);
  const spread = Math.max(...times) - Math.min(...times);
  const lateness = Math.max(...times) - questions[0].endsAt;
  const maxGraph = Math.max(...recv.map((r) => r.p.graph?.length ?? 0));
  const correctCount = recv.filter((r) => r.p.outcome === "correct").length;
  const rankOk = recv
    .filter((r) => r.p.outcome === "correct")
    .every((r) => Number.isInteger(r.p.yourRank));
  console.log(
    `result round ${recv[0].p.round}: all ${TOTAL} · spread ${spread}ms · ${lateness}ms after scheduled end`
  );
  check(
    `graph capped (≤51) with per-user rank — ${correctCount} correct answerers`,
    maxGraph <= 51 && rankOk,
    `biggest graph ${maxGraph}`
  );

  // --- the next round reaches the whole crowd in sync --------------------
  const nextQs = await Promise.all(
    answerers.map((s) => once(s, "arena:question"))
  );
  check(
    `next round reaches all ${TOTAL} (main + late) with identical endsAt`,
    nextQs.every((q) => q.round === round + 1 && q.endsAt === nextQs[0].endsAt)
  );
  let nextAccepted = 0;
  await Promise.all(
    answerers.map(async (s, i) => {
      const r = await call(s, "arena:answer", { round: round + 1, selectedOption: i % 4 });
      if (r.ok) nextAccepted++;
    })
  );
  check(
    `all ${TOTAL} can answer the new round`,
    nextAccepted === TOTAL,
    `${nextAccepted}/${TOTAL}`
  );

  clients.forEach((s) => s.close());
  late.forEach((c) => c.s.close());
  const ok = failures === 0 && accepted === TOTAL && spread < 2000;
  console.log(ok ? "\nLOAD TEST PASS" : "\nLOAD TEST FAIL");
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error("load test error:", e.message);
  process.exit(1);
});
