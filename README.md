# Arena Server — Live Quiz Arena

A real-time multiplayer quiz server. Many users join the same arena and play
in lock-step: everyone sees the **same question at the same moment**, answers
within a synced timer, then everyone sees the **same result screen** — in an
endless loop. Built per the spec in [Arena_feature.md](Arena_feature.md).

**Stack:** Node.js · Express · Socket.IO · **Redis** (live game state) ·
**MongoDB** (durable data) — plus a browser client and an interactive
terminal client for manual play.

---

## Contents

1. [Quick start](#quick-start)
2. [Playing / demo](#playing--demo)
3. [Requirements coverage](#requirements-coverage)
4. [Architecture](#architecture)
5. [Project structure](#project-structure)
6. [Socket protocol](#socket-protocol)
7. [REST API](#rest-api)
8. [Configuration](#configuration)
9. [Tests & verified results](#tests--verified-results)
10. [Scaling](#scaling)
11. [Known limitations / production checklist](#known-limitations--production-checklist)

---

## Quick start

Prerequisites: Node ≥ 18, MongoDB and Redis (both required — Redis holds the
live game state). With Docker:

```bash
docker run -d -p 27017:27017 mongo
docker run -d -p 6379:6379 redis redis-server --appendonly yes
```

Then:

```bash
npm install
cp .env.example .env        # defaults point at localhost Mongo/Redis
npm run seed                # demo arena + 12 algebra questions
npm start                   # http://localhost:3000
```

For development: `npm run dev` (auto-restart) or `npm run start:test`
(all game timers shrunk 5× — required by the test suite, handy for demos).

## Playing / demo

- **Browser:** open http://localhost:3000 in two or more tabs — each tab is
  an independent player. Connect with a name, pick *Math Arena (demo)*.
- **Terminal:** one player per terminal (answer with keys 1-4, quit with q):

  ```bash
  npm run play -- Alice      # terminal 1
  npm run play -- Bob        # terminal 2
  npm run play -- Charlie    # terminal 3
  ```

  Mix freely — terminals and browser tabs all play in the same round.

Things to watch: the first joiner starts the game instantly; someone joining
mid-question sits on a waiting screen and enters at the next question;
everyone's timer hits zero at the same moment; after a question, correct
answerers see a speed-ranked graph (fastest first) — wrong/not-attempted see
the correct answer and explanation but no graph. Kill the server mid-round
and restart it: the game resumes at the exact same spot.

## Requirements coverage

Every rule in [Arena_feature.md](Arena_feature.md), where it lives, and how
it is verified (test names refer to [Tests](#tests--verified-results)):

| Requirement | Implementation | Verified by |
|---|---|---|
| Same question/result at the same time for everyone | absolute timestamps + room broadcast, [gameEngine.js](src/services/gameEngine.js) | e2e, load (byte-identical `endsAt` across 2,000 clients) |
| Empty arena → joiner starts immediately | `ensureRunning` CAS idle→running | e2e, concurrency |
| Join during a game → wait until next question | `resolveEligibility`, [arenaSocket.js](src/sockets/arenaSocket.js) | e2e, load (50-joiner wave) |
| Question timer: easy 30s / medium 60s / hard 90s | [gameConstants.js](src/config/gameConstants.js) | e2e |
| Result timer: fixed 15s | [gameConstants.js](src/config/gameConstants.js) | e2e |
| Waiting timer = question + result remaining | `buildSnapshot` (`waitMs`) | load |
| One answer out of 4, locked | Redis `HSETNX` (atomic first-write-wins) | e2e, concurrency (two-socket race) |
| Result always shows correct answer + explanation | `computeResults` | e2e, load |
| Graph (speed-ranked) only for correct answers | `personalizeResult` | e2e, load |
| Reconnect → return exactly where the game is | join-ack snapshot + Redis presence | e2e, crash |
| Server crash → games not lost | state in Redis, `recoverRunningGames()` | crash (SIGKILL mid-round) |
| Many servers later without a rewrite | atomic CAS transitions, per-server broadcast | concurrency (2 live instances) |

## Architecture

> **Deep dive:** [ARCHITECTURE.md](ARCHITECTURE.md) walks through every flow
> step by step — first joiner, waiting, answering, results, reconnects,
> crashes, every race condition and its guard.

```
                   ┌─────────────────────────────┐
  browser/CLI ◄────►  Node server (Socket.IO)    │
   clients          │  ┌───────────────────────┐ │
                    │  │ gameEngine            │ │     question pick,
                    │  │ question→result loop  │─┼──► users, arenas,
                    │  └─────────┬─────────────┘ │     answer history
                    └────────────┼───────────────┘        (MongoDB)
                                 ▼
                    Redis — THE live database:
                    game state (Lua CAS) · live answers (HSETNX)
                    presence/eligibility · online counts
```

**Redis runs the live game; Mongo keeps history.** The game document
(status/phase/round/timers), the current round's answers, presence, and
online counts live in Redis ([liveStore.js](src/services/liveStore.js)).
Mongo holds questions, arenas, users, and finished rounds' answers
(batch-flushed once per round, fire-and-forget). A phase boundary performs
**zero Mongo work on its critical path** — a slow Mongo can never delay or
desync the loop.

**Timers are absolute timestamps, never countdowns.** Each phase stores its
`phaseEndsAt`; servers schedule a wake-up for that instant and clients count
down to it (every payload carries `serverTime` for clock sync). A transition
anchors the next phase to the *scheduled* boundary, so latency is absorbed
once, never accumulated.

**Phase transitions are atomic compare-and-swaps.** A Lua script compares the
expected `(status, phase, round)` and swaps in the next state in one atomic
step. N servers can race every boundary: exactly one wins, the rest re-read
the state and still broadcast to their own sockets. Result computation is a
pure read, safe to repeat anywhere.

**Crash recovery.** Game state lives outside the process; on boot
`recoverRunningGames()` scans Redis and re-schedules each running game at its
stored boundary. A *Redis* restart relies on Redis persistence (RDB default;
`--appendonly yes` recommended, ~1s loss window).

**Per-answer hot path:** cached game state (valid until the phase boundary by
construction) + cached question + one Redis `HSETNX` — no DB round-trips. If
Redis is briefly down, answers fall back to direct Mongo writes (the unique
index dedupes); the game loop itself requires Redis.

**The "waiting" rule:** waiting is a property of the *user*, not the game.
Joiners get `eligibleFromRound = current round + 1` (stored in Redis
presence); the server sends them no question/result data for rounds they
didn't play. A quick reconnect inside one game cycle keeps the previous
eligibility — that's how a dropped connection resumes mid-round.

## Project structure

```
src/
  config/          env.js · db.js · gameConstants.js (ALL timing rules)
  models/          Mongo (durable): ArenaGroupModel, Question (read-only
                   view of phoenix-owned collection), AuthUser,
                   ArenaAnswerModel (round history, unique answer index)
  services/        liveStore.js   — all Redis: game CAS, answers, presence
                   gameEngine.js  — the phase machine (core of the system)
                   questionService.js — filtered random question picker
                   botService.js  — simulated players (crowd + answers)
  sockets/         arenaSocket.js — join/answer/sync/leave, auth, presence
  routes/          arenaRoutes.js — REST (arena list, live state peek)
  app.js, server.js
public/index.html  browser client (no build step)
scripts/
  seed.js          demo arena + questions (idempotent)
  play.cjs         interactive terminal player
  e2e.cjs · load.cjs · crash-test.cjs · concurrency-test.cjs
  bot-test.cjs     bot crowd, profiles, accuracy, drift   (see Tests)
```

## Socket protocol

Client → server (every event takes an ack callback; errors come back as
`{ok:false, code, message}`):

| Event | Payload | Ack |
|---|---|---|
| `arena:join` | `{arenaGroupId}` | full state snapshot (below) |
| `arena:answer` | `{round, selectedOption: 0-3}` | `{ok, locked, timeTakenMs}` — correctness is **not** revealed |
| `arena:sync` | `{}` | fresh snapshot (manual resync) |
| `arena:leave` | `{}` | `{ok}` |

Server → client:

| Event | When | Payload highlights |
|---|---|---|
| `session` | on connect | `{userId, name}` — client must persist userId and set it on `socket.auth` for reconnects |
| `arena:question` | each round starts | sanitized question (no answer!), `round`, `durationMs`, `endsAt`, `serverTime` |
| `arena:result` | question ends | per-user: `outcome`, `correctOption`, `explanation`, `yourAnswer`, `yourRank`, `graph` (top-50 speed ranking with `name`/`photo` per entry, **only when correct**), `nextQuestionAt` |
| `arena:online` | joins/leaves, bot drift | `{count, humans, bots}` — `count` includes the bot crowd |

The join/sync **snapshot** tells a client exactly where the game is:
`{status, phase, round, phaseEndsAt, remainingMs, waiting, waitMs, question?,
result?, yourAnswer?, serverTime}`. Reconnection = re-emit `arena:join`,
render the snapshot. Waiting users receive no question/result content.

## REST API

- `GET /health` — liveness + server time
- `GET /api/arena-groups` — active arenas (status 1)
- `GET /api/arena-groups/:id/state` — live peek: `{status, phase, round, phaseEndsAt, online, humans, bots}`

## Configuration

`.env` (see [.env.example](.env.example)):

| Var | Default | Meaning |
|---|---|---|
| `PORT` | 3000 | HTTP + WebSocket port |
| `MONGODB_URI` | `mongodb://127.0.0.1:27017/arena` | durable store |
| `REDIS_URL` | `redis://127.0.0.1:6379` | live store (required) |
| `RESET_ONLINE_COUNTS` | `true` | zero online counters on boot — **single-server only**; set `false` when running multiple instances |
| `BOTS_ENABLED` | `true` | simulated players in every arena (see Bots below) |
| `TIMER_SCALE` | 1 | multiplies all game timers (0.2 = 5× faster; tests/dev only) |

Game rules (question 30/60/90s by difficulty, result 15s, answer grace 1s,
rejoin grace, graph cap 50) are all constants in
[src/config/gameConstants.js](src/config/gameConstants.js).

## Bots

Every active arena holds a crowd of **10–100 simulated players**
([src/services/botService.js](src/services/botService.js)) that drifts a few
bots up/down every 10s ("coming in or leaving at any time"). Each bot is a
real `auth_user` document (`isBot: true`, googleId `arena-bot-*`) with a
name and avatar photo, so bot entries on the result graph are
indistinguishable from human ones. Each round, every bot in the arena
answers: correctness is rolled against a per-round accuracy drawn from a
difficulty band — easy **80–100%** right, medium 60–90%, hard 40–75% — and
the "answer time" is randomized inside the question timer
(`BOT_*` constants in gameConstants.js).

Mechanically, bots are only a count in Redis (`arena:{id}:bots`) plus
entries in the round's answer hash, written in one pipeline by the server
that wins the round's CAS — exactly once per round, no sockets, no presence.
Displayed online counts (`arena:online`, lobby `online_user_count`,
`/state`) include bots; the engine's idle check reads the **human-only**
counter, so an arena with only bots still goes idle and bots never keep a
game running for nobody.

## Tests & verified results

Start the server with fast timers in one terminal, run tests in another:

```bash
npm run start:test          # server with TIMER_SCALE=0.2 (required by tests)

npm test                    # e2e   — full game flow over real sockets
npm run test:ui             # Playwright — real Chromium pages playing the UI
npm run test:ui:headed      # same, with VISIBLE browser windows (watch it!)
npm run test:load -- 1000   # load  — N concurrent players in one arena
npm run test:crash          # crash — SIGKILLs + restarts the server mid-round
npm run test:concurrency    # races — double-start, double-answer, 2 servers
npm run test:bots           # bots  — crowd size, profiles, accuracy, drift
```

The Playwright suite (`tests/`) covers four specs — `arena` (two-player flow
+ reload), `concurrency` (5 synced players; same user racing answers from
two tabs → exactly one accepted), `crash` (server SIGKILLed mid-question
while a browser player has an answer locked — the page auto-reconnects in
place, answer intact), and `load` (8 browsers in lock-step through a full
round). Watch any of them live:
`npx playwright test crash --headed` · or step through with
`npx playwright test --ui`.

The suite uses real Socket.IO connections against the running server (no
mocks). All results below were produced on a single laptop running the
server, both databases, and every simulated client — i.e. conservative.

**e2e (9 checks):** immediate start for first joiner · answer lock +
duplicate rejection · mid-game joiner waits, then enters at next question ·
result with explanation, graph only when correct · identical round broadcast
· reconnect snapshot lands exactly in place.

**ui (Playwright, real Chromium):** two browser players through a full round
— question renders, picked option locks and disables, a mid-question joiner
sees the waiting screen with a live countdown and no question/result content,
the result screen shows outcome + explanation with the graph only when
correct ("you" highlighted), and both land on the same next round where the
former waiter answers. Plus: a full page reload mid-game keeps the player's
identity (sessionStorage) and lands them back in place — never on the
waiting screen.

**load** (also asserts the waiting flow under load — a 50-joiner wave
mid-question all land in `waiting` with correct `waitMs`, leak no question or
result data, and all enter+answer the next round):

| players | join ack p95 | answer ack p95 | result delivery spread | after scheduled end |
|---|---|---|---|---|
| 300 | 40ms | 3ms | 6ms | 33ms |
| 1,000 | 86ms | 2ms | 12ms | 67ms |
| 2,000 | 263ms | 2ms | 26ms | 93ms |

Answer acks are flat (~2ms) at every size — the Redis hot path. All answers
accepted, every client byte-identical `round`/`endsAt`, result graph capped
at 51 entries with per-user rank intact.

**crash:** two live players, one answered → `SIGKILL` mid-question → restart
→ same round, same phase, **0ms timer drift**, the answer still locked (from
Redis), seats kept, loop continued unaided.

**concurrency (9 checks):** 20 simultaneous joins to an empty arena start the
game **exactly once**, everyone seated · the same user racing answers from
two sockets gets exactly one accepted · **two real server instances** sharing
Redis/Mongo ran one game with identical rounds/`endsAt` on both servers'
clients, rounds advancing strictly by 1 (every CAS won exactly once), no
double-announces · online counter returns exactly to baseline after 30
join/leave churners.

## Scaling

Measured headroom on one instance: arenas of **2,000+ concurrent players**;
the per-instance ceiling is Socket.IO connection count (~10k per Node
process), not the game engine. The former O(players²) result fan-out is
already fixed via the top-50 graph cap.

To go multi-server (the engine already tolerates it — proven in the
concurrency test): add the `@socket.io/redis-adapter` (~5 lines in
server.js, fixes cross-server `arena:online` broadcasts), set
`RESET_ONLINE_COUNTS=false`, put instances behind a sticky-session load
balancer. No game-logic changes. Redis keys already use `{arenaId}` hash
tags, so Redis Cluster sharding by arena works when a single Redis becomes
the limit (far beyond 10k players).

## Known limitations / production checklist

Tracked in detail in [PROGRESS.md](PROGRESS.md):

- [ ] **Auth (blocking):** the socket handshake trusts `{userId, name}` and
      creates guest accounts for unknown users — dev-only. Replace
      `authMiddleware` in [arenaSocket.js](src/sockets/arenaSocket.js) with
      signed-token (e.g. Google JWT) verification; add rate limiting on
      connect/join.
- [ ] **Redis persistence:** run with `--appendonly yes` or a Redis crash can
      lose the in-flight round (game history in Mongo is unaffected).
- [x] **Question schema:** reconciled against the real
      `staging_QuestionBank` collection and verified with a live round
      (0-indexed `answer`, `optionsText`/`optionsImg`, `solutionText`).
      `IMAGE_BASE_URL` points at the stage S3 bucket; image paths resolve
      (verified 200). Use the production bucket URL when deploying.
- [ ] Online count counts connections (two tabs = 2), and its display
      updates are per-server until the Redis adapter is added.
- [ ] Answers landing in the ~1s grace window after a round closes may be
      acked but miss that round's result — bounded, standard for synced
      quizzes.
- [ ] CORS is `*` and clients are unthrottled — tighten for production.
