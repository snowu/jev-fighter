// Roster registry. Adding a character = add a file with the same shape and list it here.
import { ATTACK_SLOTS } from "../sim/moves.js";
import { DEFAULT_WAKEUP_MOVE } from "../sim/constants.js";
import kara from "./kara.js";
import sen from "./sen.js";
import tove from "./tove.js";

function finalize(char) {
  char.moves.wakeup = { ...DEFAULT_WAKEUP_MOVE, ...(char.moves.wakeup ?? {}) };
  for (const [id, m] of Object.entries(char.moves)) {
    m.id = id;
    for (const next of Object.values(m.cancels ?? {})) {
      if (!char.moves[next]) throw new Error(`${char.id}.${id} cancels into unknown move "${next}"`);
    }
  }
  for (const slot of ATTACK_SLOTS) {
    if (!char.moves[char.slots[slot]]) throw new Error(`${char.id} slot "${slot}" points to a missing move`);
  }
  return char;
}

export const ROSTER = Object.fromEntries([kara, sen, tove].map((c) => [c.id, finalize(c)]));
export const getCharacter = (id) => ROSTER[id] ?? ROSTER.kara;
