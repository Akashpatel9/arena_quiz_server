// Simulated-player (bot) tuning. See services/botService.js.

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
