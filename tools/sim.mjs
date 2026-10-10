// Headless AI-vs-AI matches for tuning the gameplay loop.
//
//   node tools/sim.mjs                 local brains, every matchup, 20 matches each
//   node tools/sim.mjs --matches 50
//   node --env-file=$HOME/.config/typesafe/env tools/sim.mjs --jev kara:sen --matches 1
//       side A thinks with Jev (real API, real latency), side B with the local brain.
//
// Jev latency is simulated faithfully: the sim pauses while a request is in flight,
// then the answer is applied at issue frame + latency in frames.

import { createWorld, step, NEUTRAL_INPUT } from "../public/engine/sim/world.js";
import { ROSTER, getCharacter } from "../public/engine/roster/index.js";
import { AIController } from "../public/engine/ai/controller.js";
import { LocalBrain, JevBrain } from "../public/engine/ai/brains.js";
import { makeRng } from "../public/engine/ai/sampling.js";

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith("--") ? [a.slice(2), all[i + 1]?.startsWith("--") ? true : all[i + 1] ?? true] : null).filter(Boolean));
const MATCHES = Number(args.matches ?? 20);
const SEED = Number(args.seed ?? 1);
// Same reflexes for everyone, so win rates reflect the move sets rather than AI skill.
const SKILL = args["equal-skill"] ? { reactionFrames: 15, readSkill: 0.55, punishSkill: 0.8, confirmSkill: 0.75 } : null;

function jevTransport() {
  const key = process.env.TYPESAFE_API_KEY;
  if (!key) throw new Error("TYPESAFE_API_KEY not set (run with --env-file)");
  return async ({ state, questions }) => {
    const t0 = performance.now();
    const res = await fetch("https://api.typesafe.ai/v1/systemone", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "jev-latest", state, questions }),
    });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    return { ...(await res.json()), latencyMs: performance.now() - t0 };
  };
}

async function playMatch(charA, charB, brains, seed) {
  const world = createWorld(charA, charB);
  const rng = makeRng(seed);
  const ctrls = [0, 1].map((side) => new AIController({ side, brain: brains[side], rng, skill: SKILL }));
  const stats = { frames: 0, rounds: 0, timeouts: 0, hits: 0, blocks: 0, counters: 0, punishes: 0, launches: 0, maxCombo: 0, throws: 0, techs: 0, guardbreaks: 0, whiffs: 0, ducks: 0, comboHits: 0 };
  let inputs = [NEUTRAL_INPUT, NEUTRAL_INPUT];
  while (world.phase !== "over" && world.frame < 60 * 60 * 6) {
    step(world, inputs);
    for (const e of world.events) {
      if (e.type === "hit") {
        stats.hits++;
        if (e.counter) stats.counters++;
        if (e.punish) stats.punishes++;
        if (e.result === "launch" && e.combo === 1) stats.launches++;
        if (e.combo > 1) stats.comboHits++;
        stats.maxCombo = Math.max(stats.maxCombo, e.combo);
      }
      if (e.type === "block") stats.blocks++;
      if (e.type === "throw") stats.throws++;
      if (e.type === "tech") stats.techs++;
      if (e.type === "guardbreak") stats.guardbreaks++;
      if (e.type === "whiff") stats.whiffs++;
      if (e.type === "duck") stats.ducks++;
      if (e.type === "round_end") { stats.rounds++; if (e.timeout) stats.timeouts++; }
    }
    inputs = ctrls.map((c) => c.update(world));
    await Promise.all(ctrls.map((c) => c.pending));
  }
  stats.frames = world.frame;
  return { winner: world.matchWinner, stats, ctrls };
}

async function main() {
  if (args.jev) {
    const [a, b] = String(args.jev).split(":");
    const brains = [new JevBrain({ transport: jevTransport() }), new LocalBrain()];
    for (let i = 0; i < MATCHES; i++) {
      const { winner, stats, ctrls } = await playMatch(getCharacter(a), getCharacter(b), brains, SEED + i);
      const jev = ctrls[0].debugInfo();
      console.log(`${a}(Jev) vs ${b}(local): winner=${winner === 0 ? a : winner === 1 ? b : "draw"}`, stats);
      console.log(`  Jev plans=${jev.plans} stale=${jev.stale} avgLatency=${jev.latency}ms errors=${brains[0].errors}${brains[0].lastError ? ` (${brains[0].lastError})` : ""}`);
      console.log("  last decisions:", jev.log.map((l) => l.msg).join(" | "));
      console.log("  habits seen:", jev.habits);
    }
    return;
  }

  const ids = Object.keys(ROSTER);
  const total = {};
  console.log(`matchup            wins A/B/draw   avg round  timeouts  hits  blocks  counters  punishes  launches  maxCombo  throws/techs  guardbreaks`);
  for (const a of ids) for (const b of ids) {
    if (a > b) continue;
    const w = [0, 0, 0];
    const agg = {};
    for (let i = 0; i < MATCHES; i++) {
      const { winner, stats } = await playMatch(ROSTER[a], ROSTER[b], [new LocalBrain(), new LocalBrain()], SEED * 1000 + i);
      w[winner === -1 ? 2 : winner]++;
      for (const [k, v] of Object.entries(stats)) agg[k] = k === "maxCombo" ? Math.max(agg[k] ?? 0, v) : (agg[k] ?? 0) + v;
    }
    for (const [k, v] of Object.entries(agg)) total[k] = (total[k] ?? 0) + v;
    const per = (k) => (agg[k] / agg.rounds).toFixed(1);
    console.log(
      `${(a + " vs " + b).padEnd(18)} ${`${w[0]}/${w[1]}/${w[2]}`.padEnd(15)} ${(agg.frames / agg.rounds / 60).toFixed(1).padStart(6)}s  ${String(agg.timeouts).padStart(8)}  ${per("hits").padStart(4)}  ${per("blocks").padStart(6)}  ${per("counters").padStart(8)}  ${per("punishes").padStart(8)}  ${per("launches").padStart(8)}  ${String(agg.maxCombo).padStart(8)}  ${per("throws")}/${per("techs")}`.padEnd(120) + per("guardbreaks"),
    );
  }
  console.log("(per-round averages)");
}

main().catch((e) => { console.error(e); process.exit(1); });
