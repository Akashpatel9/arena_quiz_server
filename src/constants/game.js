// Gameplay timing rules (see Arena_feature.md).

// TIMER_SCALE shrinks every game timer proportionally — for tests/dev only
// (e.g. TIMER_SCALE=0.1 makes an easy question 3s and results 1.5s).
const SCALE =
  Number(process.env.TIMER_SCALE) > 0 ? Number(process.env.TIMER_SCALE) : 1;

// Question timer by difficulty: 1=easy, 2=medium, 3=hard.
export const QUESTION_DURATION_MS = {
  1: 30_000 * SCALE,
  2: 60_000 * SCALE,
  3: 90_000 * SCALE,
};
export const DEFAULT_QUESTION_DURATION_MS = 60_000 * SCALE;

// Result screen is always shown for a fixed 15 seconds.
export const RESULT_DURATION_MS = 15_000 * SCALE;

// Late answers within this window are still accepted (network latency).
export const ANSWER_GRACE_MS = 1_000;

// The result graph sent to each correct answerer is capped at the fastest N
// entries (plus the recipient's own entry/rank if they placed below the cap).
// Without a cap the result broadcast is O(players²) bytes per round.
export const GRAPH_TOP_LIMIT = 50;

export function questionDurationFor(difficulty) {
  return QUESTION_DURATION_MS[difficulty] ?? DEFAULT_QUESTION_DURATION_MS;
}
