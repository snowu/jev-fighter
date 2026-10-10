// Move helpers: frame-data math stays in code; describeMove turns numbers into
// the words Jev reasons with (it is weak at raw numbers).
//
// A character has `moves` keyed by id and `slots` mapping the 5 buttons to starter
// moves. A move may list `cancels: { slot: moveId }` — follow-ups that can be input
// during the move and come out once it connects (hit or block): that's a string.

export const ATTACK_SLOTS = ["light", "heavy", "low", "special", "throw"];

export const totalFrames = (m) => m.startup + m.active + m.recovery;

/** Frame advantage if blocked on the first active frame (negative = attacker recovers later). */
export const blockAdvantage = (m) =>
  m.level === "throw" ? -Infinity : m.blockstun - (m.active + m.recovery);

export const starter = (char, slot) => char.moves[char.slots[slot]];

/** Button starters that are strikes (not throws). */
export const strikes = (char) => ATTACK_SLOTS.map((s) => starter(char, s)).filter((m) => m.level !== "throw");

export const fastestStrike = (char) => strikes(char).reduce((a, b) => (b.startup < a.startup ? b : a));

export const maxReach = (char) => Math.max(...strikes(char).map((m) => m.range));

/** Every move reachable from a starter by following cancels, in order. */
export function stringFrom(char, moveId, seen = new Set()) {
  const m = char.moves[moveId];
  if (!m || seen.has(moveId)) return [];
  seen.add(moveId);
  const next = Object.values(m.cancels ?? {})[0];
  return [m, ...(next ? stringFrom(char, next, seen) : [])];
}

const LEVEL_WORDS = {
  high: "high attack (crouching opponents duck under it)",
  mid: "mid attack (hits crouching opponents, blocked by standing guard)",
  low: "low attack (beats standing guard, blocked by crouching guard)",
  throw: "throw (beats any guard, misses crouching or sidestepping opponents, can be broken)",
};

export function speedWord(startup) {
  if (startup <= 10) return "very fast";
  if (startup <= 14) return "fast";
  if (startup <= 18) return "medium speed";
  return "slow, can be seen coming";
}

export function reachWord(range) {
  if (range >= 2.2) return "very long reach";
  if (range >= 1.7) return "long reach";
  if (range >= 1.3) return "medium reach";
  return "short reach";
}

export function safetyWord(m) {
  const adv = blockAdvantage(m);
  if (m.level === "throw") return "leaves you open if it misses";
  if (adv >= -5) return "safe if blocked";
  if (adv >= -9) return "slightly unsafe if blocked";
  return "punishable if blocked";
}

export function describeMove(m, char) {
  const parts = [LEVEL_WORDS[m.level], speedWord(m.startup)];
  if (m.level !== "throw") {
    parts.push(reachWord(m.range));
    parts.push(m.tracking ? "tracks sidesteps" : "straight line, can be sidestepped");
  }
  parts.push(safetyWord(m));
  if (m.launch) parts.push("launches into a juggle combo");
  else if (m.launchOnCounter) parts.push("launches on counter-hit");
  if (m.knockdown) parts.push("knocks down");
  if (m.advance) parts.push("lunges forward");
  if (char && m.cancels) {
    const chain = stringFrom(char, m.id).slice(1);
    if (chain.length) parts.push(`continues into ${chain.map((x) => `${x.name} (${x.level})`).join(" then ")}`);
  }
  return `${m.name}: ${parts.join(", ")}`;
}

/** Compact frame-data line for the training HUD. */
export function frameLine(m) {
  if (m.level === "throw") return `${m.name}  i${m.startup}  throw  ${m.damage}dmg`;
  const adv = blockAdvantage(m);
  return `${m.name}  i${m.startup}  ${m.level}  ${m.damage}dmg  ${adv >= 0 ? "+" : ""}${adv} on block`;
}
