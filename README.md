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
| `J` `K` `L` `U` | light, heavy, low, special |
| `I` | throw. Press it right after being grabbed to break the throw. |
| `T` | taunt (you're open to a counter-hit) |
| hold an attack button / hold back while knocked down | wake-up attack / roll |
| `Tab` | move list with frame data · `H` hitboxes · `M` AI mind panel · `Esc` menu · `R` reset (training) |

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

**Adding a character**: copy a roster file, change the moves, persona and AI profile, and
register it in `roster/index.js`. Jev's questions are built from the move data, so no AI code changes.

See [DESIGN.md](DESIGN.md) for how the AI uses Jev.
