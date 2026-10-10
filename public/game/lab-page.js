// Animation Lab page: contact sheets of every state and move, with the same checks as
// `npm test` marked on the frames that fail. Click a frame to open it in a scrubbable 3D viewer.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { preloadModels } from "./models.js";
import { animCases, Poser, checkPose, sampleFrames, hitFrame, runChecks } from "./animlab.js";
import { HEIGHT } from "./swing.js";
import { ROSTER } from "../engine/roster/index.js";
import { BODY_RADIUS } from "../engine/sim/constants.js";

const $ = (id) => document.getElementById(id);
const THUMB = { w: 150, h: 190 };
const GROUPS = ["stance", "movement", "defence", "reactions", "attacks"];
const state = { char: "kara", group: "attacks" };
let models, results = [];

// ---- a small scene shared by thumbnails and the viewer ---------------------------------------

function makeStage() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x11141a);
  scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x1a1410, 1.1));
  const sun = new THREE.DirectionalLight(0xffffff, 1.5);
  sun.position.set(2, 6, 4);
  scene.add(sun);
  const grid = new THREE.GridHelper(8, 16, 0x3a4252, 0x252b36);
  scene.add(grid);
  const fwd = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0.01, 0), 0.6, 0x59c98b, 0.12, 0.08);
  scene.add(fwd);
  const ghost = new THREE.Mesh(new THREE.CylinderGeometry(BODY_RADIUS, BODY_RADIUS, 1.75, 16),
    new THREE.MeshBasicMaterial({ color: 0xff5a4a, transparent: true, opacity: 0.12, depthWrite: false }));
  ghost.visible = false;
  scene.add(ghost);
  const hitDot = new THREE.Mesh(new THREE.SphereGeometry(0.045, 10, 8), new THREE.MeshBasicMaterial({ color: 0xf2c14e }));
  hitDot.visible = false;
  scene.add(hitDot);
  return { scene, ghost, hitDot };
}

function showTarget(stage, move) {
  const on = !!move && move.level !== "parry";
  stage.ghost.visible = stage.hitDot.visible = on;
  if (!on) return;
  stage.ghost.position.set(move.range + BODY_RADIUS, 0.875, 0);
  stage.hitDot.position.set(move.range, HEIGHT[move.level] ?? 1.1, 0);
}

// ---- contact sheet -------------------------------------------------------------------------------

const thumbRenderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
thumbRenderer.setSize(THUMB.w, THUMB.h);
const thumbCam = new THREE.PerspectiveCamera(32, THUMB.w / THUMB.h, 0.1, 50);

function renderSheet() {
  const char = ROSTER[state.char];
  const sheet = $("sheet");
  sheet.innerHTML = "";
  const stage = makeStage();
  const poser = new Poser(char, models);
  stage.scene.add(poser.frame);
  for (const kase of animCases(char).filter((c) => c.group === state.group)) {
    const row = document.createElement("div");
    row.className = "row";
    const title = document.createElement("h3");
    title.innerHTML = `${kase.id}<small>${kase.frames} frames</small>`;
    title.onclick = () => openViewer(kase, 0);
    const thumbs = document.createElement("div");
    thumbs.className = "thumbs";
    row.append(title, thumbs);
    sheet.appendChild(row);

    const move = kase.fighter(0).move;
    showTarget(stage, move);
    const reach = move ? move.range + 0.8 : 1;
    const cx = reach / 2 - 0.15;
    thumbCam.position.set(cx, 1.0, 4.3 + reach * 0.8);
    thumbCam.lookAt(cx, 0.85, 0);
    const n = Math.min(10, kase.frames);
    const want = new Set([...Array(n)].map((_, i) => Math.round((i * (kase.frames - 1)) / Math.max(1, n - 1))));
    if (kase.expect.swing) want.add(hitFrame(move));
    let rowBad = false;
    poser.play(kase, Math.max(...want), (f) => {
      if (!want.has(f.frame)) return;
      const fails = checkPose(poser, kase, f);
      thumbRenderer.render(stage.scene, thumbCam);
      const cell = document.createElement("div");
      cell.className = `thumb${fails.length ? " bad" : ""}${kase.expect.swing && f.frame === hitFrame(move) ? " hit" : ""}`;
      cell.title = fails.length ? fails.map((x) => `${x.check}: ${x.detail}`).join("\n") : `frame ${f.frame}: ok`;
      const c = document.createElement("canvas");
      c.width = THUMB.w; c.height = THUMB.h;
      c.getContext("2d").drawImage(thumbRenderer.domElement, 0, 0);
      const label = document.createElement("span");
      label.textContent = `f${f.frame}${f.move ? ` ${phaseName(f.move, f.frame)}` : ""}`;
      cell.append(c, label);
      cell.onclick = () => openViewer(kase, f.frame);
      thumbs.appendChild(cell);
      rowBad ||= fails.length > 0;
    });
    if (rowBad) title.classList.add("bad");
  }
}

const phaseName = (m, fr) => (fr < m.startup ? "startup" : fr < m.startup + m.active ? "ACTIVE" : "recovery");

// ---- viewer ---------------------------------------------------------------------------------------

const viewRenderer = new THREE.WebGLRenderer({ canvas: $("view3d"), antialias: true });
const viewCam = new THREE.PerspectiveCamera(35, 1, 0.1, 60);
const orbit = new OrbitControls(viewCam, viewRenderer.domElement);
const view = { stage: null, poser: null, kase: null, frame: 0, playing: false, acc: 0 };

function openViewer(kase, frame) {
  const char = ROSTER[state.char];
  view.stage = makeStage();
  view.poser = new Poser(char, models);
  view.stage.scene.add(view.poser.frame);
  view.kase = kase;
  const move = kase.fighter(0).move;
  showTarget(view.stage, move);
  $("vtitle").textContent = `${char.name}: ${kase.id}`;
  $("vinfo").textContent = move
    ? `${move.level} · startup ${move.startup} · active ${move.active} · recovery ${move.recovery} · reach ${move.range} m${char.look.swings?.[move.id] ? ` · swing ${JSON.stringify(char.look.swings[move.id])}` : ""}`
    : `${kase.frames} frames`;
  $("scrub").max = kase.frames - 1;
  const reach = move ? move.range : 0.5;
  viewCam.position.set(reach / 2 + 0.6, 1.4, 4.2);
  orbit.target.set(reach / 2, 0.9, 0);
  orbit.update();
  $("viewer").classList.add("open");
  resizeViewer();
  setFrame(frame);
}

function setFrame(frame) {
  view.frame = Math.max(0, Math.min(view.kase.frames - 1, frame));
  $("scrub").value = view.frame;
  const f = view.poser.pose(view.kase, view.frame);
  const fails = checkPose(view.poser, view.kase, f);
  const m = f.move;
  $("fails").innerHTML = `<div class="muted">frame ${view.frame}${m ? ` · ${phaseName(m, view.frame)}${m && view.kase.expect.swing && view.frame === hitFrame(m) ? " · HIT FRAME" : ""}` : ""}</div>` +
    (fails.length ? fails.map((x) => `<div>✗ ${x.check}: ${x.detail}</div>`).join("") : `<div class="ok">✓ all checks pass</div>`);
}

function resizeViewer() {
  const c = viewRenderer.domElement;
  viewRenderer.setSize(c.clientWidth, c.clientHeight, false);
  viewCam.aspect = c.clientWidth / Math.max(1, c.clientHeight);
  viewCam.updateProjectionMatrix();
}
window.addEventListener("resize", () => view.kase && resizeViewer());

let last = performance.now();
function loop(now) {
  requestAnimationFrame(loop);
  const dt = now - last;
  last = now;
  if (!$("viewer").classList.contains("open")) return;
  if (view.playing) {
    view.acc += dt * ($("slow").checked ? 0.25 : 1);
    if (view.acc >= 1000 / 60) { view.acc = 0; setFrame(view.frame + 1 >= view.kase.frames ? 0 : view.frame + 1); }
  }
  viewRenderer.render(view.stage.scene, viewCam);
}
requestAnimationFrame(loop);

$("scrub").oninput = (e) => setFrame(Number(e.target.value));
$("play").onclick = () => { view.playing = !view.playing; $("play").textContent = view.playing ? "Pause" : "Play"; };
$("close").onclick = () => { $("viewer").classList.remove("open"); view.playing = false; };
window.addEventListener("keydown", (e) => {
  if (!$("viewer").classList.contains("open")) return;
  if (e.code === "ArrowRight") setFrame(view.frame + 1);
  if (e.code === "ArrowLeft") setFrame(view.frame - 1);
  if (e.code === "Space") { e.preventDefault(); $("play").click(); }
  if (e.code === "Escape") $("close").click();
});

// ---- controls -------------------------------------------------------------------------------------

function renderControls() {
  const seg = (el, items, key, label = (x) => x) => {
    el.innerHTML = "";
    for (const it of items) {
      const b = document.createElement("button");
      const bad = results.filter((r) => (key === "char" ? r.char === it : r.char === state.char && animCases(ROSTER[state.char]).find((c) => c.id === r.case)?.group === it)).length;
      b.className = state[key] === it ? "on" : "";
      b.textContent = label(it) + (bad ? ` (${bad})` : "");
      b.onclick = () => { state[key] = it; renderControls(); renderSheet(); };
      el.appendChild(b);
    }
  };
  seg($("chars"), Object.keys(ROSTER), "char", (id) => ROSTER[id].name);
  seg($("groups"), GROUPS, "group");
}

models = await preloadModels();
results = runChecks(Object.values(ROSTER), models);
$("summary").textContent = results.length ? `${results.length} failing frames (same checks as npm test)` : "all checks pass (same checks as npm test)";
$("summary").className = results.length ? "bad" : "good";
renderControls();
renderSheet();

// For scripted inspection (e.g. from automation): __lab.results, __lab.show("tove", "attacks").
window.__lab = { get results() { return results; }, show(char, group) { Object.assign(state, { char, group }); renderControls(); renderSheet(); } };
