// Combat mechanics tests: node --test tools/
import test from "node:test";
import assert from "node:assert/strict";
import { createWorld, step, NEUTRAL_INPUT } from "../public/engine/sim/world.js";
import { getCharacter } from "../public/engine/roster/index.js";
import { blockAdvantage } from "../public/engine/sim/moves.js";

const kara = getCharacter("kara"), sen = getCharacter("sen"), tove = getCharacter("tove");

/** World already in the fight phase with fighters `gap` metres apart. */
function arena(a = kara, b = sen, gap = 1.2) {
  const w = createWorld(a, b);
  w.phase = "fight";
  w.fighters[0].x = -gap / 2;
  w.fighters[1].x = gap / 2;
  return w;
}

/** Run `frames` frames; script(frame) returns [inputA, inputB] partials. Collects events. */
function run(w, frames, script = () => [{}, {}]) {
  const events = [];
  for (let i = 0; i < frames; i++) {
    const [ia = {}, ib = {}] = script(i) ?? [];
    step(w, [{ ...NEUTRAL_INPUT, ...ia }, { ...NEUTRAL_INPUT, ...ib }]);
    events.push(...w.events);
  }
  return events;
}
/** Presses each slot in turn as soon as the previous one has come out (string / combo driver). */
function presser(slots, extra = {}) {
  const queue = [...slots];
  return { input: () => ({ ...extra, attack: queue[0] ?? null }), onEvents: (ev, who = 0) => { if (ev.some((e) => e.type === "attack_start" && e.who === who)) queue.shift(); }, queue };
}
function runCombo(w, frames, p, defender = () => ({})) {
  const events = [];
  for (let i = 0; i < frames; i++) {
    step(w, [{ ...NEUTRAL_INPUT, ...p.input(i) }, { ...NEUTRAL_INPUT, ...defender(i) }]);
    p.onEvents(w.events);
    events.push(...w.events);
  }
  return events;
}
const of = (events, type) => events.filter((e) => e.type === type);

test("Kara's jab string is a natural 3-hit combo ending in knockdown", () => {
  const w = arena();
  const ev = runCombo(w, 120, presser(["light", "light", "heavy"]), () => ({ move: 1 }));
  const hits = of(ev, "hit");
  assert.deepEqual(hits.map((h) => h.move), ["jab", "jab2", "finisher"]);
  assert.deepEqual(hits.map((h) => h.combo), [1, 2, 3]);
  assert.equal(hits[2].result, "knockdown");
  assert.ok(hits[2].damage < kara.moves.finisher.damage, "3rd hit is damage-scaled");
});

test("a blocked high string can be ducked mid-string, leaving the attacker to whiff", () => {
  const w = arena();
  // Defender guards standing, then holds crouch once the first hit is blocked.
  const ev = run(w, 80, (i) => [{ attack: i === 0 || i === 6 ? "light" : null }, { crouch: i > 14 }]);
  assert.equal(of(ev, "block").length, 1);
  assert.equal(of(ev, "duck")[0]?.move, "jab2");
  assert.equal(of(ev, "hit").length, 0);
});

test("lows beat standing guard and are blocked crouching; mids beat crouching", () => {
  let w = arena(kara, sen, 1.6);
  assert.equal(of(run(w, 60, (i) => [{ attack: i === 0 ? "low" : null }, {}]), "hit")[0]?.level, "low");
  w = arena(kara, sen, 1.6);
  assert.equal(of(run(w, 60, (i) => [{ attack: i === 0 ? "low" : null }, { crouch: true }]), "block").length, 1);
  w = arena(kara, sen, 1.4);
  assert.equal(of(run(w, 60, (i) => [{ attack: i === 0 ? "special" : null }, { crouch: true }]), "hit").length, 1);
});

test("throws grab a standing guard, whiff on a crouch, and can be broken", () => {
  let w = arena(kara, sen, 0.8);
  assert.equal(of(run(w, 80, (i) => [{ attack: i === 0 ? "throw" : null }, {}]), "throw").length, 1);
  w = arena(kara, sen, 0.8);
  assert.equal(of(run(w, 60, (i) => [{ attack: i === 0 ? "throw" : null }, { crouch: true }]), "grab").length, 0);
  w = arena(kara, sen, 0.8);
  const ev = run(w, 80, (i) => [{ attack: i === 0 ? "throw" : null }, { attack: i === 18 ? "throw" : null }]);
  assert.equal(of(ev, "tech").length, 1);
  assert.equal(of(ev, "throw").length, 0);
});

test("sidestep dodges a straight attack but not a tracking one", () => {
  let w = arena(sen, kara, 1.6);
  // Kara's Overhead Cleave (linear, i22) vs Sen sidestepping right away.
  let ev = run(w, 70, (i) => [{ sidestep: i === 0 ? 1 : 0 }, { attack: i === 0 ? "heavy" : null }]);
  assert.equal(of(ev, "hit").length, 0);
  assert.equal(of(ev, "whiff")[0]?.move, "overhead");
  w = arena(sen, kara, 1.4);
  // Whirlwind (i18, tracking) catches Sen in the middle of her sidestep.
  ev = run(w, 70, (i) => [{ sidestep: i === 8 ? 1 : 0 }, { attack: i === 0 ? "special" : null }]);
  assert.equal(of(ev, "hit")[0]?.move, "whirlwind");
});

test("hitting during startup is a counter-hit with bonus damage", () => {
  const w = arena(sen, kara, 1.3);
  // Kara starts the slow Whirlwind; Sen's quick draw lands during its startup.
  const ev = run(w, 40, (i) => [{ attack: i === 2 ? "light" : null }, { attack: i === 0 ? "special" : null }]);
  const hit = of(ev, "hit")[0];
  assert.equal(hit.who, 0);
  assert.equal(hit.counter, true);
  assert.ok(hit.damage > sen.moves.draw.damage);
});

test("launcher into juggle: extra hits keep the opponent airborne and count as a combo", () => {
  const w = arena(kara, sen, 1.5);
  // Shin Chop -> Haft Lift launch, then jab -> jab2 -> finisher in the air.
  const ev = runCombo(w, 160, presser(["low", "heavy", "light", "light", "heavy"], { move: 1 }));
  const hits = of(ev, "hit");
  assert.equal(hits[1].result, "launch");
  assert.ok(hits.length >= 4, `expected a juggle, got ${hits.map((h) => h.move)}`);
  assert.equal(hits.at(-1).combo, hits.length);
});

test("blocking a punishable move lets the defender punish during recovery", () => {
  const w = arena(sen, kara, 1.5);
  // Kara overhead (-16 on block) at max range: pushback puts Sen out of jab range, so she punishes with the lunge.
  const ev = run(w, 80, (i) => [{ attack: i > 26 && i < 60 ? "fwd_heavy" : null }, { attack: i === 0 ? "heavy" : null }]);
  const block = of(ev, "block")[0];
  assert.equal(block.advantage, blockAdvantage(kara.moves.overhead));
  const punish = of(ev, "hit").find((h) => h.who === 0);
  assert.ok(punish?.punish, "Sen's Iai Lunge should land as a recovery punish");
});

test("repeated blocking breaks the guard", () => {
  const w = arena(kara, sen, 1.6);
  const ev = run(w, 600, (i) => [{ attack: i % 60 === 0 ? "heavy" : null, move: 1 }, {}]);
  assert.ok(of(ev, "guardbreak").length >= 1);
});

test("rounds end on KO and the match ends at two wins", () => {
  const w = createWorld(tove, sen, { roundFrames: 300 });
  const ev = run(w, 3000);
  assert.equal(of(ev, "round_end").length >= 2, true);
  assert.equal(w.phase, "over");
});

// ---- character signatures ------------------------------------------------------------

test("directional presses pick the variant, and fall back to the plain button", () => {
  let w = arena(sen, kara, 1.5);
  assert.equal(of(run(w, 5, (i) => [{ attack: i === 0 ? "fwd_heavy" : null }, {}]), "attack_start")[0].move, "iai");
  w = arena(sen, kara, 1.5);
  assert.equal(of(run(w, 5, (i) => [{ attack: i === 0 ? "fwd_light" : null }, {}]), "attack_start")[0].move, "draw");
  // A held direction must not stop a throw break.
  w = arena(kara, sen, 0.8);
  const ev = run(w, 80, (i) => [{ attack: i === 0 ? "throw" : null }, { attack: i === 18 ? "back_throw" : null }]);
  assert.equal(of(ev, "tech").length, 1);
});

test("Kara's armor absorbs one high/mid hit and the swing still lands; a low goes through", () => {
  let w = arena(sen, kara, 1.3);
  // Sen jabs into the armored Overhead Cleave.
  let ev = run(w, 50, (i) => [{ attack: i === 2 ? "light" : null }, { attack: i === 0 ? "heavy" : null }]);
  const armor = of(ev, "armor")[0];
  assert.ok(armor, "jab should be absorbed");
  assert.equal(armor.damage, Math.round(sen.moves.draw.damage * 0.5));
  assert.equal(of(ev, "hit").find((h) => h.who === 1)?.move, "overhead");
  // Only one hit is absorbed per swing: once spent, the next hit is a normal counter-hit.
  w = arena(sen, kara, 1.3);
  ev = run(w, 50, (i) => {
    if (i === 1) w.fighters[1].armorUsed = true;
    return [{ attack: i === 2 ? "light" : null }, { attack: i === 0 ? "heavy" : null }];
  });
  assert.equal(of(ev, "armor").length, 0);
  assert.equal(of(ev, "hit")[0]?.counter, true);
  // Lows go straight through armor.
  w = arena(sen, kara, 1.3);
  ev = run(w, 50, (i) => [{ attack: i === 2 ? "low" : null }, { attack: i === 0 ? "heavy" : null }]);
  assert.equal(of(ev, "armor").length, 0);
  assert.equal(of(ev, "hit")[0]?.who, 0);
});

test("Kara's rage: below a third of her health she hits harder", () => {
  const w = arena(kara, sen, 1.2);
  w.fighters[0].hp = 30;
  const ev = run(w, 40, (i) => [{ attack: i === 0 ? "light" : null }, { move: 1 }]);
  assert.equal(of(ev, "hit")[0].damage, Math.round(kara.moves.jab.damage * kara.traits.rage.damage));
});

test("Sen's parry deflects a mid into a guaranteed launching riposte, but loses to lows", () => {
  let w = arena(sen, kara, 1.5);
  // Kara's overhead becomes active on frame 22; Sen parries on frame 10 (window frames 4-21 of the stance).
  let ev = run(w, 120, (i) => [{ attack: i === 10 ? "special" : null }, { attack: i === 0 ? "heavy" : null }]);
  assert.equal(of(ev, "parry").length, 1);
  const riposte = of(ev, "hit").find((h) => h.move === "riposte");
  assert.ok(riposte, "riposte should land");
  assert.equal(riposte.counter, true);
  assert.equal(riposte.result, "launch");
  // A low under the stance hits normally.
  w = arena(sen, kara, 1.5);
  ev = run(w, 60, (i) => [{ attack: i === 0 ? "special" : null }, { attack: i === 0 ? "low" : null }]);
  assert.equal(of(ev, "parry").length, 0);
  assert.equal(of(ev, "hit")[0]?.who, 1);
  // A parry that catches nothing whiffs, and its recovery is punishable.
  w = arena(sen, kara, 1.2);
  assert.equal(of(run(w, 60, (i) => [{ attack: i === 0 ? "special" : null }, {}]), "whiff")[0]?.parry, true);
  w = arena(sen, kara, 1.2);
  ev = run(w, 80, (i) => [{ attack: i === 0 ? "special" : null }, { attack: i === 26 ? "light" : null }]);
  assert.equal(of(ev, "hit")[0]?.punish, true);
});

test("Tove's spear: tip hits harder and stuns longer than a point-blank hit", () => {
  const poke = (gap) => {
    const w = arena(tove, kara, gap);
    return of(run(w, 40, (i) => [{ attack: i === 0 ? "light" : null }, { crouch: true }]), "hit")[0];
  };
  const tip = poke(2.1), mid = poke(1.3), sour = poke(0.75);
  assert.equal(tip.tip, "tip");
  assert.equal(mid.tip, null);
  assert.equal(sour.tip, "sour");
  assert.ok(tip.damage > mid.damage && mid.damage > sour.damage, `${tip.damage} > ${mid.damage} > ${sour.damage}`);
  assert.ok(tip.advantage > mid.advantage);
});

test("Tove's Retreating Thrust backs her away while it hits", () => {
  const w = arena(tove, kara, 1.4);
  const x0 = w.fighters[0].x;
  const ev = run(w, 16, (i) => [{ attack: i === 0 ? "back_light" : null }, {}]);
  assert.equal(of(ev, "attack_start")[0].move, "retreat");
  assert.ok(w.fighters[0].x < x0 - 0.6);
});

test("heavy fighters fall out of juggles faster than light ones", () => {
  const launchDuration = (target) => {
    const w = arena(sen, target, 1.5);
    const ev = runCombo(w, 60, presser(["low", "heavy"])); // Ankle Slice -> Heaven Slash launch
    assert.equal(of(ev, "hit")[1]?.result, "launch");
    return w.fighters[1].duration;
  };
  assert.ok(launchDuration(kara) < launchDuration(tove));
});
