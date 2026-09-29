import { rayBox, raySphere, clamp, EPS, makeBox } from './math.js';
import { PLAYER } from './constants.js';

/**
 * The collision world.
 *
 * Two brush families exist:
 *   - BOXES  full solid AABBs (walls, crates, roofs). They block movement in all
 *            three axes and stop bullets.
 *   - RAMPS  axis-aligned slopes with a `heightAt(x, z)` surface. They are
 *            walkable ground and never block horizontally, which is what keeps
 *            bot pathing and player movement smooth on stairs and hills.
 *
 * Everything is bucketed into a uniform XZ grid so that a 60 m bullet trace or
 * a 200-cell nav bake touches only the handful of brushes that matter.
 */

const CELL = 6;

export class SolidGrid {
  constructor(bounds, cell = CELL) {
    this.cell = cell;
    this.minX = bounds.min[0];
    this.minZ = bounds.min[2];
    this.cols = Math.max(1, Math.ceil((bounds.max[0] - bounds.min[0]) / cell) + 1);
    this.rows = Math.max(1, Math.ceil((bounds.max[2] - bounds.min[2]) / cell) + 1);
    this.buckets = new Array(this.cols * this.rows);
    for (let i = 0; i < this.buckets.length; i++) this.buckets[i] = null;
    // Stamp array turns the result de-duplication from O(n^2) into O(n).
    // Raycasts fire thousands of times a second, so this matters.
    this._seen = new Int32Array(0);
    this._stamp = 0;
  }

  _ensureSeen(n) {
    if (this._seen.length < n) this._seen = new Int32Array(n);
  }

  cx(x) {
    return clamp(Math.floor((x - this.minX) / this.cell), 0, this.cols - 1);
  }

  cz(z) {
    return clamp(Math.floor((z - this.minZ) / this.cell), 0, this.rows - 1);
  }

  insert(idx, box) {
    const x0 = this.cx(box[0]);
    const x1 = this.cx(box[3]);
    const z0 = this.cz(box[2]);
    const z1 = this.cz(box[5]);
    for (let x = x0; x <= x1; x++) {
      for (let z = z0; z <= z1; z++) {
        const k = x * this.rows + z;
        let b = this.buckets[k];
        if (!b) b = this.buckets[k] = [];
        b.push(idx);
      }
    }
  }

  /** Collect the union of bucket contents covering an XZ rectangle. */
  queryXZ(minX, minZ, maxX, maxZ, out) {
    out.length = 0;
    const x0 = this.cx(minX);
    const x1 = this.cx(maxX);
    const z0 = this.cz(minZ);
    const z1 = this.cz(maxZ);
    const stamp = ++this._stamp;
    const seen = this._seen;
    for (let x = x0; x <= x1; x++) {
      for (let z = z0; z <= z1; z++) {
        const b = this.buckets[x * this.rows + z];
        if (!b) continue;
        for (let i = 0; i < b.length; i++) {
          const v = b[i];
          if (v < seen.length) {
            if (seen[v] === stamp) continue;
            seen[v] = stamp;
          }
          out.push(v);
        }
      }
    }
    return out;
  }
}

/** Exact ray/slope-surface intersection for walkable ramps. */
function rayRamp(origin, dir, solid, maxDist) {
  const r = solid.ramp;
  const axis = r.axis === 'x' ? 0 : 2;
  const cross = r.axis === 'x' ? 2 : 0;
  const span = solid.box[axis + 3] - solid.box[axis];
  if (span < EPS) return -1;
  const slope = (r.highY - r.lowY) / span;
  const b = r.dir > 0 ? slope : -slope;
  const base = r.dir > 0 ? solid.box[axis] : solid.box[axis + 3];
  // Surface plane: y = lowY + b * (coord - base)
  const a = r.lowY - b * base;
  const dn = dir[1] - b * dir[axis];
  if (Math.abs(dn) < EPS) return -1;
  const s = (a + b * origin[axis] - origin[1]) / dn;
  if (s < 0 || s > maxDist) return -1;
  const hx = origin[axis] + dir[axis] * s;
  const hy = origin[1] + dir[1] * s;
  const hz = origin[cross] + dir[cross] * s;
  if (hx < solid.box[0] - EPS || hx > solid.box[3] + EPS) return -1;
  if (hz < solid.box[2] - EPS || hz > solid.box[5] + EPS) return -1;
  // Reject hits above the wedge or rooted below its base.
  if (hy > Math.max(r.lowY, r.highY) + EPS || hy < Math.min(r.lowY, r.highY) - EPS) return -1;
  void hy;
  return s;
}

function rampSurfaceY(solid, x, z) {
  const r = solid.ramp;
  const axis = r.axis === 'x' ? 0 : 2;
  const span = solid.box[axis + 3] - solid.box[axis];
  if (span < EPS) return null;
  const coord = axis === 0 ? x : z;
  const base = r.dir > 0 ? solid.box[axis] : solid.box[axis + 3];
  const t = clamp(((coord - base) * r.dir) / span, 0, 1);
  return r.lowY + t * (r.highY - r.lowY);
}

const RAMP_SLICES = 14;

/** Decompose a ramp wedge into thin axis-aligned slabs for volumetric tests. */
function buildRampSlices(box, axis, dir, lowY, highY) {
  const out = [];
  const a0 = axis === 'x' ? box[0] : box[2];
  const a1 = axis === 'x' ? box[3] : box[5];
  const span = a1 - a0;
  const width = axis === 'x' ? span / RAMP_SLICES : span / RAMP_SLICES;
  const base = Math.min(lowY, highY);
  for (let i = 0; i < RAMP_SLICES; i++) {
    const t = (i + 1) / RAMP_SLICES;
    // Height of the slope at the far (higher) edge of this slice.
    const y = dir > 0 ? lowY + t * (highY - lowY) : highY - t * (highY - lowY);
    const top = Math.max(y, base);
    const lo = a0 + i * width;
    const hi = lo + width;
    if (axis === 'x') out.push([lo, base, box[2], hi, top, box[5]]);
    else out.push([box[0], base, lo, box[3], top, hi]);
  }
  return out;
}

export function buildWorld(level) {
  const solids = [];
  const navSolids = [];

  for (const brush of level.brushes) {
    // Purely decorative brushes never enter the collision world at all: the
    // client still draws them straight from the level data. Keeping them out of
    // both grids means road markings, pipe bundles and razor wire cannot stop a
    // bullet or trip a bot.
    if (brush.collide === false) continue;
    const [px, py, pz] = brush.p;
    const [sx, sy, sz] = brush.s;
    const nav = brush.nav !== false;

    let solid;
    if (brush.t === 'ramp') {
      const lowY = py - sy / 2;
      const highY = py + sy / 2;
      const axis = brush.axis || 'x';
      const dir = brush.dir >= 0 ? 1 : -1;
      const box = makeBox(px, py, pz, sx, sy, sz);
      solid = {
        kind: 'ramp',
        box,
        mat: brush.mat,
        brush,
        nav: brush.nav !== false,
        ramp: { axis, dir, lowY, highY },
        // A ramp is a WEDGE of solid material, not a floating slope. Anything
        // that needs volumetric collision (player movement, nav probes) walks
        // this staircase of slices rather than the ramp's bounding box -- using
        // the bounding box would fill the walkable airspace above the low end
        // with solid stone. Bullets use the exact plane test instead.
        slices: buildRampSlices(box, axis, dir, lowY, highY),
      };
    } else {
      // Cylinders and cones reuse the box collider; the visual stays round.
      // `p` is always the CENTRE for every brush type.
      solid = {
        kind: 'box',
        box: makeBox(px, py, pz, sx, sy, sz),
        mat: brush.mat,
        brush,
        nav,
        // `top: false` = this solid blocks movement and sight but its roof is
        // not somewhere anyone can stand. Perimeter walls, berms and container
        // roofs are unreachable anyway; without this they litter the nav graph
        // with isolated islands that cost memory and hide real problems.
        top: brush.top !== false,
      };
    }

    const idx = solids.length;
    solids.push(solid);
    if (solid.nav) navSolids.push(idx);
  }

  const grid = new SolidGrid(level.bounds);
  const navGrid = new SolidGrid(level.bounds);
  grid._ensureSeen(solids.length);
  navGrid._ensureSeen(solids.length);
  for (let i = 0; i < solids.length; i++) {
    grid.insert(i, solids[i].box);
    if (solids[i].nav) navGrid.insert(i, solids[i].box);
  }

  const scratch = [];

  /**
   * Highest walkable surface at or below `maxY`. Returns -Infinity when the
   * column is empty (a bottomless pit), which callers treat as "void".
   */
  function groundAt(x, z, maxY = Infinity) {
    let best = -Infinity;
    navGrid.queryXZ(x, z, x, z, scratch);
    for (let i = 0; i < scratch.length; i++) {
      const s = solids[scratch[i]];
      if (x < s.box[0] - EPS || x > s.box[3] + EPS) continue;
      if (z < s.box[2] - EPS || z > s.box[5] + EPS) continue;
      let top;
      if (s.kind === 'ramp') top = rampSurfaceY(s, x, z);
      else top = s.box[4];
      if (top === null) continue;
      if (top <= maxY + 1e-4 && top > best) best = top;
    }
    return best;
  }

  /** Lowest navigable solid underside above `minY` (bot headroom). */
  function ceilingAt(x, z, minY = -Infinity) {
    let best = Infinity;
    navGrid.queryXZ(x, z, x, z, scratch);
    for (let i = 0; i < scratch.length; i++) {
      const s = solids[scratch[i]];
      if (s.kind === 'ramp') continue;
      if (x < s.box[0] - EPS || x > s.box[3] + EPS) continue;
      if (z < s.box[2] - EPS || z > s.box[5] + EPS) continue;
      if (s.box[1] >= minY - 1e-4 && s.box[1] < best) best = s.box[1];
    }
    return best;
  }

  /**
   * Ground height for PHYSICS, using every collidable solid (including roofs
   * and other `nav: false` geometry). Navigation uses `groundAt` instead, which
   * only sees navigable surfaces -- the two questions are genuinely different.
   */
  function groundAtSolid(x, z, maxY = Infinity) {
    let best = -Infinity;
    grid.queryXZ(x, z, x, z, scratch);
    for (let i = 0; i < scratch.length; i++) {
      const s = solids[scratch[i]];
      if (x < s.box[0] - EPS || x > s.box[3] + EPS) continue;
      if (z < s.box[2] - EPS || z > s.box[5] + EPS) continue;
      const top = s.kind === 'ramp' ? rampSurfaceY(s, x, z) : s.box[4];
      if (top === null) continue;
      if (top <= maxY + 1e-4 && top > best) best = top;
    }
    return best;
  }

  /**
   * Lowest solid underside that overlaps the given footprint above `minY`.
   * This is the headroom test for standing up out of a crouch.
   */
  function ceilingOver(minX, minZ, maxX, maxZ, minY) {
    let best = Infinity;
    grid.queryXZ(minX, minZ, maxX, maxZ, scratch);
    for (let i = 0; i < scratch.length; i++) {
      const s = solids[scratch[i]];
      if (s.kind === 'ramp') continue;
      const b = s.box;
      if (maxX <= b[0] || minX >= b[3] || maxZ <= b[2] || minZ >= b[5]) continue;
      if (b[1] >= minY - 1e-4 && b[1] < best) best = b[1];
    }
    return best;
  }

  /** Does an AABB intersect any collider? Ramps test their wedge, not their box. */
  function overlapsSolid(box, opts = {}) {
    const useNav = opts.navOnly !== false;
    const source = useNav ? navGrid : grid;
    source.queryXZ(box[0], box[2], box[3], box[5], scratch);
    for (let i = 0; i < scratch.length; i++) {
      const s = solids[scratch[i]];
      if (!useNav && !s.nav) continue;
      if (s.kind === 'ramp') {
        const sl = s.slices;
        for (let k = 0; k < sl.length; k++) {
          const b = sl[k];
          if (box[0] < b[3] && box[3] > b[0] && box[1] < b[4] && box[4] > b[1] && box[2] < b[5] && box[5] > b[2]) {
            return s;
          }
        }
        continue;
      }
      const b = s.box;
      if (box[0] < b[3] && box[3] > b[0] && box[1] < b[4] && box[4] > b[1] && box[2] < b[5] && box[5] > b[2]) {
        return s;
      }
    }
    return null;
  }

  /** Every solid whose wedge/box overlaps an AABB (movement needs them all). */
  function collectSolids(box, opts = {}) {
    const useNav = opts.navOnly !== false;
    const source = useNav ? navGrid : grid;
    source.queryXZ(box[0], box[2], box[3], box[5], scratch);
    const out = [];
    for (let i = 0; i < scratch.length; i++) {
      const s = solids[scratch[i]];
      if (!useNav && !s.nav) continue;
      const list = s.kind === 'ramp' ? s.slices : [s.box];
      for (const b of list) {
        if (box[0] < b[3] && box[3] > b[0] && box[1] < b[4] && box[4] > b[1] && box[2] < b[5] && box[5] > b[2]) {
          out.push({ solid: s, box: b });
          break;
        }
      }
    }
    return out;
  }

  /**
   * Closest solid hit along a ray. Returns `{ t, point, normal, solid }` or
   * null. `mask` may be 'bullets' (default) or 'sight' -- identical today, but
   * it keeps the door open for glass that stops sight but not rounds.
   */
  function raycast(origin, dir, maxDist = 200, opts = {}) {
    const skip = opts.skip || null;
    const endX = origin[0] + dir[0] * maxDist;
    const endZ = origin[2] + dir[2] * maxDist;
    grid.queryXZ(
      Math.min(origin[0], endX),
      Math.min(origin[2], endZ),
      Math.max(origin[0], endX),
      Math.max(origin[2], endZ),
      scratch,
    );
    let bestT = maxDist;
    let bestSolid = null;
    let bestAxis = 1;
    for (let i = 0; i < scratch.length; i++) {
      const s = solids[scratch[i]];
      if (skip && skip.has(s)) continue;
      if (s.kind === 'ramp') {
        const t = rayRamp(origin, dir, s, bestT);
        if (t >= 0 && t < bestT) {
          bestT = t;
          bestSolid = s;
          bestAxis = 1;
        }
        continue;
      }
      const hit = rayBox(origin, dir, s.box, bestT);
      if (hit !== -1 && hit.t < bestT) {
        bestT = hit.t;
        bestSolid = s;
        bestAxis = hit.axis;
      }
    }
    if (!bestSolid) return null;
    const point = [origin[0] + dir[0] * bestT, origin[1] + dir[1] * bestT, origin[2] + dir[2] * bestT];
    const normal = [0, 0, 0];
    if (bestSolid.kind === 'ramp') {
      const r = bestSolid.ramp;
      const span = bestSolid.box[(r.axis === 'x' ? 0 : 2) + 3] - bestSolid.box[r.axis === 'x' ? 0 : 2];
      const slope = ((r.highY - r.lowY) / span) * r.dir;
      const n = r.axis === 'x' ? [-slope, 1, 0] : [0, 1, -slope];
      const l = Math.hypot(n[0], n[1], n[2]) || 1;
      normal[0] = n[0] / l;
      normal[1] = n[1] / l;
      normal[2] = n[2] / l;
    } else {
      const comp = bestAxis >= 0 && bestAxis <= 2 ? bestAxis : 1;
      normal[comp] = dir[comp] > 0 ? -1 : 1;
    }
    return { t: bestT, point, normal, solid: bestSolid, distance: bestT };
  }

  /** Convenience: is there clear line of sight between two points? */
  function lineOfSight(a, b, opts = {}) {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const dz = b[2] - a[2];
    const dist = Math.hypot(dx, dy, dz);
    if (dist < EPS) return true;
    const dir = [dx / dist, dy / dist, dz / dist];
    const hit = raycast(a, dir, dist - 0.02, opts);
    return !hit;
  }

  /**
   * Every navigable surface in one column, ascending. Multi-level geometry
   * (catwalks over corridors, roofs over interiors) needs more than a single
   * height per cell, and this is the query the nav baker builds on.
   */
  function columnSurfaces(x, z, maxY = Infinity) {
    const out = [];
    let rampCap = -Infinity;
    navGrid.queryXZ(x, z, x, z, scratch);
    for (let i = 0; i < scratch.length; i++) {
      const s = solids[scratch[i]];
      if (!s.nav) continue;
      if (s.kind === 'box' && s.top === false) continue;
      if (x < s.box[0] - EPS || x > s.box[3] + EPS) continue;
      if (z < s.box[2] - EPS || z > s.box[5] + EPS) continue;
      const top = s.kind === 'ramp' ? rampSurfaceY(s, x, z) : s.box[4];
      if (top === null || top > maxY + 1e-4) continue;
      if (s.kind === 'ramp' && top > rampCap) rampCap = top;
      out.push(top);
    }
    // A ramp is a *solid wedge*, not a slope floating above the ground. It is
    // therefore the only navigable surface in its own footprint: leaving the
    // terrain under it in the list would create a phantom lower layer that
    // splits the map into disconnected islands.
    const filtered = rampCap === -Infinity ? out : out.filter((t) => t >= rampCap - 1e-3);
    filtered.sort((a, b) => a - b);
    return filtered;
  }

  /** True when a body of `height` fits standing on `feetY` at (x, z). */
  function hasClearance(x, z, feetY, height, radius = PLAYER.radius) {
    const probe = makeBox(x, 0, z, radius * 2, height, radius * 2);
    probe[1] = feetY + 0.08;
    probe[4] = feetY + height;
    return !overlapsSolid(probe);
  }

  function spawnsFor(team) {
    const s = level.spawns || {};
    return s[team] || s.ffa || s.a || [[0, 0, 0]];
  }

  return {
    level,
    solids,
    grid,
    navGrid,
    bounds: level.bounds,
    groundAt,
    groundAtSolid,
    ceilingAt,
    ceilingOver,
    columnSurfaces,
    overlapsSolid,
    collectSolids,
    raycast,
    lineOfSight,
    hasClearance,
    spawnsFor,
    rampSurfaceY: (solid, x, z) => rampSurfaceY(solid, x, z),
  };
}

/** Bullet-vs-character hit shapes, shared so client feedback == server truth. */
export function playerHitboxes(pos, height, crouching) {
  const y = pos[1];
  const h = crouching ? PLAYER.heightCrouch : height;
  const headY = crouching ? 0.98 : 1.56;
  const headR = 0.14;
  const torsoBase = y + 0.78;
  const torsoHeight = (crouching ? 0.42 : 0.68);
  const torsoR = 0.27;
  return {
    head: { center: [pos[0], y + headY, pos[2]], radius: headR },
    torso: { base: [pos[0], torsoBase, pos[2]], radius: torsoR, height: torsoHeight },
    legs: makeBox(pos[0], y + 0.42, pos[2], 0.52, 0.84, 0.42),
    top: h,
  };
}

/** Nearest player hit along a ray. Returns `{ player, part, distance }` or null. */
export function raycastPlayers(players, origin, dir, maxDist, filter) {
  let best = null;
  for (let i = 0; i < players.length; i++) {
    const p = players[i];
    if (!p.alive) continue;
    if (filter && !filter(p)) continue;
    const boxes = playerHitboxes(p.pos, PLAYER.heightStand, p.crouching);
    const th = raySphere(origin, dir, boxes.head.center, boxes.head.radius, maxDist);
    const tt = Math.hypot(
      boxes.torso.base[0] - origin[0],
      boxes.torso.base[1] - origin[1],
      boxes.torso.base[2] - origin[2],
    );
    const torsoDist = rayCapsuleApprox(origin, dir, boxes.torso, maxDist);
    const tl = rayBox(origin, dir, boxes.legs, maxDist);
    const legsDist = tl === -1 ? -1 : tl.t;
    const parts = [
      ['head', th],
      ['torso', torsoDist],
      ['legs', legsDist],
    ];
    for (const [part, d] of parts) {
      if (d < 0 || d > maxDist) continue;
      if (!best || d < best.distance) best = { player: p, part, distance: d };
    }
    void tt;
  }
  return best;
}

/** Capsule vs ray, marching + bisection (kept local to avoid a cycle). */
function rayCapsuleApprox(origin, dir, capsule, maxDist) {
  const inside = (t) => {
    const py = origin[1] + dir[1] * t;
    const cy = clamp(py, capsule.base[1], capsule.base[1] + capsule.height);
    const dx = origin[0] + dir[0] * t - capsule.base[0];
    const dy = py - cy;
    const dz = origin[2] + dir[2] * t - capsule.base[2];
    return dx * dx + dy * dy + dz * dz <= capsule.radius * capsule.radius;
  };
  if (inside(0)) return 0;
  let lo = 0;
  const hi = Math.min(maxDist, 300);
  const steps = 26;
  for (let i = 1; i <= steps; i++) {
    const t = (hi * i) / steps;
    if (inside(t)) {
      let a = lo;
      let b = t;
      for (let k = 0; k < 12; k++) {
        const mid = (a + b) / 2;
        if (inside(mid)) b = mid;
        else a = mid;
      }
      return b;
    }
    lo = t;
  }
  return -1;
}
