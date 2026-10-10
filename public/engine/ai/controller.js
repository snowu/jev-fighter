// AIController: the "hands". Runs every frame and turns the latest brain Plan into inputs.
//
//   brain (Jev, ~3 Hz, async)  -> Plan of probability distributions (tactic, contingencies)
//   controller (60 Hz, sync)   -> samples those distributions when events happen
//
// It perceives the opponent through a reaction delay (it reacts to what it saw
// `reaction` frames ago), so fast moves have to be guessed and slow ones can be read,
// just like for a human. Frame math (punishes, reach) is exact code, not the model.

import { NEUTRAL_INPUT, distance, snapshot } from "../sim/world.js";
import { BODY_RADIUS } from "../sim/constants.js";
import { ATTACK_SLOTS, starter, maxReach, fastestStrike } from "../sim/moves.js";
import { OpponentModel } from "./opponentModel.js";
import { sample, chance, randInt } from "./sampling.js";

export const DIFFICULTY = {
  easy: { reaction: 1.45, read: 0.5, punish: 0.55, rate: 0.7, label: "Easy" },
  normal: { reaction: 1, read: 1, punish: 1, rate: 1, label: "Normal" },
  hard: { reaction: 0.75, read: 1.3, punish: 1.1, rate: 1.15, label: "Hard" },
};

const NOTABLE = new Set(["hit", "block", "whiff", "duck", "throw", "tech", "guardbreak"]);
const reachOf = (m) => m.range + BODY_RADIUS + (m.advance ?? 0);

export class AIController {
  /** skill: optional override of the character's ai skill numbers (e.g. for fair balance tests). */
  constructor({ side, brain, rng, difficulty = "normal", thinkEvery = 18, skill = null }) {
    this.skill = skill;
    this.side = side;
    this.brain = brain;
    this.rng = rng;
    this.diff = DIFFICULTY[difficulty] ?? DIFFICULTY.normal;
    this.thinkEvery = thinkEvery;
    this.model = new OpponentModel(side);
    this.history = [];
    this.queue = [];
    this.inbox = [];
    this.recent = [];
    this.plan = null;
    this.pending = null;
    this.lastThink = -999;
    this.urgent = true;
    this.epoch = -1;
    this.stats = { plans: 0, stale: 0, latency: [] };
    this.log = [];
    this.resetMemory();
  }

  resetMemory() {
    this.mem = {
      tactic: null, tacticUntil: 0, stance: "stand",
      guardUntil: 0, guardStance: "stand",
      queued: null, chain: null, cooldown: 0, backoffUntil: 0,
      wakeup: "getup_guard", techNow: false, punishKey: null,
    };
  }

  note(world, msg) {
    this.log.push({ frame: world.frame, msg });
    if (this.log.length > 10) this.log.shift();
  }

  get char() { return this.me.char; }
  get ai() { return this.skill ? { ...this.me.char.ai, ...this.skill } : this.me.char.ai; }
  get reaction() { return Math.round(this.ai.reactionFrames * this.diff.reaction); }
  get shape() { return { temperature: this.ai.temperature, floor: this.ai.floor }; }

  /** Call once per frame after world step; returns this fighter's input for the next step. */
  update(world) {
    this.me = world.fighters[this.side];
    this.opp = world.fighters[1 - this.side];
    const f = world.frame;

    this.model.observe(world);
    if (world.epoch !== this.epoch) { this.epoch = world.epoch; this.urgent = true; }
    this.history.push(snapshot(this.opp));
    if (this.history.length > 90) this.history.shift();

    for (const e of world.events) {
      if (NOTABLE.has(e.type)) { this.recent.push(e); if (this.recent.length > 6) this.recent.shift(); }
      // Things I do or that happen to me are felt instantly; the opponent's actions are seen late.
      const instant = e.who === this.side || e.target === this.side && e.type !== "grab";
      this.queue.push({ at: f + (instant ? 0 : this.reaction), e });
    }

    this.maybeThink(world);
    this.applyPlans(world);
    if (world.phase !== "fight") {
      if (world.phase === "intro") this.resetMemory();
      this.queue = [];
      return { ...NEUTRAL_INPUT };
    }

    const due = this.queue.filter((q) => q.at <= f);
    this.queue = this.queue.filter((q) => q.at > f);
    for (const { e } of due) this.handle(world, e);
    return this.act(world);
  }

  // ---- brain scheduling -------------------------------------------------------

  maybeThink(world) {
    if (this.pending || world.phase === "over") return;
    if (!this.urgent && world.frame - this.lastThink < this.thinkEvery) return;
    this.urgent = false;
    this.lastThink = world.frame;
    const issued = { frame: world.frame, epoch: world.epoch };
    const ctx = { world, side: this.side, model: this.model, rng: this.rng, recentEvents: this.recent.slice(-4) };
    this.pending = this.brain.think(ctx)
      .then((plan) => {
        const delay = Math.ceil((plan.latencyMs ?? 0) * 60 / 1000);
        this.inbox.push({ plan, applyAt: issued.frame + delay, epoch: issued.epoch });
      })
      .catch((err) => this.note(world, `brain error: ${err.message ?? err}`))
      .finally(() => { this.pending = null; });
  }

  applyPlans(world) {
    const ready = this.inbox.filter((i) => i.applyAt <= world.frame);
    if (!ready.length) return;
    this.inbox = this.inbox.filter((i) => i.applyAt > world.frame);
    const latest = ready.at(-1);
    // Freshness: a plan asked before a knockdown / launch / new round describes a world that no longer exists.
    if (latest.epoch !== world.epoch && this.plan) { this.stats.stale++; return; }
    this.setPlan(world, latest.plan);
  }

  setPlan(world, plan) {
    this.plan = plan;
    this.stats.plans++;
    if (plan.latencyMs) { this.stats.latency.push(plan.latencyMs); if (this.stats.latency.length > 50) this.stats.latency.shift(); }
    const inc = plan.incoming;
    this.mem.stance = chance(inc.crouch_guard / Math.max(1e-6, inc.crouch_guard + inc.stand_guard), this.rng) ? "crouch" : "stand";
    if (world.frame >= this.mem.tacticUntil || !this.mem.tactic) {
      const prev = this.mem.tactic;
      this.mem.tactic = sample(plan.tactic, this.rng, this.shape);
      this.mem.tacticUntil = world.frame + randInt(50, 110, this.rng);
      if (this.mem.tactic !== prev) this.note(world, `tactic → ${this.mem.tactic} (${plan.source})`);
    }
  }

  // ---- reactions to perceived events -------------------------------------------

  handle(world, e) {
    const { me, opp, plan, mem, rng } = this;
    if (!plan) return;
    const f = world.frame;

    if (e.type === "attack_start" && e.who === opp.side) {
      if (me.state !== "idle" && me.state !== "blockstun") return;
      const m = opp.char.moves[e.move];
      const framesToActive = m.startup - this.reaction;
      if (framesToActive + m.active < 0) return; // already over by the time we noticed
      const read = chance(Math.min(0.97, this.ai.readSkill * this.diff.read), rng);
      const correct = m.level === "mid" ? "stand" : "crouch";
      let r = sample(plan.incoming, rng, this.shape);
      if (read && r === "sidestep" && m.tracking) r = correct === "stand" ? "stand_guard" : "crouch_guard";
      if (r === "counter_attack" && me.state === "blockstun") r = "stand_guard";
      if (r === "stand_guard" || r === "crouch_guard") {
        mem.guardStance = read ? correct : r === "crouch_guard" ? "crouch" : "stand";
        mem.guardUntil = f + Math.max(0, framesToActive) + m.active + 6;
        mem.queued = null;
        this.note(world, `${read ? "read" : "guess"} ${m.level} → ${mem.guardStance} guard`);
      } else if (r === "sidestep" || r === "backdash") {
        mem.queued = r === "sidestep" ? { sidestep: chance(0.5, rng) ? 1 : -1 } : { backdash: true };
        this.note(world, `${r} vs ${m.name}`);
      } else {
        const fast = fastestStrike(me.char);
        mem.queued = { attack: ATTACK_SLOTS.find((s) => starter(me.char, s) === fast) };
        this.note(world, `counter-attack vs ${m.name}${fast.startup < framesToActive ? "" : " (gamble)"}`);
      }
      return;
    }

    if (e.type === "attack_start" && e.who === me.side && e.chained) { mem.chain = null; return; }

    if (e.type === "block" && e.who === me.side) {
      const r = sample(plan.afterBlocked, rng, this.shape);
      const cancels = me.move?.cancels;
      if (r === "keep_attacking" && cancels) { mem.chain = this.pickChain(cancels); this.note(world, "blocked → finish string"); }
      else if (r === "keep_attacking") { mem.queued = { attack: sample(plan.attack, rng, { ...this.shape, only: ["light", "low", "heavy"] }) }; this.note(world, "blocked → attack again"); }
      else if (r === "throw") { mem.queued = { attack: "throw" }; this.note(world, "blocked → throw"); }
      else if (r === "guard") { mem.guardUntil = f + 25; mem.guardStance = mem.stance; this.note(world, "blocked → guard"); }
      else { mem.queued = r === "sidestep" ? { sidestep: chance(0.5, rng) ? 1 : -1 } : { backdash: true }; this.note(world, `blocked → ${r}`); }
      return;
    }

    if (e.type === "hit" && e.who === me.side) {
      const cancels = me.move?.cancels;
      if (cancels && e.result !== "ko" && chance(this.ai.confirmSkill, rng)) { mem.chain = this.pickChain(cancels); }
      if (e.result === "launch" && e.combo === 1) this.note(world, "launched! juggle");
      return;
    }

    if (e.type === "knockdown" && e.who === me.side) {
      mem.wakeup = sample(plan.wakeup, rng, this.shape);
      this.note(world, `wake-up plan: ${mem.wakeup}`);
      return;
    }

    if (e.type === "knockdown" && e.by === me.side && chance(plan.taunt * 0.6, rng)) {
      mem.queued = { taunt: true };
      this.note(world, "taunt!");
      return;
    }

    if (e.type === "grab" && e.target === me.side) {
      mem.techNow = chance(plan.tech, rng);
      if (mem.techNow) this.note(world, "break throw");
    }
  }

  /** Prefer follow-ups that end in a launch or knockdown. */
  pickChain(cancels) {
    const entries = Object.entries(cancels);
    entries.sort(([, a], [, b]) => {
      const score = (id) => (this.me.char.moves[id].launch ? 2 : this.me.char.moves[id].knockdown ? 1 : 0);
      return score(b) - score(a);
    });
    return chance(0.75, this.rng) ? entries[0][0] : entries[randInt(0, entries.length - 1, this.rng)][0];
  }

  // ---- per-frame action ----------------------------------------------------------

  act(world) {
    const { me, opp, mem, rng } = this;
    const f = world.frame;
    const input = { ...NEUTRAL_INPUT, wakeup: mem.wakeup };
    const dist = distance(me, opp);

    if (me.state === "grabbed") { if (mem.techNow) input.attack = "throw"; return input; }
    if (me.state === "attack") { if (mem.chain) input.attack = mem.chain; return input; }
    if (me.state === "blockstun") { input.crouch = (f < mem.guardUntil ? mem.guardStance : mem.stance) === "crouch"; return input; }
    if (me.state !== "idle") return input;
    mem.chain = null;
    mem.techNow = false;
    if (!this.plan) return input;

    if (mem.queued) {
      Object.assign(input, mem.queued);
      mem.queued = null;
      return input;
    }

    const punish = this.findPunish(world, dist);
    if (punish) { input.attack = punish; return input; }

    // Juggle: get in range and start a string; hit-confirms keep it going.
    if (opp.state === "juggle") {
      const light = starter(me.char, "light");
      if (dist > reachOf(light) - 0.1) input.move = 1;
      else input.attack = "light";
      return input;
    }

    if (f < mem.guardUntil) { input.crouch = mem.guardStance === "crouch"; return input; }

    return this.runTactic(world, input, dist);
  }

  findPunish(world, dist) {
    const view = this.history[this.history.length - 1 - this.reaction];
    if (!view) return null;
    const open = (view.state === "attack" && view.phase === "recovery") || view.state === "taunt" || view.state === "guardbreak";
    if (!open) return null;
    const remaining = view.actionableIn - this.reaction;
    const key = `${view.state}:${view.moveId}:${world.frame - view.frame - this.reaction}`;
    if (this.mem.punishKey?.key !== key) {
      this.mem.punishKey = { key, go: chance(Math.min(0.98, this.ai.punishSkill * this.diff.punish), this.rng) };
    }
    if (!this.mem.punishKey.go) return null;
    let best = null, bestValue = -1;
    for (const slot of ATTACK_SLOTS) {
      const m = starter(this.me.char, slot);
      if (m.startup + 1 > remaining) continue;
      if (m.level === "throw" ? dist > 1.05 : reachOf(m) < dist) continue;
      const value = m.damage + (m.launch ? 14 : 0) + (m.cancels ? 6 : 0);
      if (value > bestValue) { best = slot; bestValue = value; }
    }
    if (best) this.note(world, `punish ${view.moveId ?? view.state} with ${starter(this.me.char, best).name}`);
    return best;
  }

  runTactic(world, input, dist) {
    const { me, opp, mem, rng, plan } = this;
    const f = world.frame;
    const aggression = plan.aggression ?? 0.5;
    const myReach = maxReach(me.char) + BODY_RADIUS;
    const oppReach = maxReach(opp.char) + BODY_RADIUS;
    const fastReach = reachOf(fastestStrike(me.char));
    let target, rate, bias = {};

    switch (mem.tactic) {
      case "pressure": target = Math.max(0.85, fastReach - 0.3); rate = 1.5; bias = { light: 1.5 }; break;
      case "poke": target = myReach - 0.15; rate = 1.0; break;
      case "bait": target = Math.floor(f / 40) % 2 ? oppReach + 0.6 : oppReach - 0.05; rate = 0.25; break;
      case "mixup": target = 0.95; rate = 1.3; bias = { low: 2, throw: 2, heavy: 1.3 }; break;
      case "throw_rush": target = 0.8; rate = 1.0; bias = { throw: 5 }; break;
      case "circle": target = oppReach + 0.1; rate = 0.5; if (chance(1 / 45, rng)) input.sidestep = chance(0.5, rng) ? 1 : -1; break;
      case "retreat": target = oppReach + 1.3; rate = 0.1; break;
      default: target = oppReach + 0.25; rate = 0.15; // turtle
    }
    if (opp.state === "knockdown") { target = fastReach - 0.1; rate = 0; }
    if (f < mem.backoffUntil) target = myReach + 0.3;

    // Rushdown tactics dash in from just outside the opponent's reach (risky: dashing isn't guarding).
    const rushing = mem.tactic === "pressure" || mem.tactic === "mixup" || mem.tactic === "throw_rush";
    if (rushing && dist > oppReach - 0.2 && dist < oppReach + 1.2 && dist > target + 0.8 && chance(0.04 + 0.08 * aggression, rng)) {
      input.dash = true;
      return input;
    }
    if (dist > target + 0.15) {
      // Inside the opponent's reach, walking forward drops your guard: approach in short steps.
      const exposed = dist < oppReach + 0.2;
      input.move = !exposed || Math.floor(f / 8) % (aggression > 0.6 ? 2 : 3) === 0 ? 1 : 0;
    } else if (dist < target - 0.2) input.move = -1;
    input.crouch = input.move === 0 && mem.stance === "crouch";

    // Only attack around the tactic's chosen distance (pokers and baiters may swing from further out).
    const inBand = dist <= target + 0.45 || mem.tactic === "poke" || mem.tactic === "bait";
    if (rate > 0 && inBand && f >= mem.cooldown && chance(0.03 * rate * (0.35 + 1.3 * aggression) * this.diff.rate, rng)) {
      const reachable = ATTACK_SLOTS.filter((s) => {
        const m = starter(me.char, s);
        return m.level === "throw" ? dist <= 1.05 : reachOf(m) >= dist;
      });
      if (reachable.length) {
        const weights = Object.fromEntries(Object.entries(plan.attack).map(([k, p]) => [k, p * (bias[k] ?? 1)]));
        const slot = sample(weights, rng, { ...this.shape, only: reachable });
        input.attack = slot;
        input.move = 0;
        input.crouch = false;
        mem.cooldown = f + Math.round(randInt(6, 26, rng) * (1.4 - aggression));
        if (mem.tactic === "poke") mem.backoffUntil = f + 35;
      }
    }
    return input;
  }

  debugInfo() {
    const lat = this.stats.latency;
    return {
      brain: this.brain.name, plan: this.plan, tactic: this.mem.tactic, stance: this.mem.stance,
      reaction: this.reaction, log: this.log, plans: this.stats.plans, stale: this.stats.stale,
      latency: lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : null,
      habits: this.model.habits(), thinking: !!this.pending,
    };
  }
}

/** Training dummy: fixed behaviours for practising combos and punishes. */
export class DummyController {
  constructor({ side, mode = "stand" }) { this.side = side; this.mode = mode; }
  update(world) {
    const input = { ...NEUTRAL_INPUT };
    const me = world.fighters[this.side];
    if (world.phase !== "fight") return input;
    switch (this.mode) {
      case "crouch": input.crouch = true; break;
      case "random": input.crouch = Math.floor(world.frame / 50) % 2 === 1; break;
      case "open": input.move = 1; break; // walking forward = never guarding
      case "attack": if (me.state === "idle" && world.frame % 70 === 0) input.attack = "heavy"; break; // practise punishing
      default: break; // stand guard
    }
    if (me.state === "grabbed" && this.mode === "random" && world.frame % 2) input.attack = "throw";
    return input;
  }
  debugInfo() { return { brain: "dummy", tactic: this.mode, log: [] }; }
}
