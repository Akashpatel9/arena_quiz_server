// Redis key layout for the live arena state (see dal/liveStore.js).
//
// The `{arenaGroupId}` hash tag keeps all of one arena's keys on the same
// cluster slot, so multi-key operations on an arena stay local to one node.

export const gameKey = (arenaGroupId) => `arena:{${arenaGroupId}}:game`;
export const onlineKey = (arenaGroupId) => `arena:{${arenaGroupId}}:online`;
export const botsKey = (arenaGroupId) => `arena:{${arenaGroupId}}:bots`;
export const answersKey = (arenaGroupId, round) =>
  `arena:{${arenaGroupId}}:r${round}:answers`;

// SCAN match patterns for boot-time sweeps over every arena.
export const GAME_KEY_PATTERN = "arena:*:game";
export const ONLINE_KEY_PATTERN = "arena:*:online";
