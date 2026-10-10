// Keyboard controller for a human player (always on the left of the screen,
// so right = toward the opponent).
import { NEUTRAL_INPUT } from "../engine/sim/world.js";

const ATTACK_KEYS = { KeyJ: "light", KeyK: "heavy", KeyL: "low", KeyU: "special", KeyI: "throw" };
const FWD = ["KeyD", "ArrowRight"], BACK = ["KeyA", "ArrowLeft"], DOWN = ["KeyS", "ArrowDown"];
const DOUBLE_TAP_MS = 220;

export class HumanController {
  /** sidestepDir(screen) -> fighter-relative sideDir; screen +1 = into the screen, -1 = toward the camera */
  constructor({ side, sidestepDir }) {
    this.side = side;
    this.sidestepDir = sidestepDir;
    this.keys = new Set();
    this.presses = [];
    this.lastTap = {};
    this.onDown = (e) => {
      if (["Tab", "Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.code)) e.preventDefault();
      if (e.repeat) return;
      this.keys.add(e.code);
      const now = performance.now();
      if (FWD.includes(e.code) || BACK.includes(e.code)) {
        const dir = FWD.includes(e.code) ? "fwd" : "back";
        if (now - (this.lastTap[dir] ?? 0) < DOUBLE_TAP_MS) this.presses.push(dir === "fwd" ? "dash" : "backdash");
        this.lastTap[dir] = now;
      } else this.presses.push(e.code);
    };
    this.onUp = (e) => this.keys.delete(e.code);
    this.onBlur = () => this.keys.clear(); // a key released while unfocused would otherwise stick
    window.addEventListener("keydown", this.onDown);
    window.addEventListener("keyup", this.onUp);
    window.addEventListener("blur", this.onBlur);
  }

  detach() {
    window.removeEventListener("keydown", this.onDown);
    window.removeEventListener("keyup", this.onUp);
    window.removeEventListener("blur", this.onBlur);
  }

  held(codes) { return codes.some((c) => this.keys.has(c)); }

  update() {
    const input = { ...NEUTRAL_INPUT };
    const fwd = this.held(FWD), back = this.held(BACK);
    input.move = fwd && !back ? 1 : back && !fwd ? -1 : 0;
    input.crouch = this.held(DOWN);
    for (const p of this.presses) {
      // Holding forward/back picks a directional variant (fwd_heavy…); the sim falls back to the plain button.
      if (ATTACK_KEYS[p]) input.attack = input.move && ATTACK_KEYS[p] !== "throw" ? `${input.move > 0 ? "fwd" : "back"}_${ATTACK_KEYS[p]}` : ATTACK_KEYS[p];
      else if (p === "KeyW" || p === "ArrowUp") input.sidestep = this.sidestepDir(1);
      else if (p === "KeyQ") input.sidestep = this.sidestepDir(-1);
      else if (p === "Space" || p === "backdash") input.backdash = true;
      else if (p === "dash") input.dash = true;
      else if (p === "KeyT") input.taunt = true;
    }
    this.presses = [];
    // Wake-up: hold an attack button to get up attacking, hold back to roll.
    input.wakeup = this.held(Object.keys(ATTACK_KEYS)) ? "wakeup_attack" : back ? "roll" : "getup_guard";
    return input;
  }

  debugInfo() { return null; }
}
