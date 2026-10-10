// Animation sanity checks: every state and move of every fighter, frame by frame (see
// public/game/animlab.js). Catches visual mistakes before a player does: wrong clip, backwards
// facing, folded spine, weapon out of hand, strikes that miss their hit point.
// Browse the same cases visually at http://localhost:5173/lab.html
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { preloadModels } from "../public/game/models.js";
import { runChecks } from "../public/game/animlab.js";
import { ROSTER } from "../public/engine/roster/index.js";

const ASSETS = new URL("../public/assets/", import.meta.url);
const diskAssets = {
  glb: async (path) => {
    const buf = await readFile(new URL(`${path}.glb`, ASSETS));
    return new GLTFLoader().parseAsync(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), "");
  },
  json: async (path) => JSON.parse(await readFile(new URL(path, ASSETS), "utf8")),
};

test("every fighter pose is physically sane across all states and moves", async () => {
  const models = await preloadModels(diskAssets);
  const fails = runChecks(Object.values(ROSTER), models);
  // Group repeated failures so the report stays readable.
  const groups = new Map();
  for (const f of fails) {
    const key = `${f.char} · ${f.case} · ${f.check}`;
    const g = groups.get(key) ?? { frames: [], detail: f.detail };
    g.frames.push(f.frame);
    groups.set(key, g);
  }
  // Known issues (tools/anim-known.json): failures accepted for now. Anything new fails the test;
  // anything on the list that no longer fails must be removed from it, so the list only shrinks.
  // Regenerate after a deliberate change with: UPDATE_KNOWN=1 npm test
  const knownPath = new URL("./anim-known.json", import.meta.url);
  const keys = [...groups.keys()].sort();
  if (process.env.UPDATE_KNOWN) await writeFile(knownPath, JSON.stringify(keys, null, 2) + "\n");
  const known = new Set(JSON.parse(await readFile(knownPath, "utf8").catch(() => "[]")));
  const fresh = keys.filter((k) => !known.has(k));
  const fixed = [...known].filter((k) => !groups.has(k));
  const report = fresh.map((k) => `  ${k} @ frames ${groups.get(k).frames.join(",")}: ${groups.get(k).detail}`).join("\n");
  assert.equal(fresh.length, 0, `new animation failures:\n${report}`);
  assert.equal(fixed.length, 0, `fixed — remove from tools/anim-known.json (or run UPDATE_KNOWN=1 npm test):\n  ${fixed.join("\n  ")}`);
});
