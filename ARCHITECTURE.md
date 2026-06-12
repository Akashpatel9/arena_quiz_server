# Architecture — how the Arena works, end to end

This document walks through every flow in the system from each user's
perspective: joining, waiting, answering, results, reconnects, crashes, and
how multiple servers cooperate. File references: the phase machine is
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
   REDIS (the live database)            MONGO (durable history)
   arena:{id}:game      game state      arena_groups   arena definitions
   arena:{id}:r{N}:answers  answers     question       question bank
   arena:{id}:presence  seats           auth_users     accounts
   arena:{id}:online    counter         arena_answers  finished rounds
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
| Live round's answers | Redis hash `arena:{id}:r{N}:answers` (field per userId) | one write per player per round — the hot path |
| Seats: `eligibleFromRound, lastSeenAt` | Redis hash `arena:{id}:presence` | reconnects may land on any server |
| Online counter (humans) | Redis `arena:{id}:online` | shared across servers, drives idle-out |
| Bot crowd size | Redis `arena:{id}:bots` | display only — added to every shown online count, never to idle-out; drifts 10–100 (botService.js) |
| Question bank, arenas, users | Mongo | durable, rarely changes |
| Finished rounds' answers | Mongo `arena_answers` | history; batch-flushed once per round |
| Current question doc, current game state, arena group | **in-process caches** | valid by construction (state can't change between boundaries), so answering needs zero DB reads |

Timestamps are stored as absolute epoch-ms. No server ever stores "seconds
remaining" — only "ends at instant T".

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
     - `pickQuestion` — questions are served IN SEQUENCE (MongoDB `_id`
       order): the first question matching the arena's filter
       (subject/chapter/difficulty/type) after the stored `lastQuestionId`
       cursor, wrapping to the start when the pool is exhausted.
     - Builds the next state: `status running, phase question, round+1,
       phaseEndsAt = now + duration(difficulty)`.
     - **CAS**: a Lua script atomically checks the stored state is still
       `(idle, -, round)` and swaps in the new state. If two users joined the
       same instant, exactly one CAS wins; the loser just reads the state the
       winner wrote.
   - Caches the question in memory, schedules a `setTimeout` for
     `phaseEndsAt`, broadcasts `arena:question` to the room.
5. The join ack returns a **snapshot** (see §9) — for this user:
   `phase question, round 1, waiting false`, the sanitized question, and
   `remainingMs`. They play immediately, per the spec.

Race detail: anyone who joins within **2s** of a question starting
(`JOIN_START_WINDOW_MS`) is also seated in that round — so two people who
"simultaneously" start an empty arena both play round 1.

## 5. Flow: a user joins while a game is running (the WAITING case)

1. Steps 1–3 as above. `ensureRunning` finds the game already running —
   nothing to start.
2. `resolveEligibility` decides which round this user may play from. It takes
   the **minimum** of the applicable candidates:
   - default: `current round + 1` (wait for the next question),
   - `current round` if they started the game or arrived inside the 2s window,
   - their **previous** `eligibleFromRound` from Redis presence if this is a
     quick rejoin (last seen within `REJOIN_GRACE_MS`, one full cycle) — that
     is what makes a dropped connection resume instead of wait.
3. The seat is persisted: `presence[userId] = {eligibleFromRound, lastSeenAt}`.
4. The snapshot they get back says `waiting: true` and contains **no question
   and no result** — the server doesn't even send data they shouldn't see.
   It does contain `waitMs`:
   - joined during a question → `waitMs = remaining question + 15s result`,
   - joined during a result → `waitMs = remaining result`.
   Either way it counts down to the moment the next question appears —
   exactly the spec's waiting timer.
5. While waiting they are skipped by result broadcasts (`eligibleFromRound >
   round`). The next `arena:question` that arrives is — by construction — a
   round they're eligible for; receiving it *is* the end of the wait.

## 6. Flow: answering a question

Client emits `arena:answer {round, selectedOption}`; the server runs this
validation chain (each failure returns a typed code in the ack):

| Check | Failure code |
|---|---|
| option is an integer 0–3 | `BAD_OPTION` |
| game running and in question phase (from the **in-memory cache** — valid until the boundary) | `NOT_ACCEPTING` |
| answer is for the current round | `WRONG_ROUND` |
| user's `eligibleFromRound ≤ round` (not a waiter) | `WAITING` |
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

If Redis is briefly unreachable, the answer is written directly to Mongo
where a unique `(arena, round, user)` index provides the same dedupe.

## 7. Flow: question ends → the RESULT screen

At `phaseEndsAt` the server's timer fires (`tick`):

1. Re-read the game from Redis (another server may have advanced it).
2. **CAS** `(running, question, N) → (running, result, N)` with the result
   phase anchored to the scheduled question end, `phaseEndsAt += 15s`.
3. The CAS **winner** kicks off the answer flush — the round's Redis hash is
   batch-inserted into Mongo `arena_answers` — as **fire-and-forget**: the
   broadcast never waits on Mongo (this is why a slow Mongo cannot delay a
   phase change). The insert is idempotent; recovery re-flushes if it failed.
4. Every server (winner or loser) now broadcasts to *its own* sockets:
   `computeResults` reads the answers (Redis first, Mongo fallback), sorts
   correct ones by `timeTakenMs`, and builds:
   - the shared part: question + `correctOption` + `explanation` + timers,
   - the ranking: top-**50** fastest correct answers (capping this keeps the
     fan-out O(players) instead of O(players²)).
5. Each connected, eligible socket gets a **personalized** `arena:result`:

| Your situation | `outcome` | `graph` | extra |
|---|---|---|---|
| answered correctly | `correct` | top-50 ranking, your row included (appended with your `yourRank` if you placed below 50) | `yourAnswer`, `yourRank` |
| answered wrong | `wrong` | `null` | `yourAnswer` shows what you picked vs `correctOption` |
| didn't answer | `not_attempted` | `null` | — |
| still waiting (joined mid-round) | *(no event at all)* | — | stays on the waiting countdown |

All three visible cases show the correct answer and the explanation — the
only difference is the graph, exactly per spec.

## 8. Flow: result ends → next question (or idle)

At the result's `phaseEndsAt`, `tick` runs again:

- Read `arena:{id}:online`. **If 0** → CAS to `idle` (round number and the
  sequence cursor are kept). The loop stops; the next joiner starts it
  again instantly.
- **Else** → `startRound` again: pick the next question in the sequence
  (after `lastQuestionId`), CAS `(running, result, N) → (running, question,
  N+1)`, broadcast `arena:question`, schedule the next tick, and delete round
  N's Redis answer hash (its contents are in Mongo by now).

Waiting users became eligible the moment that CAS wrote `round N+1` — they
receive the same broadcast as everyone else and start playing.

## 9. Flow: disconnect and reconnect ("return exactly where the game is")

The snapshot is the heart of this. `arena:join`'s ack always returns:

```
{ serverTime, status, phase, round, phaseEndsAt, remainingMs,
  waiting, waitMs, question | null, result | null, yourAnswer | null }
```

A client that reconnects (any reason: network blip, page reload, server
swap) just re-emits `arena:join` and renders the snapshot:

- **mid-question, had answered** → question screen, options locked on their
  pick (`yourAnswer`), timer at the true remaining time.
- **mid-question, hadn't answered** → question screen, can answer; the
  rejoin-grace in `resolveEligibility` (§5) kept their seat, so they're not
  treated as a new waiter.
- **mid-result** → the same personalized result everyone else is looking at,
  graph included if they were correct (recomputed — a pure read).
- **away longer than one full cycle** → treated as a fresh joiner: waiting
  screen until the next question.

The grace applies only to *connection drops*. A deliberate `arena:leave` or
switching to another arena **forfeits the seat** (presence is deleted), so
hopping to arena B and back to A means joining A fresh — waiting for the
next question — even seconds later. Disconnect = keep seat; leave = lose it.

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
2. re-arm the `setTimeout` at its stored `phaseEndsAt` (if that instant has
   already passed, the tick runs immediately and the CAS chain catches the
   game up phase by phase);
3. if it died inside a result phase, re-flush that round's answers to Mongo
   (idempotent — covers a crash between the transition and the flush).

Clients auto-reconnect and re-join (§9). Verified by `npm run test:crash`:
SIGKILL mid-question → restart → same round, same phase, **0ms drift**, the
pre-crash answer still locked, loop continues unaided.

If **Redis** itself dies, the game pauses (joins fail) until it's back;
state survives per Redis persistence (RDB snapshots by default, AOF ≈1s
window). Mongo's history is unaffected either way.

## 11. Concurrency: every race and its guard

| Race | Guard | Proven by |
|---|---|---|
| Two servers advancing the same boundary | Lua CAS on `(status, phase, round)` — exactly one winner | concurrency test: 2 live instances, rounds advance strictly +1 |
| Two users starting an empty arena | same CAS (idle→running) + 2s join window seats both | 20 simultaneous joins → one game start |
| One user, two simultaneous answers | Redis `HSETNX` (atomic, single-threaded) | two-socket race → exactly 1 accepted |
| Result broadcast duplicated per server | per-server `lastAnnounced` (round:phase) — each server emits once, only to its own sockets | no double-announce check |
| Online counter drift on churn | single INCR/DECR key, floor at 0 | 30 join/leave churners → exact baseline |
| Stale in-memory game cache | cache only trusted while `now ≤ phaseEndsAt + grace`; re-read past the boundary | by construction |
| Two servers simulating the same bot round | bot answers are written only by the round's CAS winner (`onQuestionStarted` hook); `HSETNX` means a bot can never displace a human answer | bot test + concurrency test together |

## 12. Scaling model

- **One process** handles 2,000+ players per arena (measured); the ceiling is
  Socket.IO connections (~10k/process), not the engine — per-answer work is
  one Redis op, per-round work is two CAS + one batch insert.
- **Multiple processes** need no engine changes (proven live): each server
  ticks every arena, CAS picks the winner, each broadcasts to its own
  sockets. Add `@socket.io/redis-adapter` for cross-server room emits
  (`arena:online` counts), set `RESET_ONLINE_COUNTS=false`, sticky sessions
  on the load balancer.
- **Redis Cluster** when one Redis is the limit: keys already carry
  `{arenaId}` hash tags, so each arena's keys co-locate on one shard.
