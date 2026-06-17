/**
 * Randomness helpers used by the bot simulation. The seeded PRNG and shuffle
 * are deterministic (same seed → same sequence on any server), which is how
 * every server derives the same bot roster from a count alone.
 */

export const randomInt = (min, max) =>
  Math.floor(Math.random() * (max - min + 1)) + min;

export const pick = (arr, rand) => arr[Math.floor(rand() * arr.length)];

/** A wrong option (0..3) for a question whose correct option is `correctOption`. */
export function wrongOption(correctOption) {
  const wrong = [0, 1, 2, 3].filter((o) => o !== correctOption);
  return wrong[Math.floor(Math.random() * wrong.length)];
}

/** Deterministic seedable PRNG — same seed, same sequence, on any server. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a hash of a string → a 32-bit unsigned seed. */
export function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Fisher–Yates with a seeded PRNG: a stable per-arena ordering. */
export function shuffledIndices(n, seed) {
  const rand = mulberry32(seed);
  const order = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}
