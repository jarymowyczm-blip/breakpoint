/**
 * Brush authoring helpers shared by every map. A "brush" is a declarative solid
 * consumed by both sides of the network:
 *
 *   - the client turns it into Three.js geometry with a PBR material
 *   - the server turns it into collision + navigation data
 *
 * One source of truth means what you see is exactly what you collide with, with
 * no exported level files or asset pipeline.
 *
 * Brush shape:
 *   {
 *     t:   'box' | 'ramp' | 'cyl' | 'cone',
 *     p:   [x, y, z],        // CENTRE of the brush for boxes, BASE centre for cyl/cone
 *     s:   [w, h, d],        // size (cyl/cone use s[0] as radius)
 *     mat: material key,
 *     rot: yaw in radians (visual only; colliders stay axis aligned),
 *     collide: boolean (default true),
 *     nav: boolean (default true)  // false = invisible to bot pathfinding
 *     rx,rz: presentation tilt, purely visual
 *   }
 *
 * Ramps additionally take {axis:'x'|'z', dir:1|-1} describing which way the
 * slope rises. Ramps are walkable slopes, never horizontal blockers, which is
 * what lets bots and players run up them smoothly.
 */

export function box(p, s, mat = 'concrete', extra = {}) {
  return { t: 'box', p, s, mat, ...extra };
}

export function ramp(p, s, mat = 'concrete', axis = 'x', dir = 1, extra = {}) {
  return { t: 'ramp', p, s, mat, axis, dir, ...extra };
}

export function cyl(p, radius, height, mat = 'metal', extra = {}) {
  return { t: 'cyl', p, s: [radius, height, radius], mat, ...extra };
}

/** Horizontal cylinder run along an axis, as a bundle of `count` pipes. */
export function pipes(x, y, z, length, axis = 'x', count = 3, radius = 0.22) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const off = (i - (count - 1) / 2) * radius * 2.7;
    out.push({
      t: 'cyl',
      p: axis === 'x' ? [x, y + off * 0.6, z + off] : [x + off, y + off * 0.6, z],
      s: [radius, length, radius],
      mat: 'pipe',
      // A cylinder's axis is +Y, so lay it down to match the run direction.
      rz: axis === 'x' ? Math.PI / 2 : 0,
      rx: axis === 'z' ? Math.PI / 2 : 0,
      collide: false,
      nav: false,
    });
  }
  return out;
}

export function cone(p, radius, height, mat = 'metal', extra = {}) {
  return { t: 'cone', p, s: [radius, height, radius], mat, ...extra };
}

/**
 * Ground slab given by its XZ footprint and top surface, which is how terrain
 * is authored. Cutting terrain into slabs is what makes real recessed trenches
 * possible: the hole is simply a region no slab covers.
 */
export function slab(x0, z0, x1, z1, topY, thickness, mat = 'dirt') {
  return box([(x0 + x1) / 2, topY - thickness / 2, (z0 + z1) / 2], [x1 - x0, thickness, z1 - z0], mat);
}

/** Horizontal decal-like surface (roads, pads, marking) laid just above ground. */
export function surface(x0, z0, x1, z1, y, mat = 'dirtRoad') {
  return box([(x0 + x1) / 2, y - 0.024, (z0 + z1) / 2], [x1 - x0, 0.05, z1 - z0], mat, {
    collide: false,
    nav: false,
  });
}

/** A decorative, non-colliding solid (debris, tarps, signage). */
export function deco(p, s, mat = 'metal', extra = {}) {
  return { t: 'box', p, s, mat, collide: false, nav: false, ...extra };
}

export function light(p, color, intensity, distance, extra = {}) {
  return { p, color, intensity, distance, ...extra };
}

/**
 * Deep-flatten a brush list and drop empties.
 *
 * Composite helpers (`building`, `catwalk`, `crateStack`, ...) return arrays,
 * so map files can freely mix single brushes and structures without having to
 * remember a spread operator at every call site.
 */
export function flatten(items) {
  const out = [];
  const stack = [items];
  while (stack.length) {
    const it = stack.pop();
    if (Array.isArray(it)) {
      for (let i = it.length - 1; i >= 0; i--) stack.push(it[i]);
    } else if (it) {
      out.push(it);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Composite structures
// ---------------------------------------------------------------------------

/**
 * Four walls with optional door gaps, a floor slab and an optional roof.
 * `doors` entries are { side: 'n'|'s'|'e'|'w', at: metresFromWallStart, width }.
 */
export function building({
  x,
  z,
  w,
  d,
  h,
  y = 0,
  mat = 'concrete',
  roof = true,
  roofMat = 'metalRust',
  thickness = 0.35,
  doors = [],
  windows = [],
  edgeMat = null,
  wallTop = false,
}) {
  const out = [];
  const capMat = edgeMat || mat;
  const gap = (side, along) => {
    for (const dr of doors) {
      if (dr.side !== side) continue;
      if (along >= dr.at - dr.width / 2 && along <= dr.at + dr.width / 2) return true;
    }
    return false;
  };

  // Walls are emitted in segments so doorways are real holes, not fake decals.
  const emit = (side, length, axis, cx, cz, rot) => {
    const spans = [];
    const cuts = doors
      .filter((dr) => dr.side === side)
      .map((dr) => [dr.at - dr.width / 2, dr.at + dr.width / 2])
      .sort((a, b) => a[0] - b[0]);
    let cursor = 0;
    for (const [a, b] of cuts) {
      if (a > cursor) spans.push([cursor, Math.min(a, length)]);
      cursor = Math.max(cursor, b);
    }
    if (cursor < length) spans.push([cursor, length]);
    for (const [a, b] of spans) {
      const segLen = b - a;
      if (segLen <= 0.01) continue;
      const mid = (a + b) / 2;
      const px = axis === 'x' ? cx - length / 2 + mid : cx;
      const pz = axis === 'x' ? cz : cz - length / 2 + mid;
      out.push(
        box(
          [px, y + h / 2, pz],
          axis === 'x' ? [segLen, h, thickness] : [thickness, h, segLen],
          capMat,
          { top: wallTop, ...(rot ? { rot } : {}) },
        ),
      );
      // Door lintel so the opening reads as a doorway instead of a notch.
      for (const dr of doors.filter((dd) => dd.side === side)) {
        if (Math.abs(mid - dr.at) < dr.width / 2 + 0.01 && dr.height && dr.height < h) {
          const lintelH = h - dr.height;
          out.push(
            box(
              [px, y + dr.height + lintelH / 2, pz],
              axis === 'x' ? [dr.width + 0.1, lintelH, thickness] : [thickness, lintelH, dr.width + 0.1],
              capMat,
            ),
          );
        }
      }
    }
    // Window bands: a slit left open above head height looks like a firing port.
    for (const win of windows.filter((dd) => dd.side === side)) {
      const px = axis === 'x' ? cx - length / 2 + win.at : cx;
      const pz = axis === 'x' ? cz : cz - length / 2 + win.at;
      out.push(
        box(
          [px, y + win.y, pz],
          axis === 'x' ? [win.width, win.height, thickness * 0.5] : [thickness * 0.5, win.height, win.width],
          'glass',
          { collide: false, nav: false },
        ),
      );
    }
  };

  const halfW = w / 2;
  const halfD = d / 2;
  emit('n', w, 'x', x, z - halfD, 0);
  emit('s', w, 'x', x, z + halfD, 0);
  emit('w', d, 'z', x - halfW, z, 0);
  emit('e', d, 'z', x + halfW, z, 0);

  out.push(box([x, y - 0.15, z], [w + 0.6, 0.3, d + 0.6], 'concreteDark'));

  if (roof) out.push(box([x, y + h + 0.16, z], [w + 0.5, 0.32, d + 0.5], roofMat, { nav: false }));
  return out;
}

/** Boundary wall / berm: blocks movement and sight, nobody stands on top. */
export function wall(p, s, mat = 'concreteDark') {
  return box(p, s, mat, { top: false });
}

/** A stack of crates with deterministic jitter for a lived-in look. */
export function crateStack(x, y, z, cols = 2, rows = 2, levels = 2, size = 1.1, seed = 1) {
  const out = [];
  let n = seed;
  const rnd = () => {
    n = (n * 1103515245 + 12345) & 0x7fffffff;
    return (n % 1000) / 1000;
  };
  for (let l = 0; l < levels; l++) {
    const c = Math.max(1, cols - (l % 2));
    const r = Math.max(1, rows - ((l + 1) % 2));
    for (let i = 0; i < c; i++) {
      for (let j = 0; j < r; j++) {
        const px = x + (i - (c - 1) / 2) * size + (rnd() - 0.5) * 0.06;
        const pz = z + (j - (r - 1) / 2) * size + (rnd() - 0.5) * 0.06;
        out.push(
          box([px, y + size / 2 + l * size, pz], [size, size, size], l === 0 ? 'crate' : 'crateDark', {
            rot: (rnd() - 0.5) * 0.06,
          }),
        );
      }
    }
  }
  return out;
}

/** Shipping container, optionally stacked and open at one end (walk-in cover). */
export function container(x, z, rot = 0, { w = 2.7, h = 2.6, len = 6.1, mat = 'containerRed', y = 0, open = false, nav = true } = {}) {
  const out = [];
  const cy = y + h / 2;
  const gap = open ? 2.4 : 0;
  if (!open) {
    // Container roofs are 2.6 m up: reachable only with a boost, so they are
    // not navigation surfaces.
    out.push(box([x, cy, z], [len, h, w], mat, { rot, nav, top: false }));
  } else {
    // Two side walls + a back wall + a roof, leaving the front open.
    const half = w / 2;
    const off = (dz) => [x + Math.sin(rot) * dz, cy, z + Math.cos(rot) * dz];
    out.push(box(off(half), [len, h, 0.12], mat, { rot, nav }));
    out.push(box(off(-half), [len, h, 0.12], mat, { rot, nav }));
    out.push(box(off(0), [0.14, h, w], mat, { rot: rot + Math.PI / 2, nav }));
    out.push(box([x, y + h + 0.06, z], [len, 0.12, w], mat, { rot, nav: false, top: false }));
    void gap;
  }
  return out;
}

/**
 * Elevated walkway with railings; `axis` is the long direction.
 *
 * `gaps` lists `[start, end]` ranges (in local coords, from -length/2 to
 * +length/2) where the railings are omitted. This matters for navigation: a
 * railing crossing a tower platform would slice that platform into strips, so
 * openings are authored rather than fudged afterwards.
 */
export function catwalk(x, y, z, length, axis = 'x', width = 1.7, mat = 'metalGrate', gaps = []) {
  const out = [];
  const s = axis === 'x' ? [length, 0.14, width] : [width, 0.14, length];
  out.push(box([x, y, z], s, mat));
  const railH = 1.05;
  const railT = 0.08;
  const off = width / 2 - 0.06;
  const half = length / 2;

  const spans = [];
  let cursor = -half;
  const sorted = gaps
    .map((g) => [Math.max(-half, g[0]), Math.min(half, g[1])])
    .sort((a, b) => a[0] - b[0]);
  for (const [a, b] of sorted) {
    if (a > cursor) spans.push([cursor, a]);
    cursor = Math.max(cursor, b);
  }
  if (cursor < half) spans.push([cursor, half]);

  for (const [a, b] of spans) {
    const len = b - a;
    if (len <= 0.05) continue;
    const mid = (a + b) / 2;
    for (const side of [off, -off]) {
      if (axis === 'x') out.push(box([x + mid, y + railH / 2, z + side], [len, railH, railT], 'metal'));
      else out.push(box([x + side, y + railH / 2, z + mid], [railT, railH, len], 'metal'));
    }
    // End posts frame each opening so a gap reads as a deliberate gateway.
    // They must sit ONLY at the two rail lines: a post spanning the full deck
    // width would wall off the walkway it is supposed to decorate.
    for (const edge of [a, b]) {
      if (edge <= -half || edge >= half) continue;
      for (const side of [off, -off]) {
        if (axis === 'x') out.push(box([x + edge, y + railH * 0.6, z + side], [0.14, railH * 1.2, 0.14], 'metal'));
        else out.push(box([x + side, y + railH * 0.6, z + edge], [0.14, railH * 1.2, 0.14], 'metal'));
      }
    }
  }
  return out;
}

/**
 * Straight staircase made of stacked solid slabs.
 *
 * `x, z` is the BOTTOM of the flight and `dir` is the climb direction. Each
 * step is a block occupying only its own run segment, filled from the base up,
 * so the flight is solid underneath and never leaves a lip to catch on.
 *
 * NAVIGATION WARNING: use `ramp()` for any incline bots must climb. A step run
 * shorter than the nav cell size (0.45 m) lets consecutive nav cells straddle
 * different steps, producing a height jump larger than one step and breaking
 * the path. Staircases are for decoration and for player-only shortcuts.
 */
export function stairs(x, y, z, w, rise, run, steps = 8, axis = 'x', dir = 1, mat = 'concrete') {
  const out = [];
  const stepRise = rise / steps;
  const stepRun = run / steps;
  for (let i = 0; i < steps; i++) {
    // Each step is a block occupying ONLY its own run segment, filled from the
    // base up. Spanning the whole flight per step would merge into one solid
    // wall, and leaving gaps underneath would let bodies walk under the flight.
    const h = stepRise * (i + 1);
    const along = (i + 0.5) * stepRun;
    const off = dir > 0 ? along : -along;
    if (axis === 'x') out.push(box([x + off, y + h / 2, z], [stepRun, h, w], mat));
    else out.push(box([x, y + h / 2, z + off], [w, h, stepRun], mat));
  }
  return out;
}

export function sandbags(x, y, z, length, axis = 'x', height = 1.1) {
  const out = [];
  const bag = 0.62;
  const n = Math.max(1, Math.round(length / bag));
  for (let i = 0; i < n; i++) {
    const off = (i - (n - 1) / 2) * bag;
    for (let lvl = 0; lvl < Math.round(height / 0.34); lvl++) {
      const px = axis === 'x' ? x + off : x;
      const pz = axis === 'x' ? z : z + off;
      out.push(
        box([px, y + 0.17 + lvl * 0.34, pz], [bag * 0.95, 0.34, 0.42], 'sandbag', {
          rot: ((i + lvl) % 2 ? 1 : -1) * 0.12,
        }),
      );
    }
  }
  return out;
}

export function barrels(x, y, z, positions = [[0, 0]]) {
  return positions.map(([dx, dz], i) =>
    cyl([x + dx, y + 0.46, z + dz], 0.36, 0.92, i % 3 === 0 ? 'barrelYellow' : 'barrel', {
      explosive: i % 3 === 0,
    }),
  );
}

export function fence(x, y, z, length, axis = 'x', height = 2.4) {
  const out = [];
  const postCount = Math.max(2, Math.round(length / 3));
  for (let i = 0; i < postCount; i++) {
    const off = (i / (postCount - 1) - 0.5) * length;
    const px = axis === 'x' ? x + off : x;
    const pz = axis === 'x' ? z : z + off;
    out.push(box([px, y + height / 2, pz], [0.12, height, 0.12], 'metalRust'));
    if (i < postCount - 1) {
      const seg = length / (postCount - 1) - 0.12;
      const mid = off + seg / 2 + 0.06;
      const cx = axis === 'x' ? x + mid : x;
      const cz = axis === 'x' ? z : z + mid;
      out.push(box([cx, y + height * 0.55, cz], [seg, 0.06, 0.06], 'metalRust', { collide: false, nav: false }));
      out.push(box([cx, y + height * 0.9, cz], [seg, 0.06, 0.06], 'metalRust', { collide: false, nav: false }));
      out.push(
        box(axis === 'x' ? [cx, y + height / 2, cz] : [cx, y + height / 2, cz], axis === 'x' ? [seg, height, 0.04] : [0.04, height, seg], 'mesh', {
          collide: false,
          nav: false,
        }),
      );
    }
  }
  return out;
}

/** A vehicle hull used as hard cover on outdoor maps. */
export function truck(x, z, rot = 0, mat = 'metalArmy') {
  return [
    box([x, 0.75, z], [2.4, 1.5, 5.6], mat, { rot }),
    box([x, 1.85, z - 0.6], [2.2, 0.9, 2.1], mat, { rot }),
    cyl([x - 1.15, 0.4, z - 1.7], 0.42, 0.3, 'tire', { rx: Math.PI / 2, rot: rot + Math.PI / 2, collide: false }),
    cyl([x + 1.15, 0.4, z - 1.7], 0.42, 0.3, 'tire', { rx: Math.PI / 2, rot: rot + Math.PI / 2, collide: false }),
    cyl([x - 1.15, 0.4, z + 1.8], 0.42, 0.3, 'tire', { rx: Math.PI / 2, rot: rot + Math.PI / 2, collide: false }),
    cyl([x + 1.15, 0.4, z + 1.8], 0.42, 0.3, 'tire', { rx: Math.PI / 2, rot: rot + Math.PI / 2, collide: false }),
    cyl([x - 0.9, 2.35, z - 0.6], 0.16, 0.9, 'metal', { rz: Math.PI / 2, collide: false, nav: false }),
  ];
}

/** Sniper tower: legs, platform and railings reachable by a staircase. */
export function tower(x, z, height = 7.5, size = 4.6, mat = 'metalGrate') {
  const out = [];
  const half = size / 2 - 0.4;
  for (const [dx, dz] of [
    [-half, -half],
    [half, -half],
    [-half, half],
    [half, half],
  ]) {
    out.push(box([x + dx, height / 2, z + dz], [0.34, height, 0.34], 'metalRust'));
  }
  // The platform IS navigable: it is the power position bots fight over.
  out.push(box([x, height, z], [size, 0.3, size], mat));
  const railH = 1.15;
  for (const [dx, dz, w, d] of [
    [0, -size / 2 + 0.08, size, 0.1],
    [0, size / 2 - 0.08, size, 0.1],
    [-size / 2 + 0.08, 0, 0.1, size],
    [size / 2 - 0.08, 0, 0.1, size],
  ]) {
    out.push(box([x + dx, height + railH / 2 + 0.15, z + dz], [w, railH, d], 'metal', { collide: false, nav: false }));
  }
  out.push(box([x, height + 1.9, z], [size + 0.4, 0.2, size + 0.4], 'tarp', { collide: false, nav: false }));
  return out;
}
