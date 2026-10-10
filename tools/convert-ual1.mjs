// One-time asset step: pull the clips we use from Quaternius UAL1 into compact JSON.
// UAL1's glTF export uses a different rig (DEF-*); its Unreal FBX matches our body's UE bone names.
// Run from a scratch dir with three installed (the game itself has no npm deps):
//   npm i three@0.169.0 && node convert-ual1.mjs AL_Standard.fbx Mannequin_F.glb UAL1_clips.json
import { readFileSync, writeFileSync } from "node:fs";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import * as THREE from "three";
const [fbxPath, bodyPath, outPath] = process.argv.slice(2);
const KEEP = ["Sword_Idle", "Idle_Loop", "Walk_Loop", "Crouch_Idle_Loop", "Crouch_Fwd_Loop", "Hit_Chest", "Hit_Head",
  "Death01", "Punch_Jab", "Punch_Cross", "Sword_Attack", "Roll", "Dance_Loop", "Jump_Land"];
const toAB = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
const fbx = new FBXLoader().parse(toAB(readFileSync(fbxPath)), "");
// Bone names in the glTF body, to drop tracks for bones it doesn't have (e.g. *_end helpers).
const glb = readFileSync(bodyPath);
const j = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString());
const bones = new Set(j.skins[0].joints.map((i) => j.nodes[i].name));
const round = (arr, d) => Array.from(arr, (v) => Math.round(v * 10 ** d) / 10 ** d);
const out = [];
for (const name of KEEP) {
  const clip = fbx.animations.find((a) => a.name.replace(/^.*\|/, "") === name);
  if (!clip) { console.warn("missing", name); continue; }
  const tracks = clip.tracks.filter((t) => {
    const [bone, prop] = t.name.split(".");
    if (!bones.has(bone) || bone === "root") return false; // the body's root carries its own axis fix
    if (prop === "scale") return false;
    if (prop === "position") return bone === "pelvis";
    return true;
  }).map((t) => ({ name: t.name, type: t.ValueTypeName, times: round(t.times, 4), values: round(t.values, 4) }));
  out.push({ name, duration: clip.duration, tracks });
}
writeFileSync(outPath, JSON.stringify(out));
console.log("clips", out.length, "bytes", JSON.stringify(out).length);
