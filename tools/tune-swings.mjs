// Swing tuner: for each attack whose animation fails the lab checks, search variations of its
// swing tuning (wind-up, arc span, hip turn, step) and keep the one with the fewest failing
// frames whose strike still lands on the hit point. Prefers values close to the current ones,
// so a big telegraphed cleave stays big if it can.
//   node tools/tune-swings.mjs            # report what it would change
//   node tools/tune-swings.mjs --write    # also rewrite the roster files' swings entries
//   node tools/tune-swings.mjs kara.overhead sen.iai   # only these moves
import { readFile, writeFile } from "node:fs/promises";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { preloadModels } from "../public/game/models.js";
import { animCases, Poser, checkPose } from "../public/game/animlab.js";
import { tuneSwing } from "../public/game/swing.js";
import { ROSTER } from "../public/engine/roster/index.js";

const ASSETS = new URL("../public/assets/", import.meta.url);
const models = await preloadModels({
  glb: async (p) => { const b = await readFile(new URL(`${p}.glb`, ASSETS)); return new GLTFLoader().parseAsync(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), ""); },
  json: async (p) => JSON.parse(await readFile(new URL(p, ASSETS), "utf8")),
});
const args = process.argv.slice(2);
const write = args.includes("--write");
const only = args.filter((a) => !a.startsWith("--"));

/** Frames failing any check (and whether the strike landed) for one move with a given swing spec. */
function evaluate(char, moveId, spec) {
  const saved = char.look.swings[moveId];
  char.look.swings[moveId] = spec;
  const poser = new Poser(char, models);
  const kase = animCases(char).find((c) => c.fighter(0).move?.id === moveId);
  let failing = 0, strikeMiss = false;
  const checks = new Map();
  poser.play(kase, kase.frames - 1, (f) => {
    const fails = checkPose(poser, kase, f);
    if (fails.length) failing++;
    for (const x of fails) { checks.set(x.check, (checks.get(x.check) ?? 0) + 1); if (x.check === "strike") strikeMiss = true; }
  });
  char.look.swings[moveId] = saved;
  return { failing, strikeMiss, checks };
}

const HORIZONTAL = new Set(["slash", "backslash", "sweep", "spin"]);
const changes = [];
for (const char of Object.values(ROSTER)) {
  for (const [moveId, spec0] of Object.entries(char.look.swings ?? {})) {
    if (only.length && !only.includes(`${char.id}.${moveId}`)) continue;
    const base = typeof spec0 === "string" ? { shape: spec0 } : { ...spec0 };
    const full = tuneSwing(base, char.moves[moveId]);
    const now = evaluate(char, moveId, base);
    if (now.failing === 0) continue;
    // Candidates around the current tuning.
    const windups = [...new Set([full.windup, 0.3, 0.45, 0.6, 0.8, 1.0, 1.3, 1.6].map((w) => Math.min(w, Math.max(0.3, full.windup)) ))];
    const spans = HORIZONTAL.has(full.shape) ? [full.span, 0.9, 1.2, 1.5, 2.0].filter(Boolean) : [undefined];
    const hipsList = [full.hips, 0.15, 0.3, 0.5];
    const steps = [full.step, full.step + 0.15, full.step + 0.3];
    let best = { spec: base, ...now, score: now.failing + (now.strikeMiss ? 100 : 0) };
    for (const windup of [...new Set([...windups, 0.3, 0.45, 0.6, 0.8])]) {
      for (const span of spans) {
        for (const hips of [...new Set(hipsList)]) {
          for (const step of [...new Set(steps)]) {
            const spec = { ...base, windup: +windup.toFixed(2), hips: +hips.toFixed(2), step: +step.toFixed(2) };
            if (span !== undefined) spec.span = +span.toFixed(2);
            const r = evaluate(char, moveId, spec);
            if (r.strikeMiss) continue;
            if ([...r.checks.keys()].some((k) => !now.checks.has(k))) continue; // never trade in a new kind of failure
            // Fewest failing frames; then stay close to the current feel (bigger wind-ups kept if possible).
            const drift = Math.abs(windup - full.windup) * 2 + Math.abs(hips - full.hips) + Math.abs(step - full.step) + (span !== undefined ? Math.abs(span - (full.span ?? span)) : 0);
            const score = r.failing + drift * 0.8;
            if (score < best.score) best = { spec, ...r, score };
          }
        }
      }
    }
    const line = `${char.id}.${moveId}: ${now.failing} → ${best.failing} failing frames  ${JSON.stringify(best.spec)}  [${[...best.checks].map(([k, n]) => `${k}×${n}`).join(" ") || "clean"}]`;
    console.log(line);
    if (best.spec !== base) changes.push({ char: char.id, moveId, spec: best.spec });
  }
}

if (write) {
  const byChar = new Map();
  for (const c of changes) byChar.set(c.char, [...(byChar.get(c.char) ?? []), c]);
  for (const [charId, list] of byChar) {
    const path = new URL(`../public/engine/roster/${charId}.js`, import.meta.url);
    let src = await readFile(path, "utf8");
    for (const { moveId, spec } of list) {
      const body = Object.entries(spec).map(([k, v]) => `${k}: ${typeof v === "string" ? `"${v}"` : v}`).join(", ");
      // Replace the one-line entry `      moveId: ...,` inside swings (keep any trailing comment).
      const re = new RegExp(`^(\\s{6}${moveId}: )(\\{[^\\n]*?\\}|"[^"]*")(,.*)$`, "m");
      if (!re.test(src)) { console.warn(`could not rewrite ${charId}.${moveId}`); continue; }
      src = src.replace(re, `$1{ ${body} }$3`);
    }
    await writeFile(path, src);
    console.log(`wrote ${list.length} swing(s) to roster/${charId}.js`);
  }
}
