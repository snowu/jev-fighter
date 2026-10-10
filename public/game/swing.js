// Procedural attack animation driven by the sim's frame data.
//
// Mocap clips never match a move's reach, height or timing, so attacks are posed from the move
// itself: each move has a swing shape (thrust, slash, chop...), and the weapon tip follows a
// path that passes exactly through the hit point (the move's range, at the attack level's
// height) during the active frames. Two-bone IK puts the hands on the weapon; the hips and torso
// coil into the wind-up and uncoil through the hit; the lead foot steps in while the back foot
// stays planted, and the weight drops on impact.
//
// Each move is tuned by a few numbers (see SHAPES / tuneSwing): wind-up size, step length,
// weight drop, hip rotation, lean and arc span. Defaults come from the move's frame data (heavy
// moves wind up big, jabs stay compact, retreating moves step back); roster files can override.
//
// Space: everything is solved in the fighter's group frame (metres): +x forward (towards the
// opponent), +y up, +z the fighter's right side.
import * as THREE from "three";
import { HumanoidRig } from "./rig.js";

const TORSO_CLEARANCE = 0.22; // grips (fist centres) stay this far out from the spine's axis
const WRIST_CLEARANCE = 0.145; // and wrists this far (the lab flags hands under 0.13 m)
const GRIP_TOLERANCE = 0.42; // ~24°: how far a held shaft may sit off the fist's grip axis
export const HEIGHT = { high: 1.42, mid: 1.1, low: 0.38 }; // face, chest, shins

// Per-shape defaults. windup: how far back the weapon is drawn (1 = shape's natural wind-up);
// step: lead-foot step at the strike (m); drop: weight drop at impact (m); hips: hip/torso coil
// (rad per unit of swing); lean: forward lean at impact (rad); span: horizontal arc (rad).
export const SHAPES = {
  thrust:    { step: 0.3, drop: 0.06, hips: 0.3, lean: 0.18 },
  slash:     { step: 0.2, drop: 0.05, hips: 0.4, lean: 0.1, span: 1.5 },
  backslash: { step: 0.15, drop: 0.05, hips: 0.4, lean: 0.1, span: 1.5 },
  sweep:     { step: 0.25, drop: 0.05, hips: 0.45, lean: 0.15, span: 2.0 },
  spin:      { step: 0.1, drop: 0.04, hips: 0.7, lean: 0.05, span: 2.6 },
  chop:      { step: 0.3, drop: 0.14, hips: 0.12, lean: 0.32 },
  rising:    { step: 0.18, drop: -0.02, hips: 0.15, lean: -0.08 },
};

/** Resolve a roster swing spec ("chop" or { shape: "chop", windup: 1.8, ... }) into full tuning. */
export function tuneSwing(spec, m) {
  const o = typeof spec === "string" ? { shape: spec } : spec;
  const d = SHAPES[o.shape] ?? SHAPES.slash;
  const heavy = m.startup >= 18, quick = m.startup <= 10;
  const advance = m.advance ?? 0;
  const auto = {
    windup: heavy ? 1.45 : quick ? 0.7 : 1.0,
    step: advance < 0 ? -0.28 : d.step * (heavy ? 1.3 : quick ? 0.6 : 1) + Math.max(0, advance) * 0.2,
    drop: d.drop * (heavy ? 1.4 : 1),
    strike: Math.min(m.startup - 1, heavy ? 8 : quick ? 4 : 6), // frames of fast swing at the end of startup
  };
  return { ...d, ...auto, ...o };
}

const v = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const tmp = { a: v(), b: v(), c: v(), d: v(), q1: new THREE.Quaternion(), q2: new THREE.Quaternion() };
const Y = new THREE.Vector3(0, 1, 0);
const Z = new THREE.Vector3(0, 0, 1);

const ease = (t) => t * t * (3 - 2 * t);
const clamp01 = (t) => Math.min(1, Math.max(0, t));

/**
 * Where in the swing a frame is. s: −windup (fully drawn back) … 0 (hit point) … +1 (follow-
 * through). w: blend weight against the stance clip. windK: how coiled (0..1). stepK: how far
 * the lead foot has stepped (0..1). lift: foot height while it travels.
 */
export function swingPhase(m, frame, t) {
  const W = t.windup;
  const windEnd = Math.max(1, m.startup - t.strike);
  let s, w, stepK;
  if (frame < m.startup) {
    w = ease(clamp01(frame / 4));
    if (frame < windEnd) {
      s = -W * ease(clamp01(frame / (windEnd * 0.8))); // draw back, then hold the coil (anticipation)
      stepK = 0;
    } else {
      const k = (frame - windEnd) / (m.startup - windEnd);
      s = -W + (W - 0.12) * k * k; // accelerate into the hit
      stepK = ease(k);
    }
  } else if (frame < m.startup + m.active) {
    w = 1;
    s = -0.12 + 0.42 * ((frame - m.startup) / m.active); // crosses s = 0 (the hit point) inside the active window
    stepK = 1;
  } else {
    const r = (frame - m.startup - m.active) / m.recovery;
    s = 0.3 + 0.7 * ease(clamp01(r / 0.35));
    stepK = 1 - ease(clamp01((r - 0.45) / 0.45)); // step back into stance late in recovery
    w = 1 - ease(clamp01((r - 0.35) / 0.65));
  }
  const windK = clamp01(-s / W);
  const lift = 0.11 * 4 * stepK * (1 - stepK);
  return { s, w, windK, stepK, lift };
}

/**
 * Tip position and weapon direction for a swing shape at parameter s.
 * P = hit point, sh = shoulder height. Returns { tip, dir } in the group frame.
 */
export function swingPose(shape, P, sh, s, span = 1.5) {
  const r = Math.hypot(P.x, P.y - sh) || 0.5;
  const tip = v(), dir = v();
  switch (shape) {
    case "thrust": {
      // Straight line along the attack: pulled back beside the body, driven through the target.
      const back = s < 0 ? -s : 0;
      tip.set(Math.max(-0.1, P.x - back * Math.max(0.2, P.x - 0.35)) + Math.max(0, s) * 0.18, P.y + back * 0.12, back * 0.22);
      dir.set(1, (P.y - sh) * 0.15 / Math.max(0.5, P.x), -back * 0.25).normalize();
      break;
    }
    case "slash": case "backslash": case "sweep": case "spin": {
      // Horizontal arc around the body at the target's height, from the weapon side across.
      const side = shape === "backslash" ? -1 : 1;
      const th = s < 0 ? s * span : s * span * 0.55; // short follow-through: the arms don't wrap round the body
      const rad = Math.max(0.6, P.x);
      const drop = shape === "sweep" ? 0 : -0.22 * s; // diagonal: high at wind-up, low at follow-through
      tip.set(Math.cos(th) * rad, P.y + drop, -Math.sin(th) * rad * side);
      dir.set(Math.cos(th), 0, -Math.sin(th) * side).normalize();
      break;
    }
    case "chop": case "rising": {
      // Vertical arc in front of the body around the shoulder, through the target.
      const phi0 = Math.atan2(P.x, P.y - sh); // angle from straight up
      const sign = shape === "rising" ? -1 : 1;
      const phi = phi0 + sign * (s < 0 ? s * 1.5 : s * 0.7);
      tip.set(Math.sin(phi) * r, sh + Math.cos(phi) * r, 0.05);
      dir.set(Math.sin(phi), Math.cos(phi), 0.04).normalize();
      break;
    }
    default:
      tip.copy(P);
      dir.set(1, 0, 0);
  }
  // The weapon never goes through the floor: rising wind-ups and chop follow-throughs stop on it.
  if (tip.y < 0.06) tip.y = 0.06;
  return { tip, dir };
}

/** Rotate `bone` (in world space) so its child points at `target`. */
function aim(bone, child, target) {
  const bp = bone.getWorldPosition(tmp.a), cp = child.getWorldPosition(tmp.b);
  const cur = tmp.c.subVectors(cp, bp).normalize();
  const want = tmp.d.subVectors(target, bp).normalize();
  const dq = tmp.q1.setFromUnitVectors(cur, want);
  const wq = bone.getWorldQuaternion(tmp.q2).premultiply(dq);
  const pq = bone.parent.getWorldQuaternion(new THREE.Quaternion()).invert();
  bone.quaternion.copy(pq.multiply(wq));
  bone.updateMatrixWorld(true);
}

/** Two-bone IK: shoulder → elbow → wrist reaching `target` (world), elbow bent towards `pole`. */
function solveArm(arm, target, pole) {
  const S = arm.upper.getWorldPosition(v());
  const a = arm.upperLen, b = arm.lowerLen;
  const toT = v().subVectors(target, S);
  const d = Math.min(Math.max(toT.length(), 0.05), (a + b) * 0.999);
  const u = toT.normalize();
  const x = (a * a - b * b + d * d) / (2 * d);
  const y = Math.sqrt(Math.max(0, a * a - x * x));
  const perp = v().copy(pole).addScaledVector(u, -pole.dot(u)).normalize();
  const elbow = v().copy(S).addScaledVector(u, x).addScaledVector(perp, y);
  const wrist = v().copy(S).addScaledVector(u, d);
  aim(arm.upper, arm.lower, elbow);
  aim(arm.lower, arm.hand, wrist);
}

export class SwingRig {
  constructor(root, side = "r") {
    const bone = (n) => root.getObjectByName(n);
    const arm = (s) => {
      const upper = bone(`upperarm_${s}`), lower = bone(`lowerarm_${s}`), hand = bone(`hand_${s}`);
      root.updateMatrixWorld(true);
      return {
        upper, lower, hand,
        upperLen: upper.getWorldPosition(v()).distanceTo(lower.getWorldPosition(v())),
        lowerLen: lower.getWorldPosition(v()).distanceTo(hand.getWorldPosition(v())),
      };
    };
    // Grips go through the measured rig (rig.js): fist on the shaft, straight wrist, closed fingers.
    this.body = new HumanoidRig(root);
    this.right = arm(side);
    this.left = arm(side === "r" ? "l" : "r");
    const leg = (s) => {
      const upper = bone(`thigh_${s}`), lower = bone(`calf_${s}`), hand = bone(`foot_${s}`);
      return {
        upper, lower, hand,
        upperLen: upper.getWorldPosition(v()).distanceTo(lower.getWorldPosition(v())),
        lowerLen: lower.getWorldPosition(v()).distanceTo(hand.getWorldPosition(v())),
      };
    };
    this.legs = [leg("l"), leg("r")];
    // Which side of the fighter frame (±z) the weapon arm is on: fixed once (calibrate), from the
    // first animated stance. Per-frame from the shoulders it flips when the torso coils far enough
    // (a pop), and the bind pose faces the other way from the clips, so it can't come from that.
    this.sideK = null;
    this.pelvis = bone("pelvis");
    this.spine = bone("spine_03");
    this.neck = bone("neck_01");
    this.waist = bone("spine_01");
    this.saved = new Map();
  }

  /**
   * Snapshot bones before posing them. `saved` keeps the first (clip) pose for restore();
   * `base` is what this pass blends from (the guard, when an attack is layered on top of it).
   */
  remember(bones) {
    this.base ??= new Map();
    for (const b of bones) {
      if (!this.saved.has(b)) this.saved.set(b, b.quaternion.clone());
      this.base.set(b, b.quaternion.clone());
    }
  }

  /**
   * Put back the clip pose before the next mixer update. three's mixer only writes a bone when
   * its mixed value changed, so a held clip frame would otherwise keep last frame's IK and drift.
   */
  restore() {
    for (const [b, q] of this.saved) b.quaternion.copy(q);
    this.saved.clear();
    this.base?.clear();
  }
  blend(bones, w) {
    for (const b of bones) { const solved = b.quaternion.clone(); b.quaternion.copy(this.base.get(b)).slerp(solved, w); }
  }

  /**
   * Guard: the upper body holds the weapon towards the opponent over whatever the legs are doing
   * (idle, walk, crouch, block). `pose` is { hand, dir } with the hand given relative to the chest
   * (spine_03), so a crouch lowers the guard with the body and a bladed stance still holds the
   * weapon out in front. Returns the weapon transform.
   */
  guard({ frame, root, pose, w, twoHanded, offHand = 0.3 }) {
    const toWorld = (p) => frame.localToWorld(v().copy(p));
    const axis = (x, y, z) => toWorld(v(x, y, z)).sub(frame.localToWorld(v())).normalize();
    const bones = [this.spine, this.waist, this.right.upper, this.right.lower, this.right.hand, this.left.upper, this.left.lower, this.left.hand];
    this.remember([...bones, ...this.fingerBones(true)]);
    // Square the chest towards the opponent: the stance clips stand bladed (weapon shoulder back),
    // which made the arms reach across the body and fold into it.
    const across = v().subVectors(frame.worldToLocal(this.right.upper.getWorldPosition(v())), frame.worldToLocal(this.left.upper.getWorldPosition(v())));
    const kk = this.sideK;
    const blade = Math.atan2(-across.x, across.z * kk) * kk;
    const upAxis = axis(0, 1, 0);
    this.turn(this.waist, upAxis, blade * 0.3);
    this.turn(this.spine, upAxis, blade * 0.4);
    const shoulder = frame.worldToLocal(this.right.upper.getWorldPosition(v()));
    const chest = frame.worldToLocal(this.spine.getWorldPosition(v()));
    const k = this.sideK;
    const hand = v(chest.x + pose.hand[0], chest.y + pose.hand[1], chest.z + pose.hand[2] * k);
    const dir = v(pose.dir[0], pose.dir[1], pose.dir[2] * k).normalize();
    this.forwardW = axis(1, 0, 0);
    const dirW = toWorld(v().copy(dir)).sub(frame.localToWorld(v())).normalize();
    const reached = frame.worldToLocal(this.grip(this.right, toWorld(hand), dirW));
    const q = new THREE.Quaternion().setFromUnitVectors(Y, dir);
    // Edge faces the opponent (forward), or up for a raised block.
    const edge = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
    const wantEdge = v(1, 0.2, 0).addScaledVector(dir, -dir.x).normalize();
    if (wantEdge.lengthSq() > 1e-6) {
      const roll = Math.atan2(v().crossVectors(edge, wantEdge).dot(dir), edge.dot(wantEdge));
      q.premultiply(new THREE.Quaternion().setFromAxisAngle(dir, roll));
    }
    this.blend([...bones, ...this.fingerBones(twoHanded)], w);
    root.updateMatrixWorld(true);
    // Where the fist really is after blending with the clip pose: the weapon goes there.
    const fist = frame.worldToLocal(this.body.gripFrame(this.body.arms.r).center);
    return { position: fist, quaternion: q, weight: 1 };
  }

  /**
   * Hold the weapon shaft at `grip` (world point on the shaft) along `dir` (world) with this arm,
   * via the measured rig (rig.js). Grips inside the torso are pushed out to its front first, and
   * the elbow is steered outward and down from the torso. Returns the fist centre reached.
   */
  grip(arm, grip, dir) {
    const body = this.bodyArm(arm);
    const a = this.pelvis.getWorldPosition(v()), b = this.neck.getWorldPosition(v());
    const ab = v().subVectors(b, a);
    const onAxis = (p) => a.clone().addScaledVector(ab, Math.min(1, Math.max(0, v().subVectors(p, a).dot(ab) / ab.lengthSq())));
    const g = grip.clone();
    const fromAxis = v().subVectors(g, onAxis(g));
    this.lastPushed = fromAxis.length() < TORSO_CLEARANCE;
    if (this.lastPushed) g.addScaledVector(this.forwardW, Math.max(0, TORSO_CLEARANCE - fromAxis.dot(this.forwardW)));
    const shoulder = arm.upper.getWorldPosition(v());
    const outward = v().subVectors(shoulder, onAxis(shoulder)).normalize();
    const pole = outward.multiplyScalar(0.9).addScaledVector(ab.clone().normalize(), -0.8).addScaledVector(this.forwardW, 0.25).normalize();
    let got = this.body.holdShaft(body, g, dir, pole);
    // The fist clears the torso, but a wrist bent back toward the body can still sink into it:
    // push the grip further out by the shortfall and solve again.
    for (let i = 0; i < 2; i++) {
      const wrist = arm.hand.getWorldPosition(v());
      const short = WRIST_CLEARANCE - v().subVectors(wrist, onAxis(wrist)).length();
      if (short <= 0) break;
      this.lastPushed = true;
      g.addScaledVector(this.forwardW, short + 0.01);
      got = this.body.holdShaft(body, g, dir, pole);
    }
    return got;
  }

  bodyArm(arm) { return arm === this.right ? this.body.arms.r : this.body.arms.l; }

  /**
   * After the weapon's final transform for this frame is known (guard, swing or a blend of them):
   * put the off hand on its shaft, blended in by `w`. `pos`/`quat` are in the fighter frame.
   */
  attachOffHand(frame, pos, quat, spacing, w) {
    if (w <= 0.01) return;
    const bones = [this.left.upper, this.left.lower, this.left.hand, ...this.bodyArm(this.left).fingers.map((f) => f.bone)];
    this.remember(bones);
    this.forwardW = frame.localToWorld(v(1, 0, 0)).sub(frame.localToWorld(v())).normalize();
    const dirW = v(0, 1, 0).applyQuaternion(frame.getWorldQuaternion(new THREE.Quaternion()).multiply(quat)).normalize();
    this.offHandGrip(frame.localToWorld(pos.clone()), dirW, spacing);
    this.blend(bones, w);
    frame.updateMatrixWorld(true);
  }

  /**
   * Second hand on the shaft: try the preferred spacing from the first hand, then closer and
   * further along the shaft (a real off hand slides on the haft), and keep the first reachable.
   * `main` is the first fist (world), `dirW` the shaft direction (world).
   */
  offHandGrip(main, dirW, spacing) {
    const tries = [1, 0.65, 1.4].map((k) => spacing * k);
    let fallback = null;
    for (const sp of tries) {
      const got = this.grip(this.left, v().copy(main).addScaledVector(dirW, -sp), dirW);
      const off = v().subVectors(got, main);
      const onShaft = off.addScaledVector(dirW, -off.dot(dirW)).length() < 0.03;
      if (this.body.lastReached && !this.lastPushed && onShaft) { this.offReleased = false; return got; } // really on the shaft
      fallback ??= sp;
    }
    // Out of reach (wide swings, long reaches): let go, and bring the fist back to the chest.
    this.offReleased = true;
    const arm = this.body.arms.l;
    const chest = this.spine.getWorldPosition(v());
    const rest = chest.addScaledVector(this.forwardW, 0.3).add(v(0, -0.08, 0));
    const shoulder = this.left.upper.getWorldPosition(v());
    const down = v(0, -1, 0);
    const outward = v().subVectors(shoulder, this.spine.getWorldPosition(v())).setY(0).normalize();
    this.body.reachTo(arm, rest, outward.multiplyScalar(0.8).add(down).normalize());
    return null;
  }

  /** Bones a grip touches beyond the arm chain (fingers), for remember/blend/restore. */
  fingerBones(twoHanded) {
    return (twoHanded ? [this.right, this.left] : [this.right]).flatMap((a) => this.bodyArm(a).fingers.map((f) => f.bone));
  }

  /** Fix the weapon-arm side from the current (clip) pose. Call before any IK touches it. */
  calibrate(frame) {
    if (this.sideK !== null) return;
    frame.updateMatrixWorld(true);
    const r = frame.worldToLocal(this.right.upper.getWorldPosition(v())), l = frame.worldToLocal(this.left.upper.getWorldPosition(v()));
    this.sideK = Math.sign(r.z - l.z) || 1;
  }

  /** Rotate a bone in world space about `axis` (world) by `angle`. */
  turn(b, axis, angle) {
    if (!angle) return;
    const wq = b.getWorldQuaternion(new THREE.Quaternion()).premultiply(new THREE.Quaternion().setFromAxisAngle(axis, angle));
    b.quaternion.copy(b.parent.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(wq));
    b.updateMatrixWorld(true);
  }

  /**
   * Pose the body for an attack. frame: the group (fighter frame); holder: the model holder, moved
   * for the step, the weight drop and any lunge. Returns the weapon grip transform (group frame).
   */
  apply({ frame, holder, root, tune, m, target, weaponTip, twoHanded, phase, offHand }) {
    const { s, w, windK, stepK, lift } = phase;
    this.lastWeight = w;
    const shape = tune.shape;
    const toWorld = (p) => frame.localToWorld(v().copy(p));
    const axis = (x, y, z) => toWorld(v(x, y, z)).sub(frame.localToWorld(v())).normalize();
    const bell = Math.max(0, 1 - Math.abs(s) * 1.2); // peaks at the hit point

    // Hit point: the move's reach, or the opponent's body if they're closer (so blows land on them,
    // not through them); a little lower when they're crouching.
    const reachX = target && target.dist < m.range ? Math.max(0.55, target.dist) : m.range;
    const height = (HEIGHT[m.level] ?? 1.1) - (target?.crouching && m.level === "mid" ? 0.32 : 0); // highs still sail over a duck
    const P = v(reachX, height, 0);

    // Feet as the stance clip has them, before anything moves (group frame + world foot rotation).
    const feet = this.legs.map((l) => ({
      leg: l, pos: frame.worldToLocal(l.hand.getWorldPosition(v())), q: l.hand.getWorldQuaternion(new THREE.Quaternion()),
    }));
    const lead = feet[0].pos.x >= feet[1].pos.x ? 0 : 1;

    const bones = [this.pelvis, this.spine, this.waist, this.right.upper, this.right.lower, this.right.hand,
      this.left.upper, this.left.lower, this.left.hand, ...this.legs.flatMap((l) => [l.upper, l.lower, l.hand])];
    this.remember([...bones, ...this.fingerBones(true)]);

    // Weight: back onto the rear foot while coiling, forward with the step, down on impact.
    // Low attacks sink further so the hands can reach a shin-height grip.
    const low = m.level === "low" ? 1 : 0;
    holder.position.set(w * (tune.step * 0.55 * stepK - 0.06 * windK), -w * (tune.drop * bell + 0.12 * low), 0);
    holder.updateMatrixWorld(true);

    // Hips and torso coil towards the weapon side in the wind-up and unwind through the hit.
    const k0 = this.sideK; // weapon arm side
    const dirSign = shape === "backslash" ? -1 : 1;
    // The chest turns with horizontal arcs (keeps the arms in front of it instead of wrapping
    // across the body); vertical shapes just use the hip coil.
    // (Spins already turn the whole body, so their chest coil stays small.)
    const arc = tune.span && /slash|sweep/.test(shape) ? tune.span * 0.4 : 0;
    const coil = Math.max(-1.1, Math.min(1.1, (tune.hips + arc) * s)) * k0 * dirSign;
    const up = axis(0, 1, 0), side = axis(0, 0, 1);
    this.turn(this.pelvis, up, coil * 0.4); // hips lead a little; the chest does most of the turning
    this.turn(this.spine, up, coil * 0.6);
    this.turn(this.waist, side, -(tune.lean * bell + 0.18 * low - (shape === "chop" ? 0.12 : 0.05) * windK)); // rear back, then lean in

    // Weapon path for this frame, and where the weapon hand has to be.
    const shoulderG = frame.worldToLocal(this.right.upper.getWorldPosition(v()));
    const k = this.sideK;
    const pose = (t) => { const p = swingPose(shape, P, shoulderG.y, t, tune.span); p.tip.z *= k; p.dir.z *= k; return p; };
    const { tip, dir } = pose(s);
    // Grip reach: a fist held square to the shaft reaches less far than the straight arm.
    const reach = (this.right.upperLen + this.right.lowerLen) * 0.72;
    let len = weaponTip;
    const minHand = 0.28;
    let hand = v().copy(tip).addScaledVector(dir, -len);
    if (hand.x < minHand && shape === "thrust") { len = Math.max(0.25, tip.x - minHand); hand = v().copy(tip).addScaledVector(dir, -len); }

    // Lunge further if the shoulder still can't reach the grip.
    const shortfall = Math.min(1.0, Math.max(0, hand.distanceTo(shoulderG) - reach)) * w; // smooth in the swing phase: no pops
    if (shortfall > 0) { holder.position.x += shortfall; holder.updateMatrixWorld(true); }
    const lunge = holder.position.x;
    // Still out of reach (big wind-ups above/behind the head, deep low sweeps)? Keep the planned
    // fist inside the arm's grip reach: pull it in towards the shoulder and carry the tip with it.
    // The path shrinks a little; the grips stay real. (At the hit frame the lunge covers reach.)
    const shoulderNow = frame.worldToLocal(this.right.upper.getWorldPosition(v()));
    const out = hand.distanceTo(shoulderNow) - reach;
    if (out > 0) {
      const pull = v().subVectors(shoulderNow, hand).normalize().multiplyScalar(out);
      hand.add(pull);
      tip.add(pull);
    }

    // Legs: rear foot stays planted where the stance put it; the lead foot steps (in an arc) by the
    // step plus any extra lunge, so the hips stay between the feet. Feet stay flat.
    feet.forEach((ft, i) => {
      const target = v().copy(ft.pos);
      if (i === lead) { target.x += (tune.step * stepK + shortfall) ; target.y += lift; }
      solveArm(ft.leg, toWorld(target), axis(1, 0, 0.2 * (i ? 1 : -1)));
      const lower = ft.leg.lower;
      ft.leg.hand.quaternion.copy(lower.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(ft.q));
      ft.leg.hand.updateMatrixWorld(true);
    });

    // Arms: weapon hand onto the grip. If the arm can't quite get there, the weapon follows the
    // hand (same direction) rather than floating free; then the off hand takes the handle below.
    this.forwardW = axis(1, 0, 0);
    const dirW = toWorld(v().copy(dir)).sub(frame.localToWorld(v())).normalize();
    const reached = frame.worldToLocal(this.grip(this.right, toWorld(hand), dirW));
    // Hand first: if the grip wasn't reachable the weapon goes where the fist is, along the
    // fist's axis, so the hand never lets go (the strike check still holds the tip to the hit).
    // If the fist couldn't line up with the planned shaft (wrist at its limit), turn the weapon
    // towards the fist's axis just enough to sit within a natural grip angle. Wind-ups and
    // follow-throughs absorb this invisibly; at the hit frame the lab's strike check guards it.
    hand.copy(reached);
    if (!this.body.lastReached) {
      const g = this.body.gripFrame(this.body.arms.r);
      const axisG = frame.worldToLocal(g.center.clone().add(g.axis)).sub(frame.worldToLocal(g.center.clone())).normalize();
      if (axisG.dot(dir) < 0) axisG.negate();
      const across = dir.angleTo(axisG);
      if (across > GRIP_TOLERANCE) {
        const t = (across - GRIP_TOLERANCE) / across;
        dir.lerp(axisG, t).normalize(); // close enough to a slerp for these angles
        dirW.copy(toWorld(v().copy(dir)).sub(frame.localToWorld(v())).normalize());
      }
    }
    tip.copy(hand).addScaledVector(dir, len);


    // Weapon: grip at the hand, axis towards the tip, edge facing the direction of the swing.
    // If following the hand dropped the tip into the floor, tilt the weapon up until it rests on it.
    const tipNow = v().copy(hand).addScaledVector(dir, len);
    if (tipNow.y < 0.06) { dir.y += (0.06 - tipNow.y) / len; dir.normalize(); }
    const ahead = pose(s + 0.05).tip.sub(tip);
    const q = new THREE.Quaternion().setFromUnitVectors(Y, dir);
    const edge = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
    const wantEdge = ahead.addScaledVector(dir, -ahead.dot(dir));
    if (wantEdge.lengthSq() > 1e-6) {
      wantEdge.normalize();
      const roll = Math.atan2(v().crossVectors(edge, wantEdge).dot(dir), edge.dot(wantEdge));
      q.premultiply(new THREE.Quaternion().setFromAxisAngle(dir, roll));
    }
    this.blend([...bones, ...this.fingerBones(twoHanded)], w);
    root.updateMatrixWorld(true);
    // Hand first: the weapon sits in the fist as it really ended up (after blending).
    const fist = frame.worldToLocal(this.body.gripFrame(this.body.arms.r).center);
    return { position: fist.addScaledVector(dir, -(weaponTip - len)), quaternion: q, weight: 1, blend: w, tip, lunge };
  }
}
