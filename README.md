# Jev Fighter (POC)

A 1v1 3D weapon fighter where the opponent's decisions come from TypeSafe's **Jev**.
Placeholder graphics, real combat: strings, launchers and juggles, counter-hits,
whiff punishes, sidesteps, throws and throw breaks, guard breaks, and frame data.

## Run

```sh
npm start        # http://localhost:5173 (Jev enabled if ~/.config/typesafe/env has TYPESAFE_API_KEY)
npm test         # combat mechanics tests
npm run sim      # headless AI-vs-AI matches with the local brain (add -- --equal-skill for balance)
npm run sim:jev  # one headless match with Jev driving Kara (uses the API)
```

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
| `Tab` | move list with frame data · `H` hitboxes · `P` PS1 filter · `M` AI mind panel · `Esc` menu · `R` reset (training) |

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

Characters are rigged low-poly models from [KayKit Adventurers](https://kaylousberg.itch.io/kaykit-adventurers)
by Kay Lousberg (CC0, in `public/assets/kaykit/`). Kara is the Barbarian, Sen is the Knight
without a helmet, and Tove is the Hooded Rogue with a spear built in code. The game renders with
a PS1-style pass: 240p internal resolution, vertex snapping, 15-bit colour with dithering. `P`
toggles it.

Animations follow the sim, not the other way round. Each attack clip is time-warped so its
moment of impact lands on the move's first active frame, which makes startup look exactly as
long as it is. Clip choices live in each roster file's `look.moves`, and impact times in
`public/game/models.js`. If models fail to load, the old capsules come back.

See [DESIGN.md](DESIGN.md) for how the AI uses Jev.
