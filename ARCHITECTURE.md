# Architecture — how the Arena works, end to end

This document walks through every flow in the system from each user's
perspective: joining, answering, results, reconnects, crashes, and how
multiple servers cooperate. File references: the phase machine is
[src/services/gameEngine.js](src/services/gameEngine.js), all Redis access is
[src/services/liveStore.js](src/services/liveStore.js), the socket layer is
[src/sockets/arenaSocket.js](src/sockets/arenaSocket.js), and every timing
rule is a constant in [src/config/gameConstants.js](src/config/gameConstants.js).

---

## 1. The big picture

```
 Browser tabs / terminal players
        │  WebSocket (Socket.IO) — events + ack callbacks
        ▼
 ┌──────────────────────────────────────────────┐
 │ Node server                                  │
 │  arenaSocket.js   join/answer/sync/leave     │
 │  gameEngine.js    question→result→question   │
 │       │ loop, one timer per arena            │
 └───────┼──────────────────────────────────────┘
         │
         ▼
   REDIS (the live database)            MONGO (durable reference data)
   arena:{id}:game      game state      arena_groups   arena definitions
   arena:{id}:r{N}:answers  answers     question       question bank
   arena:{id}:online    counter         auth_users     accounts
```

One principle drives everything: **the game is data, not process.** A game is
a small JSON blob in Redis. Servers don't "own" games — they read the blob,
set an alarm for its next boundary, and race to advance it. That's why a
server can die and nothing is lost, and why several servers can run the same
game.

## 2. Where every piece of state lives

| State | Where | Why there |
|---|---|---|
| Game: `status, phase, round, questionId, phaseStartedAt, phaseEndsAt, lastQuestionId` | Redis `arena:{id}:game` | changes every few seconds; must survive server death; CAS-able |
| Current round's answers | Redis hash `arena:{id}:r{N}:answers` (field per userId) | one write per player per round — the hot path; ephemeral (30-min TTL), never persisted to Mongo |
| Online counter (humans) | Redis `arena:{id}:online` | shared across servers, drives idle-out |
| Bot crowd size | Redis `arena:{id}:bots` | display only — added to every shown online count, never to idle-out; drifts 10–100 (botService.js) |
| Question bank, arenas, users | Mongo | durable reference data, rarely changes |
| Current question doc, current game state, arena group | **in-process caches** | valid by construction (state can't change between boundaries), so answering needs zero DB reads |

Timestamps are stored as absolute epoch-ms. No server ever stores "seconds
remaining" — only "ends at instant T". Answers live only in Redis for the
current round; once the next round starts the old hash is dropped (and a
30-minute TTL reaps it if a server died mid-round).

## 3. The clock: how everyone stays in sync

Every server→client payload carries `serverTime`. The client computes
`offset = serverTime - Date.now()` once per message and renders every
countdown as `endsAt - (Date.now() + offset)`. Consequences:

- A laggy client doesn't drift — it received `endsAt`, not a duration.
- All clients hit 0 at the same real-world instant (verified: byte-identical
  `endsAt` across 2,000 clients).
- A late server tick doesn't shift the schedule: when the question→result
  transition runs late, the result phase is anchored to the question's
  *scheduled* end (`resultStart = phaseEndsAt`), so the result still ends at
  its original instant. Latency is absorbed, never accumulated.

Timers per difficulty: easy **30s**, medium **60s**, hard **90s**; result
fixed **15s**; answers accepted up to **1s** past the boundary (network
grace); `TIMER_SCALE` multiplies all of these for tests.

## 4. Flow: the very first user joins an empty arena

1. Client connects. `authMiddleware` resolves the player: a known `userId` is
   looked up; otherwise a guest account is created. The server emits
   `session {userId, name}` — the client stores the id (sessionStorage) and
   sets it on `socket.auth` so reconnects keep the identity.
2. Client emits `arena:join {arenaGroupId}` with an ack callback.
3. The handler validates the arena (exists, status 1), joins the Socket.IO
   room `arena:{id}`, and increments `arena:{id}:online` (INCR).
4. `engine.ensureRunning()`:
   - `ensureGame` creates the idle game key if missing (`SET NX`).
   - The game is idle → `startRound`:
     - `pickQuestion` — picks a question matching the arena's filter
       (subject/chapter/difficulty/type).
     - Builds the next state: `status running, phase question, round+1,
       phaseEndsAt = now + duration(difficulty)`.
     - **CAS**: a Lua script atomically checks the stored state is still
       `(idle, -, round)` and swaps in the new state. If two users joined the
       same instant, exactly one CAS wins; the loser just reads the state the
       winner wrote.
   - Caches the question in memory, schedules a `setTimeout` for
     `phaseEndsAt`, broadcasts `arena:question` to the room.
5. The join ack returns a **snapshot** (see §9) — for this user:
   `phase question, round 1`, the sanitized question, and `remainingMs`. They
   play immediately, per the spec.

Race detail: two users who "simultaneously" start an empty arena both race the
idle→running CAS — exactly one wins, the loser reads the winner's `round 1`
state from the snapshot, and both play round 1.

## 5. Flow: a user joins while a game is running

1. Steps 1–3 as above. `ensureRunning` finds the game already running —
   nothing to start.
2. There is **no waiting phase**. The join ack returns the live snapshot
   (§9), which drops the user straight onto the current phase:
   - **mid-question** → the sanitized question and the synced timer; they can
     answer it right away.
   - **mid-result** → the same personalized result everyone else is seeing
     (graph included if they happened to have answered correctly — though a
     fresh joiner won't have an answer for this round).
3. Nothing per-user is persisted on join beyond the online-count increment —
   the snapshot is a pure read of the shared game state, so any server can
   serve it and every joiner sees exactly the same live phase.

## 6. Flow: answering a question

Client emits `arena:answer {round, selectedOption}`; the server runs this
validation chain (each failure returns a typed code in the ack):

| Check | Failure code |
|---|---|
| socket has joined an arena | `NOT_IN_ARENA` |
| option is an integer 0–3 | `BAD_OPTION` |
| game running and in question phase (from the **in-memory cache** — valid until the boundary) | `NOT_ACCEPTING` |
| answer is for the current round | `WRONG_ROUND` |
| within `phaseEndsAt + 1s` grace | `TOO_LATE` |

Then it builds the answer record — `timeTakenMs = now - phaseStartedAt`
(clamped to the question duration), `correct` computed against the cached
question — and stores it with **one Redis `HSETNX`**: set-if-not-exists on
the user's field in the round's hash. Redis is single-threaded, so this is an
atomic first-write-wins: double-clicks, two tabs, or two racing sockets get
exactly one accepted answer and one `ALREADY_ANSWERED`.

The ack returns `{locked, timeTakenMs}` — **never correctness**. Nobody can
peek at the result before everyone else. The total cost per answer: zero
database round-trips (two cache hits) + one Redis op (~0.1ms). That's why
answer acks stayed ~2ms with 2,000 concurrent players.

Answers are **Redis-only** — there is no Mongo write on the answer path. If
Redis is unhealthy the game isn't really running, so the answer is rejected
(`NOT_ACCEPTING`) rather than silently dropped.

## 7. Flow: question ends → the RESULT screen

At `phaseEndsAt` the server's timer fires (`tick`):

1. Re-read the game from Redis (another server may have advanced it).
2. **CAS** `(running, question, N) → (running, result, N)` with the result
   phase anchored to the scheduled question end, `phaseEndsAt += 15s`.
3. Every server (CAS winner or loser) now broadcasts to *its own* sockets —
   no Mongo work is involved, so a slow Mongo can never delay a phase change.
   `computeResults` reads the round's answers from Redis, sorts the correct
   ones by `timeTakenMs`, and builds:
   - the shared part: question + `correctOption` + `explanation` + timers,
   - the ranking: top-**50** fastest correct answers (capping this keeps the
     fan-out O(players) instead of O(players²)).
4. Each connected socket gets a **personalized** `arena:result`:

| Your situation | `outcome` | `graph` | extra |
|---|---|---|---|
| answered correctly | `correct` | top-50 ranking, your row included (appended with your `yourRank` if you placed below 50) | `yourAnswer`, `yourRank` |
| answered wrong | `wrong` | `null` | `yourAnswer` shows what you picked vs `correctOption` |
| didn't answer | `not_attempted` | `null` | — |

All three cases show the correct answer and the explanation — the only
difference is the graph, exactly per spec. The round's answer hash stays in
Redis through the result phase (and is recomputed on reconnect — a pure read)
until the next round drops it.

## 8. Flow: result ends → next question (or idle)

At the result's `phaseEndsAt`, `tick` runs again:

- Read `arena:{id}:online`. **If 0** → CAS to `idle` and put a TTL on the idle
  game key (`IDLE_GAME_TTL_MS`, 10 min) so an abandoned arena's state ages out
  of Redis instead of lingering forever. The loop stops; the next joiner
  starts it again instantly — a rejoin within the window resumes the same
  game (round continuity, the next phase `SET` clears the TTL), after it a
  fresh game starts from round 0. The `bots` key is independent and untouched.
- **Else** → `startRound` again: pick the next question, CAS
  `(running, result, N) → (running, question, N+1)`, broadcast
  `arena:question`, schedule the next tick, and delete round N's Redis answer
  hash.

Everyone connected to the room receives the new `arena:question` broadcast and
starts the next round together — there is no separate set of "waiting" users
to let in.

## 9. Flow: disconnect and reconnect ("return exactly where the game is")

The snapshot is the heart of this. `arena:join`'s ack always returns:

```
{ serverTime, status, phase, round, phaseEndsAt, remainingMs,
  question | null, result | null, yourAnswer | null }
```

A client that reconnects (any reason: network blip, page reload, server
swap) just re-emits `arena:join` and renders the snapshot:

- **mid-question, had answered** → question screen, options locked on their
  pick (`yourAnswer`, read back from the round's Redis hash), timer at the
  true remaining time.
- **mid-question, hadn't answered** → question screen, can still answer (the
  answer hash is keyed by userId, so identity — not the socket — is what
  matters).
- **mid-result** → the same personalized result everyone else is looking at,
  graph included if they were correct (recomputed — a pure read).

Because there is no per-user seat, a reconnect is just another `arena:join`:
identity comes from the persisted `userId`, and the snapshot puts the player
on whatever phase is live now. A deliberate `arena:leave` (or switching
arenas) only leaves the room and decrements the online count; coming back is
the same fresh join onto the live phase.

Client-side requirement: after the `session` event, set the assigned
`userId` on `socket.auth` — Socket.IO re-sends the handshake auth on
auto-reconnects, and without this the player would reconnect as a new guest
(this exact bug was caught by the crash test and is fixed in both bundled
clients).

## 10. Flow: a server dies

Nothing about a game lives in the process — state is in Redis, timers are
absolute. On boot the server runs `recoverRunningGames()`:

1. `SCAN` Redis for `arena:*:game` keys; for every game with
   `status running`:
2. mark the current phase as already announced (reconnecting sockets get
   their state from the join snapshot, not a re-broadcast), cache it, and
   re-arm the `setTimeout` at its stored `phaseEndsAt` — if that instant has
   already passed, the tick runs immediately and the CAS chain catches the
   game up phase by phase.

Clients auto-reconnect and re-join (§9). Verified by `npm run test:crash`:
SIGKILL mid-question → restart → same round, same phase, **0ms drift**, the
pre-crash answer still locked (it was in Redis), loop continues unaided.

If **Redis** itself dies, the game pauses (joins and answers fail) until it's
back; state survives per Redis persistence (RDB snapshots by default, AOF ≈1s
window).

## 11. Concurrency: every race and its guard

| Race | Guard | Proven by |
|---|---|---|
| Two servers advancing the same boundary | Lua CAS on `(status, phase, round)` — exactly one winner | concurrency test: 2 live instances, rounds advance strictly +1 |
| Two users starting an empty arena | same CAS (idle→running) — one winner, the loser reads the winner's round-1 state | 20 simultaneous joins → one game start |
| One user, two simultaneous answers | Redis `HSETNX` (atomic, single-threaded) | two-socket race → exactly 1 accepted |
| Result broadcast duplicated per server | per-server `lastAnnounced` (round:phase) — each server emits once, only to its own sockets | no double-announce check |
| Online counter drift on churn | single INCR/DECR key, floor at 0 | 30 join/leave churners → exact baseline |
| Stale in-memory game cache | cache only trusted while `now ≤ phaseEndsAt + grace`; re-read past the boundary | by construction |
| Two servers simulating the same bot round | bot answers are written only by the round's CAS winner (`onQuestionStarted` hook); `HSETNX` means a bot can never displace a human answer | bot test + concurrency test together |

## 12. Scaling model

- **One process** handles 2,000+ players per arena (measured); the ceiling is
  Socket.IO connections (~10k/process), not the engine — per-answer work is
  one Redis op, per-round work is one CAS + a local broadcast.
- **Multiple processes** need no engine changes (proven live): each server
  ticks every arena, CAS picks the winner, each broadcasts to its own
  sockets. Add `@socket.io/redis-adapter` for cross-server room emits
  (`arena:online` counts), set `RESET_ONLINE_COUNTS=false`, sticky sessions
  on the load balancer.
- **Redis Cluster** when one Redis is the limit: keys already carry
  `{arenaId}` hash tags, so each arena's keys co-locate on one shard.
