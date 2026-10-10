// Humanoid rig: measured bone geometry + solvers. The baseline everything else builds on.
//
// Nothing here assumes a bone axis convention. At construction it measures, from the model's
// own bind pose:
//   - arm and leg segment lengths
//   - per hand: the fist centre, the grip axis (the line a held shaft takes through the fist,
//     from the pinky side to the index side), the palm direction, and how each finger curls
// and the solvers work from those measurements, so a different humanoid model (or a mirrored
// left hand) needs no hand tuning. tools/rig.test.mjs checks the solvers on hundreds of random
// grips; the animation lab (tools/anim.test.mjs) checks every pose in the game.
import * as THREE from "three";

const v = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const q = () => new THREE.Quaternion();
const worldPos = (o) => o.getWorldPosition(v());
const worldQuat = (o) => o.getWorldQuaternion(q());

/** Set a bone's world rotation (keeps its parent). */
export function setWorldQuat(bone, wq) {
  bone.quaternion.copy(worldQuat(bone.parent).invert().multiply(wq));
  bone.updateMatrixWorld(true);
}

/** Rotate `bone` (world space) so its child points at `target`. */
export function aim(bone, child, target) {
  const bp = worldPos(bone);
  const cur = worldPos(child).sub(bp).normalize();
  const want = v().subVectors(target, bp).normalize();
  setWorldQuat(bone, worldQuat(bone).premultiply(q().setFromUnitVectors(cur, want)));
}

/** Rotate a bone in world space about `axis` (world) by `angle`. */
export function turn(bone, axis, angle) {
  if (angle) setWorldQuat(bone, worldQuat(bone).premultiply(q().setFromAxisAngle(axis, angle)));
}

/** Two-bone IK: limb.upper → limb.lower → limb.end reaching `target` (world), bending towards `pole`. */
export function solveTwoBone(limb, target, pole) {
  const S = worldPos(limb.upper);
  const a = limb.upperLen, b = limb.lowerLen;
  const toT = v().subVectors(target, S);
  const d = Math.min(Math.max(toT.length(), Math.abs(a - b) + 1e-3), (a + b) * 0.9995);
  const u = toT.normalize();
  const x = (a * a - b * b + d * d) / (2 * d);
  const y = Math.sqrt(Math.max(0, a * a - x * x));
  const perp = v().copy(pole).addScaledVector(u, -pole.dot(u));
  if (perp.lengthSq() < 1e-8) perp.copy(Math.abs(u.y) < 0.9 ? v(0, 1, 0) : v(1, 0, 0)).addScaledVector(u, -u.y);
  perp.normalize();
  aim(limb.upper, limb.lower, v().copy(S).addScaledVector(u, x).addScaledVector(perp, y));
  aim(limb.lower, limb.end, v().copy(S).addScaledVector(u, d));
}

/**
 * Two-bone IK where the elbow is *chosen*: the elbow can be anywhere on a circle, so sample it and
 * keep the elbow with the lowest cost(elbow, forearmDir). Returns the chosen elbow (world).
 */
export function solveTwoBoneChoosing(limb, target, pole, cost) {
  const S = worldPos(limb.upper);
  const a = limb.upperLen, b = limb.lowerLen;
  const toT = v().subVectors(target, S);
  const d = Math.min(Math.max(toT.length(), Math.abs(a - b) + 1e-3), (a + b) * 0.9995);
  const u = toT.normalize();
  const x = (a * a - b * b + d * d) / (2 * d);
  const r = Math.sqrt(Math.max(0, a * a - x * x));
  const e1 = v().copy(pole).addScaledVector(u, -pole.dot(u));
  if (e1.lengthSq() < 1e-8) e1.copy(Math.abs(u.y) < 0.9 ? v(0, 1, 0) : v(1, 0, 0)).addScaledVector(u, -u.y);
  e1.normalize();
  const e2 = v().crossVectors(u, e1);
  const C = v().copy(S).addScaledVector(u, x), W = v().copy(S).addScaledVector(u, d);
  let best = null;
  for (let i = 0; i < 36; i++) {
    const th = (i / 36) * Math.PI * 2;
    const E = v().copy(C).addScaledVector(e1, r * Math.cos(th)).addScaledVector(e2, r * Math.sin(th));
    const c = cost(E, v().subVectors(W, E).normalize()) + 0.35 * (1 - Math.cos(th)); // prefer the pole side
    if (!best || c < best.c) best = { c, E };
  }
  aim(limb.upper, limb.lower, best.E);
  aim(limb.lower, limb.end, W);
  return best.E;
}

/** Rotation taking orthonormal basis (a1, a2, a3) onto (b1, b2, b3). */
function basisRotation(a1, a2, a3, b1, b2, b3) {
  const A = new THREE.Matrix4().makeBasis(a1, a2, a3);
  const B = new THREE.Matrix4().makeBasis(b1, b2, b3);
  return q().setFromRotationMatrix(B.multiply(A.transpose()));
}

const FINGERS = ["index", "middle", "ring", "pinky"];
const GRIP_DIAGONAL = 0.38; // ~22°: the angle a fist holds a shaft off square to the forearm
const WRIST_LIMIT = 1.05; // ~60°: wrist flexion plus ulnar/radial deviation (forearm roll takes the twist)

export class HumanoidRig {
  /** `root`: the skinned model's root, in its bind pose (call before any animation is applied). */
  constructor(root) {
    this.root = root;
    const bone = (n) => root.getObjectByName(n);
    root.updateMatrixWorld(true);
    this.pelvis = bone("pelvis");
    this.neck = bone("neck_01");
    this.spine = bone("spine_03");
    this.waist = bone("spine_01");
    const limb = (u, l, e) => {
      const upper = bone(u), lower = bone(l), end = bone(e);
      return { upper, lower, end, upperLen: worldPos(upper).distanceTo(worldPos(lower)), lowerLen: worldPos(lower).distanceTo(worldPos(end)) };
    };
    this.arms = { r: { ...limb("upperarm_r", "lowerarm_r", "hand_r"), side: "r" }, l: { ...limb("upperarm_l", "lowerarm_l", "hand_l"), side: "l" } };
    this.legs = { r: limb("thigh_r", "calf_r", "foot_r"), l: limb("thigh_l", "calf_l", "foot_l") };
    for (const s of ["r", "l"]) this.measureHand(this.arms[s]);
  }

  /** Hand geometry in the hand bone's own space, from where its finger joints actually are. */
  measureHand(arm) {
    const hand = arm.end;
    const local = (n) => hand.worldToLocal(worldPos(this.root.getObjectByName(`${n}_${arm.side}`)));
    const knuckle = { index: local("index_01"), middle: local("middle_01"), ring: local("ring_01"), pinky: local("pinky_01") };
    const forward = knuckle.middle.clone().normalize(); // wrist → middle knuckle
    const grip = knuckle.index.clone().sub(knuckle.pinky); // pinky → index: the shaft's line through the fist
    grip.addScaledVector(forward, -grip.dot(forward)).normalize();
    // A closed fist holds a shaft diagonally (index knuckle to the heel of the palm), not square
    // to the forearm: the shaft leaves the thumb side angled ~22° towards the fingertips.
    grip.addScaledVector(forward, Math.tan(GRIP_DIAGONAL)).normalize();
    // Palm side: the thumb's base sits on it.
    const normal = v().crossVectors(forward, grip).normalize();
    if (local("thumb_01").dot(normal) < 0) normal.negate();
    arm.grip = { forward, axis: grip, palm: normal };
    // The shaft runs through the curled fingers: just palm-side of the knuckle line.
    const fingerLen = knuckle.middle.distanceTo(local("middle_03"));
    arm.fistCenter = knuckle.middle.clone().multiplyScalar(0.92).addScaledVector(normal, fingerLen * 0.45);
    arm.handRest = hand.quaternion.clone();
    arm.lowerRest = arm.lower.quaternion.clone();

    // Finger curl: each joint turns about the grip axis (in its own space), towards the palm.
    arm.fingers = [];
    const handWorldQ = worldQuat(hand);
    const axisWorld = arm.grip.axis.clone().applyQuaternion(handWorldQ);
    const palmWorld = arm.grip.palm.clone().applyQuaternion(handWorldQ);
    const addJoint = (name, amount, axisW) => {
      const b = this.root.getObjectByName(`${name}_${arm.side}`);
      if (!b || !b.children.length) return;
      const axisLocal = axisW.clone().applyQuaternion(worldQuat(b).invert()).normalize();
      // Sign: the child should move towards the palm.
      const tipBefore = worldPos(b.children[0]);
      const rest = b.quaternion.clone();
      b.quaternion.multiply(q().setFromAxisAngle(axisLocal, 0.2));
      b.updateMatrixWorld(true);
      const moved = worldPos(b.children[0]).sub(tipBefore).dot(palmWorld);
      b.quaternion.copy(rest);
      b.updateMatrixWorld(true);
      arm.fingers.push({ bone: b, rest, axis: axisLocal, angle: moved >= 0 ? amount : -amount });
    };
    for (const f of FINGERS) {
      addJoint(`${f}_01`, 1.35, axisWorld);
      addJoint(`${f}_02`, 1.5, axisWorld);
      addJoint(`${f}_03`, 0.9, axisWorld);
    }
    // Thumb wraps over the fingers: about the hand's forward axis.
    const fwdWorld = arm.grip.forward.clone().applyQuaternion(handWorldQ);
    addJoint("thumb_01", 0.5, fwdWorld);
    addJoint("thumb_02", 0.6, axisWorld);
    addJoint("thumb_03", 0.6, axisWorld);
  }

  /** World-space grip frame of a hand as currently posed. */
  gripFrame(arm) {
    const hq = worldQuat(arm.end);
    return {
      center: arm.end.localToWorld(arm.fistCenter.clone()),
      axis: arm.grip.axis.clone().applyQuaternion(hq),
      forward: arm.grip.forward.clone().applyQuaternion(hq),
      palm: arm.grip.palm.clone().applyQuaternion(hq),
    };
  }

  /** Close (t = 1) or relax (t = 0) a hand's fingers. */
  curl(arm, t = 1) {
    for (const f of arm.fingers) f.bone.quaternion.copy(f.rest).multiply(q().setFromAxisAngle(f.axis, f.angle * t));
    arm.end.updateMatrixWorld(true);
  }

  /** Every bone holdShaft() may modify for this arm (for save/restore/blend by callers). */
  armBones(arm) { return [arm.upper, arm.lower, arm.end, ...arm.fingers.map((f) => f.bone)]; }

  /**
   * Hold a shaft: put `arm`'s fist around the line through `point` along `dir` (world), with
   *  - the shaft along the fist's grip axis (either way round: whichever twists less)
   *  - the forearm coming in square to the shaft, so the wrist stays nearly straight
   *  - the forearm, not the wrist, taking the roll (pronation/supination)
   *  - the elbow bending towards `pole` (world direction, e.g. outward and down)
   *  - fingers closed
   * Returns the fist centre actually reached (world): if the shaft is out of reach, callers move
   * the weapon to it so the hand never lets go. `this.lastReached` tells whether it got there.
   */
  holdShaft(arm, point, dir, pole) {
    const D = dir.clone().normalize();
    const S = worldPos(arm.upper);
    const a = arm.upperLen, b = arm.lowerLen;
    const pa = worldPos(this.pelvis), pb = worldPos(this.neck), ab = v().subVectors(pb, pa);
    const torsoDist = (p) => p.distanceTo(pa.clone().addScaledVector(ab, Math.min(1, Math.max(0, v().subVectors(p, pa).dot(ab) / ab.lengthSq()))));

    // A straight wrist needs the forearm square to the shaft, so the only freedom is the angle φ
    // the forearm comes in at, around the shaft. Each φ fixes the hand rotation, the wrist and
    // the elbow; keep the φ whose elbow sits exactly an upper-arm length from the shoulder,
    // preferring elbows on the pole side and off the torso.
    const e1 = v().subVectors(point, S).addScaledVector(D, -v().subVectors(point, S).dot(D));
    if (e1.lengthSq() < 1e-6) e1.copy(pole).addScaledVector(D, -pole.dot(D));
    e1.normalize();
    const e2 = v().crossVectors(D, e1);
    // The forearm may also come in up to 60° off square (the wrist bends that much, within a
    // real wrist's range): search the approach angle φ round the shaft and the tilt θ off square.
    // The hand rotation and wrist depend only on φ (not the tilt): cache them per φ.
    const straightNow = worldQuat(arm.lower).multiply(arm.handRest);
    const perPhi = new Map();
    const atPhi = (phi) => {
      let c = perPhi.get(phi);
      if (!c) {
        const Fperp = v().copy(e1).multiplyScalar(Math.cos(phi)).addScaledVector(e2, Math.sin(phi));
        const { rot } = this.handRotationFor(arm, D, Fperp, 0, straightNow);
        const W = v().copy(point).sub(arm.fistCenter.clone().applyQuaternion(rot));
        c = { Fperp, rot, W, mid: v().addVectors(S, W).multiplyScalar(0.5) };
        perPhi.set(phi, c);
      }
      return c;
    };
    const evaluate = (phi, tilt) => {
      const { Fperp, rot, W, mid } = atPhi(phi);
      const F = v().copy(Fperp).multiplyScalar(Math.cos(tilt)).addScaledVector(D, Math.sin(tilt));
      const E = v().copy(W).addScaledVector(F, -b);
      const err = Math.abs(E.distanceTo(S) - a);
      const side = 1 - v().subVectors(E, mid).normalize().dot(pole);
      const td = torsoDist(E);
      // Elbows hang: raising one above both the shoulder and the wrist (a "chicken wing") costs a lot.
      const raised = Math.max(0, E.y - Math.max(S.y - 0.04, W.y));
      const cost = err * 20 + 0.12 * tilt * tilt + 0.04 * side + (td < 0.13 ? 2 * (0.13 - td) / 0.13 : 0) + 25 * raised;
      return { cost, err, F, rot, W, E, phi, tilt };
    };
    // Coarse-to-fine: a coarse sweep of approach angle φ and tilt (±50°), then a fine sweep
    // around the best. ~340 candidates instead of ~2000: cheap enough for every frame.
    const TILT = 0.87;
    let best = null;
    for (let i = 0; i < 32; i++) {
      for (let j = -4; j <= 4; j++) {
        const c = evaluate((i / 32) * Math.PI * 2, (j / 4) * TILT);
        if (!best || c.cost < best.cost) best = c;
      }
    }
    const dPhi = Math.PI / 16, dTilt = TILT / 4;
    for (const scale of [0.5, 0.2]) {
      const centre = best;
      for (let i = -2; i <= 2; i++) {
        for (let j = -2; j <= 2; j++) {
          const tilt = Math.max(-TILT, Math.min(TILT, centre.tilt + j * dTilt * scale));
          const c = evaluate(centre.phi + i * dPhi * scale, tilt);
          if (c.cost < best.cost) best = c;
        }
      }
    }

    let rot = best.rot;
    if (best.err < 0.012) {
      aim(arm.upper, arm.lower, best.E);
      aim(arm.lower, arm.end, best.W);
      this.lastReached = true;
    } else {
      // No grip within a real wrist's range (out of reach, or the shaft points at the shoulder):
      // reach as close as the arm allows with a natural hand for the forearm it got. The fist
      // then misses the shaft, and callers move the weapon to the fist (the hand never lets go).
      // Reach the wrist with plain IK and keep the wanted hand rotation, but never bend the wrist
      // past a human limit (~50°): if the limit didn't bite, the fist is still on the shaft.
      solveTwoBone(arm, best.W, pole);
      const straight = worldQuat(arm.lower).multiply(arm.handRest);
      const bend = straight.angleTo(best.rot);
      rot = bend <= WRIST_LIMIT ? best.rot : straight.clone().slerp(best.rot, WRIST_LIMIT / bend);
      this.lastReached = bend <= WRIST_LIMIT && worldPos(arm.end).distanceTo(best.W) < 0.01;
    }
    // The forearm takes the roll; the wrist keeps only what's left (≈ nothing when reached).
    const fa = v().subVectors(worldPos(arm.end), worldPos(arm.lower)).normalize();
    const rel = rot.clone().multiply(worldQuat(arm.lower).multiply(arm.handRest).invert());
    turn(arm.lower, fa, 2 * Math.atan2(rel.x * fa.x + rel.y * fa.y + rel.z * fa.z, rel.w));
    setWorldQuat(arm.end, rot);
    this.curl(arm, 1);
    return this.gripFrame(arm).center;
  }

  /**
   * Hand rotation (world) with the grip axis along sign·D and the hand pointing along F. With
   * sign 0 it picks the sign that twists least. Returns { rot, sign }.
   */
  handRotationFor(arm, D, F, fixedSign = 0, straightQ = null) {
    const g = arm.grip;
    const fw = g.forward.clone().addScaledVector(g.axis, -g.forward.dot(g.axis)).normalize();
    const n = v().crossVectors(g.axis, fw);
    const best = (fixedSign ? [fixedSign] : [1, -1]).map((sign) => {
      const X = D.clone().multiplyScalar(sign);
      const Fy = F.clone().addScaledVector(X, -F.dot(X)).normalize();
      const rot = basisRotation(g.axis, fw, n, X, Fy, v().crossVectors(X, Fy));
      // Twist cost: angle between this and the hand straight off the forearm as it is.
      const straight = straightQ ?? worldQuat(arm.lower).multiply(arm.handRest);
      return { rot, sign, cost: rot.angleTo(straight) };
    }).sort((a, b) => a.cost - b.cost)[0];
    return best;
  }

  /**
   * After the arm is solved: give the hand its grip rotation, with the roll about the forearm
   * moved into the forearm (as the radius and ulna do) and only the bend left at the wrist.
   */
  placeHand(arm, D, sign = 0) {
    const forearmAxis = v().subVectors(worldPos(arm.end), worldPos(arm.lower)).normalize();
    const F = forearmAxis.clone().addScaledVector(D, -forearmAxis.dot(D)).normalize();
    const want = this.handRotationFor(arm, D, F, sign).rot;
    // Swing-twist of the hand relative to "straight off the forearm", about the forearm axis.
    const straight = worldQuat(arm.lower).multiply(arm.handRest);
    const rel = want.clone().multiply(straight.clone().invert()); // world-space delta
    const axisDot = rel.x * forearmAxis.x + rel.y * forearmAxis.y + rel.z * forearmAxis.z;
    turn(arm.lower, forearmAxis, 2 * Math.atan2(axisDot, rel.w)); // the forearm takes the roll...
    setWorldQuat(arm.end, want); // ...so the wrist keeps only the bend
  }

  /** Free hand: reach the wrist to `point` with a straight wrist and a closed fist. */
  reachTo(arm, point, pole) {
    solveTwoBone(arm, point, pole);
    setWorldQuat(arm.end, worldQuat(arm.lower).multiply(arm.handRest));
    this.curl(arm, 1);
  }

  /** Wrist bend (rad) and wrist twist (rad) of an arm as posed: for checks. */
  wristAngles(arm) {
    const forearmAxis = v().subVectors(worldPos(arm.end), worldPos(arm.lower)).normalize();
    const straight = worldQuat(arm.lower).multiply(arm.handRest);
    const rel = worldQuat(arm.end).multiply(straight.clone().invert());
    const axisDot = rel.x * forearmAxis.x + rel.y * forearmAxis.y + rel.z * forearmAxis.z;
    const twist = Math.abs(2 * Math.atan2(axisDot, Math.abs(rel.w)));
    // Bend: the hand's whole rotation off "straight from the forearm" (the quantity holdShaft caps).
    return { bend: straight.angleTo(worldQuat(arm.end)), twist };
  }
}
