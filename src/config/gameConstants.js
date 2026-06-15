// All gameplay timing rules live here (see Arena_feature.md).

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

// ------------------------------------------------------------------- bots

// Every arena holds a drifting crowd of bots within this range.
export const BOT_MIN_PER_ARENA = 10;
export const BOT_MAX_PER_ARENA = 100;

// How often the bot population random-walks (a few bots join/leave per step).
export const BOT_DRIFT_INTERVAL_MS = 10_000;
export const BOT_DRIFT_MAX_STEP = 4;

// Share of the active bots that answer correctly, by question difficulty.
// Per round one accuracy is rolled inside the range, then each bot rolls
// against it. Easy 80–100% is from the spec; medium/hard taper off.
export const BOT_ACCURACY = {
  1: [0.8, 1.0],
  2: [0.6, 0.9],
  3: [0.4, 0.75],
};

// Bots "take" between these fractions of the question timer to answer, so
// they never look implausibly fast and always make it before time is up.
export const BOT_TIME_FRACTION = [0.12, 0.95];

// Distinct bot identities created in Mongo (each arena draws its own
// shuffled subset, so rosters differ between arenas).
export const BOT_POOL_SIZE = 150;
