/**
 * Interactive terminal player — one arena player per terminal.
 *   node scripts/play.cjs [name]     (or: npm run play -- Alice)
 * Keys: 1-4 answer · q quit
 */
const { io } = require("../node_modules/socket.io/client-dist/socket.io.js");

const BASE = process.env.ARENA_URL || "http://localhost:3000";
const NAME = process.argv[2] || `Player${Math.floor(Math.random() * 1000)}`;

const C = {
  reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m",
  green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m", cyan: "\x1b[36m",
};
let view = { mode: "connecting" }; // connecting|idle|question|result
let me = { userId: null, name: NAME };
let arenaId = null;
let offset = 0; // serverTime - local
const now = () => Date.now() + offset;

function render() {
  const out = ["\x1b[2J\x1b[H"]; // clear + home
  out.push(`${C.bold}${C.cyan}ARENA${C.reset} — ${me.name}  ${C.dim}(${view.online ?? "?"} online · q to quit)${C.reset}\n`);
  const left = view.endsAt ? Math.max(0, view.endsAt - now()) / 1000 : null;
  const timer = left !== null ? `${C.bold}${left.toFixed(1)}s${C.reset}` : "";

  if (view.mode === "connecting") out.push("connecting…");
  if (view.mode === "idle") out.push("arena is quiet — waiting for the game to start");
  const optText = (o) =>
    o && typeof o === "object" ? (o.text ?? (o.image ? "[image option]" : "?")) : o;
  if (view.mode === "question") {
    out.push(`${C.bold}Question #${view.round}${C.reset} ${C.dim}(${["", "easy", "medium", "hard"][view.q.difficulty] || "?"})${C.reset}   ⏱ ${timer}\n`);
    out.push(`  ${view.q.text}\n`);
    if (view.q.images?.length) out.push(`  ${C.dim}[${view.q.images.length} image(s) — see web client]${C.reset}`);
    view.q.options.forEach((o, i) => {
      const mark = view.picked === i ? `${C.cyan}▶${C.reset}` : " ";
      out.push(` ${mark} ${C.bold}${i + 1}.${C.reset} ${optText(o)}`);
    });
    out.push(view.picked != null ? `\n${C.dim}answer locked — waiting for results${C.reset}` : `\n${C.dim}press 1-4 to answer${C.reset}`);
  }
  if (view.mode === "result") {
    const r = view.r;
    const head = { correct: `${C.green}✅ CORRECT${C.reset}`, wrong: `${C.red}❌ WRONG${C.reset}`, not_attempted: `${C.yellow}⏰ NOT ATTEMPTED${C.reset}` }[r.outcome];
    out.push(`${head}   next question in ${timer}\n`);
    out.push(`  ${r.question.text}\n`);
    r.question.options.forEach((o, i) => {
      const tag = i === r.correctOption ? `${C.green}✓${C.reset}` : i === r.yourAnswer?.selectedOption ? `${C.red}✗${C.reset}` : " ";
      out.push(`  ${tag} ${i + 1}. ${optText(o)}`);
    });
    out.push(`\n${C.dim}Explanation:${C.reset} ${r.explanation || "—"}`);
    if (r.graph) {
      out.push(`\n${C.bold}Speed ranking${C.reset} ${C.dim}(your rank: #${r.yourRank})${C.reset}`);
      const max = Math.max(...r.graph.map((g) => g.timeTakenMs), 1);
      for (const g of r.graph.slice(0, 10)) {
        const bar = "█".repeat(Math.max(1, Math.round(20 * (1 - g.timeTakenMs / max / 1.4))));
        const you = g.userId === me.userId;
        out.push(`  #${String(g.rank).padEnd(3)} ${(you ? C.green : C.cyan) + bar + C.reset} ${g.name}${you ? " (you)" : ""} ${C.dim}${(g.timeTakenMs / 1000).toFixed(1)}s${C.reset}`);
      }
    }
  }
  process.stdout.write(out.join("\n") + "\n");
}
setInterval(render, 200);

const socket = io(BASE, { transports: ["websocket"], auth: { name: NAME } });

socket.on("session", (s) => {
  me = s;
  socket.auth = { ...socket.auth, userId: s.userId }; // keep identity on reconnects
  join();
});
socket.io.on("reconnect", join);

async function join() {
  if (!arenaId) {
    const res = await fetch(`${BASE}/api/arena-groups`).then((r) => r.json());
    if (!res.data.length) { console.log("no active arenas — run: npm run seed"); process.exit(1); }
    arenaId = res.data[0]._id;
  }
  socket.emit("arena:join", { arenaGroupId: arenaId }, (snap) => {
    if (!snap.ok) { console.log("join failed:", snap.message); process.exit(1); }
    offset = snap.serverTime - Date.now();
    if (snap.noQuestions) { console.log("\nThis arena has no questions matching its filter — pick another arena."); process.exit(1); }
    if (snap.status !== "running") view = { mode: "idle" };
    else if (snap.phase === "question")
      view = { mode: "question", round: snap.round, q: snap.question, endsAt: snap.phaseEndsAt, picked: snap.yourAnswer?.selectedOption ?? null };
    else if (snap.phase === "result")
      view = { mode: "result", r: snap.result, endsAt: snap.phaseEndsAt };
  });
}

socket.on("arena:question", (p) => {
  offset = p.serverTime - Date.now();
  view = { mode: "question", round: p.round, q: p.question, endsAt: p.endsAt, picked: null, online: view.online };
});
socket.on("arena:result", (p) => {
  offset = p.serverTime - Date.now();
  view = { mode: "result", r: p, endsAt: p.nextQuestionAt, online: view.online };
});
socket.on("arena:online", (p) => (view.online = p.count));
socket.on("disconnect", () => (view.mode = "connecting"));

// --- keyboard
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.on("data", (k) => {
  const c = k.toString();
  if (c === "q" || c === "\x03") { process.stdout.write("\n"); process.exit(0); }
  if (view.mode === "question" && view.picked == null && "1234".includes(c)) {
    const opt = Number(c) - 1;
    socket.emit("arena:answer", { round: view.round, selectedOption: opt }, (r) => {
      if (r.ok) view.picked = opt;
    });
  }
});
