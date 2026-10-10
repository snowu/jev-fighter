// Animation lab core: poses every state and move of a character frame by frame and checks the
// result is physically sane. Shared by the lab page (public/lab.html) and `npm test`
// (tools/anim.test.mjs), so visual mistakes (wrong clip, backwards facing, folded spine,
// weapon out of hand, strike missing its hit point) fail a test instead of reaching a player.
import * as THREE from "three";
import { FighterModel, airborneHeight, GROUNDED_LOW } from "./models.js";
import { HEIGHT, swingPhase } from "./swing.js";
import * as C from "../engine/sim/constants.js";
import { totalFrames } from "../engine/sim/moves.js";

const mv = (char, kind) => char.movement?.[kind] ?? C[kind.toUpperCase()];

/**
 * Every visual case for a character. A case builds a fake fighter for a frame; `expect` lists
 * which checks apply (lying down isn't "upright", a sidestep doesn't face forward, ...).
 */
export function animCases(char) {
  const base = { upright: true, grounded: true, facing: true, held: true };
  const cases = [];
  const add = (group, id, frames, fighter, expect = {}) => cases.push({ group, id, frames, fighter, expect: { ...base, ...expect } });

  add("stance", "idle", 60, () => ({ state: "idle" }));
  add("stance", "walk forward", 60, () => ({ state: "idle", walking: 1 }));
  add("stance", "walk back", 60, () => ({ state: "idle", walking: -1 }));
  add("stance", "crouch", 60, () => ({ state: "idle", crouch: true }), { crouched: true });
  // Dashes compress on take-off and landing, so they count as crouched for the head-height check.
  add("movement", "dash", mv(char, "dash").frames, () => ({ state: "dash", duration: mv(char, "dash").frames }), { crouched: true });
  add("movement", "backdash", mv(char, "backdash").frames, () => ({ state: "backdash", duration: mv(char, "backdash").frames }), { crouched: true });
  add("movement", "sidestep in", mv(char, "sidestep").frames, () => ({ state: "sidestep", sideDir: 1, duration: mv(char, "sidestep").frames }), { facing: false, crouched: true });
  add("movement", "sidestep out", mv(char, "sidestep").frames, () => ({ state: "sidestep", sideDir: -1, duration: mv(char, "sidestep").frames }), { facing: false, crouched: true });
  add("movement", "roll", mv(char, "roll").frames, () => ({ state: "roll", sideDir: 1, duration: mv(char, "roll").frames }), { upright: false, facing: false, grounded: false });
  add("movement", "taunt", C.TAUNT_FRAMES, () => ({ state: "taunt", duration: C.TAUNT_FRAMES }), { facing: false });
  add("defence", "block", 14, () => ({ state: "blockstun", duration: 14 }));
  add("defence", "block low", 14, () => ({ state: "blockstun", duration: 14, crouch: true }), { crouched: true });
  add("reactions", "hit light", 18, () => ({ state: "hitstun", duration: 18 }));
  add("reactions", "hit heavy", 26, () => ({ state: "hitstun", duration: 26 }));
  add("reactions", "juggled", C.JUGGLE_FRAMES, () => ({ state: "juggle", duration: C.JUGGLE_FRAMES }), { upright: false, grounded: false, facing: false });
  add("reactions", "knockdown", C.KNOCKDOWN_FRAMES, () => ({ state: "knockdown" }), { upright: false, facing: false, held: false, grounded: false });
  add("reactions", "guard break", C.GUARDBREAK_FRAMES, () => ({ state: "guardbreak", duration: C.GUARDBREAK_FRAMES }));
  add("reactions", "staggered", 30, () => ({ state: "staggered", duration: 30 }));
  add("reactions", "tech", C.TECH_STUN, () => ({ state: "techstun", duration: C.TECH_STUN }));
  add("reactions", "thrown", C.THROW_FRAMES, () => ({ state: "grabbed" }), { upright: false, facing: false });
  add("reactions", "throwing", C.THROW_FRAMES, () => ({ state: "grabbing" }), { facing: false, lunging: true });
  for (const [id, m] of Object.entries(char.moves)) {
    const swing = char.look?.swings?.[id];
    const shape = typeof swing === "string" ? swing : swing?.shape;
    add("attacks", `${m.name} (${id})`, totalFrames(m), () => ({ state: "attack", move: m }), {
      swing: !!swing, crouched: m.level === "low", lunging: true, facing: shape !== "spin", held: !m.parry,
    });
  }
  return cases;
}

/** A fighter object as the renderer sees it, for one frame of a case. */
export function fakeFighter(char, kase, frame) {
  return { char, hp: char.hp, frame, duration: 0, move: null, walking: 0, crouch: false, sideDir: 1, facing: 0, armorUsed: false, ...kase.fighter(frame), frame };
}

/** A posing harness: one model in its own fighter frame (+x forward), at the origin. */
export class Poser {
  constructor(char, models) {
    this.char = char;
    this.model = new FighterModel(char, models);
    this.frame = new THREE.Group();
    this.frame.add(this.model.holder);
    this.frame.updateMatrixWorld(true);
  }

  /**
   * Play a case from frame 0 to `last` as the game would (so cross-fades and blends settle the
   * same way), calling `onFrame(fighter)` after each frame is posed.
   */
  play(kase, last, onFrame) {
    this.model.clock = 0; // loops start at the same point every time: sheet and tests agree
    for (let fr = 0; fr <= last; fr++) {
      const f = fakeFighter(this.char, kase, fr);
      const t = f.move ? { dist: f.move.range, crouching: false } : null;
      this.frame.position.y = airborneHeight(f); // as the renderer does
      this.frame.updateMatrixWorld(true);
      this.model.update(f, 1 / 60, t);
      if (fr === 0) for (let i = 0; i < 6; i++) this.model.update(f, 0, t); // let the clip fade-in finish
      this.frame.updateMatrixWorld(true);
      onFrame?.(f);
    }
  }

  /** Pose a case at one frame (plays up to it). */
  pose(kase, frame) {
    let last = null;
    this.play(kase, frame, (f) => { last = f; });
    return last;
  }

  point(name) { return this.frame.worldToLocal(this.model.root.getObjectByName(name).getWorldPosition(new THREE.Vector3())); }

  weaponTip() { return this.frame.worldToLocal(this.model.weapon.localToWorld(new THREE.Vector3(0, this.model.weaponTip, 0))); }

  /** Distance from a point to the weapon's axis line (is the hand actually on the weapon?). */
  offWeapon(p) {
    const o = this.model.weapon.position, d = new THREE.Vector3(0, 1, 0).applyQuaternion(this.model.weapon.quaternion);
    const t = p.clone().sub(o).dot(d);
    return p.clone().sub(o.clone().addScaledVector(d, t)).length();
  }
}

/** The hit frame used for strike checks: where the swing crosses its hit point. */
export const hitFrame = (m) => m.startup + Math.round((0.12 / 0.42) * m.active);

/** Run every check for one posed frame. Returns a list of { check, detail } failures. */
export function checkPose(poser, kase, f) {
  const fails = [];
  const fail = (check, detail) => fails.push({ check, detail });
  const P = (n) => poser.point(n);
  const head = P("Head"), pelvis = P("pelvis"), chest = P("spine_03"), waist = P("spine_01");
  const feet = ["foot_l", "foot_r", "ball_l", "ball_r"].map(P);
  const e = kase.expect;

  const tip = poser.weaponTip();
  const bodyNames = ["Head", "pelvis", "spine_03", "spine_01", "foot_l", "foot_r", "ball_l", "ball_r", "hand_l", "hand_r", "lowerarm_l", "lowerarm_r"];
  const body = bodyNames.map(P);
  if ([...body, tip].some((p) => !Number.isFinite(p.x + p.y + p.z))) { fail("finite", "NaN in pose"); return fails; }

  if (e.upright) {
    const minHead = e.crouched ? 0.4 : e.lunging ? 0.55 : 1.15; // low moves bend right down
    if (head.y < minHead) fail("upright", `head at ${head.y.toFixed(2)} m (min ${minHead})`);
    if (head.y - pelvis.y < (e.crouched || e.lunging ? 0.25 : 0.3)) fail("upright", `head only ${(head.y - pelvis.y).toFixed(2)} m above pelvis`);
    if (chest.y < waist.y + 0.04) fail("spine", `chest (${chest.y.toFixed(2)}) not above waist (${waist.y.toFixed(2)}): folded`);
  }
  if (e.facing) {
    // Hips' forward direction from the line between the thighs: must point at the opponent (+x).
    const across = P("thigh_r").sub(P("thigh_l"));
    const fwd = new THREE.Vector3(0, 1, 0).cross(across).setY(0).normalize();
    const k = Math.sign(P("upperarm_r").z - P("upperarm_l").z) || 1; // right side may be ±z
    const facing = fwd.x * k;
    if (facing < 0.3) fail("facing", `hips face ${facing.toFixed(2)} towards the opponent (needs > 0.3)`);
  }
  if (e.grounded) {
    const lowest = Math.min(...feet.map((p) => p.y));
    if (lowest > 0.2) fail("grounded", `feet ${lowest.toFixed(2)} m off the floor`);
  }
  // Positions are in the fighter frame, which a juggle lifts: measure against the real floor.
  const ground = poser.frame.position.y;
  const lowIdx = body.reduce((best, p, i) => (p.y < body[best].y ? i : best), 0);
  const floor = body[lowIdx].y + ground;
  if (floor < -0.06) fail("floor", `${bodyNames[lowIdx]} ${(-floor).toFixed(2)} m below the floor`);
  if (!GROUNDED_LOW.has(f.state) && tip.y + ground < -0.08) fail("floor", `weapon tip ${(-(tip.y + ground)).toFixed(2)} m below the floor`);

  const handR = P("hand_r"), handL = P("hand_l");
  const attacking = f.state === "attack" && e.swing;
  // Hands are checked once the swing has fully taken over from the stance (w ≈ 1).
  const w = attacking ? swingPhase(f.move, f.frame, poser.model.tuning(f.move, poser.char.look.swings[f.move.id])).w : 0;
  if (attacking && w > 0.9) {
    if (poser.offWeapon(handR) > 0.3) fail("held", `weapon hand ${poser.offWeapon(handR).toFixed(2)} m off the weapon`);
    if (poser.offWeapon(handL) > 0.35) fail("held", `off hand ${poser.offWeapon(handL).toFixed(2)} m off the weapon`);
    if (f.frame === hitFrame(f.move)) {
      const want = new THREE.Vector3(f.move.range, HEIGHT[f.move.level] ?? 1.1, 0);
      const err = poser.weaponTip().distanceTo(want);
      if (err > 0.3) fail("strike", `tip ${err.toFixed(2)} m from the hit point at the hit frame`);
    }
  } else if (e.held && !attacking) {
    const gap = handR.distanceTo(poser.model.weapon.position);
    if (gap > 0.12) fail("held", `weapon ${gap.toFixed(2)} m from the hand`);
  }
  return fails;
}

/** Sampled frames for a case: every frame for short ones, ~24 samples for long loops. */
export function sampleFrames(kase) {
  const n = kase.frames;
  const step = Math.max(1, Math.floor(n / 24));
  const out = [];
  for (let fr = 0; fr < n; fr += step) out.push(fr);
  if (kase.expect.swing) out.push(hitFrame(kase.fighter(0).move));
  return [...new Set(out)].sort((a, b) => a - b);
}

/** Check every case of every character. Returns [{ char, case, frame, check, detail }]. */
export function runChecks(roster, models) {
  const out = [];
  for (const char of roster) {
    const poser = new Poser(char, models);
    for (const kase of animCases(char)) {
      const want = new Set(sampleFrames(kase));
      poser.play(kase, Math.max(...want), (f) => {
        if (!want.has(f.frame)) return;
        for (const x of checkPose(poser, kase, f)) out.push({ char: char.id, case: kase.id, frame: f.frame, ...x });
      });
    }
  }
  return out;
}
