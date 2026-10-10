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
2. **Brain tick (Jev, ~every 300 ms and on key events).** One request carries a fan-out of
   questions:
   - *Now*: `tactic` (choice), `aggression` (score), `taunt` (noul), `target_height` (choice)
   - *Contingencies* (speculative, cached): "if the opponent dashes in…", "if you get knocked
     down…", "if the opponent whiffs a heavy…", "if cornered…"
3. **Contingency cache = zero-latency reactions.** When an event fires mid-frame, the reflex
   layer samples from the *already-cached* distribution for that event, so there's no waiting
   on the network. That's the trick that makes a ~100–400 ms model work in a game that runs at 16 ms per frame.
4. **Freshness rule.** Tag every answer with the game tick it was asked at. Drop it if a big
   change (a hit, knockdown or round end) happened after the request was sent. Fall back to
   the last valid answer or a local default.
5. **Player modelling in code.** Track what the human does (block low/high ratio, jump-ins,
   wake-up habits, whiff-punish rate) and feed it as short phrases. Jev then *adapts* ("they
   always block low → overhead"), while code keeps the counting accurate.

### The unpredictability dial
- `temperature` on sampling (sharper = harder and more "correct"; flatter = chaotic).
- Persona text per hero changes the *shape* of the distributions.
- Confidence gating: low confidence → the hero hesitates or feints, which reads as human
  indecision rather than as a bug.
- Difficulty = reaction delay + temperature + how much habit info the brain sees.

## Game shape

**Recommendation: 3D weapon fighter on a 2.5D plane (Tekken / Soul Calibur style).**
Fight along a line with a sidestep axis, using 3D heroes and weapons. That gives the 3D wow
factor without free-roam camera and pathing problems, and the situation stays easy to
describe in words.

- **Heroes**: 2 to start (e.g. axe berserker vs katana duelist). Each has a persona string,
  a weapon class and around 12 moves.
- **Move data (JSON)**: startup/active/recovery frames, hit level (high/mid/low/throw), range,
  damage, on-block advantage. Code converts these to labels like "fast poke", "slow but
  long-range", or "punishable on block", and the labels go to Jev as candidate options.
- **Core RPS**: strike beats throw, throw beats block, block beats strike. Sidestep beats
  linear attacks, and tracking attacks beat sidestep. These are the decisions Jev mixes.

### Stack options
- **Browser: Three.js + Node proxy.** Fastest to iterate on and easy to share. Mixamo /
  Quaternius rigs and animations work out of the box. Collision is custom, but it's only
  capsules and hitboxes on a plane.
- **Godot 4.** Better animation tooling (AnimationTree, hitbox editing) for a long-term
  3D fighter. Call Jev through `HTTPRequest`. Fine for a desktop single-player build, but don't
  ship your key in a public build.

## Milestones
0. **Probe** (`probe.mjs`): measure p50/p95 latency and check the distributions are sane and
   persona-sensitive. *This decides the brain tick rate.*
1. **Grey-box**: two capsules, 6 moves each, hitboxes, health, plus the brain/reflex split
   and the contingency cache. Use a local fallback brain so the game runs when the API is down.
2. **Heroes**: rigged models, weapon movesets, hit sparks and hitstop.
3. **Feel tuning**: temperature, reaction delay, persona text, habit tracking. Test by
   playing it.
4. **Polish**: show the AI's "mind" (a debug overlay with the probability bars). This is a
   great streamer and selling feature.

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
