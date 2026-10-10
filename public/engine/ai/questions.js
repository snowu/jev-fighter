// The Jev question set: one request = a fan-out of judgments.
// "Now" answers drive the tactic; contingency answers are cached so the reflex
// layer can react instantly when the event actually happens.

import { ATTACK_SLOTS, starter, describeMove } from "../sim/moves.js";
import { shuffled } from "./sampling.js";

export const TACTICS = {
  pressure: "Stay close and keep attacking with fast moves and strings",
  poke: "Stay at the edge of your longest reach and poke, backing off after each attack",
  bait: "Step in and out of the opponent's reach to make them swing and miss, then punish the miss",
  mixup: "Get close and alternate low attacks, mid attacks and throws so the opponent cannot guess how to guard",
  throw_rush: "Walk up and throw the opponent, because they keep guarding",
  turtle: "Guard and wait for the opponent to attack first, then punish",
  circle: "Sidestep around the opponent to dodge straight attacks and look for an opening",
  retreat: "Back off to reset the distance and let the guard gauge recover",
};

export const INCOMING = {
  stand_guard: "Guard standing (stops high and mid attacks, loses to low attacks and throws)",
  crouch_guard: "Guard crouching (stops low attacks, ducks high attacks and throws, loses to mid attacks)",
  sidestep: "Sidestep (dodges straight attacks, loses to tracking attacks)",
  backdash: "Dash backwards out of range",
  counter_attack: "Attack first with the fastest move (wins if the opponent's attack is slow, trades or loses if it is fast)",
};

export const AFTER_BLOCKED = {
  keep_attacking: "Continue the string or attack again right away (beats an opponent who presses buttons late, loses to a faster interruption or a duck)",
  throw: "Throw the opponent who is still guarding",
  guard: "Stop attacking and guard",
  sidestep: "Sidestep the opponent's counterattack",
  backdash: "Dash back out of range",
};

export const WAKEUP = {
  getup_guard: "Stand up guarding",
  roll: "Roll sideways away from the opponent",
  wakeup_attack: "Get up with an attack (beats pressure, punishable if blocked)",
};

const choice = (instructions, options, rng) => ({
  type: "choice",
  instructions,
  // Jev leans toward the first option, so the order is shuffled every request.
  criteria: Object.fromEntries(shuffled(Object.entries(options), rng)),
});

export function buildQuestions(char, rng) {
  const moves = Object.fromEntries(ATTACK_SLOTS.map((slot) => [slot, describeMove(starter(char, slot), char)]));
  return {
    tactic: choice(
      "Considering the fighter's personality, the situation and the opponent's habits, which plan does the fighter follow for the next couple of seconds?",
      TACTICS, rng),
    attack: choice(
      "When the fighter next attacks, which of its moves fits best against this opponent right now? Consider the opponent's habits and how they guard.",
      moves, rng),
    aggression: {
      type: "score",
      instructions: "How aggressively does the fighter play right now, given its personality and the situation?",
      criteria: [
        "Fully defensive: only guards and waits",
        "Cautious: mostly defends and attacks only clear openings",
        "Balanced between attacking and defending",
        "Aggressive: keeps up pressure and accepts some risk",
        "All-in: attacks relentlessly regardless of risk",
      ],
    },
    incoming: choice(
      "If the opponent starts an attack at the fighter right now, how does the fighter react? Consider which attacks the opponent tends to use.",
      INCOMING, rng),
    after_blocked: choice(
      "If the fighter's attack gets blocked, what does it do next? Consider how the opponent reacts after blocking.",
      AFTER_BLOCKED, rng),
    wakeup: choice(
      "If the fighter gets knocked down, how does it get up?",
      WAKEUP, rng),
    tech: {
      type: "noul",
      instructions: "Is the fighter alert to a throw right now, ready to break it (for example because the opponent throws often or has been walking up close)?",
    },
    taunt: {
      type: "noul",
      instructions: "If the fighter knocks the opponent down right now, would it waste time taunting?",
    },
  };
}
