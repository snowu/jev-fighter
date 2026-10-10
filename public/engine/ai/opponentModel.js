// Tracks what the opponent actually does, from one fighter's point of view.
// All counting happens here in code (Jev is unreliable at counting); the brain
// receives short phrases like "crouched against 4 of your last 5 attacks".

const WINDOW = 8;

class Tally {
  constructor() { this.items = []; }
  add(x) { this.items.push(x); if (this.items.length > WINDOW) this.items.shift(); }
  count(x) { return this.items.filter((i) => i === x).length; }
  get n() { return this.items.length; }
  top() {
    const counts = {};
    for (const i of this.items) counts[i] = (counts[i] ?? 0) + 1;
    return Object.entries(counts).sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
  }
}

export class OpponentModel {
  constructor(side) {
    this.me = side;
    this.opp = 1 - side;
    this.defense = new Tally();     // how they handled my attacks
    this.offense = new Tally();     // levels of attacks they start
    this.afterBlock = new Tally();  // what they do right after blocking my attack
    this.wakeup = new Tally();      // their wake-up choices
    this.throwBreaks = new Tally(); // did they break my throws
    this.stringEnds = new Tally();  // when their string starter is blocked: continue or stop
    this.whiffs = new Tally();      // whether their attacks missed
    this.walk = { fwd: 0, back: 0 };
    this.watchAfterBlock = null;    // frame window while we wait for their first action
    this.watchString = null;
  }

  /** Call once per frame with the world (after step). */
  observe(world) {
    const opp = world.fighters[this.opp];
    if (opp.state === "idle") {
      if (opp.walking > 0) this.walk.fwd++;
      else if (opp.walking < 0) this.walk.back++;
      this.walk.fwd *= 0.998;
      this.walk.back *= 0.998;
    }
    if (this.watchAfterBlock && world.frame > this.watchAfterBlock.until) {
      this.afterBlock.add("guard");
      this.watchAfterBlock = null;
    }
    if (this.watchString && world.frame > this.watchString.until) {
      this.stringEnds.add("stop");
      this.watchString = null;
    }

    for (const e of world.events) {
      const mine = e.who === this.me, theirs = e.who === this.opp;
      switch (e.type) {
        case "attack_start":
          if (theirs) {
            if (!e.chained) this.offense.add(e.level);
            if (this.watchAfterBlock) { this.afterBlock.add(e.level === "throw" ? "throw" : "attack"); this.watchAfterBlock = null; }
            if (this.watchString && e.chained) { this.stringEnds.add("continue"); this.watchString = null; }
          }
          break;
        case "sidestep":
        case "backdash":
          if (theirs && this.watchAfterBlock) { this.afterBlock.add(e.type); this.watchAfterBlock = null; }
          break;
        case "block":
          if (mine) {
            this.defense.add(e.crouching ? "crouch_guard" : "stand_guard");
            this.watchAfterBlock = { until: world.frame + 40 };
          } else if (theirs) {
            this.watchString = { until: world.frame + 30 };
          }
          break;
        case "duck":
          if (e.attacker === this.me) this.defense.add("crouch_guard");
          break;
        case "hit":
          if (mine && e.combo === 1) this.defense.add("got_hit");
          if (theirs) this.whiffs.add("hit");
          break;
        case "whiff":
          if (mine && !e.ducked) this.defense.add(e.evadedBy === "sidestep" ? "sidestep" : e.evadedBy === "backdash" ? "backdash" : "out_of_range");
          if (theirs) this.whiffs.add("whiff");
          break;
        case "wakeup":
          if (theirs) this.wakeup.add(e.choice);
          break;
        case "tech":
          if (e.who === this.opp) this.throwBreaks.add("broke");
          break;
        case "throw":
          if (mine) this.throwBreaks.add("thrown");
          break;
      }
    }
  }

  /** Short factual phrases about the opponent's habits, strongest first. */
  habits() {
    const out = [];
    const d = this.defense;
    if (d.n >= 3) {
      const [k, c] = d.top();
      const words = {
        stand_guard: "guarded standing against", crouch_guard: "crouched against", sidestep: "sidestepped",
        backdash: "backdashed away from", got_hit: "got hit by", out_of_range: "stayed out of range of",
      };
      if (c >= 2) out.push({ w: c / d.n, text: `they ${words[k]} ${c} of your last ${d.n} attacks` });
    }
    const o = this.offense;
    if (o.n >= 3) {
      const [k, c] = o.top();
      const name = k === "throw" ? "throws" : `${k} attacks`;
      if (c / o.n >= 0.4) out.push({ w: c / o.n, text: `${c} of their last ${o.n} attacks were ${name}` });
    }
    const ab = this.afterBlock;
    if (ab.n >= 2) {
      const [k, c] = ab.top();
      const words = { attack: "attacked back immediately", throw: "tried a throw", guard: "kept guarding", sidestep: "sidestepped", backdash: "backdashed" };
      if (c >= 2) out.push({ w: c / ab.n, text: `after blocking your attack, they ${words[k]} ${c} of ${ab.n} times` });
    }
    const wk = this.wakeup;
    if (wk.n >= 2) {
      const [k, c] = wk.top();
      const words = { getup_guard: "stood up guarding", roll: "rolled away", wakeup_attack: "attacked while getting up" };
      out.push({ w: c / wk.n, text: `when knocked down they ${words[k]} ${c} of ${wk.n} times` });
    }
    const tb = this.throwBreaks;
    if (tb.n >= 2) out.push({ w: 0.6, text: `they broke ${tb.count("broke")} of your ${tb.n} throws` });
    const se = this.stringEnds;
    if (se.n >= 2) {
      const cont = se.count("continue");
      out.push({ w: Math.abs(cont / se.n - 0.5) + 0.3, text: cont / se.n >= 0.5 ? `they finish their strings even when blocked (${cont} of ${se.n})` : `they stop their strings early when blocked (${se.n - cont} of ${se.n})` });
    }
    const wh = this.whiffs;
    if (wh.n >= 4 && wh.count("whiff") >= wh.n / 2) out.push({ w: 0.7, text: `${wh.count("whiff")} of their last ${wh.n} attacks missed` });
    const { fwd, back } = this.walk;
    if (fwd > 120 && fwd > back * 2) out.push({ w: 0.5, text: "they keep walking forward into you" });
    else if (back > 120 && back > fwd * 2) out.push({ w: 0.5, text: "they keep backing away from you" });
    return out.sort((a, b) => b.w - a.w).slice(0, 4).map((h) => h.text);
  }

  /** Normalised tendencies for the local (non-Jev) brain. */
  tendencies() {
    const d = this.defense, o = this.offense, ab = this.afterBlock;
    const frac = (t, k) => (t.n ? t.count(k) / t.n : 0);
    return {
      standGuard: frac(d, "stand_guard"),
      crouchGuard: frac(d, "crouch_guard"),
      sidesteps: frac(d, "sidestep"),
      lowAttacks: frac(o, "low"),
      highAttacks: frac(o, "high"),
      throws: frac(o, "throw"),
      mashesAfterBlock: frac(ab, "attack") + frac(ab, "throw"),
      whiffy: frac(this.whiffs, "whiff"),
    };
  }
}
