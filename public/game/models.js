// Rigged fighter models (KayKit Adventurers, CC0) driven by the sim's state and frame data.
//
// The sim is the truth; this only decides which clip to show and *where in the clip* we are.
// Attack clips are time-warped so the swing's impact lands on the move's first active frame:
// startup looks exactly as long as it is, so moves can be read and reacted to.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import * as SkeletonUtils from "three/addons/utils/SkeletonUtils.js";
import { attackPhase, isCrouching } from "../engine/sim/world.js";
import { THROW_FRAMES } from "../engine/sim/constants.js";

const BASE = "./assets/kaykit/";
const FADE_FRAMES = 4; // cross-fade between clips (render frames)
const ACTIVE_SPAN = 0.12; // seconds of clip shown across the active frames, centred on impact
const LOWER_BODY = /^(hips|upperleg|lowerleg|foot|toes)/;

// Moment of impact per clip (seconds), picked by eye from contact sheets of the KayKit clips.
// Attack clips are warped so this moment lands on the move's first active frame.
const IMPACT = {
  "2H_Melee_Attack_Chop": 0.88, "2H_Melee_Attack_Slice": 0.52, "2H_Melee_Attack_Stab": 0.95,
  "2H_Melee_Attack_Spin": 1.2, "Block_Attack": 0.4,
  "1H_Melee_Attack_Slice_Horizontal": 0.42, "1H_Melee_Attack_Slice_Diagonal": 0.5,
  "1H_Melee_Attack_Stab": 0.55, "1H_Melee_Attack_Chop": 0.55,
  "Unarmed_Melee_Attack_Kick": 0.45, "Unarmed_Melee_Attack_Punch_A": 0.45, "Unarmed_Melee_Attack_Punch_B": 0.45,
};

const gltfs = new Map();
const prepared = new WeakMap();

export function loadModel(name) {
  if (!gltfs.has(name)) gltfs.set(name, new GLTFLoader().loadAsync(`${BASE}${name}.glb`));
  return gltfs.get(name);
}

/** Load every model the roster uses. Resolves to a name -> gltf map. */
export async function preloadModels(roster) {
  const names = new Set();
  for (const c of roster) {
    if (!c.look?.model) continue;
    names.add(c.look.model);
    if (c.look.weaponFrom) names.add(c.look.weaponFrom.model);
  }
  const entries = await Promise.all([...names].map(async (n) => [n, await loadModel(n)]));
  return new Map(entries);
}

// ---- one-time clip preparation per gltf -------------------------------------------------

function prepare(gltf) {
  if (prepared.has(gltf)) return prepared.get(gltf);
  const clips = new Map();
  for (const clip of gltf.animations) {
    const c = clip.clone();
    // The sim moves the fighter; drop horizontal root motion so clips don't double it.
    for (const t of c.tracks) {
      if (t.name === "hips.position" || t.name === "root.position") {
        for (let i = 0; i < t.values.length; i += 3) { t.values[i] = 0; t.values[i + 2] = 0; }
      }
    }
    clips.set(c.name, c);
  }
  const info = { clips, impact: new Map() };
  info.crouch = makeCrouch(clips);
  prepared.set(gltf, info);
  return info;
}

/** Additive lower-body "squat" layer, used for crouch guard and low attacks. */
function makeCrouch(clips) {
  const src = clips.get("Lie_StandUp") ?? clips.get("Jump_Land");
  const idle = clips.get("2H_Melee_Idle") ?? clips.get("Idle");
  if (!src || !idle) return null;
  const at = src.name === "Lie_StandUp" ? 1.4 : 0.15; // a squatting frame in the stand-up
  const fps = 30;
  const pose = THREE.AnimationUtils.subclip(src, "crouch_pose", Math.round(at * fps), Math.round(at * fps) + 1, fps);
  pose.tracks = pose.tracks.filter((t) => LOWER_BODY.test(t.name));
  const ref = THREE.AnimationUtils.subclip(idle, "crouch_ref", 0, 1, fps);
  ref.tracks = ref.tracks.filter((t) => LOWER_BODY.test(t.name));
  return THREE.AnimationUtils.makeClipAdditive(pose, 0, ref, fps);
}

/**
 * For clips not in IMPACT, a best guess at the moment of impact: when the weapon hand is furthest in front of the
 * body (arms extended into the target). Works for chops, slices and stabs alike; peak hand speed
 * lands mid-swing instead.
 */
function impactTime(info, root, clipName) {
  if (info.impact.has(clipName)) return info.impact.get(clipName);
  if (IMPACT[clipName] !== undefined) { info.impact.set(clipName, IMPACT[clipName]); return IMPACT[clipName]; }
  const clip = info.clips.get(clipName);
  let best = clip ? clip.duration * 0.45 : 0;
  const hand = root.getObjectByName("handslotr");
  if (clip && hand) {
    const mixer = new THREE.AnimationMixer(root);
    const action = mixer.clipAction(clip);
    action.play();
    const p = new THREE.Vector3();
    const inv = new THREE.Matrix4();
    let bestForward = -Infinity;
    const N = 48;
    for (let i = 0; i <= N; i++) {
      const t = (clip.duration * i) / N;
      if (t < clip.duration * 0.12 || t > clip.duration * 0.85) continue; // skip wind-up start and settle
      action.time = t;
      mixer.update(0);
      root.updateMatrixWorld(true);
      hand.getWorldPosition(p);
      p.applyMatrix4(inv.copy(root.matrixWorld).invert()); // model space: +z is forward
      if (p.z > bestForward) { bestForward = p.z; best = t; }
    }
    action.stop();
    mixer.uncacheRoot(root);
  }
  info.impact.set(clipName, best);
  return best;
}

// ---- per-fighter model ------------------------------------------------------------------

export class FighterModel {
  constructor(char, models) {
    const look = char.look;
    const gltf = models.get(look.model);
    this.info = prepare(gltf);
    this.look = look;
    this.char = char;
    this.root = SkeletonUtils.clone(gltf.scene);
    this.holder = new THREE.Group();
    this.holder.rotation.y = Math.PI / 2; // models face +z; the sim's forward is local +x
    this.holder.scale.setScalar(look.scale ?? 0.8);
    this.holder.add(this.root);

    this.bodyMats = [];
    this.weaponMats = [];
    const show = new Set(look.show ?? []);
    this.root.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = true;
      o.material = o.material.clone(); // per fighter, so flashes and tints don't leak
      for (const tex of [o.material.map]) if (tex) { tex.magFilter = THREE.NearestFilter; tex.minFilter = THREE.NearestFilter; }
      if (!o.isSkinnedMesh) o.visible = show.has(o.name);
      if (look.tint) o.material.color.multiply(new THREE.Color(look.tint));
      const isWeapon = !o.isSkinnedMesh && /^(1H|2H)_/.test(o.name);
      (isWeapon ? this.weaponMats : this.bodyMats).push(o.material);
      if (isWeapon && o.visible) this.weapon = o;
    });
    this.handR = this.root.getObjectByName("handslotr"); // GLTFLoader strips dots from node names
    if (look.weaponFrom) this.borrowWeapon(models.get(look.weaponFrom.model), look.weaponFrom.mesh);
    if (look.spear) this.buildSpear(look.spear);
    this.head = this.root.getObjectByName("head");

    // Find every attack clip's impact up front so the first swing doesn't hitch.
    for (const name of new Set(Object.values(look.moves ?? {}))) if (this.info.clips.has(name)) impactTime(this.info, this.root, name);

    this.mixer = new THREE.AnimationMixer(this.root);
    this.actions = new Map();
    this.cur = null;
    this.prev = null;
    this.fade = 0;
    this.clock = 0;
    if (this.info.crouch) {
      this.crouchAction = this.mixer.clipAction(this.info.crouch);
      this.crouchAction.blendMode = THREE.AdditiveAnimationBlendMode;
      this.crouchAction.play();
      this.crouchAction.setEffectiveWeight(0);
      this.crouchWeight = 0;
    }
  }

  borrowWeapon(gltf, meshName) {
    const src = gltf.scene.getObjectByName(meshName);
    if (!src || !this.handR) return;
    const w = src.clone();
    w.material = src.material.clone();
    w.material.map && (w.material.map.magFilter = THREE.NearestFilter);
    w.castShadow = true;
    w.visible = true;
    if (this.look.weaponFrom.scale) w.scale.multiplyScalar(this.look.weaponFrom.scale);
    this.handR.add(w);
    this.weaponMats.push(w.material);
    this.weapon = w;
  }

  /** The pack has no spear, so build a low-poly one in the right hand (handle along +y). */
  buildSpear({ length = 2.6, back = 0.9 }) {
    if (!this.handR) return;
    const group = new THREE.Group();
    const wood = new THREE.MeshStandardMaterial({ color: 0x7a5432, roughness: 0.9 });
    const steel = new THREE.MeshStandardMaterial({ color: 0xc9ced6, roughness: 0.4, metalness: 0.2 });
    const cloth = new THREE.MeshStandardMaterial({ color: 0xc23b2b, roughness: 0.9 });
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, length, 6), wood);
    shaft.position.y = length / 2 - back;
    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.42, 6), steel);
    tip.position.y = length - back + 0.21;
    const tassel = new THREE.Mesh(new THREE.ConeGeometry(0.08, 0.2, 5), cloth);
    tassel.position.y = length - back - 0.06;
    tassel.rotation.x = Math.PI;
    for (const m of [shaft, tip, tassel]) { m.castShadow = true; group.add(m); }
    this.handR.add(group);
    this.weaponMats.push(steel, wood);
    this.weapon = group;
  }

  action(name) {
    if (!this.actions.has(name)) {
      const clip = this.info.clips.get(name);
      if (!clip) return null;
      const a = this.mixer.clipAction(clip);
      a.play();
      a.setEffectiveWeight(0);
      this.actions.set(name, a);
    }
    return this.actions.get(name);
  }

  setEmissive(body, weapon) {
    for (const m of this.bodyMats) m.emissive?.setHex(body);
    for (const m of this.weaponMats) m.emissive?.setHex(weapon);
  }

  /** Which clip and clip-time represents this fighter's sim state right now. */
  choose(f, dt) {
    const look = this.look;
    const clipDur = (n) => this.info.clips.get(n)?.duration ?? 1;
    const once = (name, progress) => ({ name, time: Math.min(0.999, Math.max(0, progress)) * clipDur(name) });
    const loop = (name, speed = 1) => ({ name, time: (this.clock * speed) % clipDur(name) });
    const idle = look.idle ?? "2H_Melee_Idle";

    switch (f.state) {
      case "attack": {
        const m = f.move;
        if (m.parry) return { ...loop("Blocking"), crouch: 0 };
        const name = look.moves?.[m.id] ?? (m.level === "throw" ? "Unarmed_Melee_Attack_Punch_A" : "2H_Melee_Attack_Slice");
        return { name, time: this.attackTime(name, m, f.frame), crouch: m.level === "low" ? 0.85 : 0 };
      }
      case "idle":
        if (isCrouching(f)) return { ...loop(look.block ?? "Blocking"), crouch: 1 };
        if (f.walking > 0) return loop(look.walk ?? "Walking_B", f.char.walkForward / 2.2);
        if (f.walking < 0) return loop("Walking_Backwards", f.char.walkBack / 1.8);
        return loop(idle);
      case "blockstun": return { ...once("Block_Hit", 0.15 + 0.6 * f.frame / Math.max(1, f.duration)), crouch: f.crouch ? 1 : 0 };
      case "hitstun": return once(f.duration > 22 ? "Hit_B" : "Hit_A", f.frame / Math.max(1, f.duration));
      case "juggle": return once("Hit_B", 0.35);
      case "knockdown": return once("Death_A", f.frame / 30);
      case "ko": return once("Death_B", f.frame / 90);
      case "guardbreak": return loop("Hit_B", 0.5);
      case "staggered": return once("Hit_B", 0.1 + 0.5 * f.frame / Math.max(1, f.duration));
      case "grabbed": return once("Hit_A", 0.3 + 0.4 * f.frame / THROW_FRAMES);
      case "grabbing": return once("Throw", f.frame / THROW_FRAMES);
      case "techstun": return once("Block_Hit", f.frame / Math.max(1, f.duration));
      case "taunt": return once("Cheer", f.frame / Math.max(1, f.duration));
      case "sidestep": return once(f.sideDir > 0 ? "Dodge_Left" : "Dodge_Right", f.frame / Math.max(1, f.duration));
      case "dash": return once("Dodge_Forward", f.frame / Math.max(1, f.duration));
      case "backdash": return once("Dodge_Backward", f.frame / Math.max(1, f.duration));
      case "roll": return once(f.sideDir > 0 ? "Dodge_Right" : "Dodge_Left", f.frame / Math.max(1, f.duration));
      default: return loop(idle);
    }
  }

  /** Warp the clip so its impact lands on the first active frame, whatever the move's frame data. */
  attackTime(name, m, frame) {
    const clip = this.info.clips.get(name);
    if (!clip) return 0;
    const T = clip.duration;
    const ti = impactTime(this.info, this.root, name);
    const a0 = Math.max(0, ti - ACTIVE_SPAN / 2), a1 = Math.min(T, ti + ACTIVE_SPAN / 2);
    if (frame < m.startup) return a0 * (frame / m.startup);
    if (frame < m.startup + m.active) return a0 + (a1 - a0) * ((frame - m.startup) / m.active);
    return Math.min(T * 0.999, a1 + (T - a1) * ((frame - m.startup - m.active) / m.recovery));
  }

  update(f, dt) {
    this.clock += dt;
    const want = this.choose(f, dt);
    if (!this.cur || want.name !== this.cur.name) {
      if (this.prev) this.action(this.prev.name)?.setEffectiveWeight(0);
      this.prev = this.cur;
      this.cur = { name: want.name };
      this.fade = this.prev ? FADE_FRAMES : 0;
    }
    this.cur.time = want.time;
    const k = this.fade > 0 ? 1 - this.fade / FADE_FRAMES : 1;
    if (this.fade > 0) this.fade--;
    const cur = this.action(this.cur.name);
    if (cur) { cur.time = want.time; cur.setEffectiveWeight(k); }
    if (this.prev) {
      const p = this.action(this.prev.name);
      if (p) p.setEffectiveWeight(1 - k);
      if (k >= 1) { p?.setEffectiveWeight(0); this.prev = null; }
    }
    if (this.crouchAction) {
      const target = want.crouch ?? 0;
      this.crouchWeight += (target - this.crouchWeight) * 0.5;
      this.crouchAction.setEffectiveWeight(this.crouchWeight);
    }
    this.mixer.update(0);
    // The pack is chibi; a smaller head reads more like a fighter. Clips key scale, so re-apply after them.
    if (this.head && this.look.headScale) this.head.scale.setScalar(this.look.headScale);
  }
}
