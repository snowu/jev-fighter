// Placeholder 3D renderer: capsules + weapons, readable states, hit sparks, hitbox overlay.
// It only reads the sim; swapping in rigged models later doesn't touch combat or AI.
import * as THREE from "three";
import { ARENA_RADIUS, BODY_RADIUS, JUGGLE_FRAMES } from "../engine/sim/constants.js";
import { attackPhase, isCrouching, isGuarding } from "../engine/sim/world.js";

const LEVEL_ANGLE = { high: 0.4, mid: 0, low: -0.75, throw: -0.1 };
const LEVEL_HEIGHT = { high: 1.5, mid: 1.1, low: 0.35, throw: 1.1 };
const C = {
  weapon: 0xc8ced9, startup: 0xf2c14e, active: 0xff4545, recovery: 0x5d6575, throw: 0xc07bff,
  block: 0x2a5db8, hit: 0x9a1f1f, grab: 0x6b2fa8,
};

export class Renderer {
  constructor(canvas) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
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
      this.camera.updateProjectionMatrix();
    };
    window.addEventListener("resize", this.resize);
    this.resize();
  }

  setup(world) {
    for (const f of this.fighters) { this.scene.remove(f.group); this.scene.remove(f.hitbox); }
    this.fighters = world.fighters.map((f) => this.buildFighter(f.char.color));
  }

  buildFighter(color) {
    const group = new THREE.Group();
    const pose = new THREE.Group();
    group.add(pose);
    const bodyMat = new THREE.MeshStandardMaterial({ color, roughness: 0.6 });
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(BODY_RADIUS * 0.95, 0.85, 4, 14), bodyMat);
    body.position.y = 0.72;
    body.castShadow = true;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.19, 16, 12), bodyMat);
    head.position.y = 1.43;
    head.castShadow = true;
    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.06, 0.24), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    visor.position.set(0.17, 1.46, 0);
    const pivot = new THREE.Group();
    pivot.position.set(0.08, 1.12, 0);
    const weaponMat = new THREE.MeshStandardMaterial({ color: C.weapon, roughness: 0.45, metalness: 0.1, emissive: 0x000000 });
    const blade = new THREE.BoxGeometry(1, 0.07, 0.07);
    blade.translate(0.5, 0, 0);
    const weapon = new THREE.Mesh(blade, weaponMat);
    weapon.castShadow = true;
    pivot.add(weapon);
    pose.add(body, head, visor, pivot);

    const hitbox = new THREE.Group();
    const hbMat = new THREE.MeshBasicMaterial({ color: C.active, transparent: true, opacity: 0.3, depthWrite: false });
    const hbPlane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), hbMat);
    hbPlane.rotation.x = -Math.PI / 2;
    hitbox.add(hbPlane);
    hitbox.visible = false;
    this.scene.add(group, hitbox);
    return { group, pose, body, bodyMat, pivot, weapon, weaponMat, hitbox, hbPlane, hbMat, baseColor: new THREE.Color(color) };
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
        else this.spark(pos, e.counter ? 0xff3b3b : e.punish ? 0xf2c14e : 0xffa64d, e.counter || e.result === "launch" ? 0.3 : 0.2);
        if (e.type === "hit") this.shake = Math.max(this.shake, e.counter || e.result !== "hitstun" ? 0.12 : 0.05);
      }
      if (e.type === "throw") this.shake = 0.1;
      if (e.type === "tech") {
        const [a, b] = world.fighters;
        this.spark(new THREE.Vector3((a.x + b.x) / 2, 1.2, (a.z + b.z) / 2), 0xffffff, 0.25);
      }
    }
  }

  spark(pos, color, size) {
    const mesh = new THREE.Mesh(new THREE.IcosahedronGeometry(size, 0), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95 }));
    mesh.position.copy(pos);
    this.scene.add(mesh);
    this.sparks.push({ mesh, life: 0 });
  }

  update(world) {
    world.fighters.forEach((f, i) => this.pose(f, this.fighters[i]));
    this.updateCamera(world);
    for (const s of this.sparks) {
      s.life++;
      s.mesh.scale.setScalar(1 + s.life * 0.25);
      s.mesh.rotation.x += 0.3;
      s.mesh.material.opacity = Math.max(0, 0.95 - s.life / 10);
    }
    for (const s of this.sparks.filter((s) => s.life > 10)) { this.scene.remove(s.mesh); s.mesh.geometry.dispose(); s.mesh.material.dispose(); }
    this.sparks = this.sparks.filter((s) => s.life <= 10);
    this.renderer.render(this.scene, this.camera);
  }

  pose(f, v) {
    let y = 0;
    v.pose.rotation.set(0, 0, 0);
    v.pose.position.set(0, 0, 0);
    v.group.scale.set(1, isCrouching(f) ? 0.62 : 1, 1);
    v.pivot.rotation.set(0, 0, 0);
    v.weapon.scale.x = 0.9;
    v.weaponMat.color.setHex(C.weapon);
    v.weaponMat.emissive.setHex(0x000000);
    v.bodyMat.emissive.setHex(0x000000);
    v.hitbox.visible = false;

    switch (f.state) {
      case "attack": {
        const m = f.move, phase = attackPhase(f);
        const reach = m.range;
        v.pivot.rotation.z = LEVEL_ANGLE[m.level] ?? 0;
        if (m.level === "throw") {
          v.weapon.scale.x = phase === "active" ? 0.75 : 0.45;
          v.weaponMat.color.setHex(C.throw);
          v.weaponMat.emissive.setHex(phase === "active" ? 0x5a1f8a : 0x000000);
        } else if (phase === "startup") {
          const t = f.frame / m.startup;
          v.pivot.rotation.y = (m.tracking ? 2.4 : 1.4) * (1 - t * 0.35);
          v.weapon.scale.x = reach * 0.85;
          v.weaponMat.color.setHex(C.startup);
          v.weaponMat.emissive.setHex(0x7a5a00);
        } else if (phase === "active") {
          const t = (f.frame - m.startup) / m.active;
          v.pivot.rotation.y = m.tracking ? 1.2 - t * 2.4 : 0.15 - t * 0.3;
          v.weapon.scale.x = reach;
          v.weaponMat.color.setHex(C.active);
          v.weaponMat.emissive.setHex(0xaa1a1a);
        } else {
          const t = (f.frame - m.startup - m.active) / m.recovery;
          v.pivot.rotation.y = -0.7 * (1 - t);
          v.pivot.rotation.z -= 0.4;
          v.weapon.scale.x = reach * 0.85;
          v.weaponMat.color.setHex(C.recovery);
        }
        if (m.level === "low") v.pose.rotation.z = -0.15;
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
        v.weapon.scale.x = 0.55;
        v.weaponMat.color.setHex(C.throw);
        v.pivot.rotation.z = 0.3 + Math.sin(f.frame * 0.3) * 0.4;
        break;
      case "techstun":
        v.pose.rotation.z = 0.18;
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
    v.group.position.set(f.x, y, f.z);
    v.group.rotation.y = -f.facing;
  }

  poseHitbox(f, v, phase) {
    const m = f.move;
    if (!this.showHitboxes || m.level === "throw" || phase === "recovery") return;
    const len = m.range + BODY_RADIUS;
    v.hitbox.visible = true;
    v.hitbox.position.set(f.x, 0.01, f.z);
    v.hitbox.rotation.y = -f.attackDir;
    v.hbPlane.position.x = len / 2;
    v.hbPlane.scale.set(len, m.width, 1);
    v.hbMat.color.setHex(phase === "active" ? C.active : C.startup);
    v.hbMat.opacity = phase === "active" ? 0.35 : 0.1;
  }

  updateCamera(world) {
    const [a, b] = world.fighters;
    const mid = new THREE.Vector3((a.x + b.x) / 2, 0, (a.z + b.z) / 2);
    let ax = b.x - a.x, az = b.z - a.z;
    const sep = Math.hypot(ax, az) || 1;
    ax /= sep; az /= sep;
    // Camera on the side of the fighters' line that keeps player 1 on the left of the screen.
    const px = -az, pz = ax;
    const dist = Math.max(6.2, sep * 1.25 + 3.6);
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
