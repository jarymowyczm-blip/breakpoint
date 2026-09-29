/**
 * Deterministic scalar / vector math shared by the browser client and the
 * authoritative Node server. Deliberately dependency free: the server must be
 * able to import these modules without pulling in Three.js or any DOM API.
 *
 * Vectors are plain arrays [x, y, z] so they survive JSON round trips and can be
 * copied cheaply into network snapshots.
 */

export const EPS = 1e-6;

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

export function saturate(v) {
  return clamp(v, 0, 1);
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** Frame-rate independent exponential smoothing. */
export function damp(a, b, lambda, dt) {
  return lerp(a, b, 1 - Math.exp(-lambda * dt));
}

/** Move `a` toward `b` by at most `maxDelta`. */
export function moveToward(a, b, maxDelta) {
  const d = b - a;
  if (Math.abs(d) <= maxDelta) return b;
  return a + Math.sign(d) * maxDelta;
}

export function smoothstep(edge0, edge1, x) {
  const t = saturate((x - edge0) / (edge1 - edge0 || EPS));
  return t * t * (3 - 2 * t);
}

export function deg2rad(d) {
  return (d * Math.PI) / 180;
}

export function rad2deg(r) {
  return (r * 180) / Math.PI;
}

/** Wrap an angle into (-PI, PI]. */
export function wrapAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a <= -Math.PI) a += Math.PI * 2;
  return a;
}

/** Shortest signed delta from angle `a` to angle `b`. */
export function angleDelta(a, b) {
  return wrapAngle(b - a);
}

// ---------------------------------------------------------------------------
// vec3
// ---------------------------------------------------------------------------

export function v3(x = 0, y = 0, z = 0) {
  return [x, y, z];
}

export function vcopy(a) {
  return [a[0], a[1], a[2]];
}

export function vset(out, x, y, z) {
  out[0] = x;
  out[1] = y;
  out[2] = z;
  return out;
}

export function vadd(a, b, out = [0, 0, 0]) {
  out[0] = a[0] + b[0];
  out[1] = a[1] + b[1];
  out[2] = a[2] + b[2];
  return out;
}

export function vsub(a, b, out = [0, 0, 0]) {
  out[0] = a[0] - b[0];
  out[1] = a[1] - b[1];
  out[2] = a[2] - b[2];
  return out;
}

export function vscale(a, s, out = [0, 0, 0]) {
  out[0] = a[0] * s;
  out[1] = a[1] * s;
  out[2] = a[2] * s;
  return out;
}

export function vaddScaled(a, b, s, out = [0, 0, 0]) {
  out[0] = a[0] + b[0] * s;
  out[1] = a[1] + b[1] * s;
  out[2] = a[2] + b[2] * s;
  return out;
}

export function vdot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function vcross(a, b, out = [0, 0, 0]) {
  const x = a[1] * b[2] - a[2] * b[1];
  const y = a[2] * b[0] - a[0] * b[2];
  const z = a[0] * b[1] - a[1] * b[0];
  out[0] = x;
  out[1] = y;
  out[2] = z;
  return out;
}

export function vlen(a) {
  return Math.hypot(a[0], a[1], a[2]);
}

export function vlen2(a) {
  return a[0] * a[0] + a[1] * a[1] + a[2] * a[2];
}

export function vdist(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

export function vdist2(a, b) {
  const x = a[0] - b[0];
  const y = a[1] - b[1];
  const z = a[2] - b[2];
  return x * x + y * y + z * z;
}

export function vnorm(a, out = [0, 0, 0]) {
  const l = Math.hypot(a[0], a[1], a[2]);
  if (l < EPS) {
    out[0] = 0;
    out[1] = 0;
    out[2] = 0;
    return out;
  }
  const inv = 1 / l;
  out[0] = a[0] * inv;
  out[1] = a[1] * inv;
  out[2] = a[2] * inv;
  return out;
}

export function vlerp(a, b, t, out = [0, 0, 0]) {
  out[0] = a[0] + (b[0] - a[0]) * t;
  out[1] = a[1] + (b[1] - a[1]) * t;
  out[2] = a[2] + (b[2] - a[2]) * t;
  return out;
}

/**
 * Build a unit forward vector from yaw/pitch using the same convention the
 * renderer and the movement code use: yaw rotates about +Y (0 = looking down
 * -Z), pitch is positive when looking up.
 */
export function forwardFromAngles(yaw, pitch, out = [0, 0, 0]) {
  const cp = Math.cos(pitch);
  out[0] = -Math.sin(yaw) * cp;
  out[1] = Math.sin(pitch);
  out[2] = -Math.cos(yaw) * cp;
  return out;
}

/** Horizontal right-hand vector for a given yaw. */
export function rightFromYaw(yaw, out = [0, 0, 0]) {
  out[0] = Math.cos(yaw);
  out[1] = 0;
  out[2] = -Math.sin(yaw);
  return out;
}

// ---------------------------------------------------------------------------
// Random
// ---------------------------------------------------------------------------

/** Small, fast, seedable PRNG (mulberry32). Deterministic across platforms. */
export function makeRng(seed = 1) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randRange(rng, lo, hi) {
  return lo + rng() * (hi - lo);
}

export function pick(rng, arr) {
  return arr[Math.min(arr.length - 1, Math.floor(rng() * arr.length))];
}

/** Standard normal via Box-Muller, cheap enough for per-shot spread. */
export function randNormal(rng) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ---------------------------------------------------------------------------
// Axis aligned boxes + ray intersection
// ---------------------------------------------------------------------------

/** Boxes are `[minX, minY, minZ, maxX, maxY, maxZ]` for cache friendliness. */
export function makeBox(cx, cy, cz, sx, sy, sz) {
  return [cx - sx / 2, cy - sy / 2, cz - sz / 2, cx + sx / 2, cy + sy / 2, cz + sz / 2];
}

export function boxContainsPoint(b, p, pad = 0) {
  return (
    p[0] >= b[0] - pad &&
    p[0] <= b[3] + pad &&
    p[1] >= b[1] - pad &&
    p[1] <= b[4] + pad &&
    p[2] >= b[2] - pad &&
    p[2] <= b[5] + pad
  );
}

export function boxesOverlap(a, b) {
  return (
    a[0] < b[3] && a[3] > b[0] && a[1] < b[4] && a[4] > b[1] && a[2] < b[5] && a[5] > b[2]
  );
}

/** Volume of the intersection, used to pick the shallowest penetration axis. */
export function boxOverlapDepth(a, b) {
  return [
    Math.min(a[3], b[3]) - Math.max(a[0], b[0]),
    Math.min(a[4], b[4]) - Math.max(a[1], b[1]),
    Math.min(a[5], b[5]) - Math.max(a[2], b[2]),
  ];
}

/**
 * Slab-method segment/box intersection. Returns the entry distance along the
 * ray or -1 when there is no hit. `maxDist` may be Infinity for AI sight checks.
 */
export function rayBox(origin, dir, box, maxDist = Infinity) {
  let tmin = 0;
  let tmax = maxDist;
  let hitAxis = -1;
  for (let i = 0; i < 3; i++) {
    const o = origin[i];
    const d = dir[i];
    const lo = box[i];
    const hi = box[i + 3];
    if (Math.abs(d) < EPS) {
      if (o < lo || o > hi) return -1;
      continue;
    }
    const inv = 1 / d;
    let t1 = (lo - o) * inv;
    let t2 = (hi - o) * inv;
    let axis = i;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
      axis = i;
    }
    if (t1 > tmin) {
      tmin = t1;
      hitAxis = axis;
    }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return -1;
  }
  return { t: tmin, axis: hitAxis < 0 ? 1 : hitAxis };
}

/** Convenience boolean form of {@link rayBox}. */
export function rayBoxHit(origin, dir, box, maxDist = Infinity) {
  return rayBox(origin, dir, box, maxDist) !== -1;
}

/** Sphere/ray intersection: returns the nearest positive entry distance. */
export function raySphere(origin, dir, center, radius, maxDist = Infinity) {
  const ox = origin[0] - center[0];
  const oy = origin[1] - center[1];
  const oz = origin[2] - center[2];
  const b = ox * dir[0] + oy * dir[1] + oz * dir[2];
  const c = ox * ox + oy * oy + oz * oz - radius * radius;
  if (c > 0 && b > 0) return -1;
  const disc = b * b - c;
  if (disc < 0) return -1;
  let t = -b - Math.sqrt(disc);
  if (t < 0) t = 0;
  return t > maxDist ? -1 : t;
}

/**
 * Vertical capsule ray test. Capsules are the hit-shape for player torsos:
 * `radius` around the segment (base -> base + [0, height, 0]).
 */
export function rayCapsuleY(origin, dir, base, radius, height, maxDist = Infinity) {
  // Work relative to the capsule base, then solve a 2D problem in XZ plus a
  // clamped Y term. Iterative refine keeps this short and accurate enough for
  // hit registration at shooter distances.
  let lo = 0;
  let hi = maxDist === Infinity ? 200 : maxDist;
  const steps = 24;
  // March + bisect for the entry point: robust and branch-free enough.
  const inside = (t) => {
    const py = origin[1] + dir[1] * t;
    const cy = clamp(py, base[1], base[1] + height);
    const dx = origin[0] + dir[0] * t - base[0];
    const dy = py - cy;
    const dz = origin[2] + dir[2] * t - base[2];
    return dx * dx + dy * dy + dz * dz <= radius * radius;
  };
  if (inside(0)) return 0;
  for (let i = 1; i <= steps; i++) {
    const t = (hi * i) / steps;
    if (inside(t)) {
      for (let k = 0; k < 12; k++) {
        const mid = (lo + t) / 2;
        if (inside(mid)) hi = mid;
        else lo = mid;
      }
      return hi;
    }
  }
  return -1;
}

/** Reflect a direction about a surface normal. */
export function reflect(dir, normal, out = [0, 0, 0]) {
  const d = 2 * vdot(dir, normal);
  out[0] = dir[0] - normal[0] * d;
  out[1] = dir[1] - normal[1] * d;
  out[2] = dir[2] - normal[2] * d;
  return out;
}

/** Rotate a vector around the Y axis by `angle` radians. */
export function rotateY(vec, angle, out = [0, 0, 0]) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  out[0] = vec[0] * c - vec[2] * s;
  out[1] = vec[1];
  out[2] = vec[0] * s + vec[2] * c;
  return out;
}

/** Pitch/yaw angles pointing from `from` to `to`. */
export function anglesTo(from, to) {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const dz = to[2] - from[2];
  const horiz = Math.hypot(dx, dz);
  return { yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(dy, horiz) };
}
