import { sanitizeQuestion, solutionImagesOf } from "../utils/questionView.js";
import { GRAPH_TOP_LIMIT } from "../constants/game.js";

/**
 * Pure result computation for a round — no Mongo, no Redis, no sockets.
 * The game engine fetches the question and the round's stored answers, then
 * hands them here; keeping this side-effect-free means it can be unit-tested
 * directly and run identically on every server and on every reconnect.
 */

/**
 * Build the shared result data from a round's answers.
 *
 *  @param question   the round's question document (null → no result)
 *  @param answers    the round's stored answers (any order; not mutated)
 *  @param round      the round number
 *  @param endsAtMs   when the result phase ends (epoch ms)
 *
 * Returns { base, byUser, graph, rankByUser }; `base` is null when the
 * question is missing. Callers must treat a null `base` as "no result yet".
 */
export function buildResults({ question, answers, round, endsAtMs }) {
  if (!question) {
    return { base: null, byUser: new Map(), graph: [], rankByUser: new Map() };
  }

  // Sort a copy by speed (fastest first); never mutate the caller's array.
  const sorted = [...answers].sort((a, b) => a.timeTakenMs - b.timeTakenMs);

  // The graph: only correct answers, ranked by speed (fastest first).
  // Each recipient gets at most the top GRAPH_TOP_LIMIT entries (plus
  // their own, appended in personalizeResult if they placed below the
  // cap) — this keeps the result fan-out O(players), not O(players²).
  const ranked = sorted
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

  const byUser = new Map(sorted.map((a) => [String(a.userId), a]));
  const base = {
    serverTime: Date.now(),
    round,
    question: sanitizeQuestion(question),
    correctOption: question.correctOption,
    explanation: question.explanation,
    solutionImages: solutionImagesOf(question),
    endsAt: endsAtMs,
    // Result timer is fixed; the next question appears when it ends.
    nextQuestionAt: endsAtMs,
  };
  return { base, byUser, graph, rankByUser };
}

/**
 * Tailor the shared result to one user: their outcome (correct/wrong/
 * not_attempted), their own answer, and — only if they were correct —
 * their rank and the speed graph (with their own entry appended when they
 * placed below the top-N cap).
 */
export function personalizeResult({ base, graph, byUser, rankByUser }, userId) {
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
    yourGraph = own && own.rank > graph.length ? [...graph, own] : graph;
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
