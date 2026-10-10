// Rig baseline tests: the hand/arm solvers in public/game/rig.js on hundreds of random grips.
// If these pass, any pose built on holdShaft() holds its weapon like a hand: shaft through the
// fist, along the fist, fingers closed round it, wrist within human limits, elbow off the body.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { HumanoidRig } from "../public/game/rig.js";

const ASSETS = new URL("../public/assets/", import.meta.url);
async function body() {
  const buf = await readFile(new URL("ual/Mannequin_F.glb", ASSETS));
  return (await new GLTFLoader().parseAsync(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), "")).scene;
}
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
const wp = (o) => o.getWorldPosition(new THREE.Vector3());

test("holdShaft grips any reachable shaft like a hand", async () => {
  const root = await body();
  const rig = new HumanoidRig(root);
  const rest = new Map();
  root.traverse((o) => o.isBone && rest.set(o, o.quaternion.clone()));
  const reset = () => { for (const [b, qq] of rest) b.quaternion.copy(qq); root.updateMatrixWorld(true); };
  // Body frame from the bind pose: up, forward (toes), and which way is each arm's outside.
  const up = new THREE.Vector3(0, 1, 0);
  const fwd = wp(root.getObjectByName("ball_l")).sub(wp(root.getObjectByName("foot_l"))).setY(0).normalize();
  const random = rng(7);
  const fails = [];
  let n = 0, unreachable = 0;
  for (const side of ["r", "l"]) {
    const arm = rig.arms[side];
    for (let i = 0; i < 200; i++) {
      reset();
      const S = wp(arm.upper);
      const out = S.clone().sub(wp(rig.neck)).setY(0).normalize();
      const reach = arm.upperLen + arm.lowerLen;
      // A shaft point in front of the body within ~80% reach, any shaft direction.
      const point = S.clone()
        .addScaledVector(fwd, reach * (0.35 + 0.35 * random()))
        .addScaledVector(up, reach * (-0.6 + 0.8 * random()))
        .addScaledVector(out, reach * (-0.35 + 0.5 * random()));
      if (point.distanceTo(S) > reach * 0.8) continue;
      const dir = new THREE.Vector3(random() - 0.5, random() - 0.5, random() - 0.5).normalize();
      const pole = out.clone().multiplyScalar(0.8).addScaledVector(up, -1).normalize();
      rig.holdShaft(arm, point, dir, pole);
      root.updateMatrixWorld(true);
      if (!rig.lastReached) { unreachable++; continue; } // out of reach: callers move the weapon to the fist
      n++;
      const g = rig.gripFrame(arm);
      const toLine = (p) => { const d = p.clone().sub(point); return d.addScaledVector(dir, -d.dot(dir)).length(); };
      const axisErr = Math.min(g.axis.angleTo(dir), g.axis.angleTo(dir.clone().negate()));
      const { bend, twist } = rig.wristAngles(arm);
      const tip = wp(root.getObjectByName(`middle_03_${side}`).children[0] ?? root.getObjectByName(`middle_03_${side}`));
      const elbow = wp(arm.lower);
      const a = wp(rig.pelvis), b = wp(rig.neck), ab = b.clone().sub(a);
      const t = Math.min(1, Math.max(0, elbow.clone().sub(a).dot(ab) / ab.lengthSq()));
      const elbowToTorso = elbow.distanceTo(a.clone().addScaledVector(ab, t));
      const bad = [];
      if (toLine(g.center) > 0.015) bad.push(`fist ${toLine(g.center).toFixed(3)} m off the shaft`);
      if (axisErr > 0.18) bad.push(`shaft ${(axisErr * 57.3).toFixed(0)}° off the fist axis`);
      if (bend > 1.26) bad.push(`wrist bent ${(bend * 57.3).toFixed(0)}°`); // a real wrist manages ~40° sideways/forward
      if (twist > 0.35) bad.push(`wrist twisted ${(twist * 57.3).toFixed(0)}°`);
      if (toLine(tip) > 0.05) bad.push(`fingers open (tip ${toLine(tip).toFixed(3)} m from the shaft)`);
      if (elbowToTorso < 0.06) bad.push(`elbow in the torso (${elbowToTorso.toFixed(2)} m)`);
      const lift = elbow.y - Math.max(S.y, wp(arm.end).y);
      if (lift > 0.06) bad.push(`elbow raised ${lift.toFixed(2)} m (chicken wing)`);
      if (process.env.RIG_DEBUG && bad.length) {
        const fa = wp(arm.end).sub(wp(arm.lower)).normalize();
        bad.push(`[forearm·shaft ${fa.dot(dir).toFixed(2)}, |S→point| ${point.distanceTo(S).toFixed(2)}/${reach.toFixed(2)}, elbowTorso ${elbowToTorso.toFixed(2)}]`);
      }
      if (bad.length) fails.push(`${side}#${i}: ${bad.join(", ")}`);
    }
  }
  assert.ok(n > 150 && unreachable < n * 0.25, `too few reachable samples (${n} reachable, ${unreachable} not)`);
  assert.equal(fails.length, 0, `${fails.length}/${n} grips failed:\n  ${fails.slice(0, 25).join("\n  ")}`);
});
