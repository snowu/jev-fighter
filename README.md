# Jev Fighter (POC)

A 1v1 3D weapon fighter where the opponent's decisions come from TypeSafe's **Jev**.
Placeholder graphics, real combat: strings, launchers and juggles, counter-hits,
whiff punishes, sidesteps, throws and throw breaks, guard breaks, and frame data.

**Play the prototype:** https://snowu.github.io/jev-fighter/ (static build with the local AI
brain; Jev needs the local server below, because the API key must stay server-side).

## Run

```sh
npm start        # http://localhost:5173 (Jev enabled if ~/.config/typesafe/env has TYPESAFE_API_KEY)
npm test         # combat mechanics tests
npm run sim      # headless AI-vs-AI matches with the local brain (add -- --equal-skill for balance)
npm run sim:jev  # one headless match with Jev driving Kara (uses the API)
```

**Animation lab:** http://localhost:5173/lab.html (also on the Pages site at `/lab.html`).
It shows contact sheets of every state and move for each fighter. Frames that fail a check are
outlined in red, and clicking any frame opens it in a scrubbable 3D viewer. The same checks run
in `npm test` (`tools/anim.test.mjs`):
- **Posture:** upright and not folded, with the hips facing the opponent.
- **Floor:** feet on it and nothing below it.
- **Weapon:**
  - in hand, and held out in front in stances and blocks
  - steady, with no flailing between frames
  - the tip on the hit point at the hit frame
- **Arms:** hands in front of the chest, elbows clear of the torso, and wrists aligned with the weapon.
- **Direction and continuity:**
  - walks travel the right way
  - hits, knockdowns and rolls go away from the opponent
  - no pops between frames
  - hits visibly recoil

**Rig baseline** (`public/game/rig.js`): every grip goes through a measured humanoid rig. At
load it measures, from the model's own bind pose, the arm lengths, each hand's fist centre, the
diagonal line a held shaft takes through the fist, the palm side, and how each finger curls. No
bone-axis conventions are assumed. `holdShaft(arm, point, dir, pole)` puts a fist round a shaft:
- the forearm approaches at a natural angle, so the wrist stays inside a real wrist's range
- the forearm takes the roll, so wrists don't twist like a candy wrapper
- elbows hang and stay off the torso
- the fingers close round the shaft

When a grip is out of reach, the weapon follows the fist, so a hand never lets go. Two-handed
weapons put the off hand on the weapon's final position each frame, sliding along the shaft; in
wide swings it lets go to a fist at the chest. `tools/rig.test.mjs` checks the solver on ~320
random grips per run.

**Swing tuner** (`node tools/tune-swings.mjs [--write] [char.move ...]`): for each attack that
fails the lab checks, it searches its wind-up, arc span, hip turn and step. It keeps the variant
with the fewest failing frames whose strike still lands, never trades in a new kind of failure,
and prefers values close to the current feel. `--write` updates the roster files.

**Known issues** (`tools/anim-known.json`): animation-check failures accepted for now, mostly
wind-up frames of a few swings where these short-armed mannequins can't hold the planned path.
New failures fail `npm test` (and block deploys), and fixed ones must be removed, so the list only
shrinks. Regenerate after a deliberate change with `UPDATE_KNOWN=1 npm test`.

**Deploys:** every push to `main` runs the tests, then `tools/build-pages.mjs`, then publishes to
Pages. The build adds `?v=<commit>` to every module and asset URL, and pages load through a
never-cached `version.json`, so a deploy shows up immediately instead of after GitHub's
10-minute cache.

No build step and no dependencies. three.js loads from a pinned CDN URL. The API key stays
on the server: the page talks to `/api/brain`, and `server.mjs` forwards that to TypeSafe.

## Controls

| Key | Action |
|---|---|
| `A` / `D` | walk back / forward. Standing still or walking back guards high and mid. |
| `S` | crouch: guards lows, ducks highs and throws, but mids hit you |
| `W` / `Q` | sidestep into the screen / toward the camera: dodges straight attacks, not tracking ones |
| `D` `D` | dash in (fast, but you're not guarding) |
| `Space` or `A` `A` | backdash |
| `J` `K` `L` `U` | light, heavy, low, special. Hold `D` or `A` while pressing for a directional move (e.g. `D`+`K`). |
| `I` | throw. Press it right after being grabbed to break the throw. |
| `T` | taunt (you're open to a counter-hit) |
| hold an attack button / hold back while knocked down | wake-up attack / roll |
| `Tab` | move list with frame data · `H` hitboxes · `P` PS1 filter · `M` AI mind panel · `F3` animation lab · `Esc` menu · `R` reset (training) |

**Strings**: press the next button during a move, e.g. Kara `J J K`. A follow-up comes out
once the previous hit connects. It's a true combo on hit, but there's a gap on block that
the defender can duck (high enders) or interrupt.

## Layout

```
public/engine/sim/      deterministic combat: world.js (state machine, hit resolution), moves.js, constants.js
public/engine/roster/   one file per character: frame data, strings, persona, AI profile
public/engine/ai/       perception → Jev questions → brains (Jev / local) → reflex controller
public/game/            browser client: input, three.js renderer, HUD, menu
tools/                  combat tests, headless sim runner
server.mjs              static server + /api/brain proxy
```

**Adding a character**: copy a roster file, change the moves, persona, signature and AI
profile, and register it in `roster/index.js`. Signatures are move flags (`armor`, `parry`,
`tipper`) and `traits` (`rage`), plus optional `movement` and `juggleFloat`. Jev's questions are
built from the move data, so there are no AI code changes.

## Fighters

- **Kara, Axe Berserker**: armored heavy swings shrug off one high or mid hit. She hits harder
  below a third of her health. Beat her with lows and throws.
- **Sen, Katana Duelist**: `U` Mirror Stance parries highs and mids into a launching riposte.
  Lows and throws beat it.
- **Tove, Spear Lancer**: spear tips hit hardest at full reach and weakly point blank. Get in
  close on her.

`Tab` in game shows the full move list with frame data and each fighter's signature.

## Look

Fighters use Quaternius's female mannequin and Universal Animation Library 1 + 2 (all CC0,
in `public/assets/ual/`). The fighters share one body. Each gets its own build, colours, weapon
(axe, katana or spear) and a few low-poly accessories (horned helm, topknot, hood and cloak),
built in `public/game/models.js` and parented to bones. UAL1's clips are pre-converted to JSON
from its Unreal FBX (`tools/convert-ual1.mjs`), because its glTF export uses a different rig.
The game renders with a PS1-style pass: 240p internal resolution, vertex snapping, 15-bit colour
with dithering. `P` toggles it.

Attacks are animated from the sim's own data, not from mocap. Each move has a swing shape
(thrust, slash, backslash, chop, rising, sweep or spin, set in the roster's `look.swings`).
The weapon tip follows a path that passes through the real hit point during the active frames:
the move's reach, or the opponent's body if they're closer, at face, chest or shin height.
Two-bone IK puts both hands on the weapon. The hips and torso coil in the wind-up and unwind
through the hit, the lead foot steps in while the rear foot stays planted, and the weight drops
on impact (`public/game/swing.js`). Each move is tuned by a few numbers in its roster
`look.swings` entry (`windup`, `step`, `drop`, `hips`, `lean`, `span`). Anything left out
defaults from the frame data: heavy moves wind up big, jabs stay compact, and retreating moves
step back. The wind-up takes the
startup, the strike crosses the target inside the active window, and the follow-through and
return fill the recovery. Stance, movement, hit reactions, knockdowns and throws still use
clips. If models fail to load, the old capsules come back.

See [DESIGN.md](DESIGN.md) for how the AI uses Jev.
