// Jev fighting-game probe.
// Measures round-trip latency for a realistic "AI brain tick" and shows how
// sampling from Jev's probabilities yields varied, in-character decisions.
//
//   TYPESAFE_API_KEY=... node probe.mjs [runs=20]
//
// No dependencies: uses the documented HTTP contract (POST /v1/systemone).

const KEY = process.env.TYPESAFE_API_KEY;
const RUNS = Number(process.argv[2] ?? 20);
const URL = "https://api.typesafe.ai/v1/systemone";

if (!KEY) {
  console.error("Set TYPESAFE_API_KEY first:  TYPESAFE_API_KEY=sk-... node probe.mjs");
  process.exit(1);
}

// --- State: what the game engine would describe each brain tick. -----------
// Numbers are bucketed into words in code (Jev is weak at raw numbers/math).
const personas = {
  berserker:
    "Kara, a reckless axe berserker. Loves trading hits, hates backing off, gets wilder when hurt.",
  duelist:
    "Sen, a patient katana duelist. Waits for mistakes, punishes whiffs, rarely jumps.",
};

function situation(persona) {
  return {
    fighter: personas[persona],
    weapon: "two-handed weapon: slow heavy swings with long reach, weak up close",
    distance: "mid range (just outside the opponent's sword reach, inside your own)",
    your_health: "about one third left",
    opponent_health: "about two thirds left",
    round: "final round, 12 seconds left on the clock",
    position: "your back is near the arena wall",
    opponent_recent_habits: [
      "blocked low 4 of the last 5 times you attacked",
      "dashed in with a fast stab after each of your last 3 whiffed swings",
      "has not thrown you all round",
    ],
    opponent_now: "standing still, guarding",
  };
}

// --- Questions: speculative fan-out. One request, many judgments. ----------
// Some are used right away (tactic); others are contingency answers cached
// so the reflex layer can react instantly when the event actually fires.
const questions = {
  tactic: {
    type: "choice",
    instructions:
      "Given the fighter's personality and the situation, which tactic does this fighter use next?",
    criteria: {
      press_attack: "Step in and attack aggressively",
      overhead_mixup: "Attack high, since the opponent keeps blocking low",
      throw: "Grab the opponent, since they keep guarding",
      bait_whiff: "Fake an attack to bait the opponent's dash-in, then punish it",
      back_off: "Create space and reset to a safer distance",
      wait_and_block: "Hold guard and wait for the opponent to commit",
    },
  },
  on_opponent_dash: {
    type: "choice",
    instructions:
      "If the opponent suddenly dashes in with a fast stab right now, how does this fighter respond?",
    criteria: {
      block: "Block the stab",
      counter_swing: "Swing to trade or beat the stab",
      sidestep: "Sidestep the stab",
      jump_back: "Jump backwards out of range",
    },
  },
  on_knockdown_wakeup: {
    type: "choice",
    instructions: "If this fighter gets knocked down right now, what does it do when getting up?",
    criteria: {
      wakeup_attack: "Attack while standing up",
      block: "Get up guarding",
      roll_away: "Roll away from the opponent",
    },
  },
  aggression: {
    type: "score",
    instructions: "How aggressively should this fighter play right now?",
    criteria: [
      "Fully defensive: only blocks and waits",
      "Cautious: mostly defends and attacks only safe openings",
      "Balanced between attacking and defending",
      "Aggressive: keeps up pressure and accepts some risk",
      "All-in: attacks relentlessly regardless of risk",
    ],
  },
  taunt: {
    type: "noul",
    instructions: "Would this fighter taunt the opponent right now?",
  },
};

async function ask(state) {
  const t0 = performance.now();
  const res = await fetch(URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "jev-latest", state, questions }),
  });
  const ms = performance.now() - t0;
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return { ms, body: await res.json() };
}

// Sample from the distribution instead of taking argmax: this is the
// "real unpredictability" knob. temperature < 1 sharpens, > 1 flattens.
function sample(probabilities, temperature = 1) {
  const entries = Object.entries(probabilities).map(([k, p]) => [k, Math.pow(p, 1 / temperature)]);
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let r = Math.random() * total;
  for (const [k, w] of entries) if ((r -= w) <= 0) return k;
  return entries.at(-1)[0];
}

const pct = (xs, p) => xs.slice().sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))];

for (const persona of Object.keys(personas)) {
  const lat = [];
  let last;
  for (let i = 0; i < RUNS; i++) {
    const { ms, body } = await ask(situation(persona));
    lat.push(ms);
    last = body;
  }
  const a = last.answers;
  console.log(`\n=== ${persona} (${last.model}, ${last.usage.input_tokens} input tokens/request) ===`);
  console.log(`latency ms  p50=${pct(lat, 0.5).toFixed(0)}  p95=${pct(lat, 0.95).toFixed(0)}  min=${Math.min(...lat).toFixed(0)}`);
  console.log("tactic probabilities:", fmt(a.tactic.probabilities), `confidence=${a.tactic.confidence.toFixed(2)}`);
  console.log("on_opponent_dash:", fmt(a.on_opponent_dash.probabilities));
  console.log("on_knockdown_wakeup:", fmt(a.on_knockdown_wakeup.probabilities));
  console.log(`aggression score=${a.aggression.score.toFixed(2)} / 4   taunt p=${a.taunt.noul.toFixed(2)}`);
  const picks = Array.from({ length: 12 }, () => sample(a.tactic.probabilities, 1.0));
  console.log("12 sampled tactics (T=1.0):", picks.join(", "));
  const costPerHour = (last.usage.input_tokens * 3 * 3600 * 0.042) / 1e6;
  console.log(`est. cost at 3 brain ticks/sec: $${costPerHour.toFixed(2)}/hour of play`);
}

function fmt(p) {
  return Object.entries(p)
    .sort((x, y) => y[1] - x[1])
    .map(([k, v]) => `${k}:${v.toFixed(2)}`)
    .join("  ");
}
