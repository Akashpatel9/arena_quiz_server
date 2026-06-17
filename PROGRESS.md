# Progress & open questions

## Status

Feature-complete against [Arena_feature.md](Arena_feature.md): game loop
(question → result → question), difficulty-based timers, answer locking,
personalized result screens with the speed graph, reconnect snapshots, crash
recovery, and CAS-guarded transitions for future multi-server deployment.

**Waiting phase removed (2026-06-14).** Joiners no longer sit on a waiting
screen until the next question — the join snapshot drops them directly onto the
current arena phase: if a question is live they see it and can answer it right
away, and if a result is live they see that result. This deleted the
per-user `eligibleFromRound` machinery entirely (`resolveEligibility`, Redis
`presence` hash, `REJOIN_GRACE_MS`/`JOIN_START_WINDOW_MS`, the `WAITING` answer
error, and the snapshot `waiting`/`waitMs` fields) from the engine, socket
layer, liveStore, and clients. The test scripts (e2e, load, Playwright
arena.spec) and the `play` TUI were updated to the new behavior but have NOT
been re-run yet — so the "Verified (2026-06-12)" results below predate this
change and their waiting-specific assertions no longer apply. NOTE: README.md,
ARCHITECTURE.md, and Arena_feature.md still describe the old waiting design and
are stale on this point.

**Bot service added (2026-06-12)** per the bot spec: every active arena holds
10–100 bots whose count random-walks every 10s (join/leave), each bot is a
real `auth_user` (`isBot: true`) with name + photo, and every round
the whole crowd answers with difficulty-banded accuracy (easy 80–100% right).
Bots are a Redis count + answer-hash entries only (no sockets/presence);
answers are written once per round by the round's CAS winner; the engine's
idle check stays human-only so bots never keep an empty arena running.
Displayed counts (`arena:online` now `{count, humans, bots}`, lobby
`online_user_count`, `/state`) include bots. The result graph entries now
carry `photo` (denormalized onto answers like `userName`), for humans too.
Disable with `BOTS_ENABLED=false`.

Architecture (after the Redis migration): **Redis is the live database** —
game state (Lua CAS transitions), current-round answers, online counts.
**Mongo is durable reference data only** — questions, arenas, users. Phase
boundaries do no Mongo work on the critical path.

**Answers are Redis-only (2026-06-14).** Raw answers are never persisted to
Mongo — there's no product need for historical answer analytics. They live in
a per-round Redis hash, drive the live result, survive the 15s result phase
(`ANSWER_TTL_MS`) so reconnects still recompute it, and are cleared when the
next round starts (`clearRound`). This removed the `flushAnswers` batch write,
both Mongo answer fallbacks, and the `ArenaAnswer` model entirely. Trade-off:
a Redis outage mid-round loses that round's answers (acceptable — Redis already
holds the game state, so the game can't run without it). If per-user
history/leaderboards are ever needed, persist *aggregates*, not raw rows.

Other trade-offs accepted: Redis is now required for the game to
run, and Redis durability is RDB/AOF-based — run Redis with
`--appendonly yes` in production. The old `arena_games` / `arena_presences`
Mongo collections are unused (stale data may remain; safe to drop).

Verified (2026-06-12, Docker mongo + redis), all passing:

- **tests/e2e.cjs** (9 checks): immediate start for first joiner; answer
  lock + duplicate rejection; mid-game joiner waits then enters at next
  question; result with explanation and correct-only speed graph; synced
  round broadcast; reconnect snapshot.
- **tests/load.cjs**, one arena, all clients + server + both DBs on one
  laptop (numbers are conservative — the single-process test client is its
  own bottleneck):
  | players | join ack p95 | answer ack p95 | result spread | after sched. end |
  |---|---|---|---|---|
  | 300 | 40ms | 3ms | 6ms | 33ms |
  | 1000 | 86ms | 2ms | 12ms | 67ms |
  | 2000 | 263ms | 2ms | 26ms | 93ms |
  All answers accepted at every size; identical round+endsAt on every
  client; graph capped at 51 entries with per-user rank intact. Answer acks
  are flat (Redis hot path); only the join burst (guest-user creation in
  Mongo) grows with N. The waiting phase is asserted under load too (500+50):
  a late-joiner wave mid-question all land in 'waiting' with the correct
  waitMs, see no question data and no result for the round they didn't play,
  and are all let in (and can answer) exactly at the next question.
- **tests/crash-test.cjs**: SIGKILL mid-question with live, answered
  clients → restart → same round, same phase, 0ms timer drift, the answer
  still locked (from Redis), players kept their seats, loop continued.
- **tests/arena.spec.cjs** (Playwright, real Chromium pages): full two-player
  UI flow (question render, answer lock, waiting screen for late joiner,
  result with explanation and correct-only graph, synced next round) and a
  mid-game page reload that keeps identity and lands back in place. 2/2
  passing in 36s against a TIMER_SCALE=0.2 server.
- **tests/bot-test.cjs** (9 checks): bot crowd within [10,100] and present
  in the live round's answers; every bot answer carries name/photo;
  per-round accuracy lands inside the difficulty band; bot times inside the
  question timer; a correct human lands ranked on a graph mixed with bot
  entries (profile fields included); `/state` and `arena:online` report
  `humans + bots`; the population drifts across two 10s steps.
- **tests/concurrency-test.cjs** (9 checks): 20 simultaneous joins to an
  empty arena start the game exactly once with everyone seated; the same
  user racing answers from two sockets gets exactly one accepted; **two
  server instances sharing Redis/Mongo** ran the same game with identical
  rounds/endsAt on both servers' clients, rounds advancing strictly by 1
  (every CAS won exactly once), no double-announces, identical results;
  online counter returned exactly to baseline after 30 join/leave churners.

The result graph is capped at GRAPH_TOP_LIMIT (50) fastest entries plus the
recipient's own entry/rank — this keeps the result fan-out O(players) instead
of O(players²), the only real scaling bottleneck found.

Bug found by crash-test and fixed: socket.io auto-reconnects re-send the
ORIGINAL handshake auth, so clients must update `socket.auth.userId` after
the `session` event or a reconnect lands them on a fresh guest identity
(fixed in public/index.html; any production client must do the same).

## Assumptions to reconcile

1. ~~Question collection shape~~ **RECONCILED (2026-06-12)** against the real
   `staging_QuestionBank` collection on Atlas (1001 docs): `text[]`,
   `optionsText[]`/`optionsImg[]`, `answer[]` (verified 0-indexed,
   single-answer), `solutionText[]`/`solutionImg[]`, `qType` (filter's
   `question_type` maps to it). Virtuals `correctOption`/`explanation` keep
   the engine unchanged. Verified live: a real round in "Chemical Bonding
   for JEE Mains" played end-to-end with the correct answer/explanation
   mapping and no answer leakage. **IMAGE_BASE_URL** is set to the stage S3
   bucket (learnoverse-s3-bucket-stage, ap-south-1); sanitized questions
   carry absolute image URLs, verified resolving with HTTP 200 — swap to the
   prod bucket on deploy. Also: `npm run seed` now refuses non-local
   databases (use --force).
2. **Auth** — socket handshake takes `{userId, name}` and silently creates a
   guest `auth_user` when unknown. Swap `authMiddleware` in
   `src/sockets/arenaSocket.js` for real token verification (Google JWT).
3. **online_user_count** — counts connections, not distinct users (two tabs =
   2). Authoritative count is in Redis; the Mongo field is best-effort lobby
   display. Reset on boot (`RESET_ONLINE_COUNTS`) is only correct for a
   single instance.
4. **"Not attempted" reach** — users who never joined a round (still waiting)
   get no result screen for it, by design; only players of that round get the
   not-attempted result.
5. **Data gap (for the content team):** 65 of the 163 active arenas have
   filters matching ZERO questions in `staging_QuestionBank` (it holds only
   1,001 questions, mostly chemistry/physics ch. 1–6; e.g. "Magnetism",
   "Sound Waves", "Fluid Mechanics" arenas are empty). Verified 2026-06-12:
   the other 98 arenas all pick filter-matching questions (0 mismatches).
   Joining an empty arena now returns `noQuestions: true` in the snapshot
   and both clients show "no questions in this arena yet" instead of a
   forever-quiet arena.

6. **Bot accuracy bands** — the spec only states easy = 80–100% right; medium
   (60–90%) and hard (40–75%) are assumptions, tunable in `BOT_ACCURACY`
   (gameConstants.js). Bot photos use i.pravatar.cc placeholder URLs — swap
   for real assets when product decides.

## Multi-server checklist (when the time comes)

- [ ] socket.io Redis adapter (cross-server room broadcasts)
- [ ] `RESET_ONLINE_COUNTS=false` + shared presence counting
- [ ] keep CAS transitions as-is — they already tolerate N concurrent loops
- [ ] bot drift loop runs per server (crowd drifts N× faster with N servers —
      harmless; put it behind a Redis lock if it ever matters). Bot answers
      are already exactly-once (written by the round's CAS winner).
