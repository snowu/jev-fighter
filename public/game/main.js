import { createWorld, step, resetRound, NEUTRAL_INPUT } from "../engine/sim/world.js";
import { GUARD_MAX } from "../engine/sim/constants.js";
import { ROSTER } from "../engine/roster/index.js";
import { slotsOf, baseSlot, starter, frameLine } from "../engine/sim/moves.js";
import { AIController, DummyController, DIFFICULTY } from "../engine/ai/controller.js";
import { LocalBrain, JevBrain, proxyTransport } from "../engine/ai/brains.js";
import { makeRng } from "../engine/ai/sampling.js";
import { HumanController } from "./input.js";
import { Renderer } from "./render.js";
import { preloadModels } from "./models.js";

const $ = (id) => document.getElementById(id);
const TICK_MS = 1000 / 60;
const KEY_FOR = { light: "J", heavy: "K", low: "L", special: "U", throw: "I" };
const DIR_KEY = { fwd: "→", back: "←" };
const keyFor = (slot) => (slot.includes("_") ? DIR_KEY[slot.split("_")[0]] : "") + KEY_FOR[baseSlot(slot)];

// ---- settings & menu -------------------------------------------------------------

const DEFAULTS = { mode: "versus", brain: "jev", p1: "kara", p2: "sen", difficulty: "normal", dummy: "stand" };
let settings = { ...DEFAULTS };
try { settings = { ...DEFAULTS, ...JSON.parse(localStorage.getItem("jevfighter.settings") ?? "{}") }; } catch {}
const save = () => { try { localStorage.setItem("jevfighter.settings", JSON.stringify(settings)); } catch {} };

// Brain API: same origin when served by `npm start`; the Cloudflare Worker proxy on GitHub Pages.
const API = location.hostname.endsWith("github.io") ? "https://jev-fighter-brain.zancato-t.workers.dev" : "";
let jevAvailable = false;
let hasServer = false; // false on static hosting (GitHub Pages): no /api proxy, so no Jev
const roster = Object.values(ROSTER).map((c) => [c.id, c.name, c.title]);
const OPTIONS = {
  mode: [["versus", "You vs AI"], ["watch", "AI vs AI", "watch two brains fight"], ["training", "Training", "dummy + frame data"]],
  brain: [["jev", "Jev", "TypeSafe System One"], ["local", "Local", "hand-tuned fallback"]],
  p1: roster, p2: roster,
  difficulty: Object.entries(DIFFICULTY).map(([k, d]) => [k, d.label]),
  dummy: [["stand", "Stand guard"], ["crouch", "Crouch guard"], ["random", "Switching guard"], ["open", "No guard"], ["attack", "Attacks", "practise punishing"]],
};

function renderMenu() {
  for (const el of document.querySelectorAll("[data-opt]")) {
    const key = el.dataset.opt;
    el.innerHTML = "";
    for (const [value, label, sub] of OPTIONS[key]) {
      const b = document.createElement("button");
      b.className = settings[key] === value ? "on" : "";
      b.innerHTML = `${label}${sub ? `<small>${sub}</small>` : ""}`;
      if (key === "brain" && value === "jev" && !jevAvailable) { b.disabled = true; b.innerHTML = `Jev<small>${hasServer ? "no API key on server" : "brain server unreachable"}</small>`; }
      b.onclick = () => { settings[key] = value; save(); renderMenu(); };
      el.appendChild(b);
    }
  }
}

function showMenu(show) {
  $("menu").style.display = show ? "flex" : "none";
  if (game) game.paused = show;
}

fetch(`${API}/api/status`, { cache: "no-store" }).then((r) => r.json()).then((s) => { hasServer = true; jevAvailable = s.jev; })
  .catch(() => {}).finally(() => {
    if (!jevAvailable && settings.brain === "jev") settings.brain = "local";
    renderMenu();
  });
renderMenu();

// ---- game ------------------------------------------------------------------------------

const renderer = new Renderer(document.createElement("canvas"));
document.body.prepend(renderer.renderer.domElement);
let game = null;

// Models load in the background; FIGHT waits for them (capsules are the fallback if loading fails).
const startBtn = $("start");
startBtn.disabled = true;
startBtn.textContent = "LOADING MODELS…";
const modelsReady = preloadModels(Object.values(ROSTER))
  .then((models) => { renderer.models = models; })
  .catch((err) => console.warn("models failed to load, using placeholder capsules", err))
  .finally(() => { startBtn.disabled = false; startBtn.textContent = "FIGHT"; });

function makeBrain() {
  return settings.brain === "jev" && jevAvailable ? new JevBrain({ transport: proxyTransport(`${API}/api/brain`) }) : new LocalBrain();
}

function startGame() {
  if (game) game.controllers.forEach((c) => c.detach?.());
  const chars = [ROSTER[settings.p1], ROSTER[settings.p2]];
  const training = settings.mode === "training";
  const world = createWorld(chars[0], chars[1], training ? { roundFrames: Infinity } : undefined);
  const rng = makeRng(Date.now() % 1e9);
  const human = () => new HumanController({ side: 0, sidestepDir: (screen) => renderer.sidestepDir(screen, world.fighters[0]) });
  const ai = (side) => new AIController({ side, brain: makeBrain(), rng, difficulty: settings.difficulty });
  const controllers = settings.mode === "watch" ? [ai(0), ai(1)]
    : training ? [human(), new DummyController({ side: 1, mode: settings.dummy })]
    : [human(), ai(1)];
  renderer.setup(world);
  game = { world, controllers, inputs: [NEUTRAL_INPUT, NEUTRAL_INPUT], acc: 0, last: performance.now(), paused: false, training, idleFrames: 0, lastAdv: null, combos: [null, null] };
  $("train").style.display = training ? "block" : "none";
  $("mind").style.display = training ? "none" : "flex";
  renderMoves();
  showMenu(false);
}

function tick() {
  const { world, controllers } = game;
  step(world, game.inputs);
  renderer.onEvents(world, world.events);
  for (const e of world.events) onEvent(e);
  if (game.training) trainingUpkeep();
  game.inputs = controllers.map((c) => c.update(world));
}

// Don't let a backgrounded tab pile up time and fast-forward on return.
document.addEventListener("visibilitychange", () => { if (game) game.last = performance.now(); });

function loop(now) {
  requestAnimationFrame(loop);
  if (!game) return;
  if (!game.paused) {
    game.acc += Math.min(100, now - game.last);
    let steps = 0;
    while (game.acc >= TICK_MS && steps++ < 5) { tick(); game.acc -= TICK_MS; }
  }
  game.last = now;
  renderer.update(game.world);
  updateHud();
}
requestAnimationFrame(loop);

// ---- training ----------------------------------------------------------------------

function trainingUpkeep() {
  const { world } = game;
  const calm = world.fighters.every((f) => f.state === "idle");
  game.idleFrames = calm ? game.idleFrames + 1 : 0;
  if (game.idleFrames === 40) for (const f of world.fighters) { f.hp = f.char.hp; f.guard = GUARD_MAX; }
}

function resetPositions() {
  if (!game) return;
  resetRound(game.world);
  game.world.phase = "fight";
}

// ---- events → callouts ------------------------------------------------------------

function callout(text, color = "#fff", ms = 900) {
  const el = $("callout");
  el.textContent = text;
  el.style.color = color;
  el.style.opacity = 1;
  clearTimeout(callout.t);
  callout.t = setTimeout(() => { el.style.opacity = 0; }, ms);
}

function pop(f, text, color) {
  const p = renderer.screenPos(f);
  const el = document.createElement("div");
  el.className = "pop";
  el.textContent = text;
  el.style.color = color;
  el.style.left = `${p.x}px`;
  el.style.top = `${p.y}px`;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 900);
}

function onEvent(e) {
  const { world } = game;
  const F = world.fighters;
  switch (e.type) {
    case "round_start": callout("FIGHT", "#f2c14e", 700); break;
    case "round_end": callout(e.timeout ? "TIME" : "K.O.", "#ff5a4a", 1600); break;
    case "match_end": {
      const name = e.winner === -1 ? "DRAW" : `${F[e.winner].char.name.toUpperCase()} WINS`;
      setTimeout(() => callout(`${name}  ·  Enter: rematch`, "#f2c14e", 600000), 400);
      break;
    }
    case "hit":
      if (e.counter) pop(F[e.target], "COUNTER!", "#ff4d4d");
      else if (e.punish) pop(F[e.target], "PUNISH!", "#f2c14e");
      if (e.result === "launch" && e.combo === 1) pop(F[e.target], "LAUNCH!", "#ffa64d");
      if (e.tip === "tip") pop(F[e.target], "TIPPER!", "#59c98b");
      if (e.combo >= 2) game.combos[e.who] = { hits: e.combo, dmg: e.comboDamage, at: performance.now() };
      if (e.advantage !== null && e.who === 0) game.lastAdv = { text: `${F[0].char.moves[e.move].name}: ${fmtAdv(e.advantage)} on hit`, adv: e.advantage };
      break;
    case "block":
      if (e.who === 0) game.lastAdv = { text: `${F[0].char.moves[e.move].name}: ${fmtAdv(e.advantage)} on block`, adv: e.advantage };
      if (e.who === 1) game.lastAdv = { text: `You blocked ${F[1].char.moves[e.move].name}: you are ${fmtAdv(-e.advantage)}`, adv: -e.advantage };
      break;
    case "guardbreak": pop(F[e.who], "GUARD BREAK", "#b78cff"); break;
    case "tech": pop(F[e.who], "BREAK!", "#ffffff"); break;
    case "duck": pop(F[e.who], "DUCK", "#7ab8ff"); break;
    case "throw": pop(F[e.target], "THROW", "#c07bff"); break;
    case "taunt": pop(F[e.who], "TAUNT", "#ffffff"); break;
    case "parry": pop(F[e.who], "PARRY!", "#7ae8ff"); break;
    case "armor": pop(F[e.who], "ARMOR", "#ffb347"); break;
    case "rage": pop(F[e.who], "RAGE", "#ff3b2f"); break;
  }
}

const fmtAdv = (n) => (n > 0 ? `+${n}` : `${n}`);

// ---- HUD -------------------------------------------------------------------------------

let hudFrame = 0;
function updateHud() {
  const { world, controllers } = game;
  world.fighters.forEach((f, i) => {
    $(`n${i}`).innerHTML = `${f.char.name}<small>${f.char.title}${controllers[i] instanceof HumanController ? " · you" : ""}</small>`;
    const pct = `${(100 * f.hp / f.char.hp).toFixed(1)}%`;
    $(`h${i}`).style.width = pct;
    $(`l${i}`).style.width = pct;
    $(`g${i}`).style.width = `${(100 * f.guard / GUARD_MAX).toFixed(0)}%`;
    $(`g${i}`).style.background = f.guard < 30 ? "#b78cff" : "";
    $(`p${i}`).innerHTML = [0, 1].map((k) => `<div class="pip ${world.wins[i] > k ? "on" : ""}"></div>`).join("");
  });
  $("timer").textContent = Number.isFinite(world.roundFrames) ? Math.max(0, Math.ceil(world.roundFrames / 60)) : "∞";
  if (world.phase === "intro" && world.phaseFrame === 1) callout(`ROUND ${world.round}`, "#fff", 900);

  const comboEl = $("combo");
  const now = performance.now();
  const c = game.combos.map((x, i) => x && now - x.at < 1400 ? [x, i] : null).filter(Boolean).at(-1);
  if (c) {
    const [x, i] = c;
    comboEl.innerHTML = `${x.hits} HITS<small>${x.dmg} damage</small>`;
    comboEl.style.opacity = 1;
    comboEl.style.left = i === 0 ? "24px" : "auto";
    comboEl.style.right = i === 1 ? "24px" : "auto";
    comboEl.style.textAlign = i === 0 ? "left" : "right";
  } else comboEl.style.opacity = 0;

  if (++hudFrame % 6 !== 0) return;
  const brainCtrl = controllers.find((x) => x instanceof AIController);
  const lat = brainCtrl?.debugInfo().latency;
  $("brainTag").textContent = brainCtrl ? `${brainCtrl.brain.name === "jev" ? "Jev" : "Local"} brain${lat ? ` · ${lat} ms` : ""}` : "training";
  if (game.training) renderTraining();
  else renderMind();
}

function bars(probs, selected, labels = {}) {
  if (!probs) return "";
  return Object.entries(probs).sort((a, b) => b[1] - a[1]).map(([k, p]) =>
    `<div class="row ${k === selected ? "sel" : ""}"><span>${labels[k] ?? k.replaceAll("_", " ")}</span><div class="b"><i style="width:${(p * 100).toFixed(0)}%"></i></div><span class="mono">${(p * 100).toFixed(0)}%</span></div>`).join("");
}

function renderMind() {
  const html = game.controllers.map((c) => {
    if (!(c instanceof AIController)) return "";
    const d = c.debugInfo();
    const char = game.world.fighters[c.side].char;
    const p = d.plan;
    const moveNames = Object.fromEntries(slotsOf(char).map((s) => [s, `${starter(char, s).name} (${keyFor(s)})`]));
    const src = p?.source ?? "—";
    return `<div class="mindcard">
      <h3>${char.name}'s mind <span class="tag ${src === "jev" ? "jev" : ""}">${src}</span>${d.latency ? `<span class="tag">${d.latency} ms</span>` : ""}<span class="tag">plans ${d.plans}${d.stale ? ` · stale ${d.stale}` : ""}</span>${d.thinking ? "<span class='tag'>thinking…</span>" : ""}</h3>
      ${p ? `
      <div class="group"><b>Tactic</b>${bars(p.tactic, d.tactic)}</div>
      <div class="group"><b>Preferred attack</b>${bars(p.attack, null, moveNames)}</div>
      <div class="group"><b>If attacked</b>${bars(p.incoming)}</div>
      <div class="group mono">aggression ${(p.aggression * 100).toFixed(0)}% · throw-break ready ${(p.tech * 100).toFixed(0)}% · taunt ${(p.taunt * 100).toFixed(0)}% · reaction ${d.reaction}f</div>
      ${p.error ? `<div class="group" style="color:var(--bad)">${p.error}</div>` : ""}` : "<div class='log'>waiting for first plan…</div>"}
      ${d.habits?.length ? `<div class="group"><b>Has noticed</b><div class="log">${d.habits.map((h) => `<div>• ${h}</div>`).join("")}</div></div>` : ""}
      <div class="group"><b>Decisions</b><div class="log mono">${d.log.slice(-6).map((l) => `<div>${l.msg}</div>`).join("")}</div></div>
    </div>`;
  }).join("");
  $("mind").innerHTML = html;
}

function renderTraining() {
  const adv = game.lastAdv;
  const color = !adv ? "" : adv.adv >= 0 ? "var(--good)" : adv.adv <= -10 ? "var(--bad)" : "var(--hp)";
  const combo = game.combos[0];
  $("train").innerHTML = `<h3>Training · dummy: ${OPTIONS.dummy.find(([k]) => k === settings.dummy)[1]}</h3>
    <div>Last frame advantage</div>
    <div class="adv mono" style="color:${color}">${adv ? adv.text : "—"}</div>
    <div class="log">≥ 0: your turn · −1 to −9: safe · −10 or worse: punishable by a fast attack</div>
    <div style="margin-top:6px">Best recent combo: <b>${combo ? `${combo.hits} hits, ${combo.dmg} dmg` : "—"}</b></div>
    <div class="log" style="margin-top:6px"><kbd>R</kbd> reset positions · health refills when both fighters are idle · <kbd>Tab</kbd> move list</div>`;
}

function renderMoves() {
  const char = game.world.fighters[0].char;
  const rows = [];
  for (const slot of slotsOf(char)) {
    const walk = (m, keys, depth) => {
      rows.push(`<tr class="${depth ? "chain" : ""}"><td class="k">${keys}</td><td>${depth ? "↳ " : ""}${frameLine(m)}</td></tr>`);
      for (const [s, id] of Object.entries(m.cancels ?? {})) walk(char.moves[id], `${keys} ${keyFor(s)}`, depth + 1);
      if (m.parry) walk(char.moves[m.parry.riposte], "auto", depth + 1);
    };
    walk(starter(char, slot), keyFor(slot), 0);
  }
  $("moves").innerHTML = `<h3 style="margin:0 0 6px;font-size:12px;color:var(--muted)">${char.name} · ${char.title}</h3>
    <div class="log" style="margin:0 0 6px;color:var(--text)">${char.signature}</div><table class="mono">${rows.join("")}</table>
    <div class="log" style="margin-top:6px">→/← = hold toward/away (D/A) while pressing · i = startup frames · on block: + you recover first, ≤ −10 punishable</div>`;
}

// ---- global keys -------------------------------------------------------------------

window.addEventListener("keydown", (e) => {
  if (e.code === "Escape") { if (game) showMenu($("menu").style.display === "none"); return; }
  if ($("menu").style.display !== "none") { if (e.code === "Enter" && !startBtn.disabled) startGame(); return; }
  if (e.code === "Tab") { const m = $("moves"); m.style.display = m.style.display === "block" ? "none" : "block"; }
  if (e.code === "KeyH") renderer.showHitboxes = !renderer.showHitboxes;
  if (e.code === "KeyP") callout(renderer.togglePS1() ? "PS1 ON" : "PS1 OFF", "#fff", 600);
  if (e.code === "KeyM" && !game?.training) { const m = $("mind"); m.style.display = m.style.display === "none" ? "flex" : "none"; }
  if (e.code === "KeyR" && game?.training) resetPositions();
  if (e.code === "Enter" && game?.world.phase === "over") { $("callout").style.opacity = 0; startGame(); }
});
$("start").onclick = startGame;

// Dev hook for scripted testing (e.g. from the console): __jev.advance(60) steps one second.
window.__jev = {
  get game() { return game; },
  start: (opts = {}) => { Object.assign(settings, opts); startGame(); },
  ready: () => modelsReady,
  get renderer() { return renderer; },
  async advance(frames = 1) {
    for (let i = 0; i < frames; i++) {
      tick();
      await Promise.all(game.controllers.map((c) => c.pending)); // brains answer "between frames", like the headless runner
    }
    renderer.update(game.world);
    updateHud();
    return game.world.frame;
  },
  /** Queue a key press for the human controller on the next tick (e.g. "KeyJ"), optionally held. */
  press(code) { game.controllers[0].presses?.push(code); },
  hold(code, on = true) { const k = game.controllers[0].keys; if (k) on ? k.add(code) : k.delete(code); },
};
