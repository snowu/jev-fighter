export default {
  id: "tove",
  name: "Tove",
  title: "Spear Lancer",
  color: 0x2fa36b,
  weapon: "long spear: pokes from far away, clumsy when the opponent gets close",
  persona:
    "Tove, a nervous spear lancer. Keeps the opponent at the tip of her spear and hates being close. Panics and gets jumpy when cornered or rushed.",
  signature:
    "Spacing: her spear hits hardest with the tip at full reach and stuns longer there, but hits weakly point blank. Longest reach in the roster, a long backdash and a retreating thrust to keep people out; light, so she floats long in juggles.",
  look: {
    build: [0.94, 1.05], trim: 0x6b5233, accent: 0x1d4634, weapon: "spear", weaponLength: 2.2,
    parts: ["hood", "cloak"],
    swings: {
      trip: { shape: "thrust", windup: 0.8, step: 0.2, hips: 0.2 }, // grab: a quick reach in
      poke: { shape: "thrust", windup: 0.8, step: 0.1, hips: 0.5 }, // keep-away poke: barely commits
      poke2: { shape: "thrust", windup: 0.8, step: 0.12, hips: 0.5 },
      tailsweep: { shape: "sweep", windup: 0.6, step: 0.15, hips: 0.15, span: 1.5 },
      arc: { shape: "sweep", windup: 0.8, step: 0.2, hips: 0.55, span: 1.5 },
      footstab: { shape: "thrust", windup: 0.3, step: 0.3, hips: 0.15 },
      vault: { shape: "thrust", windup: 0.3, step: 0.45, drop: -0.04, hips: 0.15 }, // spear-braced vault: a driving thrust
      lunge: { shape: "thrust", windup: 1.4, step: 0.65, drop: 0.1, lean: 0.3, hips: 0.15 }, // full-extension lunge
      retreat: { shape: "thrust", windup: 0.6, step: -0.35 },
      wakeup: { shape: "thrust", windup: 0.8, hips: 0.3, step: 0.45 },
    },
  },

  hp: 100,
  walkForward: 2.0,
  walkBack: 2.4,
  juggleFloat: 1.1,
  movement: { backdash: { frames: 16, distance: 1.9 } },
  slots: { light: "poke", heavy: "arc", low: "footstab", special: "vault", throw: "trip", fwd_heavy: "lunge", back_light: "retreat" },
  moves: {
    poke: { name: "Spear Poke", level: "mid", tipper: true, startup: 11, active: 3, recovery: 15, damage: 7, range: 2.0, width: 0.35, hitstun: 16, blockstun: 12, guardDamage: 8, cancels: { light: "poke2" } },
    poke2: { name: "Twin Poke", level: "mid", tipper: true, startup: 13, active: 3, recovery: 18, damage: 6, range: 2.0, width: 0.35, hitstun: 18, blockstun: 12, guardDamage: 8, cancels: { low: "tailsweep" } },
    tailsweep: { name: "Tail Sweep", level: "low", startup: 15, active: 3, recovery: 22, damage: 10, range: 2.0, width: 0.6, knockdown: true, hitstun: 0, blockstun: 10, guardDamage: 12 },
    arc: { name: "Sweeping Arc", level: "low", tracking: true, tipper: true, startup: 20, active: 5, recovery: 26, damage: 13, range: 2.1, width: 1.6, knockdown: true, hitstun: 0, blockstun: 10, guardDamage: 18 },
    footstab: { name: "Foot Stab", level: "low", tipper: true, startup: 15, active: 2, recovery: 17, damage: 8, range: 1.9, width: 0.35, hitstun: 18, blockstun: 11, guardDamage: 8 },
    vault: { name: "Vault Kick", level: "mid", startup: 24, active: 4, recovery: 28, damage: 12, range: 1.3, advance: 1.4, width: 0.6, launch: true, hitstun: 0, blockstun: 14, guardDamage: 22 },
    lunge: { name: "Long Lunge", level: "mid", tipper: true, startup: 20, active: 3, recovery: 26, damage: 12, range: 2.5, advance: 0.4, width: 0.35, hitstun: 24, blockstun: 10, guardDamage: 14 },
    retreat: { name: "Retreating Thrust", level: "mid", tipper: true, startup: 14, active: 3, recovery: 17, damage: 7, range: 1.9, advance: -0.8, width: 0.35, hitstun: 17, blockstun: 12, guardDamage: 8 },
    trip: { name: "Haft Trip", level: "throw", startup: 11, active: 2, recovery: 24, damage: 13, range: 0.95, width: 0.6 },
  },
  ai: {
    reactionFrames: 15,
    readSkill: 0.55,
    confirmSkill: 0.75,
    punishSkill: 0.75,
    temperature: 1.0,
    floor: 0.08,
    local: {
      aggression: 0.5,
      tactics: { pressure: 0.4, poke: 4, bait: 1, throw_rush: 0.2, turtle: 1, circle: 1, retreat: 1.5 },
      incoming: { stand_guard: 2, crouch_guard: 1.5, sidestep: 1, backdash: 2, counter_attack: 0.8 },
      afterBlocked: { keep_attacking: 1, throw: 0.3, guard: 1.5, sidestep: 1, backdash: 2.5 },
      wakeup: { getup_guard: 1.5, roll: 2.5, wakeup_attack: 0.8 },
      tech: 0.5,
      taunt: 0.2,
    },
  },
};
