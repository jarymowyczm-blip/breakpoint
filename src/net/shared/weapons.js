import { clamp, smoothstep, lerp, makeRng, forwardFromAngles, randNormal } from './math.js';
import { COMBAT, PLAYER } from './constants.js';

/**
 * Data-driven weapon system.
 *
 * Every number that decides a gunfight lives here, and the same module runs on
 * the client and the server. That is deliberate: spread and pellet directions
 * are computed from a *seed* rather than from local randomness, so the client
 * can draw a tracer that matches exactly where the server put the bullet, while
 * the server still resolves the damage. The client cannot cheat by claiming a
 * perfectly accurate shot, because the server generates the cone itself.
 *
 * Ballistics model:
 *   - hitscan with damage falloff by distance
 *   - recoil as a per-shot VIEW kick (pitch/yaw) plus a deterministic pattern
 *   - spread as a permanent cone (stance/state) plus a decaying bloom
 *   - pellets for shotguns, semi/auto/bolt fire modes
 */

// ---------------------------------------------------------------------------
// Recoil patterns
// ---------------------------------------------------------------------------

/**
 * Generate a recognisable recoil pattern: a climb that saturates, then a
 * sweeping sway the shooter has to counter. Deterministic for a given seed, so
 * a pattern is learnable -- which is the whole point of having patterns.
 */
function genRecoil({ seed, count, risePerShot, riseCap, swayStart, swayAmp, swayPeriod, drift = 0, jitter = 0.16 }) {
  const rng = makeRng(seed);
  const out = [];
  for (let i = 0; i < count; i++) {
    const rise = Math.min(risePerShot * i, riseCap);
    const phase = i < swayStart ? 0 : Math.sin(((i - swayStart) / swayPeriod) * Math.PI * 2) * swayAmp;
    const noise = (rng() - 0.5) * jitter;
    out.push([phase + noise + drift * i * 0.03, rise]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Weapons
// ---------------------------------------------------------------------------

/**
 * `spread` values are in radians of half-angle at the muzzle.
 * `falloff.start/end` are metres, `min` is the damage multiplier at `end`.
 * `model` drives the first-person view model; `audio` drives procedural synth.
 */
export const WEAPONS = {
  ar: {
    id: 'ar',
    name: 'VK-74',
    className: 'Assault Rifle',
    slot: 'primary',
    damage: 26,
    fireMode: 'auto',
    rpm: 640,
    pellets: 1,
    magSize: 30,
    reserveMax: 240,
    reloadTime: 2.35,
    reloadEmptyTime: 3.05,
    switchTime: 0.55,
    falloff: { start: 30, end: 85, min: 0.56 },
    spread: {
      base: 0.0016, ads: 0.0007, crouch: 0.72, move: 0.0115, air: 0.05,
      perShot: 0.0031, max: 0.045, recover: 0.075, recoverDelay: 0.06,
    },
    recoil: {
      pattern: genRecoil({ seed: 11, count: 34, risePerShot: 0.34, riseCap: 1.5, swayStart: 6, swayAmp: 0.95, swayPeriod: 9, drift: 1 }),
      kick: 0.052,
      recovery: 8.5,
      viewKick: 0.9,
      shake: 0.35,
    },
    ads: { zoom: 1.35, time: 0.21, sensMult: 0.85, moveMult: 0.55 },
    mobility: 1,
    audio: { level: 1, body: 210, snap: 0.9, tail: 0.55, pitch: 1 },
    model: { receiver: [0.4, 0.16, 0.9], barrel: [0.06, 0.06, 0.5], mag: [0.12, 0.3, 0.28], stock: [0.16, 0.14, 0.42], color: '#3b4046' },
  },
  smg: {
    id: 'smg',
    name: 'MP-9',
    className: 'Submachine Gun',
    slot: 'primary',
    damage: 19,
    fireMode: 'auto',
    rpm: 920,
    pellets: 1,
    magSize: 32,
    reserveMax: 288,
    reloadTime: 1.95,
    reloadEmptyTime: 2.6,
    switchTime: 0.42,
    falloff: { start: 16, end: 52, min: 0.42 },
    spread: {
      base: 0.0032, ads: 0.0018, crouch: 0.78, move: 0.0095, air: 0.05,
      perShot: 0.0026, max: 0.06, recover: 0.105, recoverDelay: 0.05,
    },
    recoil: {
      pattern: genRecoil({ seed: 23, count: 34, risePerShot: 0.21, riseCap: 0.95, swayStart: 4, swayAmp: 1.15, swayPeriod: 6, jitter: 0.26 }),
      kick: 0.03,
      recovery: 11,
      viewKick: 0.6,
      shake: 0.22,
    },
    ads: { zoom: 1.18, time: 0.16, sensMult: 0.9, moveMult: 0.72 },
    mobility: 1.06,
    audio: { level: 0.85, body: 250, snap: 1, tail: 0.4, pitch: 1.2 },
    model: { receiver: [0.3, 0.15, 0.62], barrel: [0.05, 0.05, 0.32], mag: [0.1, 0.38, 0.22], stock: [0.12, 0.12, 0.3], color: '#2f3338' },
  },
  shotgun: {
    id: 'shotgun',
    name: 'BR-12',
    className: 'Combat Shotgun',
    slot: 'primary',
    damage: 13,
    fireMode: 'pump',
    rpm: 78,
    pellets: 9,
    magSize: 7,
    reserveMax: 56,
    reloadTime: 0.55,
    reloadEmptyTime: 0.75,
    shellReload: true,
    switchTime: 0.7,
    falloff: { start: 7, end: 26, min: 0.18 },
    spread: {
      base: 0.032, ads: 0.024, crouch: 0.7, move: 0.014, air: 0.035,
      perShot: 0.02, max: 0.09, recover: 0.12, recoverDelay: 0.04,
    },
    recoil: {
      pattern: genRecoil({ seed: 41, count: 13, risePerShot: 1.5, riseCap: 3.4, swayStart: 3, swayAmp: 1.4, swayPeriod: 4, jitter: 0.5 }),
      kick: 0.24,
      recovery: 5.5,
      viewKick: 3.4,
      shake: 1.5,
    },
    ads: { zoom: 1.1, time: 0.24, sensMult: 0.95, moveMult: 0.68 },
    mobility: 0.94,
    audio: { level: 1.35, body: 120, snap: 1.3, tail: 0.85, pitch: 0.72 },
    model: { receiver: [0.36, 0.17, 0.95], barrel: [0.09, 0.09, 0.62], mag: [0, 0, 0], stock: [0.17, 0.16, 0.4], color: '#4a3327' },
  },
  dmr: {
    id: 'dmr',
    name: 'M-14 DMR',
    className: 'Marksman Rifle',
    slot: 'primary',
    damage: 47,
    fireMode: 'semi',
    rpm: 300,
    pellets: 1,
    magSize: 20,
    reserveMax: 160,
    reloadTime: 2.6,
    reloadEmptyTime: 3.2,
    switchTime: 0.62,
    falloff: { start: 45, end: 120, min: 0.7 },
    spread: {
      base: 0.0011, ads: 0.0004, crouch: 0.6, move: 0.016, air: 0.06,
      perShot: 0.006, max: 0.05, recover: 0.06, recoverDelay: 0.1,
    },
    recoil: {
      pattern: genRecoil({ seed: 57, count: 20, risePerShot: 0.8, riseCap: 2.7, swayStart: 3, swayAmp: 0.7, swayPeriod: 5, jitter: 0.2 }),
      kick: 0.15,
      recovery: 6.5,
      viewKick: 2.1,
      shake: 0.85,
    },
    ads: { zoom: 2.3, time: 0.28, sensMult: 0.7, moveMult: 0.48 },
    mobility: 0.96,
    audio: { level: 1.15, body: 175, snap: 1.1, tail: 0.7, pitch: 0.88 },
    model: { receiver: [0.36, 0.15, 1.0], barrel: [0.05, 0.05, 0.7], mag: [0.1, 0.26, 0.24], stock: [0.14, 0.17, 0.5], color: '#4a3a2a' },
  },
  sniper: {
    id: 'sniper',
    name: 'AX-50',
    className: 'Bolt-Action Rifle',
    slot: 'primary',
    damage: 112,
    fireMode: 'bolt',
    rpm: 42,
    pellets: 1,
    magSize: 5,
    reserveMax: 35,
    reloadTime: 3.4,
    reloadEmptyTime: 4.1,
    switchTime: 0.95,
    falloff: { start: 150, end: 320, min: 0.85 },
    spread: {
      base: 0.0006, ads: 0.00008, crouch: 0.5, move: 0.03, air: 0.09,
      perShot: 0.012, max: 0.05, recover: 0.05, recoverDelay: 0.35,
    },
    recoil: {
      pattern: genRecoil({ seed: 71, count: 10, risePerShot: 2.6, riseCap: 5.2, swayStart: 1, swayAmp: 0.5, swayPeriod: 3, jitter: 0.15 }),
      kick: 0.4,
      recovery: 4.2,
      viewKick: 5.4,
      shake: 2.2,
    },
    scope: true,
    ads: { zoom: 5.5, time: 0.45, sensMult: 0.42, moveMult: 0.34 },
    mobility: 0.86,
    audio: { level: 1.5, body: 145, snap: 1.4, tail: 1.1, pitch: 0.8 },
    model: { receiver: [0.34, 0.15, 1.15], barrel: [0.055, 0.055, 0.82], mag: [0.09, 0.2, 0.2], stock: [0.15, 0.18, 0.58], color: '#2b2f33' },
  },
  pistol: {
    id: 'pistol',
    name: 'P-19',
    className: 'Sidearm',
    slot: 'secondary',
    damage: 30,
    fireMode: 'semi',
    rpm: 400,
    pellets: 1,
    magSize: 17,
    reserveMax: 102,
    reloadTime: 1.55,
    reloadEmptyTime: 2.1,
    switchTime: 0.28,
    falloff: { start: 20, end: 62, min: 0.6 },
    spread: {
      base: 0.0034, ads: 0.0013, crouch: 0.75, move: 0.013, air: 0.045,
      perShot: 0.0055, max: 0.05, recover: 0.1, recoverDelay: 0.05,
    },
    recoil: {
      pattern: genRecoil({ seed: 89, count: 17, risePerShot: 0.62, riseCap: 2.1, swayStart: 3, swayAmp: 1.0, swayPeriod: 5, jitter: 0.3 }),
      kick: 0.085,
      recovery: 12,
      viewKick: 1.4,
      shake: 0.5,
    },
    ads: { zoom: 1.15, time: 0.14, sensMult: 0.92, moveMult: 0.8 },
    mobility: 1.12,
    audio: { level: 0.9, body: 260, snap: 1.05, tail: 0.42, pitch: 1.05 },
    model: { receiver: [0.2, 0.17, 0.34], barrel: [0.045, 0.045, 0.12], mag: [0.07, 0.2, 0.14], stock: [0, 0, 0], color: '#33373c' },
  },
};

export const WEAPON_IDS = Object.keys(WEAPONS);

/** Handy default loadout per mode. */
export const LOADOUTS = {
  default: { primary: 'ar', secondary: 'pistol' },
  close: { primary: 'smg', secondary: 'pistol' },
  assault: { primary: 'ar', secondary: 'pistol' },
  marksman: { primary: 'dmr', secondary: 'pistol' },
  recon: { primary: 'sniper', secondary: 'pistol' },
  breacher: { primary: 'shotgun', secondary: 'pistol' },
  campaign: { primary: 'ar', secondary: 'pistol' },
};

export function getWeapon(id) {
  return WEAPONS[id] || WEAPONS.ar;
}

// ---------------------------------------------------------------------------
// Runtime state
// ---------------------------------------------------------------------------

export function makeWeaponState(id, { ammo = null } = {}) {
  const w = getWeapon(id);
  return {
    id: w.id,
    ammo: ammo === null ? w.magSize : ammo,
    reserve: w.reserveMax,
    reloading: false,
    reloadEndsAt: 0,
    reloadStartedAt: 0,
    nextFireAt: 0,
    shotIndex: 0,
    bloom: 0,
    lastShotAt: -99,
    pumpEndsAt: 0,
    triggerWasDown: false,
    triggerPressedAt: 0,
  };
}

/** Seconds between shots. */
export function shotInterval(w) {
  return 60 / w.rpm;
}

export function isReloading(state) {
  return state.reloading;
}

export function needsReload(state) {
  const w = getWeapon(state.id);
  return state.ammo <= 0 || (state.ammo < w.magSize && state.reserve > 0);
}

/**
 * Spread half-angle in radians for the current stance, scaled by movement, and
 * including the accumulated bloom. `speed` is horizontal speed in m/s.
 */
export function currentSpread(w, state, ctx) {
  const sp = w.spread;
  let value = sp.base;
  if (ctx.ads) value = sp.ads;
  else if (ctx.crouching) value *= sp.crouch;
  if (!ctx.ads) {
    const moveFactor = clamp(ctx.speed / COMBAT.movingSpreadRefSpeed, 0, 1.35);
    value += sp.move * moveFactor;
  } else {
    // Aiming down sights still penalises sprinting, just less.
    value += sp.move * clamp(ctx.speed / COMBAT.movingSpreadRefSpeed, 0, 1.35) * 0.45;
  }
  if (ctx.airborne) value += sp.air;
  value += state.bloom;
  return Math.min(value, sp.max + Math.max(sp.base, sp.ads));
}

/** Advance reload / bloom / pump timers. Called by the server every tick. */
export function updateWeapon(w, state, dt, now) {
  const sp = w.spread;
  if (state.bloom > 0 && now - state.lastShotAt > sp.recoverDelay) {
    state.bloom = Math.max(0, state.bloom - sp.recover * dt);
  }
  if (state.reloading && now >= state.reloadEndsAt) {
    finishReload(w, state);
  }
  if (state.pumpEndsAt && now >= state.pumpEndsAt) state.pumpEndsAt = 0;
}

export function finishReload(w, state) {
  if (w.shellReload) {
    // Shell-by-shell: one round per reload cycle, never touching the reserve
    // beyond what fits.
    if (state.reserve > 0 && state.ammo < w.magSize) {
      state.reserve--;
      state.ammo++;
    }
  } else {
    const want = w.magSize - state.ammo;
    const take = Math.min(want, state.reserve);
    state.ammo += take;
    state.reserve -= take;
  }
  state.reloading = false;
  state.reloadEndsAt = 0;
}

export function startReload(w, state, now) {
  if (state.reloading || state.reserve <= 0 || state.ammo >= w.magSize) return false;
  state.reloading = true;
  state.reloadStartedAt = now;
  const empty = state.ammo <= 0;
  state.reloadEndsAt = now + (empty ? w.reloadEmptyTime : w.reloadTime);
  return true;
}

export function cancelReload(state) {
  state.reloading = false;
  state.reloadEndsAt = 0;
}

/**
 * Attempt a trigger pull. Returns a descriptor for the shot or a reason why
 * nothing happened. `now` is the shared simulation clock in seconds.
 */
export function tryFire(w, state, now, ctx) {
  if (state.reloading) return { ok: false, reason: 'reloading' };
  if (state.ammo <= 0) return { ok: false, reason: 'empty' };
  if (state.pumpEndsAt && now < state.pumpEndsAt) return { ok: false, reason: 'cycling' };
  if (now < state.nextFireAt) return { ok: false, reason: 'rate' };

  // Trigger discipline: semi/bolt/pump need a release between shots.
  if (w.fireMode !== 'auto') {
    if (state.triggerWasDown) return { ok: false, reason: 'held' };
    state.triggerWasDown = true;
  }

  state.ammo--;
  state.shotIndex++;
  state.nextFireAt = now + shotInterval(w);
  state.lastShotAt = now;
  state.bloom = Math.min(w.spread.max * 1.4, state.bloom + w.spread.perShot);
  if (w.fireMode === 'pump' || w.fireMode === 'bolt') {
    state.pumpEndsAt = now + shotInterval(w) * 0.92;
  }

  const shotIndex = state.shotIndex - 1;
  const pattern = w.recoil.pattern[Math.min(shotIndex, w.recoil.pattern.length - 1)];
  const spread = currentSpread(w, state, ctx);
  return {
    ok: true,
    shotIndex,
    spread,
    recoilPattern: pattern,
    kick: w.recoil.kick,
  };
}

export function releaseTrigger(w, state) {
  if (w.fireMode !== 'auto') state.triggerWasDown = false;
}

// ---------------------------------------------------------------------------
// Shot resolution (shared by client prediction and the server's authority)
// ---------------------------------------------------------------------------

/**
 * Deterministic pellet directions for one shot.
 *
 * Both sides call this with the same seed, so the tracer the shooter sees is
 * the tracer the server resolves. Only pellets the server agrees on can do
 * damage, which keeps the client honest without a round trip per bullet.
 */
export function shotDirections(w, baseDir, spread, seed, out = []) {
  out.length = 0;
  const rng = makeRng(seed);
  for (let i = 0; i < w.pellets; i++) {
    if (spread <= 1e-6) {
      out.push([baseDir[0], baseDir[1], baseDir[2]]);
      continue;
    }
    // Uniform-ish disc with a gaussian falloff, so most pellets cluster near
    // the centre of the cone instead of spreading evenly to its edge.
    const a = rng() * Math.PI * 2;
    const r = Math.abs(randNormal(rng)) * 0.42;
    const mag = Math.min(Math.tan(spread) * r, Math.tan(spread) * 1.4);
    const cos = Math.cos(a) * mag;
    const sin = Math.sin(a) * mag;
    out.push(normalizeFromBase(baseDir, cos, sin));
  }
  return out;
}

/** Rotate `baseDir` by small offsets on its local right/up axes. */
function normalizeFromBase(base, rightOff, upOff) {
  // Build an orthonormal basis without allocating.
  const upX = 0;
  const upY = 1;
  const upZ = 0;
  let rx = base[1] * upZ - base[2] * upY;
  let ry = base[2] * upX - base[0] * upZ;
  let rz = base[0] * upY - base[1] * upX;
  let rl = Math.hypot(rx, ry, rz);
  if (rl < 1e-6) {
    rx = 1;
    ry = 0;
    rz = 0;
    rl = 1;
  }
  rx /= rl;
  ry /= rl;
  rz /= rl;
  const ux = ry * base[2] - rz * base[1];
  const uy = rz * base[0] - rx * base[2];
  const uz = rx * base[1] - ry * base[0];
  const x = base[0] + rx * rightOff + ux * upOff;
  const y = base[1] + ry * rightOff + uy * upOff;
  const z = base[2] + rz * rightOff + uz * upOff;
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
}

/** Damage multiplier from distance travelled. */
export function damageAtDistance(w, distance) {
  const f = w.falloff;
  if (distance <= f.start) return 1;
  const t = smoothstep(f.start, f.end, distance);
  return lerp(1, f.min, t);
}

/** Body-region multiplier, applied on top of falloff. */
export function partMultiplier(part) {
  if (part === 'head') return COMBAT.headMult;
  if (part === 'legs') return COMBAT.limbMult;
  return COMBAT.torsoMult;
}

/** Full damage for a resolved hit. */
export function computeDamage(w, distance, part) {
  return w.damage * damageAtDistance(w, distance) * partMultiplier(part);
}

/** Aim direction for a player, from their view angles. */
export function aimDirection(yaw, pitch) {
  return forwardFromAngles(yaw, pitch);
}

/**
 * Recoil contributed to the view by a shot. Returned in radians of pitch/yaw
 * offset; the caller decays it over time with `recoil.recovery`.
 */
export function recoilOffset(w, pattern, adsScale = 1) {
  const scale = adsScale;
  return {
    pitch: pattern[1] * 0.0125 * scale,
    yaw: pattern[0] * 0.0125 * scale,
  };
}

/** Effective movement speed multiplier while a weapon is equipped. */
export function weaponMoveMultiplier(w, { ads, sprinting }) {
  let m = w.mobility;
  if (ads) m *= w.ads.moveMult;
  if (sprinting) m *= 0.92;
  return clamp(m, 0.3, 1.4);
}

/** Headshot threshold used by the HUD and the kill feed. */
export function isHeadshot(part) {
  return part === 'head';
}

/** Weapon categories a bot may be assigned, weighted by archetype. */
export function pickWeaponFor(rng, archetype) {
  if (archetype === 'sniper') return 'sniper';
  if (archetype === 'defensive') return rng() < 0.5 ? 'dmr' : 'ar';
  if (archetype === 'aggressive') return rng() < 0.5 ? 'smg' : 'shotgun';
  const pool = ['ar', 'ar', 'smg', 'dmr', 'shotgun'];
  return pool[Math.floor(rng() * pool.length)];
}

export { PLAYER };
