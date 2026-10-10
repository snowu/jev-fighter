// Turns the live simulation into the compact, worded situation Jev reasons over.
// Numbers are bucketed into words here; Jev is weak at raw numbers and distractors.

import { ARENA_RADIUS, GUARD_MAX } from "../sim/constants.js";
import { distance, attackPhase, isCrouching } from "../sim/world.js";
import { maxReach, fastestStrike } from "../sim/moves.js";

export function distanceWords(d, me, opp) {
  const myReach = maxReach(me.char) + 0.3, oppReach = maxReach(opp.char) + 0.3;
  const myFast = fastestStrike(me.char).range + 0.3, oppFast = fastestStrike(opp.char).range + 0.3;
  if (d <= 1.05) return "point blank: close enough to throw";
  if (d <= Math.min(myFast, oppFast)) return "close: inside both fighters' fast attacks";
  if (d <= myReach && d > oppReach) return "your longest attacks reach the opponent but none of theirs reach you";
  if (d <= oppReach && d > myReach) return "the opponent's longest attacks reach you but none of yours reach them";
  if (d <= myReach && d <= oppReach) return "mid range: both fighters' longer attacks reach";
  return "far: out of range for both fighters";
}

export function healthWords(f) {
  const r = f.hp / f.char.hp;
  if (r >= 0.85) return "nearly full";
  if (r >= 0.6) return "most of it left";
  if (r >= 0.35) return "about half";
  if (r >= 0.15) return "low";
  return "critical, one or two hits from losing";
}

function guardWords(f) {
  const r = f.guard / GUARD_MAX;
  if (r > 0.6) return "solid";
  if (r > 0.3) return "worn down";
  return "about to break";
}

function backToEdge(f, o) {
  const r = Math.hypot(f.x, f.z);
  if (r < ARENA_RADIUS - 1.4) return false;
  const away = Math.atan2(f.z - o.z, f.x - o.x);
  return (f.x * Math.cos(away) + f.z * Math.sin(away)) / r > 0.5;
}

export function stateWords(f, viewer) {
  const m = f.move;
  switch (f.state) {
    case "idle":
      if (isCrouching(f)) return "crouching with guard up";
      if (f.walking > 0) return "walking forward";
      if (f.walking < 0) return "backing away with guard up";
      return "standing with guard up";
    case "attack": {
      const phase = attackPhase(f);
      if (phase === "recovery") return `recovering from ${m.name}, open to punishment`;
      return `attacking with ${m.name} (${m.level})`;
    }
    case "blockstun": return "blocking an attack";
    case "hitstun": return "reeling from a hit";
    case "juggle": return "launched in the air";
    case "knockdown": return "knocked down on the floor";
    case "guardbreak": return "guard broken, defenceless";
    case "sidestep": return "sidestepping";
    case "backdash": return "dashing backwards";
    case "roll": return "rolling away";
    case "taunt": return "taunting";
    case "grabbing": return "throwing";
    case "grabbed": return "being thrown";
    default: return f.state;
  }
}

function roundWords(world, side) {
  const mine = world.wins[side], theirs = world.wins[1 - side];
  const secs = Math.ceil(world.roundFrames / 60);
  const time = secs > 40 ? "plenty of time left" : secs > 15 ? "the clock is running down" : "only a few seconds left on the clock";
  let stakes = `round ${world.round}, you have won ${mine} rounds and the opponent ${theirs}; first to 2 wins`;
  if (mine === 1 && theirs === 1) stakes += "; this round decides the match";
  else if (theirs === 1) stakes += "; losing this round loses the match";
  else if (mine === 1) stakes += "; winning this round wins the match";
  return `${stakes}; ${time}`;
}

const EVENT_WORDS = {
  hit: (e, me) => e.who === me
    ? `you landed ${e.counter ? "a counter-hit" : e.punish ? "a punish" : "a hit"}${e.combo > 1 ? ` (${e.combo}-hit combo)` : ""}`
    : `you got hit${e.counter ? " by a counter-hit" : ""}${e.combo > 1 ? ` (${e.combo}-hit combo)` : ""}`,
  block: (e, me) => (e.who === me ? "your attack was blocked" : "you blocked an attack"),
  whiff: (e, me) => (e.who === me ? "your attack missed" : "the opponent's attack missed"),
  duck: (e, me) => (e.who === me ? "you ducked under a high attack" : "the opponent ducked your high attack"),
  throw: (e, me) => (e.who === me ? "you threw the opponent" : "you got thrown"),
  tech: (e, me) => (e.who === me ? "you broke a throw" : "the opponent broke your throw"),
  guardbreak: (e, me) => (e.who === me ? "your guard broke" : "you broke the opponent's guard"),
};

/** Build the state object sent to Jev. */
export function describeSituation(world, side, model, recentEvents = []) {
  const me = world.fighters[side], opp = world.fighters[1 - side];
  const situation = {
    fighter: me.char.persona,
    weapon: me.char.weapon,
    opponent: `${opp.char.name}, ${opp.char.title}: ${opp.char.weapon}`,
    distance: distanceWords(distance(me, opp), me, opp),
    your_health: healthWords(me),
    opponent_health: healthWords(opp),
    your_guard_gauge: guardWords(me),
    opponent_guard_gauge: guardWords(opp),
    match: roundWords(world, side),
    you_now: stateWords(me),
    opponent_now: stateWords(opp),
  };
  const edges = [];
  if (backToEdge(me, opp)) edges.push("your back is near the arena edge");
  if (backToEdge(opp, me)) edges.push("the opponent's back is near the arena edge");
  if (edges.length) situation.position = edges.join("; ");
  const recent = recentEvents.map((e) => EVENT_WORDS[e.type]?.(e, side)).filter(Boolean).slice(-3);
  if (recent.length) situation.just_happened = recent;
  const habits = model.habits();
  if (habits.length) situation.opponent_habits = habits;
  return situation;
}
