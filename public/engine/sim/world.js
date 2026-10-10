// Deterministic combat simulation. No rendering, no randomness, no AI: it advances
// one frame from two input objects and reports what happened as events.
//
// Combat rules (the RPS the AI has to read):
//   stand guard  blocks high + mid            | loses to low, throw
//   crouch guard blocks low, ducks high/throw | loses to mid
//   sidestep     dodges straight attacks      | loses to tracking attacks
//   hitting during the opponent's startup = counter-hit (more damage, more stun, some moves launch)
//   hitting during the opponent's recovery = whiff punish
//   strings: press the next button during a move; it comes out once the move connects.
//     Natural combo on hit, but a gap on block the opponent can duck or interrupt.
//   launchers send the opponent airborne for a juggle; damage scales down per combo hit
//   blocking drains the guard gauge; empty gauge = guard break (defenceless)
//   throws can be broken by pressing throw within the tech window
//
// Input (per fighter per frame), directions are relative to the opponent:
//   { move: -1|0|1, crouch, attack: slot|null, sidestep: -1|0|1, dash, backdash, taunt, wakeup }

import * as C from "./constants.js";
import { totalFrames } from "./moves.js";

export const NEUTRAL_INPUT = Object.freeze({ move: 0, crouch: false, attack: null, sidestep: 0, dash: false, backdash: false, taunt: false, wakeup: "getup_guard" });

const TIMED_STATES = new Set(["blockstun", "hitstun", "guardbreak", "techstun", "taunt", "sidestep", "dash", "backdash", "roll"]);
const STRIKE_IMMUNE = new Set(["knockdown", "ko", "grabbed", "grabbing"]);
const UNTHROWABLE = new Set(["sidestep", "hitstun", "blockstun", "techstun", "backdash", "juggle", "roll"]);

export function createFighter(char, side) {
  return {
    side, char,
    hp: char.hp, guard: C.GUARD_MAX,
    x: 0, z: 0, facing: 0,
    state: "idle", frame: 0, duration: 0,
    move: null, attackDir: 0, contact: null, contactFrame: 0, ducked: false, chainSlot: null, chained: false,
    crouch: false, walking: 0, sideDir: 0,
    buffer: null, techPressed: false,
    combo: 0, comboDamage: 0, juggleHits: 0,
  };
}

export function createWorld(charA, charB, { roundFrames = C.ROUND_FRAMES } = {}) {
  const world = {
    frame: 0, round: 1, wins: [0, 0],
    phase: "intro", phaseFrame: 0, roundLength: roundFrames, roundFrames,
    hitstop: 0, epoch: 0, roundWinner: null, matchWinner: null,
    fighters: [createFighter(charA, 0), createFighter(charB, 1)],
    events: [],
  };
  resetRound(world);
  return world;
}

export function resetRound(world) {
  const [a, b] = world.fighters;
  for (const [f, x] of [[a, -C.START_DISTANCE / 2], [b, C.START_DISTANCE / 2]]) {
    Object.assign(f, {
      hp: f.char.hp, guard: C.GUARD_MAX, x, z: 0, state: "idle", frame: 0, duration: 0, move: null,
      crouch: false, walking: 0, buffer: null, chainSlot: null, techPressed: false, combo: 0, comboDamage: 0, juggleHits: 0,
    });
  }
  a.facing = 0;
  b.facing = Math.PI;
  world.phase = "intro";
  world.phaseFrame = 0;
  world.roundFrames = world.roundLength;
  world.hitstop = 0;
  world.roundWinner = null;
  world.epoch++;
}

// ---------------------------------------------------------------------------

export const angleTo = (f, o) => Math.atan2(o.z - f.z, o.x - f.x);
export const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

export function isCrouching(f) {
  if (f.state === "attack") return f.move.level === "low";
  return (f.state === "idle" || f.state === "blockstun") && f.crouch;
}

export function isGuarding(f) {
  return (f.state === "idle" && f.walking <= 0) || f.state === "blockstun";
}

export function attackPhase(f) {
  if (f.state !== "attack") return null;
  const m = f.move;
  if (f.frame < m.startup) return "startup";
  if (f.frame < m.startup + m.active) return "active";
  return "recovery";
}

/** Frames until this fighter can act again (0 if actionable). */
export function framesUntilActionable(f) {
  if (f.state === "idle") return 0;
  if (f.state === "attack") return totalFrames(f.move) - f.frame;
  if (f.state === "knockdown") return C.KNOCKDOWN_FRAMES - f.frame;
  if (f.state === "juggle") return f.duration - f.frame + C.JUGGLE_LANDING_KNOCKDOWN;
  if (f.state === "grabbing" || f.state === "grabbed") return C.THROW_FRAMES - f.frame;
  return Math.max(0, f.duration - f.frame);
}

function setState(f, state, duration = 0) {
  f.state = state;
  f.frame = 0;
  f.duration = duration;
  if (state !== "attack") { f.move = null; f.chainSlot = null; }
  if (state !== "idle") f.walking = 0;
  if (state === "idle" || state === "blockstun" || state === "knockdown") { f.combo = 0; f.comboDamage = 0; f.juggleHits = 0; }
}

function moveBy(f, angle, dist) {
  f.x += Math.cos(angle) * dist;
  f.z += Math.sin(angle) * dist;
}

// ---------------------------------------------------------------------------

export function step(world, inputs) {
  world.events = [];
  world.frame++;
  const [a, b] = world.fighters;
  const emit = (e) => world.events.push({ frame: world.frame, ...e });

  if (world.phase === "over") return world;

  if (world.phase === "intro") {
    world.phaseFrame++;
    a.facing = angleTo(a, b);
    b.facing = angleTo(b, a);
    if (world.phaseFrame >= C.INTRO_FRAMES) {
      world.phase = "fight";
      world.phaseFrame = 0;
      emit({ type: "round_start", round: world.round });
    }
    return world;
  }

  const live = world.phase === "fight";
  const inA = live ? inputs[0] ?? NEUTRAL_INPUT : NEUTRAL_INPUT;
  const inB = live ? inputs[1] ?? NEUTRAL_INPUT : NEUTRAL_INPUT;
  registerInput(a, inA);
  registerInput(b, inB);

  // Hitstop: the world freezes but button presses still register (for strings and buffers).
  if (world.hitstop > 0) { world.hitstop--; return world; }
  world.phaseFrame++;

  updateFighter(world, a, b, inA, emit);
  updateFighter(world, b, a, inB, emit);

  // Collect contacts from both sides before applying, so simultaneous hits trade.
  const contacts = [checkContact(a, b, emit), checkContact(b, a, emit)].filter(Boolean);
  for (const c of contacts) applyContact(world, c, emit);

  separate(a, b);
  for (const f of world.fighters) {
    const r = Math.hypot(f.x, f.z);
    if (r > C.ARENA_RADIUS) { f.x *= C.ARENA_RADIUS / r; f.z *= C.ARENA_RADIUS / r; }
    if (f.state !== "blockstun") f.guard = Math.min(C.GUARD_MAX, f.guard + C.GUARD_REGEN);
  }

  if (world.phase === "fight") {
    world.roundFrames--;
    checkRoundEnd(world, emit);
  } else if (world.phase === "ko" && world.phaseFrame >= C.KO_FRAMES) {
    if (Math.max(...world.wins) >= C.ROUNDS_TO_WIN) {
      world.phase = "over";
      const [wa, wb] = world.wins;
      world.matchWinner = wa === wb ? -1 : wa > wb ? 0 : 1;
      emit({ type: "match_end", winner: world.matchWinner });
    } else {
      world.round++;
      resetRound(world);
    }
  }
  return world;
}

function checkRoundEnd(world, emit) {
  const [a, b] = world.fighters;
  const aDead = a.hp <= 0, bDead = b.hp <= 0;
  let winner = null;
  if (aDead || bDead) winner = aDead && bDead ? -1 : aDead ? 1 : 0;
  else if (world.roundFrames <= 0) {
    const ra = a.hp / a.char.hp, rb = b.hp / b.char.hp;
    winner = Math.abs(ra - rb) < 1e-9 ? -1 : ra > rb ? 0 : 1;
  }
  if (winner === null) return;
  if (winner === -1) { world.wins[0]++; world.wins[1]++; } else world.wins[winner]++;
  world.phase = "ko";
  world.phaseFrame = 0;
  world.roundWinner = winner;
  world.epoch++;
  if (aDead || bDead) world.hitstop = C.HITSTOP.ko;
  emit({ type: "round_end", winner, timeout: !(aDead || bDead), wins: [...world.wins] });
}

function registerInput(f, inp) {
  if (inp.attack) {
    if (f.state === "attack") {
      f.chainSlot = inp.attack; // string follow-up
      f.buffer = { kind: "attack", value: inp.attack, ttl: C.INPUT_BUFFER }; // or next move if pressed late in recovery
    } else if (f.state === "grabbed") { if (inp.attack === "throw") f.techPressed = true; }
    else f.buffer = { kind: "attack", value: inp.attack, ttl: C.INPUT_BUFFER };
  } else if (inp.sidestep) f.buffer = { kind: "sidestep", value: inp.sidestep, ttl: C.INPUT_BUFFER };
  else if (inp.dash) f.buffer = { kind: "dash", ttl: C.INPUT_BUFFER };
  else if (inp.backdash) f.buffer = { kind: "backdash", ttl: C.INPUT_BUFFER };
  else if (inp.taunt) f.buffer = { kind: "taunt", ttl: C.INPUT_BUFFER };
}

function updateFighter(world, f, o, inp, emit) {
  if (f.buffer && --f.buffer.ttl < 0) f.buffer = null;
  f.frame++;

  switch (f.state) {
    case "idle": {
      f.facing = angleTo(f, o);
      f.crouch = !!inp.crouch;
      if (f.buffer) {
        const buf = f.buffer;
        f.buffer = null;
        if (buf.kind === "attack") return startAttack(f, o, f.char.slots[buf.value], emit);
        f.crouch = false;
        if (buf.kind === "sidestep") { setState(f, "sidestep", C.SIDESTEP.frames); f.sideDir = buf.value; return emit({ type: "sidestep", who: f.side }); }
        if (buf.kind === "dash") { setState(f, "dash", C.DASH.frames); return emit({ type: "dash", who: f.side }); }
        if (buf.kind === "backdash") { setState(f, "backdash", C.BACKDASH.frames); return emit({ type: "backdash", who: f.side }); }
        if (buf.kind === "taunt") { setState(f, "taunt", C.TAUNT_FRAMES); return emit({ type: "taunt", who: f.side }); }
      }
      f.walking = f.crouch ? 0 : inp.move || 0;
      if (f.walking) {
        const speed = f.walking > 0 ? f.char.walkForward : f.char.walkBack;
        if (f.walking < 0 || distance(f, o) > C.MIN_SEPARATION + 0.05) moveBy(f, f.facing, f.walking * speed * C.DT);
      }
      return;
    }

    case "attack": {
      const m = f.move;
      // String follow-up: input any time during the move, comes out once it has connected.
      const next = f.chainSlot && f.contact && f.contact !== "grab" ? m.cancels?.[f.chainSlot] : null;
      if (next && f.frame >= f.contactFrame + C.CANCEL_DELAY && f.frame <= m.startup + m.active + C.CANCEL_LATE) {
        return startAttack(f, o, next, emit, true);
      }
      if (f.frame < m.startup) {
        if (m.tracking) f.attackDir = angleTo(f, o);
        if (m.advance) moveBy(f, f.attackDir, m.advance / m.startup);
      }
      f.facing = f.attackDir;
      if (f.frame >= totalFrames(m)) {
        if (!f.contact) emit({ type: "whiff", who: f.side, move: m.id, level: m.level, ducked: f.ducked, evadedBy: o.state });
        setState(f, "idle");
      }
      return;
    }

    case "blockstun":
      f.crouch = !!inp.crouch; // you may switch guard height while blocking (to duck a high string ender)
      break;

    case "sidestep":
      f.facing = angleTo(f, o);
      moveBy(f, f.facing + f.sideDir * Math.PI / 2, C.SIDESTEP.distance / C.SIDESTEP.frames);
      break;

    case "dash":
      f.facing = angleTo(f, o);
      if (distance(f, o) > C.MIN_SEPARATION + 0.1) moveBy(f, f.facing, C.DASH.distance / C.DASH.frames);
      break;

    case "backdash":
      f.facing = angleTo(f, o);
      moveBy(f, f.facing + Math.PI, C.BACKDASH.distance / C.BACKDASH.frames);
      break;

    case "roll":
      f.facing = angleTo(f, o);
      moveBy(f, f.facing + Math.PI - f.sideDir * Math.PI / 3, C.ROLL.distance / C.ROLL.frames);
      break;

    case "juggle":
      if (f.frame >= f.duration) {
        setState(f, "knockdown");
        f.frame = C.KNOCKDOWN_FRAMES - C.JUGGLE_LANDING_KNOCKDOWN;
        world.epoch++;
        emit({ type: "knockdown", who: f.side, by: o.side, fromJuggle: true });
      }
      return;

    case "knockdown":
      if (f.frame >= C.KNOCKDOWN_FRAMES) {
        const choice = inp.wakeup || "getup_guard";
        emit({ type: "wakeup", who: f.side, choice });
        f.facing = angleTo(f, o);
        if (choice === "roll") { setState(f, "roll", C.ROLL.frames); f.sideDir = world.frame % 2 ? 1 : -1; }
        else if (choice === "wakeup_attack") startAttack(f, o, "wakeup", emit);
        else { setState(f, "idle"); f.crouch = false; }
      }
      return;

    case "grabbed":
      if (f.techPressed && f.frame <= C.THROW_TECH_WINDOW) {
        setState(f, "techstun", C.TECH_STUN);
        setState(o, "techstun", C.TECH_STUN);
        moveBy(f, angleTo(o, f), 0.5);
        moveBy(o, angleTo(f, o), 0.5);
        f.techPressed = false;
        world.epoch++;
        world.hitstop = C.HITSTOP.block;
        return emit({ type: "tech", who: f.side, attacker: o.side });
      }
      return;

    case "grabbing":
      if (f.frame >= C.THROW_FRAMES) {
        const dmg = f.char.moves[f.char.slots.throw].damage;
        o.hp = Math.max(0, o.hp - dmg);
        emit({ type: "throw", who: f.side, target: o.side, damage: dmg });
        setState(f, "idle");
        world.hitstop = C.HITSTOP.hit;
        if (o.hp <= 0) setState(o, "ko");
        else { setState(o, "knockdown"); world.epoch++; emit({ type: "knockdown", who: o.side, by: f.side }); }
      }
      return;
  }

  if (TIMED_STATES.has(f.state) && f.frame >= f.duration) {
    if (f.state !== "blockstun") f.crouch = false;
    setState(f, "idle");
  }
}

function startAttack(f, o, moveId, emit, chained = false) {
  const m = f.char.moves[moveId];
  if (!m) return;
  setState(f, "attack");
  f.move = m;
  f.attackDir = angleTo(f, o);
  f.facing = f.attackDir;
  if (chained) moveBy(f, f.attackDir, Math.min(C.CHAIN_STEP, Math.max(0, distance(f, o) - C.MIN_SEPARATION)));
  f.contact = null;
  f.ducked = false;
  f.chained = chained;
  f.chainSlot = null;
  f.buffer = null;
  f.crouch = m.level === "low";
  emit({ type: "attack_start", who: f.side, move: m.id, level: m.level, chained });
}

function checkContact(a, d, emit) {
  if (attackPhase(a) !== "active" || a.contact) return null;
  if (STRIKE_IMMUNE.has(d.state)) return null;
  if (d.state === "roll" && d.frame < 18) return null;

  const m = a.move;
  const dx = d.x - a.x, dz = d.z - a.z;
  const cos = Math.cos(a.attackDir), sin = Math.sin(a.attackDir);
  const along = dx * cos + dz * sin;
  const lateral = Math.abs(dx * sin - dz * cos);
  if (along < -C.BODY_RADIUS || along > m.range + C.BODY_RADIUS || lateral > m.width / 2 + C.BODY_RADIUS) return null;

  if (m.level === "throw") {
    if (isCrouching(d) || UNTHROWABLE.has(d.state)) return null;
    return { kind: "grab", a, d, m };
  }
  if (d.state === "juggle") return { kind: "hit", a, d, m, counter: false };
  if (m.level === "high" && isCrouching(d)) {
    if (!a.ducked) { a.ducked = true; emit({ type: "duck", who: d.side, attacker: a.side, move: m.id }); }
    return null;
  }
  const blocked = isGuarding(d) && (m.level === "low" ? isCrouching(d) : !isCrouching(d));
  const counter = (d.state === "attack" && d.frame < d.move.startup) || d.state === "taunt";
  return { kind: blocked ? "block" : "hit", a, d, m, counter };
}

function applyContact(world, { kind, a, d, m, counter }, emit) {
  a.contact = kind;
  a.contactFrame = a.frame;
  const attackerLeft = totalFrames(m) - a.frame;

  if (kind === "grab") {
    setState(a, "grabbing");
    const preTech = d.buffer?.kind === "attack" && d.buffer.value === "throw";
    setState(d, "grabbed");
    d.techPressed = preTech;
    d.crouch = false;
    return emit({ type: "grab", who: a.side, target: d.side, move: m.id });
  }

  if (kind === "block") {
    setState(d, "blockstun", m.blockstun);
    moveBy(d, a.attackDir, C.PUSH_ON_BLOCK);
    d.guard -= m.guardDamage ?? 10;
    world.hitstop = Math.max(world.hitstop, C.HITSTOP.block);
    emit({ type: "block", who: a.side, target: d.side, move: m.id, level: m.level, crouching: d.crouch, advantage: m.blockstun - attackerLeft });
    if (d.guard <= 0) {
      d.guard = C.GUARD_RESET_AFTER_BREAK;
      setState(d, "guardbreak", C.GUARDBREAK_FRAMES);
      d.crouch = false;
      emit({ type: "guardbreak", who: d.side, by: a.side });
    }
    return;
  }

  const wasJuggled = d.state === "juggle";
  const punish = d.state === "attack" && attackPhase(d) === "recovery";
  const combo = d.state === "hitstun" || wasJuggled ? d.combo + 1 : 1;
  const scale = C.COMBO_SCALING[Math.min(combo - 1, C.COMBO_SCALING.length - 1)];
  const damage = Math.max(1, Math.round(m.damage * scale * (counter ? C.COUNTER_DAMAGE : 1)));
  const comboDamage = (combo > 1 ? d.comboDamage : 0) + damage;
  const juggleHits = wasJuggled ? d.juggleHits + 1 : 0;

  d.hp = Math.max(0, d.hp - damage);
  d.crouch = false;

  let result;
  if (d.hp <= 0) { setState(d, "ko"); result = "ko"; }
  else if (wasJuggled && (juggleHits >= C.JUGGLE_MAX_HITS || m.knockdown)) {
    setState(d, "knockdown");
    d.frame = C.KNOCKDOWN_FRAMES - C.JUGGLE_LANDING_KNOCKDOWN;
    result = "knockdown";
  } else if (wasJuggled || m.launch || (counter && m.launchOnCounter)) {
    const dur = wasJuggled ? Math.max(C.JUGGLE_MIN_FRAMES, Math.round(C.JUGGLE_FRAMES * C.JUGGLE_DECAY ** juggleHits)) : C.JUGGLE_FRAMES;
    setState(d, "juggle", dur);
    result = "launch";
  } else if (m.knockdown) { setState(d, "knockdown"); result = "knockdown"; }
  else { setState(d, "hitstun", m.hitstun + (counter ? C.COUNTER_HITSTUN : 0)); result = "hitstun"; }

  // Launches pop the opponent up in place so the juggle is reachable.
  moveBy(d, a.attackDir, result === "launch" ? (wasJuggled ? 0.1 : 0) : C.PUSH_ON_HIT);
  d.combo = combo;
  d.comboDamage = comboDamage;
  d.juggleHits = juggleHits;
  world.hitstop = Math.max(world.hitstop, counter ? C.HITSTOP.counter : wasJuggled ? C.HITSTOP.juggle : C.HITSTOP.hit);
  if (result === "knockdown" || result === "launch") world.epoch++;

  emit({
    type: "hit", who: a.side, target: d.side, move: m.id, level: m.level, damage,
    counter, punish, combo, comboDamage, result,
    advantage: result === "hitstun" ? d.duration - attackerLeft : null,
  });
  if (result === "knockdown") emit({ type: "knockdown", who: d.side, by: a.side });
}

function separate(a, b) {
  const d = distance(a, b);
  if (d >= C.MIN_SEPARATION) return;
  const ang = d > 1e-6 ? angleTo(a, b) : a.facing;
  const push = (C.MIN_SEPARATION - d) / 2;
  moveBy(a, ang + Math.PI, push);
  moveBy(b, ang, push);
}

/** Small copy of a fighter for AI perception history. */
export function snapshot(f) {
  return {
    side: f.side, state: f.state, frame: f.frame, duration: f.duration,
    moveId: f.move?.id ?? null, level: f.move?.level ?? null,
    phase: attackPhase(f), crouching: isCrouching(f), guarding: isGuarding(f),
    walking: f.walking, x: f.x, z: f.z, hp: f.hp, guard: f.guard,
    actionableIn: framesUntilActionable(f),
  };
}
