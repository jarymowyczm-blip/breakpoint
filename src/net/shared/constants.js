/**
 * Tunables shared by client and server so that predicted movement on the
 * client matches the authoritative simulation exactly. Any drift here shows up
 * as rubber-banding, so these live in one place.
 */

export const PLAYER = {
  radius: 0.34,
  /** Square collider footprint (players are never rotated for collision). */
  width: 0.62,
  heightStand: 1.8,
  heightCrouch: 1.16,
  eyeStand: 1.62,
  eyeCrouch: 1.02,
  /** Maximum ledge a player can walk up without jumping. */
  stepHeight: 0.48,
  /** Ground probe distance used to stay glued to slopes and stairs. */
  groundSnap: 0.42,

  speedWalk: 3.1,
  speedRun: 4.9,
  speedSprint: 6.6,
  speedCrouch: 1.85,
  speedAds: 2.2,
  /** Backpedalling and lateral movement are slower than pure forward. */
  backwardMult: 0.82,
  strafeMult: 0.9,

  accelGround: 62,
  accelAir: 14,
  frictionGround: 9.6,
  frictionAir: 0.35,
  jumpSpeed: 5.0,
  /** Grace period after walking off an edge during which jump still works. */
  coyoteTime: 0.12,
  /** Jump pressed slightly before landing is remembered. */
  jumpBuffer: 0.14,
  gravity: -19.6,
  /** Terminal velocity keeps long falls from tunnelling through the floor. */
  maxFallSpeed: -46,

  crouchTime: 0.22,
  /** Movement penalty while airborne, feels weighty rather than floaty. */
  airControl: 0.34,
  /** Speed above which footsteps become audible to other players (m/s). */
  footstepSpeed: 2.0,
  footstepInterval: 0.42,
  sprintFootstepInterval: 0.3,
  maxHealth: 100,
  healthRegenDelay: 7.5,
  healthRegenRate: 14,
  maxArmor: 100,
};

export const COMBAT = {
  /** How long a corpse lingers before the body is removed. */
  corpseTime: 9,
  respawnTime: 4.2,
  /** Friendly fire is off in team modes. */
  friendlyFire: false,
  /** Time a player is protected after spawning (no damage in or out). */
  spawnProtection: 1.6,
  /** Assist window: damage dealt within this many seconds of a kill counts. */
  assistWindow: 8,
  /** Shotgun pellets are hitscan; pellets per trigger pull. */
  maxPellets: 12,
  /** Hitscan range for the longest weapon (sniper) in metres. */
  maxRange: 260,
  /** Reward multipliers by body region. */
  headMult: 2.45,
  torsoMult: 1,
  limbMult: 0.78,
  /** Movement speed above which a shooter's spread penalty is at maximum. */
  movingSpreadRefSpeed: 5.5,
};

export const NET = {
  /** Server simulation rate. */
  tickRate: 30,
  /** Client input send rate. */
  inputRate: 60,
  /** How many snapshots the client interpolates between. */
  interpDelay: 0.1,
  /** Ring buffer length for lag compensation, in seconds. */
  lagCompHistory: 1.0,
  /** Snapshots sent per second (may be lower than the tick rate on big matches). */
  snapshotRate: 20,
  /** Maximum rewind any single shot may request, as anti-cheat. */
  maxRewind: 0.5,
  maxPlayersPerLobby: 16,
};

export const DIFFICULTY = {
  recruit: { aimError: 4.6, reactionTime: 0.62, burstAccuracy: 0.6, moveSpeedMult: 0.85, health: 90, viewDist: 45, fov: 1.15 },
  regular: { aimError: 2.8, reactionTime: 0.42, burstAccuracy: 0.72, moveSpeedMult: 0.95, health: 100, viewDist: 60, fov: 1.05 },
  veteran: { aimError: 1.6, reactionTime: 0.28, burstAccuracy: 0.84, moveSpeedMult: 1.05, health: 100, viewDist: 75, fov: 0.95 },
  elite: { aimError: 0.9, reactionTime: 0.19, burstAccuracy: 0.93, moveSpeedMult: 1.15, health: 110, viewDist: 90, fov: 0.85 },
};
