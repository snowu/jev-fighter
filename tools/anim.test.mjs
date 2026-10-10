// Animation sanity checks: every state and move of every fighter, frame by frame (see
// public/game/animlab.js). Catches visual mistakes before a player does: wrong clip, backwards
// facing, folded spine, weapon out of hand, strikes that miss their hit point.
// Browse the same cases visually at http://localhost:5173/lab.html
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
  const report = [...groups].map(([k, g]) => `  ${k} @ frames ${g.frames.join(",")}: ${g.detail}`).join("\n");
  assert.equal(fails.length, 0, `animation checks failed:\n${report}`);
});
