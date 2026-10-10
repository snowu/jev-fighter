// Randomness for the AI. The sim stays deterministic; all dice live here.

/** Small seeded PRNG (mulberry32) so headless runs are reproducible. */
export function makeRng(seed = Date.now()) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function normalize(weights) {
  const total = Object.values(weights).reduce((s, w) => s + Math.max(0, w), 0);
  if (total <= 0) {
    const n = Object.keys(weights).length;
    return Object.fromEntries(Object.keys(weights).map((k) => [k, 1 / n]));
  }
  return Object.fromEntries(Object.entries(weights).map(([k, w]) => [k, Math.max(0, w) / total]));
}

/**
 * Sample a key from a probability map.
 * temperature > 1 flattens (wilder), < 1 sharpens (more "correct");
 * floor is a total probability budget spread evenly over the options, so nothing is ever
 * fully impossible and the AI never becomes perfectly exploitable (e.g. 0.06 = 6% total).
 */
export function sample(probs, rng, { temperature = 1, floor = 0, only = null } = {}) {
  let entries = Object.entries(probs);
  if (only) entries = entries.filter(([k]) => only.includes(k));
  if (!entries.length) return null;
  const n = entries.length;
  const shaped = entries.map(([k, p]) => [k, Math.pow(Math.max(p, 1e-9), 1 / temperature)]);
  const total = shaped.reduce((s, [, w]) => s + w, 0);
  const weights = shaped.map(([k, w]) => [k, (1 - floor) * (w / total) + floor / n]);
  let r = rng() * weights.reduce((s, [, w]) => s + w, 0);
  for (const [k, w] of weights) if ((r -= w) <= 0) return k;
  return weights.at(-1)[0];
}

export const chance = (p, rng) => rng() < p;
export const randInt = (lo, hi, rng) => lo + Math.floor(rng() * (hi - lo + 1));

export function shuffled(arr, rng) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
