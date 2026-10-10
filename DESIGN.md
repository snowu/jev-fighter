# Jev Fighter — design notes

## What Jev is (and why it fits)

Jev (`jev-1.13.0`, alias `jev-latest`) is TypeSafe's "System One" model. You give it
**state** (text / JSON) plus **questions**, and it returns typed answers with
calibrated **probabilities**, not prose:

- `choice`: pick one of up to 255 options, with a probability per option
- `score`: position on 2–10 ordered levels
- `noul`: P(yes)

All questions in one request run in parallel. Endpoint: `POST https://api.typesafe.ai/v1/systemone`.
Pricing is $0.042 per million input tokens, and output is free. Limits are 80 req/s, 100K tok/s,
and 64k tokens of context.

A fighting-game AI needs a *mixed strategy*: the probabilities of strike, throw, block and
bait should depend on context. Jev returns exactly that distribution. **Sample from it instead
of taking the argmax**, and you get an opponent that is unpredictable but still sensible.
Because the state is natural language, a persona line ("reckless berserker, gets wilder when
hurt") changes behaviour without any hand-tuned weights.

## Constraints that shape the design

| Jev constraint (from docs) | Consequence |
|---|---|
| A network round trip per call; latency isn't published | Jev can't run per frame (16 ms). Treat it as the *brain*, not the hands. |
| Weak at numbers, counting, math | Code buckets frame data and distances into words ("fast", "punishable", "mid range") and counts the player's habits itself. |
| Accuracy drops with irrelevant state | Send a compact situation summary, never the raw game state. |
| Leans toward the first Choice option | Shuffle option order per request; it costs nothing. |
| Text only | Describe the game in words. No screenshots. |
| Key must stay server-side | Use a tiny proxy (Node), or a desktop build where the key isn't shipped publicly. |

## Architecture: brain + reflexes

```
 game loop (60fps)                       brain loop (event + ~3 Hz)
 ┌──────────────────────┐   situation    ┌──────────────────────────┐
 │ Reflex layer (code)  │ ─────────────► │ Situation describer      │
 │ executes current     │                │ (frame data → words,     │
 │ intent: spacing,     │                │  habit counts → phrases) │
 │ combos, input timing │                └────────────┬─────────────┘
 │                      │                             │ 1 request, fan-out Qs
 │ contingency table ◄──┼── answers + probabilities ◄─┤ Jev (via proxy)
 └──────────────────────┘                             │
```

1. **Reflex layer (deterministic, per frame).** Executes the current intent: walk to range,
   perform the chosen move string, input the combo, block when told to block. Includes
   human-like reaction delays (e.g. 12–20 frames) so it never feels like a frame-perfect bot.
2. **Brain tick (Jev, every 18 frames ≈ 300 ms, plus right after any knockdown, launch or new round).**
   One request carries 8 questions (`public/engine/ai/questions.js`):
   - *Now*: `tactic` (choice of 8 plans), `attack` (choice over the character's own moves,
     described from frame data), `aggression` (score)
   - *Contingencies* (cached): `incoming` (how to react when attacked), `after_blocked`
     (finish the string, throw, guard, sidestep or backdash), `wakeup`, `tech` (noul: ready to
     break throws), `taunt` (noul)
3. **Contingency cache = zero-latency reactions.** When an event fires mid-frame, the reflex
   layer samples from the *already-cached* distribution for that event, so there's no waiting
   on the network. That's the trick that makes a ~250 ms model work in a game that runs at 16 ms per frame.
4. **Freshness rule.** Each plan is tagged with the world `epoch`, which changes on a
   knockdown, the initial launch, a throw break or a new round. A plan asked in an older epoch
   is dropped and an urgent re-think is issued.
5. **Player modelling in code** (`opponentModel.js`). It counts guard choices against my
   attacks, attack levels used, the first action after blocking, wake-up choices, throw
   breaks, string habits and whiffs. These become phrases like "they crouched against 4 of
   your last 5 attacks". Jev adapts to them; code does the counting.
6. **Human-like perception.** The controller sees the opponent through a per-character
   reaction delay (13–16 frames). Slow moves can be *read* (`readSkill`); fast ones must be
   *guessed* from the cached `incoming` distribution. Punishes use exact frame data from the
   delayed view (`punishSkill`); string follow-ups are hit-confirmed (`confirmSkill`).
7. **Local brain** (`brains.js`). Same plan shape, hand-tuned from each character's AI
   profile. It covers fallback, offline play and the headless sim, so the game never depends
   on the API being up.

### The unpredictability dial
- `temperature` on sampling (sharper = harder and more "correct"; flatter = chaotic).
- Persona text per hero changes the *shape* of the distributions.
- Confidence gating: low confidence → the hero hesitates or feints, which reads as human
  indecision rather than as a bug.
- Difficulty = reaction delay + temperature + how much habit info the brain sees.

## Combat system (as built)

A deterministic 60 fps sim (`public/engine/sim/world.js`) on a 3D ground plane. Fighters
always face each other and can circle with sidesteps.

| Defence | Beats | Loses to |
|---|---|---|
| Stand guard (standing still or walking back) | highs, mids | lows, throws |
| Crouch guard | lows; ducks highs and throws | mids |
| Sidestep | straight attacks | tracking attacks |
| Walking forward or dashing | nothing (fast approach) | everything |

- **Frame data per move**: startup, active and recovery frames, hitstun, blockstun, guard
  damage, range, width. Advantage on block = blockstun − (active + recovery). Moves at −10 or
  worse are punishable.
- **Strings**: `cancels: { slot: moveId }`. Input during the move; the follow-up comes out once
  the previous hit connects. Follow-ups combo on hit (2 + startup < hitstun) but leave a gap on
  block. High enders can be ducked, and long gaps can be interrupted.
- **Counter-hits**: hitting during the opponent's startup gives ×1.3 damage and +8 hitstun,
  and some moves launch on counter-hit. **Whiff punishes**: hitting during recovery.
- **Launchers and juggles**: each juggle hit re-lofts the opponent lower, up to 4 hits. Combo
  damage scaling goes 100/90/80/70/60/50%.
- **Hitstop** (4–11 frames) and screen shake give impact. **Input buffer**: 8 frames.
- **Guard gauge** drains on block and slowly regenerates. Empty means a guard break: 45
  frames defenceless.
- **Throws**: break by pressing throw within 20 frames. Throws whiff against crouching or
  sidestepping opponents.
- **Wake-up**: stand up guarding, roll, or a wake-up attack (punishable).

- **Directional moves**: holding forward or back while pressing a button picks a variant
  (`slots.fwd_heavy`, `slots.back_light`…). If the character has no variant, the press falls
  back to the plain button. Each character has 7 starters plus strings.

### Characters and their signatures

Each character has one mechanic that changes how the matchup is played. These are opt-in move
flags and `traits` in the roster file, so new characters can reuse or combine them.

| | Kara, Axe Berserker | Sen, Katana Duelist | Tove, Spear Lancer |
|---|---|---|---|
| Signature | **Armor** (`armor`): Overhead Cleave and Bull Rush absorb one high or mid hit (taking half its damage) and land anyway. Lows and throws go through. **Rage** (`traits.rage`): ×1.2 damage below ⅓ health. | **Parry** (`parry: { riposte }`): Mirror Stance deflects any high or mid hit; the attacker staggers and an auto riposte launches them. Lows and throws beat it, and a whiffed stance is very punishable. | **Tipper** (`tipper`): hitting with the outer ~30% of the reach does ×1.3 damage, +6 hitstun and extra push. Point blank does ×0.75. |
| Body | 110 hp, slow walk, clumsy sidestep, heavy (`juggleFloat` 0.85: falls out of juggles fast) | 95 hp, fastest sidestep and dash | 100 hp, long backdash, light (`juggleFloat` 1.1: floats longer in juggles) |
| Directional moves | →K Bull Rush (armored lunge), ←K Ground Splitter (slow, huge low) | →K Iai Lunge (long-range punisher, i14), ←J Sheathing Cut (hits while stepping back) | →K Long Lunge (2.5 m reach), ←J Retreating Thrust (keep-out) |
| Countered by | lows, throws, and fast jabs after the armor is spent | lows and throws, or simply not attacking | getting in close |

The AI learns these as well. Each fighter's `signature` text is sent to Jev as `your_style`
and `opponent_style`. The *if attacked* question gains `parry` or `armor_through` options when
the move set has them. The opponent model counts "they parried / armored through N of your
attacks". Spot checks against the live model:
- Sen facing a Kara who only swings mids parries 93% of the time.
- Sen facing a Kara who throws a lot crouches 70% of the time instead.
- Tove facing a Sen who keeps parrying picks low attacks 83% of the time.
- Kara facing mid pokes splits between guarding and armoring through.

The reflexes time a parry so its window covers the incoming hit, and turn a read low or throw
into a crouch instead of a parry or armor swing.

**Balance check** (`npm run sim -- --equal-skill --matches 60 --detail`: sides alternate, and
everyone gets the same reflexes):
- Every matchup lands between 47% and 53%, except Sen vs Tove at 63/37. That's an intended
  counter: Sen's parry eats Tove's mid pokes until Tove switches to lows, which is exactly the
  adjustment Jev makes.
- Rounds last 22–52 s, with ~15 hits per round.
- Kara armors ~1 hit and enrages in ~80% of rounds. Tove lands ~3 tippers per round. Sen
  parries ~0.6 times per round against Kara and ~1.2 against Tove.
- `--detail` also prints the top damage sources per side, for spotting a dominant move.

## Status and next steps

Done: probe, grey-box with full combat, three characters with distinct signatures
(armor/rage, parry, tipper) and directional moves, Jev and local brains, AI mind panel,
training mode, headless sim with per-side detail, 17 tests.

Next:
- **Feel pass from real play**: tune walk speeds, pushback, hitstop and AI reaction times
  against a human.
- **More moves**: down + button, and more strings per directional starter (toward ~12 moves each).
- **More signatures** for new characters, e.g. stances, projectiles, a meter-based super, or
  wall interactions.
- **Models**: Quaternius CC0 mannequin and animations with a PS1 pass are in. Next steps:
  - swap the mannequin for [Universal Base Characters](https://quaternius.itch.io/universal-base-characters)
    (same rig, real faces, hair and outfits; free, but a manual itch.io download)
  - more attack clips per character (UAL Pro/Source are paid; Mixamo needs an Adobe login)
  - two-handed grips (IK the off hand onto the weapon)
  - a real arena
- **Jev experiments**: per-round "game plan" questions, confidence-gated hesitation and
  feints, and a temperature slider in the menu.
- **Sharing**: a Cloudflare Worker with static assets plus `/api/brain`, with the key stored
  as a secret and rate limiting. (The EMT widget has the pattern.)

## Probe results (2026-10-10, jev-1.13.0, 20 runs per hero, ~920 input tokens)

| | p50 | p95 | min |
|---|---|---|---|
| berserker | 237 ms | 483 ms | 213 ms |
| duelist | 231 ms | 306 ms | 194 ms |

- About 14 frames typical and up to about 29 frames worst case. A brain update rate of 3–4 Hz
  works. Reactions to events must come from the stored contingency answers.
- Personality strongly changes behaviour in the same situation. Aggression scored 2.82/4 for
  the berserker vs 1.21/4 for the duelist. Berserker tactics: press 0.48 / overhead 0.36 /
  bait 0.15. Duelist tactics: bait 0.63 / block 0.19 / overhead 0.14.
- Some contingency answers are nearly certain (berserker counter-swing 0.93, wake-up attack 0.98),
  so they'd be predictable. Add a probability floor or raise the temperature for reactions.
- Cost is about $0.42/hour at 3 updates/sec.
