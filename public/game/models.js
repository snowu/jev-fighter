// Rigged fighter models driven by the sim's state and frame data.
//
// Body: Quaternius female mannequin. Animations: Quaternius Universal Animation Library 1 + 2
// (both CC0, same humanoid rig; UAL1 clips are pre-converted to JSON). Weapons and accessories are low-poly shapes built here and
// parented to bones, so each fighter gets its own silhouette from one shared body.
//
// The sim is the truth. Strikes are posed procedurally (swing.js) so the weapon tip passes through
// the actual hit point on the active frames; everything else (stance, movement, hit reactions,
// knockdowns, throws) plays a clip at the time the sim's state implies.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import * as SkeletonUtils from "three/addons/utils/SkeletonUtils.js";
import { isCrouching } from "../engine/sim/world.js";
import { SwingRig, swingPhase, tuneSwing } from "./swing.js";
import { assetQuery } from "./version.js";
import { THROW_FRAMES, KNOCKDOWN_FRAMES, JUGGLE_FRAMES } from "../engine/sim/constants.js";

const BASE = "./assets/";
const BODY = "ual/Mannequin_F";
const ANIM_GLB = "ual/UAL2"; // UAL2, same bone names as the body
const ANIM_JSON = "ual/UAL1_clips.json"; // UAL1 clips converted from its Unreal FBX (tools/convert-ual1.mjs)
const FADE_FRAMES = 4; // cross-fade between clips (render frames)
const ACTIVE_SPAN = 0.1; // seconds of clip shown across the active frames, centred on impact
const LOWER_BODY = /^(pelvis|thigh|calf)/; // crouch layer: feet keep the stance's flat footing
/** Height of a juggled fighter above the floor (shared by the renderer and the animation lab). */
export function airborneHeight(f) {
  if (f.state !== "juggle" || !f.duration) return 0;
  const t = Math.min(1, f.frame / f.duration);
  return 4 * 1.35 * (f.duration / JUGGLE_FRAMES) * t * (1 - t) + 0.05;
}
export const GROUNDED_LOW = new Set(["knockdown", "ko", "roll", "juggle", "grabbed"]); // states whose clips can sink into the floor

// Moment of impact (seconds) for the few clip-driven attacks (throws); strikes are procedural (swing.js).
export const IMPACT = { Melee_Hook: 0.19 };

// Weapon grips (hand-bone rotations mapping the weapon's +y onto a hand axis). The two libraries
// pose the hand differently, so the grip follows the clip: UAL2 sword clips swing the blade along
// the hand's +x, UAL1 stances (idle, walk, crouch) hold it along -y (forward and up), and jabs
// drive along +y (Tove's spear pokes use the jab clip). The weapon slerps between grips.
const H = Math.PI / 2;
export const GRIPS = { blade: [0, 0, -H], rest: [Math.PI, 0, 0], thrust: [0, 0, 0] };
const gripFor = (clip) => (/^Punch_/.test(clip.name) ? "thrust" : clip.userData.src === "ual1" ? "rest" : "blade");

// Guard poses per weapon: hand position relative to the weapon shoulder (forward, up, side) and
// the weapon's direction, in the fighter frame (+x towards the opponent). stand: ready guard
// (also under walks and crouches); high/low: blocking across the face / across the shins.
// Hands are placed relative to the chest (forward, up, weapon side), out in front of the body.
// offHand: where the second hand grips, along the weapon from the first (+ towards the butt):
// katana hands together on the hilt; axe and spear lead hand further up the shaft (negative).
const GUARDS = {
  katana: { stand: { hand: [0.42, -0.12, 0.06], dir: [0.82, 0.55, -0.12] }, high: { hand: [0.38, 0.22, 0.12], dir: [0.3, 0.35, -0.89] }, low: { hand: [0.4, -0.38, 0.08], dir: [0.45, -0.45, -0.77] }, offHand: 0.14 },
  axe: { stand: { hand: [0.4, -0.18, 0.08], dir: [0.45, 0.86, -0.2] }, high: { hand: [0.38, 0.2, 0.12], dir: [0.3, 0.3, -0.9] }, low: { hand: [0.4, -0.38, 0.08], dir: [0.4, -0.5, -0.77] }, offHand: -0.32 },
  // Spear: the off (lead) hand sits forward on the shaft, so offHand is negative.
  spear: { stand: { hand: [0.3, -0.15, 0.1], dir: [0.97, 0.22, -0.06] }, high: { hand: [0.38, 0.2, 0.12], dir: [0.3, 0.3, -0.9] }, low: { hand: [0.4, -0.35, 0.08], dir: [0.75, -0.22, -0.62] }, offHand: -0.26 },
};

// Clips for every non-attack state.
const STATE_CLIPS = {
  idle: "Sword_Idle", walk: "Walk_Loop", crouch: "Crouch_Idle_Loop", block: "Sword_Block",
  hitLight: "Hit_Chest", hitHeavy: "Hit_Head", knockback: "Hit_Knockback", fall: "Death01", getup: "LayToIdle",
  guardbreak: "Idle_Shield_Break", throwing: "OverhandThrow", taunt: "Dance_Loop", dash: "Sword_Dash_RM",
  roll: "Roll", parry: "Sword_Block",
};

// Asset access is injectable so the same code runs in the browser (fetch) and in Node checks
// (read from disk); see tools/anim.test.mjs.
const browserAssets = {
  glb: (path) => new GLTFLoader().loadAsync(`${BASE}${path}.glb${assetQuery}`),
  json: (path) => fetch(`${BASE}${path}${assetQuery}`).then((r) => r.json()),
};

/** Load the shared body and animation libraries once. Resolves to the asset bundle. */
export async function preloadModels(assets = browserAssets) {
  const [body, ual2, ual1] = await Promise.all([assets.glb(BODY), assets.glb(ANIM_GLB), assets.json(ANIM_JSON)]);
  const clips = new Map();
  const fromUal1 = ual1.map((j) => Object.assign(turnAround(THREE.AnimationClip.parse(j)), { userData: { src: "ual1" } }));
  for (const c of [...fromUal1, ...ual2.animations]) {
    if (!clips.has(c.name)) clips.set(c.name, Object.assign(prepareClip(c), { userData: c.userData ?? {} }));
  }
  return { body, clips, crouch: makeCrouch(clips), impact: new Map() };
}

/** UAL1's Unreal FBX faces the opposite way to UAL2: spin its pelvis 180° about root-space up (z). */
function turnAround(clip) {
  const spin = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI);
  const q = new THREE.Quaternion();
  for (const t of clip.tracks) {
    if (t.name === "pelvis.quaternion") {
      for (let i = 0; i < t.values.length; i += 4) {
        q.fromArray(t.values, i).premultiply(spin).toArray(t.values, i);
      }
    } else if (t.name === "pelvis.position") {
      for (let i = 0; i < t.values.length; i += 3) { t.values[i] = -t.values[i]; t.values[i + 1] = -t.values[i + 1]; }
    }
  }
  return clip;
}

/** The sim moves the fighter: freeze root motion so clips don't move it a second time. */
function prepareClip(clip) {
  const c = clip.clone();
  const rootMotion = /_RM$/.test(c.name);
  for (const t of c.tracks) {
    // Ground-plane axes: root lives in the y-up armature space; pelvis in root's z-up space.
    const axes = t.name === "root.position" ? [0, 2] : rootMotion && t.name === "pelvis.position" ? [0, 1] : null;
    if (!axes) continue;
    for (const a of axes) for (let i = a; i < t.values.length; i += 3) t.values[i] = t.values[a]; // hold the first key
  }
  return c;
}

/** Additive lower-body squat (crouch minus stand), layered under attacks for low moves. */
function makeCrouch(clips) {
  const pose = clips.get(STATE_CLIPS.crouch), ref = clips.get(STATE_CLIPS.idle);
  if (!pose || !ref) return null;
  const fps = 30;
  const p = THREE.AnimationUtils.subclip(pose, "crouch_add", 0, 1, fps);
  p.tracks = p.tracks.filter((t) => LOWER_BODY.test(t.name));
  const r = THREE.AnimationUtils.subclip(ref, "crouch_ref", 0, 1, fps);
  r.tracks = r.tracks.filter((t) => LOWER_BODY.test(t.name));
  return THREE.AnimationUtils.makeClipAdditive(p, 0, r, fps);
}

// ---- weapons and accessories (bone-space shapes) -------------------------------------------

const mat = (color, opts = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.75, ...opts });

/** Weapon built along the hand bone's +y (towards the fingers), grip at the origin. */
function buildWeapon(kind, length) {
  const g = new THREE.Group();
  const add = (geo, m, y, rot = null, x = 0) => {
    const mesh = new THREE.Mesh(geo, m);
    mesh.position.set(x, y, 0);
    if (rot) mesh.rotation.set(...rot);
    mesh.castShadow = true;
    g.add(mesh);
    return mesh;
  };
  const wood = mat(0x6b4a2c), steel = mat(0xc4cad3, { metalness: 0.3, roughness: 0.4 }), dark = mat(0x1d1f24);
  const metal = [];
  if (kind === "axe") {
    add(new THREE.CylinderGeometry(0.03, 0.035, length, 6), wood, length / 2 - 0.25);
    metal.push(add(new THREE.BoxGeometry(0.32, 0.36, 0.04), steel, length - 0.42, null, 0.15)); // broad blade
    metal.push(add(new THREE.BoxGeometry(0.1, 0.14, 0.05), steel, length - 0.42, null, -0.08)); // back spike
  } else if (kind === "katana") {
    add(new THREE.CylinderGeometry(0.018, 0.018, 0.26, 6), dark, 0.05); // wrapped grip
    add(new THREE.CylinderGeometry(0.06, 0.06, 0.015, 10), dark, 0.19); // tsuba
    metal.push(add(new THREE.BoxGeometry(0.055, length - 0.2, 0.018), steel, 0.2 + (length - 0.2) / 2));
  } else if (kind === "spear") {
    add(new THREE.CylinderGeometry(0.022, 0.022, length, 6), wood, length / 2 - 0.7);
    metal.push(add(new THREE.ConeGeometry(0.045, 0.3, 6), steel, length - 0.7 + 0.15));
    add(new THREE.ConeGeometry(0.05, 0.12, 5), mat(0xb23a2a), length - 0.72, [Math.PI, 0, 0]);
  }
  g.userData.metal = [...new Set(metal.map((m) => m.material))];
  // Distance from the grip to the part that hits (axe head, blade tip, spearhead).
  g.userData.tip = { axe: length - 0.42, katana: length, spear: length - 0.7 + 0.3 }[kind] ?? length;
  return g;
}

/** Simple accessories so the fighters read differently at a glance. Positions are in bone space. */
function buildAccessories(root, pivot, parts, colors) {
  const head = root.getObjectByName("Head"), chest = root.getObjectByName("spine_03"), hips = root.getObjectByName("pelvis");
  const out = [];
  const attach = (bone, mesh, pos, rot = [0, 0, 0], scale = null) => {
    if (!bone) return;
    mesh.position.set(...pos);
    mesh.rotation.set(...rot);
    if (scale) mesh.scale.set(...scale);
    mesh.castShadow = true;
    bone.add(mesh);
    out.push(mesh.material);
  };
  for (const part of parts) {
    switch (part) {
      case "horned_helm":
        attach(head, new THREE.Mesh(new THREE.SphereGeometry(0.13, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), mat(colors.accent)), [0, 0.1, 0.01]);
        for (const s of [-1, 1]) attach(head, new THREE.Mesh(new THREE.ConeGeometry(0.03, 0.2, 6), mat(0xe6dcc2)), [0.13 * s, 0.17, 0], [0, 0, -0.9 * s]);
        break;
      case "fur_mantle":
        attach(chest, new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.07, 6, 10), mat(0x5a3d26)), [0, 0.18, 0], [Math.PI / 2, 0, 0], [1.2, 1, 1]);
        break;
      case "topknot":
        attach(head, new THREE.Mesh(new THREE.SphereGeometry(0.11, 8, 6), mat(0x16171b)), [0, 0.12, -0.02], [0, 0, 0], [1, 0.9, 1.05]);
        attach(head, new THREE.Mesh(new THREE.SphereGeometry(0.05, 6, 5), mat(0x16171b)), [0, 0.24, -0.06]);
        attach(head, new THREE.Mesh(new THREE.TorusGeometry(0.105, 0.012, 4, 14), mat(0xd8d0bc)), [0, 0.1, 0], [Math.PI / 2 + 0.15, 0, 0]);
        break;
      case "sash":
        attach(hips, new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.16, 0.07, 10), mat(colors.accent)), [0, 0.06, 0]);
        break;
      case "hood":
        attach(head, new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.34, 8), mat(colors.accent)), [0, 0.15, -0.03], [-0.25, 0, 0]);
        break;
      case "cloak": { // placed in model space (-z forward), then moved onto the chest bone so it follows the body
        const cloak = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.72, 0.02), mat(colors.accent));
        attach(pivot, cloak, [0, 1.06, 0.17], [0.06, 0, 0]);
        pivot.updateMatrixWorld(true);
        chest?.attach(cloak);
        break;
      }
    }
  }
  return out;
}

// ---- per-fighter model ------------------------------------------------------------------

export class FighterModel {
  constructor(char, assets) {
    const look = char.look;
    this.assets = assets;
    this.look = look;
    this.char = char;
    this.root = SkeletonUtils.clone(assets.body.scene);
    this.holder = new THREE.Group();
    const [w, h] = look.build ?? [1, 1];
    this.holder.scale.set(w, h, w);
    this.holder.rotation.y = -Math.PI / 2; // the body faces -z; the sim's forward is local +x
    this.pivot = new THREE.Group(); // model space (-z forward): yaw (sidesteps, rolls) and tilt (airborne)
    this.pivot.add(this.root);
    this.holder.add(this.pivot);
    this.tilt = 0;

    // Recolour the mannequin: M_Main = outfit, M_Joints = trim.
    this.bodyMats = [];
    this.root.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = true;
      o.material = o.material.clone();
      o.material.color.setHex(o.material.name === "M_Joints" ? look.trim ?? 0x333333 : char.color);
      o.material.roughness = 0.8;
      o.material.metalness = 0;
      this.bodyMats.push(o.material);
    });
    this.bodyMats.push(...buildAccessories(this.root, this.pivot, look.parts ?? [], { accent: look.accent ?? 0x333333 }));

    // The weapon lives in the fighter's frame (not on the hand) so attacks can place its tip exactly;
    // outside attacks it follows the hand with a grip that suits the current clip.
    this.hand = this.root.getObjectByName("hand_r");
    this.weapon = buildWeapon(look.weapon, look.weaponLength ?? 1);
    this.weaponTip = this.weapon.userData.tip;
    this.grips = Object.fromEntries(Object.entries(GRIPS).map(([k, e]) => [k, new THREE.Quaternion().setFromEuler(new THREE.Euler(...e))]));
    this.gripQ = this.grips.rest.clone();
    this.weaponMats = this.weapon.userData.metal;
    this.holder.updateMatrixWorld(true);
    this.rig = new SwingRig(this.root);
    this.rig.gripInv = this.grips.blade.clone().invert(); // hand rotation that puts the weapon through the fist
    this.floorBones = ["Head", "pelvis", "spine_03", "hand_l", "hand_r", "foot_l", "foot_r", "ball_l", "ball_r", "lowerarm_l", "lowerarm_r", "calf_l", "calf_r"]
      .map((n) => this.root.getObjectByName(n)).filter(Boolean);
    this.toes = ["l", "r"].map((s) => [this.root.getObjectByName(`foot_${s}`), this.root.getObjectByName(`ball_${s}`)]);

    this.mixer = new THREE.AnimationMixer(this.root);
    this.actions = new Map();
    this.cur = null;
    this.prev = null;
    this.fade = 0;
    this.clock = 0;
    this.crouchWeight = 0;
    this.guardW = 0;
    if (assets.crouch) {
      this.crouchAction = this.mixer.clipAction(assets.crouch);
      this.crouchAction.blendMode = THREE.AdditiveAnimationBlendMode;
      this.crouchAction.play();
      this.crouchAction.setEffectiveWeight(0);
    }
  }

  action(name) {
    if (!this.actions.has(name)) {
      const clip = this.assets.clips.get(name);
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
  choose(f) {
    const S = STATE_CLIPS;
    const dur = (n) => this.assets.clips.get(n)?.duration ?? 1;
    const at = (name, progress) => ({ name, time: Math.min(0.999, Math.max(0, progress)) * dur(name) });
    const loop = (name, speed = 1) => {
      const d = dur(name), t = (this.clock * Math.abs(speed)) % d;
      return { name, time: speed < 0 ? d - t : t };
    };
    const p = f.duration ? f.frame / f.duration : 0;
    const bump = (x, c, wdt) => Math.max(0, 1 - Math.abs(x - c) / wdt);
    const ease01 = (t) => { const x = Math.min(1, Math.max(0, t)); return x * x * (3 - 2 * x); };
    const recoil = (t) => (t < 0.12 ? t / 0.12 : Math.max(0, 1 - (t - 0.12) / 0.7)); // fast snap, slow recovery
    const hop = (t, height) => ({ crouch: 0.55 * Math.max(bump(t, 0.08, 0.2), bump(t, 0.92, 0.2)), lift: height * Math.sin(Math.PI * t) });

    switch (f.state) {
      case "attack": {
        const m = f.move;
        if (m.parry) return loop(S.idle); // stance + the raised "high" guard (the library's block clip faces backwards)
        const swing = this.look.swings?.[m.id];
        // Procedural swings stand on the idle (or crouch) stance; the rig poses the upper body.
        if (swing) return { ...loop(S.idle), crouch: m.level === "low" ? 0.85 : 0, swing };
        const name = this.look.moves?.[m.id] ?? "Melee_Hook";
        return { name, time: this.attackTime(name, m, f.frame) };
      }
      case "idle":
        if (isCrouching(f)) return loop(S.crouch);
        if (f.walking > 0) return loop(S.walk, f.char.walkForward / 1.6);
        if (f.walking < 0) return loop(S.walk, -f.char.walkBack / 1.6); // played backwards
        return loop(S.idle);
      case "blockstun": return { ...(f.crouch ? loop(S.crouch) : loop(S.idle)), lean: 0.1 * recoil(p), crouch: f.crouch ? 0 : 0.15 * recoil(p) };
      // Hits: the clip plus a real recoil (snap back, then recover), bigger for heavy hits.
      case "hitstun": {
        const heavy = f.duration > 22;
        return { ...at(heavy ? S.hitHeavy : S.hitLight, p), lean: (heavy ? 0.38 : 0.22) * recoil(p), crouch: heavy ? 0.3 * recoil(p) : 0 };
      }
      // Juggled: tumbling backwards with knees tucked, not a rigid plank.
      // Juggled: the knockback clip's airborne frame, turned so the head trails away from the
      // opponent (knocked back, not forward), tipping further back as they fall.
      case "juggle": return { ...at(S.knockback, 0.32), yaw: Math.PI, lean: 0.2 + 0.35 * p, crouch: 0.45 };
      case "knockdown": {
        // Fall for most of it, then get up in the last stretch.
        const k = f.frame / KNOCKDOWN_FRAMES;
        // The get-up is the fall played in reverse: the library's get-up starts lying the other
        // way round (head towards the opponent), which flipped the body on the floor.
        return k < 0.5 ? at(S.fall, (k / 0.5) * 0.5) : at(S.fall, 0.5 * (1 - (k - 0.5) / 0.5));
      }
      case "ko": return at(S.fall, f.frame / 140);
      // Guard break / parried: dazed backward sway, guard dropped (the library's shield-break clip
      // lurches towards the opponent).
      case "guardbreak": case "staggered":
        return { ...at(S.hitHeavy, 0.35), lean: 0.22 + 0.07 * Math.sin(this.clock * 9), crouch: 0.2 };
      case "grabbed": return at(S.hitHeavy, 0.2 + 0.6 * f.frame / THROW_FRAMES);
      case "grabbing": return at(S.throwing, f.frame / THROW_FRAMES);
      case "techstun": return { ...loop(S.idle), ...hop(p, 0.03), lean: 0.2 * Math.sin(Math.PI * p) }; // shoved apart, stays on its feet
      case "taunt": return loop(S.taunt);
      // No dodge clips in the library: dashes are a quick hop in stance (compress, low hop, land)
      // leaning the way the sim moves the fighter.
      case "sidestep": return { ...loop(S.idle), ...hop(p, 0.04), roll: 0.22 * f.sideDir };
      case "dash": return { ...loop(S.idle), ...hop(p, 0.06), lean: -0.2 };
      case "backdash": return { ...loop(S.idle), ...hop(p, 0.08), lean: 0.18 };
      // Roll away from the opponent while facing them. The UAL1 clips are already turned to face
      // the opponent on load, so this plays as-is (turning it again made it roll *towards* them).
      case "roll": return at(S.roll, p);
      default: return loop(S.idle);
    }
  }

  /** Warp the clip so its impact lands on the first active frame, whatever the move's frame data. */
  attackTime(name, m, frame) {
    const clip = this.assets.clips.get(name);
    if (!clip) return 0;
    const T = clip.duration;
    const ti = IMPACT[name] ?? T * 0.45;
    const a0 = Math.max(0, ti - ACTIVE_SPAN / 2), a1 = Math.min(T, ti + ACTIVE_SPAN / 2);
    if (frame < m.startup) return a0 * (frame / m.startup);
    if (frame < m.startup + m.active) return a0 + (a1 - a0) * ((frame - m.startup) / m.active);
    return Math.min(T * 0.999, a1 + (T - a1) * ((frame - m.startup - m.active) / m.recovery));
  }

  update(f, dt, target = null) {
    this.clock += dt;
    const want = this.choose(f);
    if (!this.cur || want.name !== this.cur.name) {
      if (this.prev) this.action(this.prev.name)?.setEffectiveWeight(0);
      this.prev = this.cur;
      this.cur = { name: want.name };
      this.fade = this.prev ? FADE_FRAMES : 0;
    }
    const k = this.fade > 0 ? 1 - this.fade / FADE_FRAMES : 1;
    if (this.fade > 0) this.fade--;
    const cur = this.action(this.cur.name);
    if (cur) { cur.time = want.time; cur.setEffectiveWeight(k); }
    if (this.prev) {
      const p = this.action(this.prev.name);
      if (k >= 1) { p?.setEffectiveWeight(0); this.prev = null; } else p?.setEffectiveWeight(1 - k);
    }
    if (this.crouchAction) {
      this.crouchWeight += ((want.crouch ?? 0) - this.crouchWeight) * 0.5;
      this.crouchAction.setEffectiveWeight(this.crouchWeight);
    }
    // Model space faces -z: +x tilt leans back, +z roll leans to the fighter's side.
    this.pivot.rotation.set(this.tilt + (want.lean ?? 0), want.yaw ?? 0, want.roll ?? 0);
    this.holder.position.set(0, want.lift ?? 0, 0);
    this.rig.restore();
    this.mixer.update(0);
    if (GROUNDED_LOW.has(f.state)) this.keepAboveFloor();
    this.placeWeapon(f, want, target);
    if (!GROUNDED_LOW.has(f.state)) this.liftToes();
  }

  /** Bent knees (crouch layer, blends) can tip the toes into the floor: pitch the foot up instead. */
  liftToes() {
    const frame = this.holder.parent;
    if (!frame) return;
    frame.updateMatrixWorld(true);
    const up = new THREE.Vector3(0, 1, 0);
    for (const [foot, ball] of this.toes) {
      const f = frame.worldToLocal(foot.getWorldPosition(new THREE.Vector3()));
      const b = frame.worldToLocal(ball.getWorldPosition(new THREE.Vector3()));
      const floorY = -frame.position.y; // the fighter frame may be lifted (juggles)
      if (b.y >= floorY + 0.01) continue;
      const d = b.clone().sub(f);
      const angle = Math.asin(Math.min(1, (floorY + 0.01 - b.y) / d.length()));
      const axisLocal = d.clone().cross(up).normalize();
      const axisWorld = frame.localToWorld(axisLocal.clone()).sub(frame.localToWorld(new THREE.Vector3())).normalize();
      if (!this.rig.saved.has(foot)) this.rig.saved.set(foot, foot.quaternion.clone()); // restored before the next mixer update
      const wq = foot.getWorldQuaternion(new THREE.Quaternion()).premultiply(new THREE.Quaternion().setFromAxisAngle(axisWorld, angle));
      foot.quaternion.copy(foot.parent.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(wq));
      foot.updateMatrixWorld(true);
    }
  }

  /** Lying, rolling and airborne clips can dip below the floor: lift the body so nothing does. */
  keepAboveFloor() {
    const frame = this.holder.parent;
    if (!frame) return;
    frame.updateMatrixWorld(true);
    let lowest = Infinity;
    for (const b of this.floorBones) lowest = Math.min(lowest, frame.worldToLocal(b.getWorldPosition(new THREE.Vector3())).y);
    if (lowest < 0.03) { this.holder.position.y += 0.03 - lowest; this.holder.updateMatrixWorld(true); }
  }

  tuning(m, spec) {
    this.tuned ??= new Map();
    if (!this.tuned.has(m.id)) this.tuned.set(m.id, tuneSwing(spec, m));
    return this.tuned.get(m.id);
  }

  /** Swing pose (attacks) blended with the hand-held rest pose. Needs the group's transform up to date. */
  /** Which guard the upper body holds in this state (null: let the clip move the arms). */
  guardFor(f) {
    switch (f.state) {
      case "idle": case "techstun": case "dash": case "backdash": case "sidestep": return "stand";
      case "blockstun": return f.crouch ? "low" : "high";
      case "attack": return f.move.parry ? "high" : this.look.swings?.[f.move.id] ? "stand" : null;
      default: return null;
    }
  }

  placeWeapon(f, want, target) {
    const frame = this.holder.parent;
    if (!frame || !this.hand) return;
    if (this.weapon.parent !== frame) frame.add(this.weapon);
    frame.updateMatrixWorld(true);
    this.rig.calibrate(frame); // first call: the pure clip pose, before any IK
    const twoHanded = this.look.twoHanded ?? true;

    // 1. Clip: the weapon follows the hand with the grip that suits the current clip.
    const clip = this.assets.clips.get(this.cur.name);
    if (clip) this.gripQ.slerp(this.grips[gripFor(clip)], 0.35);
    const frameQ = frame.getWorldQuaternion(new THREE.Quaternion()).invert();
    const pos = frame.worldToLocal(this.rig.body.gripFrame(this.rig.body.arms.r).center); // in the fist
    const quat = frameQ.multiply(this.hand.getWorldQuaternion(new THREE.Quaternion())).multiply(this.gripQ);

    // 2. Guard: weapon held towards the opponent, eased in and out, poses blended smoothly.
    const guards = GUARDS[this.look.weapon] ?? GUARDS.katana;
    const g = this.guardFor(f);
    this.guardW += ((g ? 1 : 0) - this.guardW) * 0.3;
    if (g) {
      const to = guards[g];
      this.guardPose ??= { hand: [...to.hand], dir: [...to.dir] };
      for (const key of ["hand", "dir"]) this.guardPose[key] = this.guardPose[key].map((x, i) => x + (to[key][i] - x) * 0.35);
    }
    if (this.guardW > 0.01 && this.guardPose) {
      const breathe = Math.sin(this.clock * 2.2) * 0.012; // a little life in the stance
      const pose = { hand: [this.guardPose.hand[0], this.guardPose.hand[1] + breathe, this.guardPose.hand[2]], dir: this.guardPose.dir };
      const gd = this.rig.guard({ frame, root: this.root, pose, w: this.guardW, twoHanded, offHand: guards.offHand ?? 0.3 });
      pos.copy(gd.position); // the fist as it really is (the guard already blended the arms)
      quat.slerp(gd.quaternion, this.guardW);
    }

    // 3. Attack: the swing takes over from the guard.
    if (want.swing && f.state === "attack") {
      const tune = this.tuning(f.move, want.swing);
      const swing = this.rig.apply({
        frame, holder: this.holder, root: this.root, tune, m: f.move, target,
        weaponTip: this.weaponTip, twoHanded, phase: swingPhase(f.move, f.frame, tune), offHand: guards.offHand,
      });
      pos.copy(swing.position); // in the fist as posed
      quat.slerp(swing.quaternion, swing.blend);
      this.lastTip = swing.tip;
    }
    // Blends between poses can still dip the tip into the floor: tilt it up to rest on it.
    if (!GROUNDED_LOW.has(f.state)) {
      const dir = new THREE.Vector3(0, 1, 0).applyQuaternion(quat);
      const tipY = pos.y + dir.y * this.weaponTip + frame.position.y;
      if (tipY < 0.06) {
        const want = dir.clone().setY(dir.y + (0.06 - tipY) / this.weaponTip).normalize();
        quat.premultiply(new THREE.Quaternion().setFromUnitVectors(dir, want));
      }
    }
    this.weapon.position.copy(pos);
    this.weapon.quaternion.copy(quat);
    // Off hand last, onto the weapon as it finally is this frame: always on the shaft.
    const holdW = Math.max(this.guardW, want.swing && f.state === "attack" ? swingPhase(f.move, f.frame, this.tuning(f.move, want.swing)).w : 0);
    if (twoHanded) this.rig.attachOffHand(frame, pos, quat, guards.offHand ?? 0.3, holdW);
  }
}
