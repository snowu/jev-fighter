// Brains produce a Plan: probability distributions the reflex controller samples from.
// Plan = { source, latencyMs, tactic, attack, aggression (0..1), incoming, afterBlocked, wakeup, tech, taunt }
//
// JevBrain asks TypeSafe's Jev; LocalBrain is a hand-tuned fallback with the same
// shape (used before Jev answers, offline, on errors, and in headless tests).

import { normalize } from "./sampling.js";
import { describeSituation } from "./perception.js";
import { buildQuestions, TACTICS } from "./questions.js";
import { ATTACK_SLOTS, starter } from "../sim/moves.js";

export class LocalBrain {
  constructor() { this.name = "local"; }

  async think(ctx) { return this.plan(ctx); }

  plan({ world, side, model }) {
    const me = world.fighters[side], opp = world.fighters[1 - side];
    const L = me.char.ai.local;
    const t = model.tendencies();
    const hp = me.hp / me.char.hp, oppHp = opp.hp / opp.char.hp;
    const reckless = L.aggression > 0.6;

    const tactics = Object.fromEntries(Object.keys(TACTICS).map((k) => [k, L.tactics[k] ?? 0.5]));
    if (hp < 0.35) {
      if (reckless) tactics.pressure *= 1.6;
      else { tactics.turtle *= 1.5; tactics.retreat *= 1.4; }
    }
    if (me.guard < 35) tactics.retreat *= 2.5;
    tactics.mixup *= 1 + 1.5 * t.standGuard;
    tactics.throw_rush *= 1 + 1.5 * t.standGuard;
    tactics.pressure *= 1 + t.crouchGuard;
    tactics.bait *= 1 + 1.5 * t.whiffy;
    tactics.circle *= 1 + t.highAttacks;

    const attack = {};
    for (const slot of ATTACK_SLOTS) {
      const lvl = starter(me.char, slot).level;
      let w = slot === "light" ? 1.5 : 1;
      if (lvl === "low") w *= 1 + 2 * t.standGuard;
      if (lvl === "mid") w *= 1 + 2 * t.crouchGuard;
      if (lvl === "throw") w *= 0.6 + 2 * t.standGuard;
      if (lvl === "high") w *= 1 - 0.7 * t.crouchGuard;
      attack[slot] = w;
    }

    const incoming = { ...L.incoming };
    incoming.crouch_guard *= 1 + 2 * (t.lowAttacks + t.throws + t.highAttacks * 0.5);
    incoming.stand_guard *= 1 + 1.5 * (1 - t.lowAttacks);
    const afterBlocked = { ...L.afterBlocked };
    afterBlocked.guard *= 1 + 2 * t.mashesAfterBlock;
    afterBlocked.keep_attacking *= 1 + (1 - t.mashesAfterBlock);

    let aggression = L.aggression;
    if (reckless && hp < 0.4) aggression += 0.15;
    if (!reckless && hp < oppHp - 0.2) aggression += 0.1;
    if (world.roundFrames < 600 && hp < oppHp) aggression += 0.2;

    return {
      source: "local", latencyMs: 0,
      tactic: normalize(tactics), attack: normalize(attack),
      aggression: Math.min(1, aggression),
      incoming: normalize(incoming), afterBlocked: normalize(afterBlocked), wakeup: normalize(L.wakeup),
      tech: Math.min(0.95, L.tech + 0.5 * t.throws), taunt: L.taunt,
    };
  }
}

export class JevBrain {
  /** transport({ state, questions }) -> Promise<{ answers, model, latencyMs? }> */
  constructor({ transport, fallback = new LocalBrain() }) {
    this.name = "jev";
    this.transport = transport;
    this.fallback = fallback;
    this.errors = 0;
    this.lastError = null;
  }

  async think(ctx) {
    const { world, side, model, rng, recentEvents } = ctx;
    const state = describeSituation(world, side, model, recentEvents);
    const questions = buildQuestions(world.fighters[side].char, rng);
    const t0 = performance.now();
    try {
      const res = await this.transport({ state, questions });
      const a = res.answers;
      return {
        source: "jev", latencyMs: res.latencyMs ?? performance.now() - t0, model: res.model,
        tactic: a.tactic.probabilities, attack: a.attack.probabilities,
        aggression: a.aggression.score / 4,
        incoming: a.incoming.probabilities, afterBlocked: a.after_blocked.probabilities, wakeup: a.wakeup.probabilities,
        tech: a.tech.noul, taunt: a.taunt.noul,
        confidence: { tactic: a.tactic.confidence, attack: a.attack.confidence, incoming: a.incoming.confidence },
        state,
      };
    } catch (err) {
      this.errors++;
      this.lastError = String(err.message ?? err);
      return { ...this.fallback.plan(ctx), source: "local (jev error)", error: this.lastError };
    }
  }
}

/** Browser transport: goes through the local proxy so the API key never reaches the page. */
export const proxyTransport = (url = "/api/brain") => async (payload) => {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  if (!res.ok) throw new Error(`proxy ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
};
