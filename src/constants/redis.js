// Expiry windows for the live keys in Redis. See dal/liveStore.js.

// Live-round answers expire on their own if a flush never happens
// (e.g. the arena went idle, or every server died mid-round).
export const ANSWER_TTL_MS = 30 * 60 * 1000;

// Bot counts are touched on every drift step; arenas that stop drifting
// (deactivated, server gone) age out instead of leaking keys.
export const BOTS_TTL_MS = 24 * 60 * 60 * 1000;

// When an arena empties of real users the game goes idle; the idle key then
// ages out after this window so abandoned arenas don't keep state in Redis
// forever. A player returning within the window resumes the same game (round
// continuity); after it, a fresh game starts from round 0. The bots key is
// independent and untouched.
export const IDLE_GAME_TTL_MS = 10 * 60 * 1000;
