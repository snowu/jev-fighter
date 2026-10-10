// Global combat tuning. Distances are metres on the ground plane (x, z); time is frames at 60 fps.

export const FPS = 60;
export const DT = 1 / FPS;

export const ARENA_RADIUS = 6;
export const BODY_RADIUS = 0.3;
export const MIN_SEPARATION = 0.7;
export const START_DISTANCE = 3.2;

export const ROUND_FRAMES = 60 * FPS;
export const ROUNDS_TO_WIN = 2;
export const INTRO_FRAMES = 60;
export const KO_FRAMES = 100;

export const GUARD_MAX = 100;
export const GUARD_REGEN = 0.12; // per frame while not in blockstun
export const GUARD_RESET_AFTER_BREAK = 50;
export const GUARDBREAK_FRAMES = 45;

export const COUNTER_DAMAGE = 1.3;
export const COUNTER_HITSTUN = 8;
export const PUSH_ON_HIT = 0.25;
export const CHAIN_STEP = 0.25; // string follow-ups step in to stay in range
export const PUSH_ON_BLOCK = 0.3;

export const KNOCKDOWN_FRAMES = 50;
export const THROW_FRAMES = 40;
export const THROW_TECH_WINDOW = 20;
export const TECH_STUN = 16;
export const TAUNT_FRAMES = 45;

export const SIDESTEP = { frames: 20, distance: 1.3 };
export const BACKDASH = { frames: 16, distance: 1.5 };
export const DASH = { frames: 14, distance: 1.3 }; // forward dash: fast approach, but not guarding
export const ROLL = { frames: 24, distance: 1.8 };
export const INPUT_BUFFER = 8;

// Shared by every character unless their roster entry overrides it.
export const DEFAULT_WAKEUP_MOVE = {
  id: "wakeup",
  name: "Rising Strike",
  level: "mid",
  startup: 14,
  active: 3,
  recovery: 22,
  damage: 9,
  range: 1.4,
  width: 0.6,
  hitstun: 18,
  blockstun: 10,
  guardDamage: 10,
};

// Feel: freeze both fighters briefly on impact so hits land with weight.
export const HITSTOP = { hit: 7, counter: 11, block: 4, juggle: 5, ko: 24 };

// Strings: a follow-up can come out from CANCEL_DELAY frames after contact until
// CANCEL_LATE frames after the active window. Follow-ups combo when
// CANCEL_DELAY + followUp.startup < the hitstun the previous hit caused.
export const CANCEL_DELAY = 2;
export const CANCEL_LATE = 8;

// Juggles: launchers send the opponent airborne; each extra hit re-lofts them lower.
export const JUGGLE_FRAMES = 44;
export const JUGGLE_DECAY = 0.75;
export const JUGGLE_MIN_FRAMES = 16;
export const JUGGLE_MAX_HITS = 4;
export const JUGGLE_LANDING_KNOCKDOWN = 34;

// Damage multiplier for the nth hit of a combo.
export const COMBO_SCALING = [1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.45];

// ---- Character signatures (each roster entry opts in through move flags or `traits`) ----

// Armor (move flag `armor`): during startup and active frames the move absorbs one high or mid
// hit, taking part of its damage without flinching. Lows and throws go through it.
export const ARMOR_DAMAGE = 0.5;

// Parry (move flag `parry: { riposte }`): during its active frames a high or mid strike is
// deflected; the attacker staggers and the parrier answers with the riposte move.
// Lows and throws beat it, and a whiffed parry has long recovery.
export const PARRY_STAGGER_EXTRA = 14; // stagger lasts riposte startup + active + this

// Tipper (move flag `tipper`): connecting with the outer part of the reach hits harder and
// pushes further; connecting point blank is weak. Rewards spacing.
export const TIPPER = { from: 0.72, damage: 1.3, hitstun: 6, push: 0.45, sourWithin: 0.85, sourDamage: 0.75 };
