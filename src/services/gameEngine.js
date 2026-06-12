import ArenaGroup from "../models/ArenaGroupModel.js";
import ArenaAnswer from "../models/ArenaAnswerModel.js";
import Question from "../models/Question.js";
import {
  pickQuestion,
  sanitizeQuestion,
  solutionImagesOf,
} from "./questionService.js";
import {
  questionDurationFor,
  RESULT_DURATION_MS,
  ANSWER_GRACE_MS,
  GRAPH_TOP_LIMIT,
} from "../config/gameConstants.js";

export const arenaRoom = (arenaGroupId) => `arena:${arenaGroupId}`;

// Arena group (title/filter) changes rarely; cache it off the loop's path.
const GROUP_CACHE_MS = 60_000;

/**
 * Drives the question → result → question loop for every arena.
 *
 * All LIVE state lives in Redis (see liveStore.js): the game document,
 * the current round's answers, online counts and presence. Mongo holds only
 * durable data — questions, arena definitions, users, and finished rounds'
 * answers (batch-flushed). A phase boundary therefore performs no Mongo work
 * on its critical path: one Redis CAS + one Redis read + local broadcasts.
 *
 * Design rules that give the architecture guarantees from Arena_feature.md:
 *  - Timers are absolute `phaseEndsAt` timestamps, never in-memory
 *    countdowns: a crashed/restarted server re-reads the game keys and
 *    resumes mid-phase (recoverRunningGames).
 *  - Every phase transition is an atomic compare-and-swap on the expected
 *    (status, phase, round). With several servers running the same loop,
 *    exactly one wins each transition; the others re-read the state and
 *    still broadcast to their own connected sockets.
 *  - Result computation is a pure read of stored answers, so it is safe for
 *    every server to compute and broadcast it independently.
 *
 * `hooks.onQuestionStarted(game, question)` fires when THIS server wins a
 * round's question transition — i.e. exactly once per round across all
 * servers. The bot service uses it to write the round's bot answers.
 */
export function createGameEngine(io, liveStore, hooks = {}) {
  /** arenaGroupId -> setTimeout handle for the next phase boundary */
  const timers = new Map();
  /** arenaGroupId -> { round, question } so answers don't hit any DB */
  const questionCache = new Map();
  /** arenaGroupId -> "round:phase" last emitted by THIS server */
  const lastAnnounced = new Map();
  /** arenaGroupId -> last known game state (valid until its phase boundary) */
  const gameCache = new Map();
  /** arenaGroupId -> { group, at } */
  const groupCache = new Map();

  // ---------------------------------------------------------------- public

  /**
   * Make sure the arena has a running game. Called when a user joins:
   * if nobody was playing (status idle) the game starts immediately.
   * Returns { game, started } — `started` is true when THIS call won the
   * idle→running transition (its caller gets to play the new round).
   */
  async function ensureRunning(arenaGroupId) {
    let game = await liveStore.ensureGame(arenaGroupId);
    if (game.status === "running") {
      cacheGame(game);
      scheduleNext(game);
      return { game, started: false, noQuestions: false };
    }

    const group = await getGroup(arenaGroupId);
    const { game: won, noQuestions } = await startRound(game, group, guardOf(game));
    game = won || (await liveStore.getGame(arenaGroupId)) || game;
    cacheGame(game);
    await announce(game);
    scheduleNext(game);
    return {
      game,
      started: Boolean(won && game.status === "running"),
      // The arena's filter matches nothing in the question bank — the game
      // cannot start; callers should tell the user instead of "quiet arena".
      noQuestions,
    };
  }

  /** Resume every game that was live when the server last stopped. */
  async function recoverRunningGames() {
    const games = (await liveStore.scanGames()).filter(
      (g) => g.status === "running"
    );
    for (const game of games) {
      // Mark current phase as already announced: sockets reconnecting get
      // their state from the join snapshot, not a re-broadcast.
      lastAnnounced.set(String(game.arenaGroupId), announceKey(game));
      cacheGame(game);
      // If the crash happened between the result transition and the answer
      // flush, the round's answers are still only in Redis — persist them.
      if (game.phase === "result") await flushAnswers(game);
      scheduleNext(game);
    }
    if (games.length) {
      console.log(`[engine] recovered ${games.length} running game(s)`);
    }
  }

  /**
   * Everything a (re)joining client needs to land exactly where the game is:
   * current phase, synced timers, the live question or the full result.
   */
  async function buildSnapshot(game, { userId, eligibleFromRound }) {
    const now = Date.now();
    const remainingMs = game?.phaseEndsAt
      ? Math.max(0, game.phaseEndsAt.getTime() - now)
      : 0;
    const snapshot = {
      serverTime: now,
      status: game?.status ?? "idle",
      phase: game?.status === "running" ? game.phase : null,
      round: game?.round ?? 0,
      phaseEndsAt: game?.phaseEndsAt ? game.phaseEndsAt.getTime() : null,
      remainingMs,
      eligibleFromRound,
      waiting: false,
      waitMs: 0,
      question: null,
      result: null,
      yourAnswer: null,
    };
    if (!game || game.status !== "running") return snapshot;

    const waiting = eligibleFromRound > game.round;
    if (waiting) {
      // Waiting timer = until the next question appears.
      snapshot.waiting = true;
      snapshot.waitMs =
        game.phase === "question"
          ? remainingMs + RESULT_DURATION_MS
          : remainingMs;
      return snapshot;
    }

    if (game.phase === "question") {
      const question = await getQuestionFor(game);
      snapshot.question = question ? sanitizeQuestion(question) : null;
      let answer = await liveStore.getAnswer(
        game.arenaGroupId,
        game.round,
        userId
      );
      if (!answer) {
        answer = await ArenaAnswer.findOne({
          arenaGroupId: game.arenaGroupId,
          round: game.round,
          userId,
        }).lean();
      }
      if (answer) {
        snapshot.yourAnswer = {
          selectedOption: answer.selectedOption,
          timeTakenMs: answer.timeTakenMs,
        };
      }
    } else if (game.phase === "result") {
      const results = await computeResults(game);
      snapshot.result = results.base
        ? personalizeResult(results, userId)
        : null;
    }
    return snapshot;
  }

  /**
   * Record one user's answer for the current question.
   * Throws { code, message } on any rule violation.
   *
   * Fast path: cached game state + cached question + one Redis HSETNX.
   * No database round-trips while the question is live.
   */
  async function submitAnswer({ arenaGroupId, user, round, selectedOption }) {
    if (
      !Number.isInteger(selectedOption) ||
      selectedOption < 0 ||
      selectedOption > 3
    ) {
      throw err("BAD_OPTION", "selectedOption must be an integer 0..3");
    }
    const game = await getGameCached(arenaGroupId);
    if (!game || game.status !== "running" || game.phase !== "question") {
      throw err("NOT_ACCEPTING", "No question is live right now");
    }
    if (round !== game.round) {
      throw err("WRONG_ROUND", "This question is no longer live");
    }
    if (user.eligibleFromRound > game.round) {
      throw err("WAITING", "You join the game at the next question");
    }
    const now = Date.now();
    if (now > game.phaseEndsAt.getTime() + ANSWER_GRACE_MS) {
      throw err("TOO_LATE", "Time is up for this question");
    }

    const question = await getQuestionFor(game);
    if (!question) throw err("NOT_ACCEPTING", "Question unavailable");

    const timeTakenMs = Math.min(
      Math.max(0, now - game.phaseStartedAt.getTime()),
      game.questionDurationMs ?? now - game.phaseStartedAt.getTime()
    );
    const answer = {
      arenaGroupId: String(arenaGroupId),
      round: game.round,
      questionId: String(game.questionId),
      userId: String(user.userId),
      userName: user.name || "",
      userPhoto: user.photo || "",
      selectedOption,
      correct: selectedOption === question.correctOption,
      timeTakenMs,
      answeredAt: new Date(now).toISOString(),
    };

    if (liveStore.isHealthy()) {
      const saved = await liveStore.saveAnswer(arenaGroupId, game.round, answer);
      if (!saved) {
        throw err("ALREADY_ANSWERED", "You already answered this question");
      }
    } else {
      // Redis briefly unavailable — write straight to Mongo (unique index
      // dedupes) so a player's answer is never dropped.
      try {
        await ArenaAnswer.create(answer);
      } catch (e) {
        if (e?.code === 11000) {
          throw err("ALREADY_ANSWERED", "You already answered this question");
        }
        throw e;
      }
    }
    // Correctness is never revealed before the result screen.
    return { locked: true, round: game.round, selectedOption, timeTakenMs };
  }

  // ----------------------------------------------------------- game loop

  function scheduleNext(game) {
    const key = String(game.arenaGroupId);
    clearTimeout(timers.get(key));
    timers.delete(key);
    if (game.status !== "running" || !game.phaseEndsAt) {
      questionCache.delete(key);
      return;
    }
    const delay = Math.max(0, game.phaseEndsAt.getTime() - Date.now());
    timers.set(
      key,
      setTimeout(() => {
        tick(game.arenaGroupId).catch((e) => {
          console.error(`[engine] tick failed for arena ${key}:`, e);
          // Retry shortly instead of letting the game stall forever.
          timers.set(key, setTimeout(() => tick(game.arenaGroupId), 1000));
        });
      }, delay)
    );
  }

  async function tick(arenaGroupId) {
    const game = await liveStore.getGame(arenaGroupId);
    if (!game || game.status !== "running") return;

    const now = Date.now();
    if (now < game.phaseEndsAt.getTime() - 25) {
      // Woke up early (clock drift / another server moved the boundary).
      scheduleNext(game);
      return;
    }

    let current = game;
    if (game.phase === "question") {
      // Anchor the result phase to the scheduled question end, so timers stay
      // identical for everyone even if this tick fired slightly late.
      const resultStartMs = game.phaseEndsAt.getTime();
      const { won, game: after } = await liveStore.casGame(
        arenaGroupId,
        guardOf(game),
        {
          ...game,
          phase: "result",
          phaseStartedAt: resultStartMs,
          phaseEndsAt: resultStartMs + RESULT_DURATION_MS,
        }
      );
      // The transition winner persists the round's answers to Mongo.
      // Fire-and-forget: results are computed from Redis, so the broadcast
      // never waits on this write; recovery re-flushes if it fails.
      if (won) {
        flushAnswers(game).catch((e) =>
          console.error("[engine] background answer flush failed:", e.message)
        );
      }
      current = after || game;
    } else if (game.phase === "result") {
      const online = await liveStore.getOnline(arenaGroupId);
      if (online <= 0) {
        // Arena emptied out — stop the loop until the next joiner.
        const { game: after } = await liveStore.casGame(
          arenaGroupId,
          guardOf(game),
          {
            ...game,
            status: "idle",
            phase: null,
            questionId: null,
            questionDurationMs: null,
            phaseStartedAt: null,
            phaseEndsAt: null,
          }
        );
        current = after || game;
      } else {
        const group = await getGroup(arenaGroupId);
        const { game: won } = await startRound(game, group, guardOf(game));
        current = won || (await liveStore.getGame(arenaGroupId)) || game;
      }
    }

    cacheGame(current);
    await announce(current);
    scheduleNext(current);
  }

  /**
   * Move the game into a fresh question round. `guard` is the CAS condition
   * (the idle state for a fresh start, or the finished result phase
   * mid-loop). Returns { game, noQuestions } — game is the new state, or
   * null if another server won the transition.
   */
  async function startRound(game, group, guard) {
    // Sequential serving: continue from the last question this arena used.
    const question = await pickQuestion(group, game.lastQuestionId);
    if (!question) {
      console.error(
        `[engine] no questions match the filter of arena ${game.arenaGroupId}; going idle`
      );
      await liveStore.casGame(game.arenaGroupId, guard, {
        ...game,
        status: "idle",
        phase: null,
        questionId: null,
        questionDurationMs: null,
        phaseStartedAt: null,
        phaseEndsAt: null,
      });
      return { game: null, noQuestions: true };
    }

    const durationMs = questionDurationFor(question.difficulty);
    const nowMs = Date.now();
    const { won, game: after } = await liveStore.casGame(
      game.arenaGroupId,
      guard,
      {
        arenaGroupId: String(game.arenaGroupId),
        status: "running",
        phase: "question",
        round: game.round + 1,
        questionId: String(question._id),
        questionDurationMs: durationMs,
        phaseStartedAt: nowMs,
        phaseEndsAt: nowMs + durationMs,
        // The sequence cursor — pickQuestion serves the next one after this.
        lastQuestionId: String(question._id),
      }
    );
    if (!won) return { game: null, noQuestions: false };

    questionCache.set(String(game.arenaGroupId), {
      round: after.round,
      question,
    });
    cacheGame(after);
    if (hooks.onQuestionStarted) {
      // Fire-and-forget: bots must never delay the question broadcast.
      Promise.resolve(hooks.onQuestionStarted(after, question)).catch((e) =>
        console.error("[engine] onQuestionStarted hook failed:", e.message)
      );
    }
    // Previous round is flushed to Mongo by now; free its Redis hash.
    if (game.round > 0) {
      liveStore.clearRound(game.arenaGroupId, game.round).catch(() => {});
    }
    return { game: after, noQuestions: false };
  }

  // ---------------------------------------------------------- broadcasting

  const announceKey = (game) =>
    game.status === "running" ? `${game.round}:${game.phase}` : "idle";

  /** Emit the current phase to this server's sockets, exactly once. */
  async function announce(game) {
    if (!game) return;
    const key = String(game.arenaGroupId);
    const phaseKey = announceKey(game);
    if (lastAnnounced.get(key) === phaseKey) return;
    lastAnnounced.set(key, phaseKey);

    if (game.status !== "running") return;

    if (game.phase === "question") {
      const question = await getQuestionFor(game);
      if (!question) return;
      io.to(arenaRoom(game.arenaGroupId)).emit("arena:question", {
        serverTime: Date.now(),
        round: game.round,
        question: sanitizeQuestion(question),
        durationMs: game.questionDurationMs,
        endsAt: game.phaseEndsAt.getTime(),
      });
    } else if (game.phase === "result") {
      await broadcastResults(game);
    }
  }

  async function broadcastResults(game) {
    const results = await computeResults(game);
    if (!results.base) return;
    const sockets = await io.in(arenaRoom(game.arenaGroupId)).fetchSockets();
    for (const socket of sockets) {
      const { userId, eligibleFromRound } = socket.data;
      // Users still waiting for their first question stay on the waiting
      // screen; they don't see results of a round they never played.
      if (!userId || eligibleFromRound > game.round) continue;
      socket.emit("arena:result", personalizeResult(results, userId));
    }
  }

  /**
   * Build the shared result data for the current round. Pure read — safe to
   * run on every server and on every reconnect.
   */
  async function computeResults(game) {
    const question = await getQuestionFor(game);
    if (!question) return { base: null, byUser: new Map(), graph: [] };

    // Redis holds the live round; Mongo is the fallback (Redis down, or a
    // reconnect after the round was flushed and its key expired).
    let answers = await liveStore.getAnswers(game.arenaGroupId, game.round);
    if (!answers?.length) {
      answers = await ArenaAnswer.find({
        arenaGroupId: game.arenaGroupId,
        round: game.round,
      }).lean();
    }
    answers.sort((a, b) => a.timeTakenMs - b.timeTakenMs);

    // The graph: only correct answers, ranked by speed (fastest first).
    // Each recipient gets at most the top GRAPH_TOP_LIMIT entries (plus
    // their own, appended in personalizeResult if they placed below the
    // cap) — this keeps the result fan-out O(players), not O(players²).
    const ranked = answers
      .filter((a) => a.correct)
      .map((a, i) => ({
        rank: i + 1,
        userId: String(a.userId),
        name: a.userName,
        photo: a.userPhoto || null,
        timeTakenMs: a.timeTakenMs,
      }));
    const graph = ranked.slice(0, GRAPH_TOP_LIMIT);
    const rankByUser = new Map(ranked.map((g) => [g.userId, g]));

    const byUser = new Map(answers.map((a) => [String(a.userId), a]));
    const base = {
      serverTime: Date.now(),
      round: game.round,
      question: sanitizeQuestion(question),
      correctOption: question.correctOption,
      explanation: question.explanation,
      solutionImages: solutionImagesOf(question),
      endsAt: game.phaseEndsAt.getTime(),
      // Result timer is fixed; the next question appears when it ends.
      nextQuestionAt: game.phaseEndsAt.getTime(),
    };
    return { base, byUser, graph, rankByUser };
  }

  function personalizeResult({ base, graph, byUser, rankByUser }, userId) {
    const answer = byUser.get(String(userId));
    const outcome = !answer
      ? "not_attempted"
      : answer.correct
        ? "correct"
        : "wrong";

    // The graph only appears for users who answered correctly. If they
    // placed below the top-N cap, append their own entry so they always
    // see their rank.
    let yourGraph = null;
    let yourRank = null;
    if (outcome === "correct") {
      const own = rankByUser.get(String(userId));
      yourRank = own?.rank ?? null;
      yourGraph =
        own && own.rank > graph.length ? [...graph, own] : graph;
    }

    return {
      ...base,
      outcome,
      yourAnswer: answer
        ? {
            selectedOption: answer.selectedOption,
            timeTakenMs: answer.timeTakenMs,
          }
        : null,
      yourRank,
      graph: yourGraph,
    };
  }

  // --------------------------------------------------------------- helpers

  const guardOf = (game) => ({
    status: game.status,
    phase: game.phase,
    round: game.round,
  });

  async function getQuestionFor(game) {
    const key = String(game.arenaGroupId);
    const cached = questionCache.get(key);
    if (cached && cached.round === game.round) return cached.question;
    if (!game.questionId) return null;
    const question = await Question.findById(game.questionId);
    if (question) questionCache.set(key, { round: game.round, question });
    return question;
  }

  function cacheGame(game) {
    if (game) gameCache.set(String(game.arenaGroupId), game);
    return game;
  }

  /**
   * The game state can only change at a phase boundary, so between
   * boundaries the cached copy is authoritative — no Redis read per answer.
   * Anything idle, missing or past its boundary is re-read from Redis.
   */
  async function getGameCached(arenaGroupId) {
    const cached = gameCache.get(String(arenaGroupId));
    if (
      cached &&
      cached.status === "running" &&
      cached.phaseEndsAt &&
      Date.now() <= cached.phaseEndsAt.getTime() + ANSWER_GRACE_MS
    ) {
      return cached;
    }
    return cacheGame(await liveStore.getGame(arenaGroupId));
  }

  async function getGroup(arenaGroupId) {
    const key = String(arenaGroupId);
    const cached = groupCache.get(key);
    if (cached && Date.now() - cached.at < GROUP_CACHE_MS) return cached.group;
    const group = await ArenaGroup.findById(arenaGroupId);
    groupCache.set(key, { group, at: Date.now() });
    return group;
  }

  /**
   * Move a finished round's answers from Redis into Mongo in one batch.
   * Idempotent (unique index ignores duplicates), so safe to retry/repeat.
   */
  async function flushAnswers(game) {
    const answers = await liveStore.getAnswers(game.arenaGroupId, game.round);
    if (!answers?.length) return;
    try {
      await ArenaAnswer.insertMany(answers, { ordered: false });
    } catch (e) {
      if (e?.code !== 11000 && !e?.writeErrors?.every((w) => w.code === 11000)) {
        console.error("[engine] answer flush failed:", e.message);
      }
    }
  }

  function err(code, message) {
    const e = new Error(message);
    e.code = code;
    e.expected = true;
    return e;
  }

  function stop() {
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
  }

  return {
    ensureRunning,
    recoverRunningGames,
    buildSnapshot,
    submitAnswer,
    getGame: getGameCached,
    stop,
  };
}
