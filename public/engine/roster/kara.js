export default {
  id: "kara",
  name: "Kara",
  title: "Axe Berserker",
  color: 0xd9472b,
  weapon: "two-handed axe: slow heavy swings with long reach, weak up close",
  persona:
    "Kara, a reckless axe berserker. Loves trading hits and hates backing off. Gets wilder and more reckless as she gets hurt. Rarely sidesteps.",
  signature:
    "Armor and rage: her heavy swings shrug off one high or mid hit and keep going (low attacks and throws stop them), and below a third of her health she hits much harder. Heavy and slow on her feet, falls quickly out of juggles.",
  // Renderer-only: silhouette and weapon shape (the sim never reads this).
  // Renderer-only: silhouette, colours, weapon and clip per move (the sim never reads this).
  look: {
    build: [1.12, 1.04], trim: 0x3b2618, accent: 0x4a4f57, weapon: "axe", weaponLength: 1.25,
    parts: ["horned_helm", "fur_mantle"],
    // Procedural swing shape per move (public/game/swing.js); moves without one (throws) use clips.
    swings: {
      jab: "thrust", jab2: "thrust", finisher: "slash", overhead: "chop", shin: "sweep", lift: "rising",
      whirlwind: "spin", bullrush: "thrust", splitter: "chop", wakeup: "slash",
    },
    moves: { headbutt: "Melee_Hook" }, // clip-driven moves (throws)
  },

  hp: 110,
  walkForward: 2.3,
  walkBack: 1.5,
  juggleFloat: 0.85,
  movement: { sidestep: { frames: 24, distance: 1.1 }, backdash: { frames: 20, distance: 1.3 }, dash: { frames: 16, distance: 1.5 } },
  traits: { rage: { below: 0.33, damage: 1.2 } },
  slots: { light: "jab", heavy: "overhead", low: "shin", special: "whirlwind", throw: "headbutt", fwd_heavy: "bullrush", back_heavy: "splitter" },
  moves: {
    jab: { name: "Haft Jab", level: "high", startup: 10, active: 3, recovery: 14, damage: 7, range: 1.35, width: 0.5, hitstun: 18, blockstun: 13, guardDamage: 8, cancels: { light: "jab2", heavy: "finisher" } },
    jab2: { name: "Haft Jab 2", level: "high", startup: 12, active: 3, recovery: 16, damage: 6, range: 1.3, width: 0.5, hitstun: 20, blockstun: 12, guardDamage: 8, cancels: { heavy: "finisher" } },
    finisher: { name: "Axe Finisher", level: "mid", startup: 16, active: 4, recovery: 24, damage: 14, range: 1.6, width: 0.5, knockdown: true, hitstun: 0, blockstun: 14, guardDamage: 22 },
    overhead: { name: "Overhead Cleave", level: "mid", armor: true, startup: 22, active: 4, recovery: 26, damage: 20, range: 1.9, width: 0.5, knockdown: true, hitstun: 0, blockstun: 14, guardDamage: 35 },
    shin: { name: "Shin Chop", level: "low", startup: 16, active: 3, recovery: 20, damage: 11, range: 1.7, width: 0.5, hitstun: 22, blockstun: 10, guardDamage: 12, cancels: { heavy: "lift" } },
    lift: { name: "Haft Lift", level: "mid", startup: 14, active: 3, recovery: 22, damage: 9, range: 1.5, width: 0.5, launch: true, hitstun: 0, blockstun: 12, guardDamage: 14 },
    whirlwind: { name: "Whirlwind", level: "mid", tracking: true, startup: 18, active: 6, recovery: 24, damage: 16, range: 1.6, width: 1.4, launchOnCounter: true, hitstun: 24, blockstun: 16, guardDamage: 25 },
    bullrush: { name: "Bull Rush", level: "mid", armor: true, startup: 22, active: 4, recovery: 28, damage: 12, range: 1.1, advance: 1.8, width: 0.7, hitstun: 26, blockstun: 14, guardDamage: 25 },
    splitter: { name: "Ground Splitter", level: "low", startup: 26, active: 4, recovery: 30, damage: 20, range: 2.0, width: 0.9, knockdown: true, hitstun: 0, blockstun: 12, guardDamage: 30 },
    headbutt: { name: "Headbutt Grab", level: "throw", startup: 10, active: 2, recovery: 24, damage: 18, range: 0.95, width: 0.6 },
  },
  ai: {
    reactionFrames: 16,
    readSkill: 0.45,
    confirmSkill: 0.6,
    punishSkill: 0.65,
    temperature: 1.15,
    floor: 0.1,
    // Fallback brain biases (used before the first Jev answer, offline, and in headless tests).
    local: {
      aggression: 0.75,
      tactics: { pressure: 4, poke: 1, bait: 0.5, throw_rush: 1.5, turtle: 0.3, circle: 0.2, retreat: 0.2 },
      incoming: { stand_guard: 2, crouch_guard: 1, sidestep: 0.3, backdash: 0.3, counter_attack: 1.5, armor_through: 1.5 },
      afterBlocked: { keep_attacking: 3, throw: 1.5, guard: 1, sidestep: 0.2, backdash: 0.3 },
      wakeup: { getup_guard: 1, roll: 0.5, wakeup_attack: 2.5 },
      tech: 0.35,
      taunt: 0.5,
    },
  },
};
