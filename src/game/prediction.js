/**
 * Client-side netcode primitives.
 *
 * Two separate problems live here, and conflating them is the usual source of
 * "the netcode feels bad" bugs:
 *
 *   1. THE LOCAL PLAYER must feel instant. We run the identical `stepPlayer`
 *      the server runs, immediately, on every input. When the server's answer
 *      finally arrives we compare it to what we predicted for that exact tick
 *      and smooth the difference away instead of yanking the camera.
 *
 *   2. EVERYONE ELSE only exists as 20 snapshots a second. They are rendered a
 *      fixed ~100 ms in the past and interpolated between the two snapshots
 *      that bracket that time, so they move smoothly rather than teleporting
 *      20 times a second.
 *
 * Prediction only ever covers movement. Damage, ammo, health and hit
 * registration are always the server's, because those are the things a client
 * must never be trusted with.
 */

import { PLAYER, NET } from '../net/shared/constants.js';
import { stepPlayer, makePlayerState } from '../net/shared/movement.js';
import { weaponMoveMultiplier } from '../net/shared/weapons.js';

/** Beyond this the prediction was simply wrong (teleport, respawn, death). */
const SNAP_DISTANCE = 1.6;
/** Below this the difference is invisible and correcting it causes shimmer. */
const IGNORE_DISTANCE = 0.02;
/** How long a correction takes to blend out. Short enough to stay honest. */
const SMOOTH_TIME = 0.12;

// ---------------------------------------------------------------------------
// Interpolation
// ---------------------------------------------------------------------------

/** Linear interpolation with the shortest-path wrap across ±PI. */
export function lerpAngle(a, b, t) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/**
 * A ring buffer of snapshots that answers "what did the world look like at
 * time T", by interpolating between the snapshots either side of T.
 */
export class SnapshotBuffer {
  constructor({ capacity = 40, interpDelay = NET.interpDelay } = {}) {
    this.capacity = capacity;
    this.interpDelay = interpDelay;
    this.items = [];
    this.latest = null;
    this.renderTime = 0;
  }

  push(snap) {
    if (this.latest && snap.tick <= this.latest.tick) return; // late or duplicate
    this.items.push(snap);
    if (this.items.length > this.capacity) this.items.shift();
    this.latest = snap;
  }

  clear() {
    this.items.length = 0;
    this.latest = null;
  }

  get size() {
    return this.items.length;
  }

  /**
   * Interpolate every player row at `renderTime`. Rows are returned as plain
   * objects (not the positional arrays) because the renderer wants names.
   */
  sample(renderTime = this.renderTime) {
    this.renderTime = renderTime;
    if (!this.items.length) return [];
    if (this.items.length === 1) return this.items[0].players.map(toObject);

    const target = renderTime;
    // Walk back from the newest snapshot to find the pair bracketing `target`.
    let hi = this.items.length - 1;
    while (hi > 0 && this.items[hi].t > target) hi--;
    const a = this.items[hi];
    const b = this.items[Math.min(hi + 1, this.items.length - 1)];

    // Snapshots are stamped with server time, so convert to seconds.
    const span = Math.max(1e-4, b.t - a.t);
    const alpha = Math.max(0, Math.min(1, (target - a.t) / span));

    const byId = new Map();
    for (const row of a.players) byId.set(row[0], row);
    const out = [];
    for (const rowB of b.players) {
      const rowA = byId.get(rowB[0]);
      if (!rowA) {
        out.push(toObject(rowB));
        continue;
      }
      const obj = toObject(rowB);
      obj.x = lerp(rowA[1], rowB[1], alpha);
      obj.y = lerp(rowA[2], rowB[2], alpha);
      obj.z = lerp(rowA[3], rowB[3], alpha);
      obj.yaw = lerpAngle(rowA[4], rowB[4], alpha);
      obj.pitch = lerp(rowA[5], rowB[5], alpha);
      obj.height = lerp(rowA[22], rowB[22], alpha);
      out.push(obj);
    }
    return out;
  }
}

export function toObject(row) {
  const flags = row[8];
  return {
    id: row[0],
    x: row[1],
    y: row[2],
    z: row[3],
    yaw: row[4],
    pitch: row[5],
    recoilPitch: row[6],
    recoilYaw: row[7],
    flags,
    grounded: (flags & 1) !== 0,
    crouching: (flags & 2) !== 0,
    sprinting: (flags & 4) !== 0,
    ads: (flags & 8) !== 0,
    reloading: (flags & 16) !== 0,
    firing: (flags & 32) !== 0,
    dead: (flags & 128) !== 0,
    health: row[9],
    armor: row[10],
    team: row[11],
    weapon: row[12],
    ammo: row[13],
    ammoPrimary: row[14],
    ammoSecondary: row[15],
    kills: row[16],
    deaths: row[17],
    assists: row[18],
    score: row[19],
    height: row[22],
  };
}

// ---------------------------------------------------------------------------
// Local prediction
// ---------------------------------------------------------------------------

/**
 * Drives the local player through the same movement code the server runs, and
 * quietly reconciles when the server disagrees.
 */
export class LocalPredictor {
  constructor({ world, spawn, yaw = 0, tickRate = NET.tickRate }) {
    this.world = world;
    this.state = makePlayerState(spawn, yaw);
    this.state.grounded = true;
    this.tick = 1 / tickRate;
    this.accumulator = 0;
    /** Simulated ticks produced locally but not yet confirmed by the server. */
    this.predictedTick = 0;
    /** tick -> { pos, vel, yaw, pitch } as we predicted it at that tick. */
    this.history = new Map();
    this.historyLimit = 240;

    this.offset = [0, 0, 0];
    this.offsetTime = 0;
    this.corrections = 0;
    this.bigCorrections = 0;
    this.enabled = true;
  }

  reset(spawn, yaw) {
    this.state = makePlayerState(spawn, yaw);
    this.state.grounded = true;
    this.accumulator = 0;
    this.predictedTick = 0;
    this.history.clear();
    this.offset[0] = this.offset[1] = this.offset[2] = 0;
    this.offsetTime = 0;
  }

  /** The position the camera should actually use (prediction + live offset). */
  renderPos(out = [0, 0, 0]) {
    out[0] = this.state.pos[0] + this.offset[0];
    out[1] = this.state.pos[1] + this.offset[1];
    out[2] = this.state.pos[2] + this.offset[2];
    return out;
  }

  /**
   * Advance prediction for one frame. The step is fixed-rate to mirror the
   * server exactly: the newest input is what the server will integrate, so the
   * client integrates the same newest input, once per server tick.
   */
  update(dt, input, weapon) {
    if (this.offsetTime > 0) {
      const decay = Math.max(0, 1 - dt / SMOOTH_TIME);
      this.offset[0] *= decay;
      this.offset[1] *= decay;
      this.offset[2] *= decay;
      this.offsetTime = Math.max(0, this.offsetTime - dt);
    }

    this.accumulator += dt;
    let steps = 0;
    const moveMult = weaponMoveMultiplier(weapon, { ads: !!input.ads, sprinting: false });
    while (this.accumulator >= this.tick && steps < 6) {
      this.accumulator -= this.tick;
      steps++;
      this.predictedTick++;
      stepPlayer(this.world, this.state, input, this.tick, { moveMult, canJump: true, canSprint: true });
      this.remember(this.predictedTick);
    }
    // A long stall must not be replayed in full: drop the backlog instead.
    if (this.accumulator > this.tick * 6) this.accumulator = 0;

    if (this.history.size > this.historyLimit) {
      let oldest = Infinity;
      for (const k of this.history.keys()) if (k < oldest) oldest = k;
      this.history.delete(oldest);
    }
  }

  /**
   * Advance exactly one simulation tick. Used offline, where the client also
   * drives the authoritative simulation: stepping both from the same accumulator
   * with the same input makes prediction and truth bit-identical, so there is
   * nothing to reconcile and local play is perfectly crisp.
   */
  stepOnce(input, weapon) {
    this.predictedTick++;
    const moveMult = weaponMoveMultiplier(weapon, { ads: !!input.ads, sprinting: false });
    stepPlayer(this.world, this.state, input, this.tick, { moveMult, canJump: true, canSprint: true });
    this.remember(this.predictedTick);
    return this.state;
  }

  remember(tick) {
    this.history.set(tick, {
      pos: [this.state.pos[0], this.state.pos[1], this.state.pos[2]],
      vel: [this.state.vel[0], this.state.vel[1], this.state.vel[2]],
      yaw: this.state.yaw,
      pitch: this.state.pitch,
    });
  }

  /**
   * Fold in the server's authoritative row for `ackTick`.
   *
   * Small errors become a decaying offset so the camera never jitters; large
   * errors (respawn, teleport, a wall we walked through) snap, because blending
   * a teleport would slide the player across the map.
   */
  reconcile(row, ackTick, { hard = false } = {}) {
    if (!this.enabled || !row) return;
    const serverPos = [row[1], row[2], row[3]];

    // Everything at or before the ack is settled history: prune before reading
    // so the map cannot grow without bound on a long-lived connection.
    const predicted = this.history.get(ackTick);
    for (const key of [...this.history.keys()]) if (key <= ackTick) this.history.delete(key);

    // With no comparable prediction (the very first snapshot after a respawn, a
    // round reset, a teleport) there is nothing to blend against. Adopt the
    // server position only when it is obviously somewhere else, so a spawn does
    // not get fought over frame by frame.
    if (hard || !predicted) {
      if (hard || distance(this.state.pos, serverPos) > SNAP_DISTANCE) this.hardSnap(serverPos);
      return;
    }

    const err = [
      serverPos[0] - predicted.pos[0],
      serverPos[1] - predicted.pos[1],
      serverPos[2] - predicted.pos[2],
    ];
    const d = Math.hypot(err[0], err[1], err[2]);
    if (d <= IGNORE_DISTANCE) return;

    if (d > SNAP_DISTANCE) {
      this.hardSnap(serverPos);
      this.bigCorrections++;
      return;
    }

    // A small disagreement becomes an offset that decays over SMOOTH_TIME, so
    // the correction is invisible instead of a one-frame twitch.
    this.offset[0] = err[0];
    this.offset[1] = err[1];
    this.offset[2] = err[2];
    this.offsetTime = SMOOTH_TIME;
    this.corrections++;
  }

  hardSnap(serverPos) {
    this.state.pos[0] = serverPos[0];
    this.state.pos[1] = serverPos[1];
    this.state.pos[2] = serverPos[2];
    this.offset[0] = this.offset[1] = this.offset[2] = 0;
    this.offsetTime = 0;
  }

  get speed() {
    return Math.hypot(this.state.vel[0], this.state.vel[2]);
  }

  get eyeHeight() {
    return this.state.height * 0.9;
  }

  get eyeY() {
    return this.renderPos()[1] + this.eyeHeight;
  }
}

function distance(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

export { SNAP_DISTANCE, IGNORE_DISTANCE, PLAYER };
