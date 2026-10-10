// Procedural attack animation driven by the sim's frame data.
//
// Mocap clips never match a move's reach, height or timing, so attacks are posed from the move
// itself: each move has a swing shape (thrust, slash, chop...), and the weapon tip follows a
// path that passes exactly through the hit point (the move's range, at the attack level's
// height) during the active frames. Two-bone IK puts the hands on the weapon; the torso twists
// and leans with the swing and the body steps in when the target is beyond arm's reach.
//
// Space: everything is solved in the fighter's group frame (metres): +x forward (towards the
// opponent), +y up, +z the fighter's right side.
import * as THREE from "three";

const HEIGHT = { high: 1.42, mid: 1.1, low: 0.38 }; // face, chest, shins
const STRIKE_FRAMES = 6; // the fast part of the swing at the end of startup

const v = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const tmp = { a: v(), b: v(), c: v(), d: v(), q1: new THREE.Quaternion(), q2: new THREE.Quaternion() };
const Y = new THREE.Vector3(0, 1, 0);
const ease = (t) => t * t * (3 - 2 * t);
const clamp01 = (t) => Math.min(1, Math.max(0, t));

/** Swing parameter s (−1 wind-up … 0 hit point … +1 follow-through) and blend weight for a frame. */
export function swingPhase(m, frame) {
  const windEnd = Math.max(1, m.startup - STRIKE_FRAMES);
  let s, w;
  if (frame < m.startup) {
    w = ease(clamp01(frame / Math.max(2, windEnd * 0.6)));
    s = frame < windEnd ? -1 : -1 + 0.88 * ((frame - windEnd) / (m.startup - windEnd)) ** 2; // accelerate into the hit
  } else if (frame < m.startup + m.active) {
    w = 1;
    s = -0.12 + 0.42 * ((frame - m.startup) / m.active); // crosses s = 0 (the hit point) inside the active window
  } else {
    const r = (frame - m.startup - m.active) / m.recovery;
    s = 0.3 + 0.7 * ease(clamp01(r / 0.35));
    w = 1 - ease(clamp01((r - 0.35) / 0.65));
  }
  return { s, w };
}

/**
 * Tip position and weapon direction for a swing shape at parameter s.
 * P = hit point, sh = shoulder height. Returns { tip, dir } in the group frame.
 */
export function swingPose(shape, P, sh, s) {
  const r = Math.hypot(P.x, P.y - sh) || 0.5;
  const tip = v(), dir = v();
  switch (shape) {
    case "thrust": {
      // Straight line along the attack: pulled back beside the body, driven through the target.
      const back = s < 0 ? -s : 0;
      tip.set(P.x - back * Math.max(0.2, P.x - 0.35) + Math.max(0, s) * 0.18, P.y + back * 0.12, back * 0.22);
      dir.set(1, (P.y - sh) * 0.15 / Math.max(0.5, P.x), -back * 0.25).normalize();
      break;
    }
    case "slash": case "backslash": case "sweep": case "spin": {
      // Horizontal arc around the body at the target's height, from the weapon side across.
      const span = shape === "spin" ? 2.6 : shape === "sweep" ? 2.0 : 1.5;
      const side = shape === "backslash" ? -1 : 1;
      const th = s * span;
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
    this.right = arm(side);
    this.left = arm(side === "r" ? "l" : "r");
    this.spine = bone("spine_03");
    this.waist = bone("spine_01");
    this.saved = new Map();
  }

  remember(bones) { for (const b of bones) this.saved.set(b, b.quaternion.clone()); }

  /**
   * Put back the clip pose before the next mixer update. three's mixer only writes a bone when
   * its mixed value changed, so a held clip frame would otherwise keep last frame's IK and drift.
   */
  restore() {
    for (const [b, q] of this.saved) b.quaternion.copy(q);
    this.saved.clear();
  }
  blend(bones, w) {
    for (const b of bones) { const solved = b.quaternion.clone(); b.quaternion.copy(this.saved.get(b)).slerp(solved, w); }
  }

  /**
   * Pose the upper body for an attack. frame: the group (fighter frame); holder: the model holder,
   * shifted forward to lunge when the hand can't reach. Returns the weapon grip transform (group frame).
   */
  apply({ frame, holder, root, shape, m, target, weaponTip, twoHanded, phase }) {
    const { s, w } = phase;
    // Hit point: the move's reach, or the opponent's body if they're closer (so blows land on them,
    // not through them); a little lower when they're crouching.
    const reachX = target && target.dist < m.range ? Math.max(0.55, target.dist) : m.range;
    const height = (HEIGHT[m.level] ?? 1.1) - (target?.crouching && m.level === "mid" ? 0.32 : 0); // highs still sail over a duck
    const P = v(reachX, height, 0);
    const shoulderG = frame.worldToLocal(this.right.upper.getWorldPosition(v()));
    const k = Math.sign(shoulderG.z) || 1; // which side of the frame the weapon arm is on
    const pose = (t) => { const p = swingPose(shape, P, shoulderG.y, t); p.tip.z *= k; p.dir.z *= k; return p; };
    const { tip, dir } = pose(s);

    // Hand sits a weapon's length back from the tip; choke up if that would put it inside the body.
    const reach = (this.right.upperLen + this.right.lowerLen) * 0.98;
    let len = weaponTip;
    const minHand = 0.28;
    let hand = v().copy(tip).addScaledVector(dir, -len);
    if (hand.x < minHand && shape === "thrust") { len = Math.max(0.25, tip.x - minHand); hand = v().copy(tip).addScaledVector(dir, -len); }

    // Lunge: move the whole body forward by however much the shoulder can't reach.
    const need = hand.distanceTo(shoulderG) - reach;
    const lunge = Math.min(0.7, Math.max(0, need)) * w;
    holder.position.x = lunge;
    holder.updateMatrixWorld(true);

    // Torso: twist with horizontal swings, lean into chops and thrusts.
    const bones = [this.spine, this.waist, this.right.upper, this.right.lower, this.right.hand, this.left.upper, this.left.lower, this.left.hand];
    this.remember(bones);
    const twist = shape === "slash" || shape === "sweep" || shape === "spin" ? -0.45 * s : shape === "backslash" ? 0.45 * s : 0;
    const lean = shape === "chop" ? 0.3 * Math.max(0, 1 - Math.abs(s)) : shape === "thrust" ? 0.15 * Math.max(0, 1 + Math.min(0, s)) : 0.1;
    const up = frame.localToWorld(v(0, 1, 0)).sub(frame.localToWorld(v())).normalize();
    const sideAxis = frame.localToWorld(v(0, 0, 1)).sub(frame.localToWorld(v())).normalize();
    for (const [b, axis, ang] of [[this.spine, up, twist], [this.waist, sideAxis, -lean]]) {
      const wq = b.getWorldQuaternion(new THREE.Quaternion()).premultiply(new THREE.Quaternion().setFromAxisAngle(axis, ang));
      b.quaternion.copy(b.parent.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(wq));
      b.updateMatrixWorld(true);
    }

    // Arms: weapon hand onto the grip, off hand further down the handle for two-handed weapons.
    const toWorld = (p) => frame.localToWorld(v().copy(p));
    const poleR = toWorld(v(-0.3, -1, 0.8 * k)).sub(frame.localToWorld(v())).normalize();
    solveArm(this.right, toWorld(hand), poleR);
    if (twoHanded) {
      const off = v().copy(hand).addScaledVector(dir, -0.3);
      const poleL = toWorld(v(-0.3, -1, -0.8 * k)).sub(frame.localToWorld(v())).normalize();
      solveArm(this.left, toWorld(off), poleL);
    }
    this.blend(bones, w);
    root.updateMatrixWorld(true);

    // Weapon: grip at the hand, axis towards the tip, edge facing the direction of the swing.
    const ahead = pose(s + 0.05).tip.sub(tip);
    const q = new THREE.Quaternion().setFromUnitVectors(Y, dir);
    const edge = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
    const wantEdge = ahead.addScaledVector(dir, -ahead.dot(dir));
    if (wantEdge.lengthSq() > 1e-6) {
      wantEdge.normalize();
      const roll = Math.atan2(v().crossVectors(edge, wantEdge).dot(dir), edge.dot(wantEdge));
      q.premultiply(new THREE.Quaternion().setFromAxisAngle(dir, roll));
    }
    return { position: v().copy(tip).addScaledVector(dir, -weaponTip), quaternion: q, weight: w, tip, lunge };
  }
}
