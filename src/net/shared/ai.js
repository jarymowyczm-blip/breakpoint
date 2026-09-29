import { clamp, wrapAngle, angleDelta, damp, makeRng, randRange, anglesTo } from './math.js';
import { DIFFICULTY, PLAYER } from './constants.js';
import { pickWeaponFor } from './weapons.js';

/**
 * Bot AI.
 *
 * Bots never touch player state directly. They emit the *same input command a
 * human keyboard and mouse would emit*, which is then fed through the shared
 * `stepPlayer` like everyone else. The payoff is significant: bots are subject
 * to identical acceleration, crouch and jump constraints, they cannot move
 * faster than a player, and nothing about the netcode needs special cases for
 * them. Their only advantages are the difficulty scalars below.
 *
 * Decision layer (cheap, runs every tick):
 *   PERCEIVE  vision cone + line of sight + hearing, with memory decay
 *   DECIDE    a small state machine: patrol / hunt / engage / reload / retreat
 *   ACT       aim with reaction delay and turn-rate limits, then fire in bursts
 *   MOVE      follow an A* path expressed as forward/strafe input relative to
 *             the aim direction, exactly how a human strafes while aiming
 */

export const BOT_ARCHETYPES = {
  assault: {
    // Pushes aggressively, closes distance, rarely holds still.
    preferredRange: 14,
    aggression: 0.95,
    holdCover: 0.15,
    burstShots: [3, 6],
    burstPause: [0.18, 0.42],
    strafes: true,
    usesAds: 0.35,
    reloadWhen: 0.15,
  },
  defensive: {
    // Holds angles, keeps medium range, retreats when hurt.
    preferredRange: 24,
    aggression: 0.35,
    holdCover: 0.75,
    burstShots: [2, 4],
    burstPause: [0.35, 0.8],
    strafes: false,
    usesAds: 0.6,
    reloadWhen: 0.35,
  },
  sniper: {
    // Long range, crouches, waits for the shot, terrible up close.
    preferredRange: 55,
    aggression: 0.1,
    holdCover: 0.95,
    burstShots: [1, 2],
    burstPause: [1.1, 1.9],
    strafes: false,
    usesAds: 1,
    reloadWhen: 0.5,
  },
  aggressive: {
    // Shotgun/SMG rusher: always moving, always in your face.
    preferredRange: 7,
    aggression: 1,
    holdCover: 0.02,
    burstShots: [4, 8],
    burstPause: [0.1, 0.25],
    strafes: true,
    usesAds: 0.1,
    reloadWhen: 0.1,
  },
};

const FIRST_NAMES = [
  'KESTREL', 'VULTURE', 'JACKAL', 'OSPREY', 'MAGPIE', 'RAVEN', 'SHRIKE', 'HORNET',
  'TALON', 'BISHOP', 'ROOK', 'VIPER', 'COBRA', 'LYNX', 'PUMA', 'FALCON', 'CONDOR',
];
const TEAM_TAGS = { a: ['ALPHA', 'BRAVO'], b: ['ECHO', 'DELTA'] };

let botSerial = 1;

export function botName(rng, team) {
  const pool = TEAM_TAGS[team] || ['NEUTRAL'];
  const first = pool[Math.floor(rng() * pool.length)];
  const name = FIRST_NAMES[Math.floor(rng() * FIRST_NAMES.length)];
  return `${name}-${String(botSerial++).padStart(2, '0')}`;
}

/**
 * Create a bot brain. `difficulty` is a key of DIFFICULTY; `archetype` a key of
 * BOT_ARCHETYPES. The two are independent so a "recruit sniper" and an "elite
 * sniper" are both expressible.
 */
export function createBotBrain({ team, archetype = 'assault', difficulty = 'regular', seed = 1, assignedPoint = null }) {
  const rng = makeRng(seed);
  const profile = BOT_ARCHETYPES[archetype] || BOT_ARCHETYPES.assault;
  const diff = DIFFICULTY[difficulty] || DIFFICULTY.regular;
  const weaponId = pickWeaponFor(rng, archetype);

  return {
    team,
    archetype,
    difficulty,
    weaponId,
    profile,
    diff,
    rng,
    state: 'patrol',
    stateTime: 0,

    // perception
    targetId: null,
    lastKnown: null,
    lastSeenAt: -999,
    alertness: 0,
    reactUntil: 0,
    heardAt: -999,

    // aiming
    aimYaw: 0,
    aimPitch: 0,
    aimJitter: 0,
    turnRate: diff.aimError > 2 ? 7.5 : 11,

    // firing
    burstLeft: 0,
    burstPauseUntil: 0,
    shotsThisBurst: 0,
    triggerDown: false,

    // movement
    path: null,
    pathIndex: 0,
    pathGoal: null,
    pathComputedAt: -99,
    repathAt: 0,
    goal: null,
    assignedPoint,
    stuckTime: 0,
    lastPos: null,
    strafeDir: rng() < 0.5 ? -1 : 1,
    strafeUntil: 0,
    unstickUntil: 0,
    unstickDir: [0, 0],
    jumpCooldown: 0,

    // stance / weapon handling
    wantReload: false,
    wantAds: false,
    wantCrouch: false,
    scanYaw: 0,
  };
}

/** Reset per-life brain state on respawn. */
export function resetBrain(brain, spawnYaw) {
  brain.state = 'patrol';
  brain.stateTime = 0;
  brain.targetId = null;
  brain.lastKnown = null;
  brain.lastSeenAt = -999;
  brain.alertness = 0;
  brain.burstLeft = 0;
  brain.path = null;
  brain.pathIndex = 0;
  brain.pathGoal = null;
  brain.goal = null;
  brain.aimYaw = spawnYaw;
  brain.aimPitch = 0;
  brain.wantReload = false;
  brain.wantAds = false;
  brain.wantCrouch = false;
  brain.stuckTime = 0;
  brain.lastPos = null;
}

// ---------------------------------------------------------------------------
// Perception
// ---------------------------------------------------------------------------

/**
 * Pick a visible enemy. Returns the entity or null. Considers the vision cone,
 * distance, line of sight and whether the bot was recently shot.
 */
function perceive(bot, self, candidates, world, now) {
  const brain = bot.brain;
  const eye = self.eye;
  const diff = brain.diff;
  const fovCos = Math.cos((diff.fov * Math.PI) / 2);
  const viewDist2 = diff.viewDist * diff.viewDist;

  let best = null;
  let bestScore = Infinity;
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (!c.alive || c.team === self.team) continue;
    const dx = c.pos[0] - eye[0];
    const dy = c.pos[1] - eye[1];
    const dz = c.pos[2] - eye[2];
    const dist2 = dx * dx + dy * dy + dz * dz;
    if (dist2 > viewDist2) continue;
    const dist = Math.sqrt(dist2) || 1e-4;
    // Cone check against the bot's facing direction.
    const fwdX = -Math.sin(brain.aimYaw) * Math.cos(brain.aimPitch);
    const fwdY = Math.sin(brain.aimPitch);
    const fwdZ = -Math.cos(brain.aimYaw) * Math.cos(brain.aimPitch);
    const dot = (dx * fwdX + dy * fwdY + dz * fwdZ) / dist;
    const alerted = brain.alertness > 0.5;
    // A bot that has already been engaged scans wider -- it knows roughly where
    // to look, so it does not need the visual cone to tell it.
    if (dot < fovCos && !alerted) continue;

    const targetEye = [c.pos[0], c.pos[1] + (c.crouching ? 1.0 : 1.52), c.pos[2]];
    if (!world.lineOfSight(eye, targetEye)) continue;

    // Prefer close targets, and targets that are roughly in front.
    const score = dist + (1 - dot) * 12;
    if (score < bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Pathing
// ---------------------------------------------------------------------------

function ensurePath(bot, self, nav, world, now, goal) {
  const brain = bot.brain;
  if (!goal) return;
  const goalMoved = !brain.pathGoal || Math.hypot(goal[0] - brain.pathGoal[0], goal[2] - brain.pathGoal[2]) > 2.5;
  const expired = now > brain.repathAt;
  if (brain.path && !goalMoved && !expired) return;
  const from = [self.pos[0], self.pos[1] + 0.1, self.pos[2]];
  const path = nav.findPath(from, goal);
  if (path && path.length) {
    brain.path = path;
    brain.pathIndex = path.length > 1 ? 1 : 0;
    brain.pathGoal = [goal[0], goal[1], goal[2]];
    brain.pathComputedAt = now;
    brain.repathAt = now + randRange(brain.rng, 1.2, 2.2);
  } else {
    brain.path = null;
    // Back off the retry: a failed path is usually a temporary elevation or a
    // player standing in a doorway, so hammering A* wastes the whole budget.
    brain.repathAt = now + randRange(brain.rng, 0.6, 1.2);
    brain.pathGoal = null;
  }
}

/** Nearest point in a path, guarding against a stale index after a shove. */
function currentWaypoint(brain) {
  const path = brain.path;
  if (!path) return null;
  while (brain.pathIndex < path.length) {
    const wp = path[brain.pathIndex];
    const g = brain.goal;
    if (!g) break;
    return wp;
  }
  return path[path.length - 1] || null;
}

// ---------------------------------------------------------------------------
// Main update
// ---------------------------------------------------------------------------

/**
 * Run one bot tick and return the input command plus intent flags.
 *
 * `ctx` provides { world, nav, enemies, now, objective, sounds }.
 */
export function updateBot(bot, self, ctx, dt) {
  const brain = bot.brain;
  const { world, nav, now } = ctx;
  const weapon = ctx.weapon;
  brain.stateTime += dt;

  // ---------------------------------------------------------------------
  // Hearing: recent gunshots within earshot set a fuzzy last-known position.
  // ---------------------------------------------------------------------
  if (ctx.sounds) {
    for (const s of ctx.sounds) {
      if (s.kind !== 'shot' || s.team === self.team) continue;
      const d = Math.hypot(s.pos[0] - self.pos[0], s.pos[1] - self.pos[1], s.pos[2] - self.pos[2]);
      const hearing = 55;
      if (d > hearing) continue;
      if (now - brain.lastSeenAt < 0.4) continue;
      const jitter = (hearing - d) * 0.06;
      brain.lastKnown = [
        s.pos[0] + (brain.rng() - 0.5) * jitter,
        s.pos[1],
        s.pos[2] + (brain.rng() - 0.5) * jitter,
      ];
      brain.heardAt = now;
      brain.alertness = Math.max(brain.alertness, 0.6);
    }
  }

  // ---------------------------------------------------------------------
  // Perception
  // ---------------------------------------------------------------------
  const visible = perceive(bot, self, ctx.enemies, world, now);
  if (visible) {
    if (brain.targetId !== visible.id) {
      // New contact: react after the archetype's reaction time.
      brain.reactUntil = now + brain.diff.reactionTime * (brain.state === 'engage' ? 0.6 : 1);
    }
    brain.targetId = visible.id;
    brain.lastKnown = [visible.pos[0], visible.pos[1], visible.pos[2]];
    brain.lastSeenAt = now;
    brain.alertness = 1;
  } else {
    brain.alertness = Math.max(0, brain.alertness - dt * 0.35);
    if (now - brain.lastSeenAt > 5.5) {
      brain.targetId = null;
      brain.lastKnown = null;
    }
  }

  const target = visible || (brain.targetId != null ? ctx.byId.get(brain.targetId) : null);
  const engaged = !!visible;
  const dist = target ? Math.hypot(target.pos[0] - self.pos[0], target.pos[2] - self.pos[2]) : Infinity;

  // ---------------------------------------------------------------------
  // State selection
  // ---------------------------------------------------------------------
  const prof = brain.profile;
  const healthFrac = self.health / self.maxHealth;
  let nextState = brain.state;

  if (brain.wantReload || self.weaponAmmo <= 0) nextState = 'reload';
  else if (healthFrac < 0.28 && prof.aggression < 0.7 && target) nextState = 'retreat';
  else if (engaged && now >= brain.reactUntil) nextState = 'engage';
  else if (target) nextState = 'hunt';
  else if (now - brain.lastSeenAt < 6 && brain.lastKnown) nextState = 'hunt';
  else nextState = 'patrol';

  if (nextState !== brain.state) {
    brain.state = nextState;
    brain.stateTime = 0;
    brain.burstLeft = 0;
    if (nextState === 'patrol' || nextState === 'hunt') {
      brain.path = null;
      brain.pathGoal = null;
    }
  }

  // ---------------------------------------------------------------------
  // Aim
  // ---------------------------------------------------------------------
  let desiredYaw = brain.aimYaw;
  let desiredPitch = brain.aimPitch;

  if (target && (engaged || brain.state === 'hunt' || brain.state === 'retreat')) {
    const aimHeight = engaged ? (target.crouching ? 0.95 : 1.45) : 1.0;
    const aimPoint = [
      target.pos[0],
      target.pos[1] + aimHeight + (engaged ? brain.aimJitter * 0.4 : 0),
      target.pos[2],
    ];
    const a = anglesTo(self.eye, aimPoint);
    desiredYaw = a.yaw;
    desiredPitch = a.pitch;
    // Aim error: a persistent offset plus per-moment jitter, scaled inversely by
    // skill. Applied to the VIEW, so it also biases where the shots go.
    if (engaged) {
      const err = (brain.diff.aimError * Math.PI) / 180;
      const wobble = 1 + Math.sin(now * 6.3 + self.id * 1.7) * 0.4;
      desiredYaw += ((brain.rng() - 0.5) * err) * wobble;
      desiredPitch += ((brain.rng() - 0.5) * err * 0.6) * wobble;
      brain.aimJitter = err;
    }
  } else if (brain.lastKnown && brain.state === 'hunt') {
    const a = anglesTo(self.eye, brain.lastKnown);
    desiredYaw = a.yaw;
    desiredPitch = clamp(a.pitch, -0.4, 0.4);
  } else if (brain.state === 'patrol') {
    // Slow scan so idle bots sweep angles instead of staring at a wall.
    brain.scanYaw += dt * 0.55;
    desiredYaw = brain.aimYaw + Math.sin(brain.scanYaw) * 0.9;
  }

  // Turn-rate limit: bots cannot snap.
  const maxTurn = brain.turnRate * (brain.state === 'engage' ? 1.35 : 0.9) * dt;
  const dy = angleDelta(brain.aimYaw, desiredYaw);
  brain.aimYaw = wrapAngle(brain.aimYaw + clamp(dy, -maxTurn, maxTurn));
  brain.aimPitch = clamp(brain.aimPitch + clamp(desiredPitch - brain.aimPitch, -maxTurn, maxTurn), -1.3, 1.3);

  // ---------------------------------------------------------------------
  // Movement intent
  // ---------------------------------------------------------------------
  let moveGoal = null;
  if (brain.state === 'patrol') {
    if (!brain.goal || Math.hypot(brain.goal[0] - self.pos[0], brain.goal[2] - self.pos[2]) < 2.5) {
      brain.goal = brain.assignedPoint
        ? [brain.assignedPoint[0] + (brain.rng() - 0.5) * 8, brain.assignedPoint[1], brain.assignedPoint[2] + (brain.rng() - 0.5) * 8]
        : nav.randomPoint(brain.rng, self.pos, 8);
    }
    moveGoal = brain.goal;
  } else if (brain.state === 'hunt') {
    moveGoal = brain.lastKnown;
  } else if (brain.state === 'retreat') {
    // Run away from the threat, toward the nearest friendly-ish open space.
    if (target) {
      const away = [
        self.pos[0] + (self.pos[0] - target.pos[0]) * 1.5,
        self.pos[1],
        self.pos[2] + (self.pos[2] - target.pos[2]) * 1.5,
      ];
      moveGoal = nav.randomPoint(brain.rng, away, 6) || away;
    }
  } else if (brain.state === 'engage') {
    // Hold the archetype's preferred range: back off if too close, close in if
    // too far, otherwise hold and use cover.
    if (target) {
      if (dist < prof.preferredRange * 0.55) {
        moveGoal = [self.pos[0] + (self.pos[0] - target.pos[0]), self.pos[1], self.pos[2] + (self.pos[2] - target.pos[2])];
      } else if (dist > prof.preferredRange * 1.3 && prof.aggression > 0.5) {
        moveGoal = brain.lastKnown;
      } else {
        moveGoal = null;
      }
    }
  }

  if (moveGoal) {
    brain.goal = moveGoal;
    ensurePath(bot, self, nav, world, now, moveGoal);
  }

  let forward = 0;
  let right = 0;
  let jump = false;

  if (brain.path && brain.pathIndex < brain.path.length) {
    let wp = brain.path[brain.pathIndex];
    let dxw = wp[0] - self.pos[0];
    let dzw = wp[2] - self.pos[2];
    let d = Math.hypot(dxw, dzw);
    // Consume waypoints we have already reached, skipping any that sit behind a
    // wall corner we just rounded.
    while (d < 0.9 && brain.pathIndex < brain.path.length - 1) {
      brain.pathIndex++;
      wp = brain.path[brain.pathIndex];
      dxw = wp[0] - self.pos[0];
      dzw = wp[2] - self.pos[2];
      d = Math.hypot(dxw, dzw);
    }
    if (d > 0.001) {
      const dirX = dxw / d;
      const dirZ = dzw / d;
      // Convert the world-space desire into forward/strafe relative to where the
      // bot is AIMING -- this is what makes them strafe while tracking a target.
      const fX = -Math.sin(brain.aimYaw);
      const fZ = -Math.cos(brain.aimYaw);
      const rX = Math.cos(brain.aimYaw);
      const rZ = -Math.sin(brain.aimYaw);
      forward = clamp(dirX * fX + dirZ * fZ, -1, 1);
      right = clamp(dirX * rX + dirZ * rZ, -1, 1);
      // Vertical: jump when the next waypoint is meaningfully above us.
      if (wp[1] - self.pos[1] > 0.6 && self.grounded && now > brain.jumpCooldown) {
        jump = true;
        brain.jumpCooldown = now + 0.9;
      }
    }
  }

  // Strafing during a fight, unless the archetype plants its feet.
  if (brain.state === 'engage' && target) {
    if (prof.strafes) {
      if (now > brain.strafeUntil) {
        brain.strafeDir *= brain.rng() < 0.62 ? -1 : 1;
        brain.strafeUntil = now + randRange(brain.rng, 0.35, 0.95);
      }
      right = clamp(right + brain.strafeDir * 0.85, -1, 1);
      forward = clamp(forward * 0.35 + (dist > prof.preferredRange * 1.4 ? 0.8 : dist < prof.preferredRange * 0.6 ? -0.7 : 0), -1, 1);
    } else if (prof.holdCover > 0.5) {
      forward = clamp(forward * 0.6, -1, 1);
    }
  }

  // Charge into melee range for aggressive archetypes.
  if (brain.state === 'engage' && prof.aggression > 0.85 && target && dist > prof.preferredRange) {
    forward = 1;
  }

  // ---------------------------------------------------------------------
  // Unstuck: if we keep asking to move and the position is not changing,
  // shove sideways for a moment, then repath.
  // ---------------------------------------------------------------------
  if (Math.abs(forward) + Math.abs(right) > 0.1 && self.grounded) {
    if (!brain.lastPos) brain.lastPos = [self.pos[0], self.pos[1], self.pos[2]];
    const moved = Math.hypot(self.pos[0] - brain.lastPos[0], self.pos[2] - brain.lastPos[2]);
    if (moved < 0.035) brain.stuckTime += dt;
    else brain.stuckTime = 0;
    brain.lastPos[0] = self.pos[0];
    brain.lastPos[1] = self.pos[1];
    brain.lastPos[2] = self.pos[2];
    if (brain.stuckTime > 0.5 && now > brain.unstickUntil) {
      brain.unstickUntil = now + 0.7;
      brain.unstickDir = [Math.sign(Math.sin(now * 3.1 + self.id)) || 1, 0];
      brain.stuckTime = 0;
      brain.repathAt = 0;
      brain.path = null;
    }
  }
  if (now < brain.unstickUntil) {
    right = brain.unstickDir[0];
    forward = -0.3;
    if (self.grounded && now > brain.jumpCooldown) {
      jump = true;
      brain.jumpCooldown = now + 1.1;
    }
  }

  // ---------------------------------------------------------------------
  // Weapon handling
  // ---------------------------------------------------------------------
  brain.wantAds = false;
  brain.wantCrouch = false;
  let wantFire = false;

  if (brain.state === 'engage' && target) {
    brain.wantAds = brain.rng() < prof.usesAds || dist > 30;
    // Snipers and defenders go prone-ish when holding an angle.
    brain.wantCrouch = brain.archetype === 'sniper' && dist > 30 && !prof.strafes;
    if (now >= brain.reactUntil && self.weaponAmmo > 0 && !brain.wantReload) {
      if (brain.burstLeft > 0) {
        wantFire = true;
        brain.burstLeft -= dt;
      } else if (now > brain.burstPauseUntil) {
        const [lo, hi] = prof.burstShots;
        brain.shotsThisBurst = Math.round(randRange(brain.rng, lo, hi));
        brain.burstLeft = brain.shotsThisBurst * (60 / weapon.rpm) * 0.92;
        const [plo, phi] = prof.burstPause;
        brain.burstPauseUntil = now + randRange(brain.rng, plo, phi);
        wantFire = true;
        brain.burstLeft -= dt;
      }
    }
  }

  // Reload when the magazine is worth refilling, scaled by archetype patience.
  const magFrac = self.weaponAmmo / weapon.magSize;
  if (!brain.wantReload && magFrac <= prof.reloadWhen && brain.state !== 'engage') brain.wantReload = true;
  if (!brain.wantReload && self.weaponAmmo <= 0) brain.wantReload = true;
  if (brain.wantReload && self.weaponAmmo >= weapon.magSize) brain.wantReload = false;

  // Sprint when travelling a long way with no target in sight.
  const sprint =
    brain.state === 'patrol' || (brain.state === 'hunt' && !engaged) || brain.state === 'retreat'
      ? Math.abs(forward) > 0.5
      : false;

  return {
    input: {
      forward,
      right,
      jump,
      crouch: brain.wantCrouch,
      sprint,
      walk: false,
      yaw: brain.aimYaw,
      pitch: brain.aimPitch,
      ads: brain.wantAds,
    },
    wantFire,
    wantReload: brain.wantReload,
    state: brain.state,
  };
}

/** Extra spread a bot's imperfect aim contributes to its shots, in radians. */
export function botSpread(brain) {
  return (brain.diff.aimError * Math.PI) / 180 * 0.55;
}

/** Where a bot's body should face when idle on spawn. */
export function spawnFacing(level, spawn) {
  void level;
  void spawn;
  return 0;
}

export { PLAYER };
