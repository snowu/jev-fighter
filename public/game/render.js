// 3D renderer: rigged models (or capsule fallbacks), readable states, hit sparks, hitbox
// overlay, PS1-style presentation. It only reads the sim, so visuals never change combat or AI.
import * as THREE from "three";
import { FighterModel } from "./models.js";
import { PS1Pass } from "./ps1.js";
import { ARENA_RADIUS, BODY_RADIUS, JUGGLE_FRAMES, TIPPER } from "../engine/sim/constants.js";
import { attackPhase, isCrouching, isGuarding, enraged } from "../engine/sim/world.js";

const LEVEL_ANGLE = { high: 0.4, mid: 0, low: -0.5, throw: -0.1 };
const PIVOT_X = 0.08; // hand position in front of the body's centre at rest
const MAX_ARM = 0.45; // how far the arm can push the weapon forward; any reach beyond that is a lean/step
const LEVEL_HEIGHT = { high: 1.5, mid: 1.1, low: 0.35, throw: 1.1 };
const C = {
  weapon: 0xc8ced9, startup: 0xf2c14e, active: 0xff4545, recovery: 0x5d6575, throw: 0xc07bff,
  block: 0x2a5db8, hit: 0x9a1f1f, grab: 0x6b2fa8,
  parry: 0x7ae8ff, armor: 0xb85a00, rage: 0x5a0d08,
};

export class Renderer {
  constructor(canvas) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.ps1 = new PS1Pass(this.renderer);
    try { this.ps1.enabled = localStorage.getItem("jevfighter.ps1") !== "off"; } catch {}
    this.models = null; // name -> gltf, set once loaded; until then fighters are capsules
    this.lastUpdate = performance.now();
    this.renderer.shadowMap.enabled = true;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0e1014);
    this.scene.fog = new THREE.Fog(0x0e1014, 14, 30);
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
    this.camPos = new THREE.Vector3(0, 2.4, 8);
    this.camLook = new THREE.Vector3(0, 1, 0);
    this.shake = 0;
    this.showHitboxes = true;
    this.fighters = [];
    this.sparks = [];

    this.scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x1a1410, 0.9));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(4, 10, 6);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    Object.assign(sun.shadow.camera, { left: -8, right: 8, top: 8, bottom: -8 });
    this.scene.add(sun);

    const floor = new THREE.Mesh(new THREE.CircleGeometry(ARENA_RADIUS, 72), new THREE.MeshStandardMaterial({ color: 0x252a35, roughness: 0.95 }));
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.scene.add(floor);
    const grid = new THREE.PolarGridHelper(ARENA_RADIUS, 12, 6, 72, 0x343b4a, 0x2d3340);
    grid.position.y = 0.002;
    this.scene.add(grid);
    const edge = new THREE.Mesh(new THREE.RingGeometry(ARENA_RADIUS, ARENA_RADIUS + 0.1, 96), new THREE.MeshBasicMaterial({ color: 0xf2c14e, side: THREE.DoubleSide }));
    edge.rotation.x = -Math.PI / 2;
    edge.position.y = 0.004;
    this.scene.add(edge);

    this.resize = () => {
      this.renderer.setSize(window.innerWidth, window.innerHeight);
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.ps1.setSize(window.innerWidth, window.innerHeight);
      this.camera.updateProjectionMatrix();
    };
    window.addEventListener("resize", this.resize);
    this.resize();
  }

  setup(world) {
    for (const f of this.fighters) { this.scene.remove(f.group); this.scene.remove(f.hitbox); f.model?.mixer.stopAllAction(); }
    const mirror = world.fighters[0].char.id === world.fighters[1].char.id;
    this.fighters = world.fighters.map((f, i) => {
      if (this.models && f.char.look?.weapon) {
        try { return this.buildModelFighter(f.char, mirror && i === 1); } catch (err) { console.warn("model failed, using capsule", err); }
      }
      return this.buildFighter(f.char);
    });
    this.ps1.wobbleAll(this.scene);
  }

  togglePS1() {
    this.ps1.enabled = !this.ps1.enabled;
    try { localStorage.setItem("jevfighter.ps1", this.ps1.enabled ? "on" : "off"); } catch {}
    return this.ps1.enabled;
  }

  buildModelFighter(char, alt) {
    const model = new FighterModel(char, this.models);
    if (alt) for (const m of model.bodyMats) m.color.multiply(new THREE.Color(0x8fa0ff)); // tell mirror-match fighters apart
    const group = new THREE.Group();
    group.add(model.holder);
    this.scene.add(group);
    return { model, group, ...this.buildHitbox() };
  }

  buildHitbox() {
    const hitbox = new THREE.Group();
    const hbMat = new THREE.MeshBasicMaterial({ color: C.active, transparent: true, opacity: 0.3, depthWrite: false });
    const hbPlane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), hbMat);
    hbPlane.rotation.x = -Math.PI / 2;
    const tipMat = new THREE.MeshBasicMaterial({ color: 0x59c98b, transparent: true, opacity: 0.35, depthWrite: false });
    const tipPlane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), tipMat);
    tipPlane.rotation.x = -Math.PI / 2;
    tipPlane.position.y = 0.002;
    hitbox.add(hbPlane, tipPlane);
    hitbox.visible = false;
    this.scene.add(hitbox);
    return { hitbox, hbPlane, hbMat, tipPlane, tipMat };
  }

  // Placeholder bodies: one capsule + head, scaled to a build, with a few accessory shapes and
  // a weapon shaped after the character's weapon. Local axes: +x forward, +y up, z sideways.
  buildFighter(char) {
    const look = char.look ?? {};
    const [w, h] = look.build ?? [1, 1];
    const color = char.color;
    const group = new THREE.Group();
    const pose = new THREE.Group();
    pose.scale.set(w, h, w);
    group.add(pose);
    const bodyMat = new THREE.MeshStandardMaterial({ color, roughness: 0.6 });
    const accentMat = new THREE.MeshStandardMaterial({ color: look.accent ?? 0x333333, roughness: 0.8 });
    const darkMat = new THREE.MeshStandardMaterial({ color: 0x15171c, roughness: 0.7 });
    const mesh = (geo, mat, x, y, z) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.castShadow = true;
      pose.add(m);
      return m;
    };
    const body = mesh(new THREE.CapsuleGeometry(BODY_RADIUS * 0.95, 0.85, 4, 14), bodyMat, 0, 0.72, 0);
    mesh(new THREE.SphereGeometry(0.19, 16, 12), bodyMat, 0, 1.43, 0);
    mesh(new THREE.BoxGeometry(0.08, 0.06, 0.24), new THREE.MeshBasicMaterial({ color: 0xffffff }), 0.17, 1.46, 0);

    for (const part of look.parts ?? []) {
      switch (part) {
        case "pauldrons":
          for (const z of [-0.3, 0.3]) mesh(new THREE.SphereGeometry(0.17, 12, 10), accentMat, 0, 1.2, z).scale.set(1, 0.75, 1);
          break;
        case "horns":
          for (const z of [-1, 1]) {
            const horn = mesh(new THREE.ConeGeometry(0.05, 0.28, 8), new THREE.MeshStandardMaterial({ color: 0xe8dcc0, roughness: 0.5 }), 0, 1.6, 0.14 * z);
            horn.rotation.x = 0.55 * z;
          }
          break;
        case "belt":
          mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.1, 18), accentMat, 0, 0.62, 0);
          break;
        case "topknot":
          mesh(new THREE.SphereGeometry(0.085, 10, 8), darkMat, -0.12, 1.6, 0);
          break;
        case "sash": {
          mesh(new THREE.CylinderGeometry(0.29, 0.29, 0.09, 18), accentMat, 0, 0.74, 0);
          const tail = mesh(new THREE.BoxGeometry(0.04, 0.32, 0.09), accentMat, -0.27, 0.6, 0.12);
          tail.rotation.x = 0.2;
          break;
        }
        case "scabbard": {
          const sc = mesh(new THREE.BoxGeometry(0.8, 0.05, 0.05), darkMat, -0.05, 0.68, -0.31);
          sc.rotation.z = -0.45;
          break;
        }
        case "hood":
          mesh(new THREE.ConeGeometry(0.235, 0.38, 14), accentMat, -0.02, 1.58, 0);
          break;
        case "cloak": {
          const cloak = mesh(new THREE.BoxGeometry(0.05, 1.05, 0.52), accentMat, -0.3, 0.82, 0);
          cloak.rotation.z = -0.1;
          break;
        }
      }
    }

    // Weapon: the main piece is scaled along x to the move's reach each frame; end pieces
    // (axe head, spear tip) are repositioned to the end so they don't stretch.
    const pivot = new THREE.Group();
    pivot.position.set(PIVOT_X / w, 1.12, 0);
    pivot.scale.set(1 / w, 1 / h, 1 / w); // reach is in world metres regardless of build
    pose.add(pivot);
    const weaponMat = new THREE.MeshStandardMaterial({ color: C.weapon, roughness: 0.45, metalness: 0.1, emissive: 0x000000 });
    const kind = look.weapon ?? "blade";
    const length = look.weaponLength ?? 1.1; // fixed, real size: reach comes from arm and lean, not stretching
    const armGeo = new THREE.BoxGeometry(1, 0.075, 0.075);
    armGeo.translate(0.5, 0, 0);
    const arm = new THREE.Mesh(armGeo, bodyMat);
    arm.position.set(0, 1.12, 0);
    pose.add(arm);
    const [thick, depth] = { axe: [0.08, 0.08], katana: [0.045, 0.025], spear: [0.045, 0.045] }[kind] ?? [0.07, 0.07];
    const blade = new THREE.BoxGeometry(1, thick, depth);
    blade.translate(0.5, 0, 0);
    const weapon = new THREE.Mesh(blade, weaponMat);
    weapon.castShadow = true;
    pivot.add(weapon);
    const ends = [];
    const addEnd = (geo, mat, back, y = 0, rot = null) => {
      const m = new THREE.Mesh(geo, mat);
      m.castShadow = true;
      if (rot) m.rotation.set(...rot);
      m.position.y = y;
      pivot.add(m);
      ends.push({ m, back });
    };
    const addFixed = (geo, mat, x, rot = null) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.x = x;
      if (rot) m.rotation.set(...rot);
      pivot.add(m);
    };
    if (kind === "axe") {
      addEnd(new THREE.BoxGeometry(0.22, 0.44, 0.05), weaponMat, 0.13, 0.1); // broad head
      addEnd(new THREE.BoxGeometry(0.1, 0.16, 0.06), weaponMat, 0.13, -0.18); // back spike
    } else if (kind === "katana") {
      addFixed(new THREE.CylinderGeometry(0.075, 0.075, 0.02, 16), darkMat, 0.2, [0, 0, Math.PI / 2]); // tsuba
      addFixed(new THREE.BoxGeometry(0.2, 0.055, 0.045), darkMat, 0.09); // wrapped handle
    } else if (kind === "spear") {
      addEnd(new THREE.ConeGeometry(0.065, 0.34, 8), weaponMat, 0.17, 0, [0, 0, -Math.PI / 2]); // blade tip
      addEnd(new THREE.SphereGeometry(0.05, 8, 6), new THREE.MeshStandardMaterial({ color: 0xc23b2b }), 0.4, -0.05); // tassel
    }

    this.scene.add(group);
    return { group, pose, body, bodyMat, pivot, weapon, weaponMat, ends, arm, length, w, ...this.buildHitbox(), baseColor: new THREE.Color(color) };
  }

  /** Converts "into the screen" (+1) / "toward the camera" (-1) into a fighter-relative sidestep direction. */
  sidestepDir(screen, fighter) {
    const fwd = new THREE.Vector3().subVectors(this.camLook, this.camPos);
    const perpX = -Math.sin(fighter.facing), perpZ = Math.cos(fighter.facing);
    return screen * (perpX * fwd.x + perpZ * fwd.z >= 0 ? 1 : -1);
  }

  onEvents(world, events) {
    for (const e of events) {
      if (e.type === "hit" || e.type === "block") {
        const a = world.fighters[e.who], d = world.fighters[e.target];
        const t = 0.3;
        const pos = new THREE.Vector3(d.x + (a.x - d.x) * t, LEVEL_HEIGHT[e.level] ?? 1, d.z + (a.z - d.z) * t);
        if (e.type === "block") this.spark(pos, 0x7ab8ff, 0.14);
        else this.spark(pos, e.counter ? 0xff3b3b : e.tip === "tip" ? 0x59c98b : e.punish ? 0xf2c14e : 0xffa64d, e.counter || e.result === "launch" || e.tip === "tip" ? 0.3 : 0.2);
        if (e.type === "hit") this.shake = Math.max(this.shake, e.counter || e.result !== "hitstun" ? 0.12 : 0.05);
      }
      if (e.type === "throw") this.shake = 0.1;
      if (e.type === "parry" || e.type === "armor") {
        const d = world.fighters[e.who];
        this.spark(new THREE.Vector3(d.x, 1.2, d.z), e.type === "parry" ? C.parry : 0xffb347, 0.32);
        this.shake = Math.max(this.shake, e.type === "parry" ? 0.1 : 0.06);
      }
      if (e.type === "tech") {
        const [a, b] = world.fighters;
        this.spark(new THREE.Vector3((a.x + b.x) / 2, 1.2, (a.z + b.z) / 2), 0xffffff, 0.25);
      }
    }
  }

  spark(pos, color, size) {
    const mesh = new THREE.Mesh(new THREE.IcosahedronGeometry(size * 0.6, 0), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95 }));
    mesh.position.copy(pos);
    this.scene.add(mesh);
    this.sparks.push({ mesh, life: 0 });
  }

  update(world) {
    const now = performance.now();
    this.dt = Math.min(0.1, (now - this.lastUpdate) / 1000);
    this.lastUpdate = now;
    world.fighters.forEach((f, i) => this.pose(f, this.fighters[i], world.fighters[1 - i]));
    this.updateCamera(world);
    for (const s of this.sparks) {
      s.life++;
      s.mesh.scale.setScalar(1 + s.life * 0.12);
      s.mesh.rotation.x += 0.3;
      s.mesh.material.opacity = Math.max(0, 0.95 - s.life / 10);
    }
    for (const s of this.sparks.filter((s) => s.life > 10)) { this.scene.remove(s.mesh); s.mesh.geometry.dispose(); s.mesh.material.dispose(); }
    this.sparks = this.sparks.filter((s) => s.life <= 10);
    this.ps1.render(this.scene, this.camera);
  }

  /** Rigged model: the clip/time comes from the sim state; flashes and glows go on the materials. */
  poseModel(f, v, opp) {
    let y = 0;
    let body = enraged(f) ? (Math.floor(f.frame / 12) % 2 ? 0x3a0604 : 0x1c0302) : 0x000000;
    let weapon = 0x000000;
    const phase = attackPhase(f);
    switch (f.state) {
      case "attack":
        if (f.move.parry) weapon = phase === "active" ? 0x1f7a8a : 0x000000;
        else if (phase === "startup") weapon = 0x4a3600;
        else if (phase === "active") weapon = 0x8a1010;
        // Textured models take emissive at full strength, so keep these glows dim.
        if (f.move.armor && !f.armorUsed && phase !== "recovery") body = f.frame % 6 < 3 ? 0x4a2400 : 0x2a1400;
        break;
      case "hitstun": body = f.frame < 5 ? 0x606060 : 0x000000; break;
      case "blockstun": body = f.frame < 4 ? 0x18306a : 0x000000; break;
      case "juggle": {
        const t = Math.min(1, f.frame / f.duration);
        y = 4 * 1.35 * (f.duration / JUGGLE_FRAMES) * t * (1 - t) + 0.05;
        break;
      }
      case "guardbreak": body = f.frame % 10 < 5 ? 0x5a2ccc : 0x1a0848; break;
      case "staggered": body = f.frame % 8 < 4 ? 0x1f6a7a : 0x0a2a33; break;
      case "grabbed": body = 0x3a1460; break;
    }
    v.model.setEmissive(body, weapon);
    v.model.tilt = f.state === "juggle" ? 0.6 : 0; // tipped back while airborne (model faces -z)
    v.group.position.set(f.x, y, f.z); // before the model update: attack poses are solved in this frame
    v.group.rotation.y = -f.facing;
    // Aim swings at the opponent as they actually are: how far away, and whether they're ducking.
    const target = opp && { dist: Math.hypot(opp.x - f.x, opp.z - f.z) - BODY_RADIUS, crouching: isCrouching(opp) };
    v.model.update(f, this.dt ?? 1 / 60, target);
    v.hitbox.visible = false;
    if (f.state === "attack" && f.move.level !== "throw") this.poseHitbox(f, v, phase);
  }

  pose(f, v, opp) {
    if (v.model) return this.poseModel(f, v, opp);
    let y = 0;
    v.pose.rotation.set(0, 0, 0);
    v.pose.position.set(0, 0, 0);
    v.group.scale.set(1, isCrouching(f) ? 0.62 : 1, 1);
    v.pivot.rotation.set(0, 0, 0);
    v.pivot.position.x = PIVOT_X / v.w;
    v.weapon.scale.x = v.length;
    v.weaponMat.color.setHex(C.weapon);
    v.weaponMat.emissive.setHex(0x000000);
    // Rage: a dull red glow under every state that doesn't set its own.
    v.bodyMat.emissive.setHex(enraged(f) ? (Math.floor(f.frame / 12) % 2 ? C.rage : 0x3a0806) : 0x000000);
    v.hitbox.visible = false;

    switch (f.state) {
      case "attack": {
        const m = f.move, phase = attackPhase(f);
        v.pivot.rotation.z = LEVEL_ANGLE[m.level] ?? 0;
        if (m.parry) {
          // Stance: weapon held upright across the body, glowing while it can deflect.
          v.pivot.rotation.set(0, 1.45, 1.25);
          v.weaponMat.color.setHex(phase === "active" ? C.parry : phase === "startup" ? C.startup : C.recovery);
          v.weaponMat.emissive.setHex(phase === "active" ? 0x1f7a8a : 0x000000);
          v.pose.rotation.z = phase === "recovery" ? 0.15 : -0.05;
          break;
        }
        if (m.armor && !f.armorUsed && phase !== "recovery") v.bodyMat.emissive.setHex(C.armor);
        if (m.level === "throw") {
          v.weapon.scale.x = v.length * (phase === "active" ? 0.6 : 0.4);
          v.weaponMat.color.setHex(C.throw);
          v.weaponMat.emissive.setHex(phase === "active" ? 0x5a1f8a : 0x000000);
        } else if (phase === "startup") {
          const t = f.frame / m.startup;
          v.pivot.rotation.y = (m.tracking ? 2.4 : 1.4) * (1 - t * 0.35);
          v.weaponMat.color.setHex(C.startup);
          v.weaponMat.emissive.setHex(0x7a5a00);
        } else if (phase === "active") {
          const t = (f.frame - m.startup) / m.active;
          v.pivot.rotation.y = m.tracking ? 1.2 - t * 2.4 : 0.15 - t * 0.3;
          v.weaponMat.color.setHex(C.active);
          v.weaponMat.emissive.setHex(0xaa1a1a);
        } else {
          const t = (f.frame - m.startup - m.active) / m.recovery;
          v.pivot.rotation.y = -0.7 * (1 - t);
          v.pivot.rotation.z -= 0.4;
          v.weaponMat.color.setHex(C.recovery);
        }
        if (m.level === "low") v.pose.rotation.z = -0.15;
        if (m.level !== "throw") this.extend(f, v, phase);
        this.poseHitbox(f, v, phase);
        break;
      }
      case "blockstun":
        v.bodyMat.emissive.setHex(C.block);
        v.pivot.rotation.set(0, 1.35, f.crouch ? -0.3 : 0.35);
        v.pose.rotation.z = 0.08;
        break;
      case "hitstun":
        v.bodyMat.emissive.setHex(f.frame < 6 ? 0xffffff : C.hit);
        v.pose.rotation.z = 0.28;
        v.pivot.rotation.z = -0.9;
        break;
      case "juggle": {
        const t = Math.min(1, f.frame / f.duration);
        const h = 1.35 * (f.duration / JUGGLE_FRAMES);
        y = 4 * h * t * (1 - t) + 0.15;
        v.pose.rotation.z = 0.9 + t * 0.6;
        v.bodyMat.emissive.setHex(C.hit);
        break;
      }
      case "knockdown":
      case "ko":
        v.pose.rotation.z = 1.5;
        v.pose.position.y = 0.05;
        v.pivot.rotation.z = -0.8;
        break;
      case "guardbreak":
        v.bodyMat.emissive.setHex(f.frame % 10 < 5 ? 0x7a3cff : 0x2a1060);
        v.pose.rotation.z = Math.sin(f.frame * 0.4) * 0.18;
        v.pivot.rotation.z = -1.1;
        break;
      case "grabbed":
        v.bodyMat.emissive.setHex(C.grab);
        v.pose.rotation.z = Math.min(1.2, f.frame * 0.05);
        break;
      case "grabbing":
        v.weapon.scale.x = v.length * 0.45;
        v.weaponMat.color.setHex(C.throw);
        v.pivot.rotation.z = 0.3 + Math.sin(f.frame * 0.3) * 0.4;
        break;
      case "techstun":
        v.pose.rotation.z = 0.18;
        break;
      case "staggered":
        v.bodyMat.emissive.setHex(f.frame % 8 < 4 ? 0x1f6a7a : 0x0a2a33);
        v.pose.rotation.z = 0.35 + Math.sin(f.frame * 0.5) * 0.12;
        v.pivot.rotation.z = -1.2;
        break;
      case "taunt":
        v.pivot.rotation.set(f.frame * 0.35, 0, 1.2);
        v.pose.rotation.z = -0.05;
        break;
      case "sidestep":
      case "dash":
      case "roll":
      case "backdash":
        v.pose.rotation.z = f.state === "dash" ? -0.3 : f.state === "backdash" ? 0.25 : 0;
        v.pose.rotation.x = f.state === "sidestep" ? -0.25 * f.sideDir : 0;
        if (f.state === "roll") { v.pose.rotation.z = 1.4; v.pose.position.y = 0.2; }
        v.pivot.rotation.z = -0.6;
        break;
      default:
        if (isGuarding(f)) v.pivot.rotation.set(0, 1.3, isCrouching(f) ? -0.25 : 0.4);
        else v.pivot.rotation.set(0, 0.3, -0.7); // walking forward: weapon down, not guarding
    }
    v.arm.scale.x = v.pivot.position.x;
    for (const { m, back } of v.ends) m.position.x = Math.max(0.15, v.weapon.scale.x - back);
    v.group.position.set(f.x, y, f.z);
    v.group.rotation.y = -f.facing;
  }

  /**
   * The weapon keeps its real length, so a move whose range is longer than the weapon shows
   * where the extra reach comes from: the arm pushes forward, then the whole body leans/steps in.
   * At full extension the weapon tip sits exactly on the hitbox edge (where it touches the opponent's body).
   */
  extend(f, v, phase) {
    const m = f.move;
    const flat = v.length * Math.cos(v.pivot.rotation.z); // horizontal reach of the weapon at this angle
    // Negative = the weapon is longer than the move's reach: choke up on the grip so the tip still marks the reach.
    const need = m.range - PIVOT_X - flat;
    const arm = Math.min(need, MAX_ARM), lean = Math.max(0, need - arm);
    let k;
    if (phase === "startup") k = 0.1 * f.frame / m.startup;
    else if (phase === "active") k = 1;
    else k = Math.max(0, 1 - 2.5 * (f.frame - m.startup - m.active) / m.recovery);
    v.pivot.position.x = (PIVOT_X + arm * k) / v.w;
    v.pose.position.x = lean * k;
    if (lean > 0.05) v.pose.rotation.z -= 0.12 * k * Math.min(1, lean / 0.4); // tip the torso into a lunge
  }

  /**
   * Ground overlay of where the move connects: the sim hits when the opponent's centre is within
   * range + BODY_RADIUS, i.e. when their body surface is within `range`. The overlay draws that
   * surface line, so it ends exactly at the weapon tip.
   */
  poseHitbox(f, v, phase) {
    const m = f.move;
    if (!this.showHitboxes || m.level === "throw" || m.parry || phase === "recovery") return;
    const len = m.range;
    v.hitbox.visible = true;
    v.hitbox.position.set(f.x, 0.01, f.z);
    v.hitbox.rotation.y = -f.attackDir;
    v.hbPlane.position.x = len / 2;
    v.hbPlane.scale.set(len, m.width, 1);
    v.hbMat.color.setHex(phase === "active" ? C.active : C.startup);
    v.hbMat.opacity = phase === "active" ? 0.35 : 0.1;
    // Tipper moves: show the sweet spot at the end of the reach.
    v.tipPlane.visible = !!m.tipper;
    if (m.tipper) {
      const from = (m.range + BODY_RADIUS) * TIPPER.from - BODY_RADIUS;
      v.tipPlane.position.x = (from + len) / 2;
      v.tipPlane.scale.set(len - from, m.width + 0.02, 1);
      v.tipMat.opacity = phase === "active" ? 0.5 : 0.15;
    }
  }

  updateCamera(world) {
    const [a, b] = world.fighters;
    const mid = new THREE.Vector3((a.x + b.x) / 2, 0, (a.z + b.z) / 2);
    let ax = b.x - a.x, az = b.z - a.z;
    const sep = Math.hypot(ax, az) || 1;
    ax /= sep; az /= sep;
    // Camera on the side of the fighters' line that keeps player 1 on the left of the screen.
    const px = -az, pz = ax;
    const dist = Math.max(5.4, sep * 1.2 + 3.3);
    const target = new THREE.Vector3(mid.x + px * dist, 2.3 + sep * 0.08, mid.z + pz * dist);
    this.camPos.lerp(target, 0.1);
    this.camLook.lerp(new THREE.Vector3(mid.x, 1.0, mid.z), 0.15);
    this.camera.position.copy(this.camPos);
    if (this.shake > 0.002) {
      this.camera.position.x += (Math.random() - 0.5) * this.shake;
      this.camera.position.y += (Math.random() - 0.5) * this.shake;
      this.shake *= 0.85;
    }
    this.camera.lookAt(this.camLook);
  }

  /** Pixel position above a fighter (for floating text). */
  screenPos(f, height = 2.1) {
    const p = new THREE.Vector3(f.x, height, f.z).project(this.camera);
    return { x: (p.x + 1) / 2 * window.innerWidth, y: (1 - p.y) / 2 * window.innerHeight };
  }
}
