// Roster registry. Adding a character = add a file with the same shape and list it here.
import { ATTACK_SLOTS, DIRECTIONS, baseSlot } from "../sim/moves.js";
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
    if (!char.slots[slot]) throw new Error(`${char.id} has no move on "${slot}"`);
  }
  for (const [slot, id] of Object.entries(char.slots)) {
    const [dir] = slot.split("_");
    if (!ATTACK_SLOTS.includes(baseSlot(slot)) || (slot.includes("_") && !DIRECTIONS.includes(dir))) throw new Error(`${char.id} has an unknown slot "${slot}"`);
    if (!char.moves[id]) throw new Error(`${char.id} slot "${slot}" points to a missing move`);
  }
  for (const [id, m] of Object.entries(char.moves)) {
    if (m.parry && !char.moves[m.parry.riposte]) throw new Error(`${char.id}.${id} parries into unknown move "${m.parry.riposte}"`);
  }
  return char;
}

export const ROSTER = Object.fromEntries([kara, sen, tove].map((c) => [c.id, finalize(c)]));
export const getCharacter = (id) => ROSTER[id] ?? ROSTER.kara;
