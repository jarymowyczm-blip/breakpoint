import { clamp, makeBox } from './math.js';
import { PLAYER } from './constants.js';

/**
 * Uniform-grid navigation with a surface LIST per cell.
 *
 * THE PROBLEM WITH LAYERS
 * A naive grid stores one height per cell, which breaks wherever a walkway
 * crosses a corridor: the ground under the catwalk disappears. Numbering
 * surfaces ("layer 0 = lowest, layer 1 = next") looks like a fix but silently
 * fragments geometry: the same physical deck is layer 0 in the cells beside a
 * staircase and layer 1 in the cells on top of it, and because layers form
 * separate graphs the deck tears in half.
 *
 * THE MODEL USED HERE
 * Each cell stores up to MAX_SURFACES distinct walkable heights, sorted. A
 * navigation node is `(cell, surfaceIndex)`. Two nodes are neighbours when their
 * CELLS are adjacent AND their HEIGHTS are within one step of each other --
 * height proximity, never index equality. So a deck at 8.05 m connects to the
 * next deck at 8.05 m no matter which slot it occupies in either cell. Surfaces
 * within one cell are also linked to each other when they are a step apart,
 * which is what lets a staircase top join the platform it serves.
 *
 * Solid occupancy is tested with a point probe per surface, then the resulting
 * solid map is eroded by the agent radius. Testing a full agent-width box per
 * cell instead would seal any gap narrower than cell + agent width -- doorways,
 * gate openings and trench lips all get walled off by half a player width.
 */

const SQRT2 = Math.SQRT2;

/** Surfaces closer together than this are treated as one (steps, curbs). */
const SURFACE_MERGE = 0.4;
/** Slot count per cell. Three covers ground + deck + roof. */
export const MAX_SURFACES = 4;

export function buildNav(world, { cell = 0.45, maxStep = 0.55, height = PLAYER.heightStand } = {}) {
  const { min, max } = world.bounds;
  const cols = Math.max(1, Math.ceil((max[0] - min[0]) / cell));
  const rows = Math.max(1, Math.ceil((max[2] - min[2]) / cell));
  const cells = cols * rows;
  const nodes = cells * MAX_SURFACES;
  const TOP = max[1] + 3;

  const groundY = new Float32Array(nodes).fill(-9999);
  const flags = new Uint8Array(nodes);
  const region = new Int32Array(nodes).fill(-1);
  const solidPts = new Uint8Array(nodes);

  const toX = (cx) => min[0] + (cx + 0.5) * cell;
  const toZ = (cz) => min[2] + (cz + 0.5) * cell;

  const probe = makeBox(0, 0, 0, 0.02, 0.02, 0.02);
  const pointBlocked = (x, y, z) => {
    probe[0] = x - 0.01;
    probe[3] = x + 0.01;
    probe[2] = z - 0.01;
    probe[5] = z + 0.01;
    probe[1] = y - 0.01;
    probe[4] = y + 0.01;
    return world.overlapsSolid(probe) !== null;
  };

  // -- Bake ---------------------------------------------------------------
  const list = [];
  for (let cz = 0; cz < rows; cz++) {
    for (let cx = 0; cx < cols; cx++) {
      const cellI = cx * rows + cz;
      const x = toX(cx);
      const z = toZ(cz);
      const raw = world.columnSurfaces(x, z, TOP);
      list.length = 0;
      for (const s of raw) {
        if (!list.length || s - list[list.length - 1] > SURFACE_MERGE) list.push(s);
      }
      const used = Math.min(list.length, MAX_SURFACES);
      for (let k = 0; k < used; k++) {
        const y = list[k];
        const node = cellI * MAX_SURFACES + k;
        // Knee, chest and head-height probes: a surface is standable only when a
        // body occupies it *and* has headroom.
        if (pointBlocked(x, y + 0.35, z) || pointBlocked(x, y + 1.1, z) || pointBlocked(x, y + height - 0.25, z)) {
          solidPts[node] = 1;
          continue;
        }
        groundY[node] = y;
        flags[node] = 1;
      }
    }
  }

  // -- Erode by agent radius ---------------------------------------------
  const erode = Math.max(1, Math.ceil(PLAYER.radius / cell));
  {
    const snapshot = flags.slice();
    for (let cx = 0; cx < cols; cx++) {
      for (let cz = 0; cz < rows; cz++) {
        const cellI = cx * rows + cz;
        for (let k = 0; k < MAX_SURFACES; k++) {
          const node = cellI * MAX_SURFACES + k;
          if (!snapshot[node]) continue;
          const y = groundY[node];
          let ok = true;
          for (let dx = -erode; dx <= erode && ok; dx++) {
            for (let dz = -erode; dz <= erode; dz++) {
              const nx = cx + dx;
              const nz = cz + dz;
              if (nx < 0 || nz < 0 || nx >= cols || nz >= rows) {
                ok = false;
                break;
              }
              // Clearance is about *horizontal room at this height*, so match on
              // height proximity rather than slot index. A deck is slot 1 over
              // open ground and slot 2 where a wall top shares the column; slot
              // equality would punch a 45 cm hole in the deck at every wall.
              const base = (nx * rows + nz) * MAX_SURFACES;
              let fits = false;
              for (let kk = 0; kk < MAX_SURFACES; kk++) {
                const other = base + kk;
                if (snapshot[other] && !solidPts[other] && Math.abs(groundY[other] - y) <= maxStep) {
                  fits = true;
                  break;
                }
              }
              if (!fits) {
                ok = false;
                break;
              }
            }
          }
          if (!ok) flags[node] = 0;
        }
      }
    }
  }

  // -- Node iteration helper ---------------------------------------------
  const cellOf = (x, z) => ({
    cx: clamp(Math.floor((x - min[0]) / cell), 0, cols - 1),
    cz: clamp(Math.floor((z - min[2]) / cell), 0, rows - 1),
  });

  /** Visit every walkable node reachable in one step from `node`. */
  function neighbours(node, visit) {
    const cellI = (node / MAX_SURFACES) | 0;
    const slot = node - cellI * MAX_SURFACES;
    const y = groundY[node];
    const cx = (cellI / rows) | 0;
    const cz = cellI % rows;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        if (!dx && !dz) continue;
        const nx = cx + dx;
        const nz = cz + dz;
        if (nx < 0 || nz < 0 || nx >= cols || nz >= rows) continue;
        const base = (nx * rows + nz) * MAX_SURFACES;
        const straightX = dx === 0 ? true : flags[((cx + dx) * rows + cz) * MAX_SURFACES + slot] === 1;
        const straightZ = dz === 0 ? true : flags[(cx * rows + (cz + dz)) * MAX_SURFACES + slot] === 1;
        const diagonal = dx !== 0 && dz !== 0;
        for (let k = 0; k < MAX_SURFACES; k++) {
          const j = base + k;
          if (!flags[j]) continue;
          // Height proximity, NOT slot equality: this is what keeps a deck
          // connected when it sits in slot 1 on one side of a staircase.
          if (Math.abs(groundY[j] - y) > maxStep) continue;
          // No cutting through wall corners. On a diagonal the orthogonal
          // neighbours only need *any* surface within a step, so a deck and its
          // access stairs are not treated as a corner.
          if (diagonal && !(straightX && straightZ)) {
            const okX = orthogonallyPassable((cx + dx) * rows + cz, y);
            const okZ = orthogonallyPassable(cx * rows + (cz + dz), y);
            if (!okX || !okZ) continue;
          }
          visit(j, diagonal);
        }
      }
    }
  }

  function orthogonallyPassable(cellI, y) {
    const base = cellI * MAX_SURFACES;
    for (let k = 0; k < MAX_SURFACES; k++) {
      if (flags[base + k] && Math.abs(groundY[base + k] - y) <= maxStep) return true;
    }
    return false;
  }

  // -- Sanity filter: nodes with no neighbour at all are useless ----------
  {
    let visited = 0;
    for (let node = 0; node < nodes; node++) {
      if (!flags[node]) continue;
      visited++;
    }
    // (Nothing to drop here; the region pass below already separates islands,
    //  and the bot AI only ever paths within one region.)
    void visited;
  }

  // -- Region flood fill --------------------------------------------------
  let regionCount = 0;
  const regionSizes = [];
  const stack = [];
  for (let start = 0; start < nodes; start++) {
    if (!flags[start] || region[start] !== -1) continue;
    const id = regionCount++;
    let size = 0;
    stack.length = 0;
    stack.push(start);
    region[start] = id;
    while (stack.length) {
      const node = stack.pop();
      size++;
      neighbours(node, (j) => {
        if (region[j] === -1) {
          region[j] = id;
          stack.push(j);
        }
      });
    }
    regionSizes.push(size);
  }

  let mainRegion = -1;
  let mainSize = 0;
  for (let i = 0; i < regionSizes.length; i++) {
    if (regionSizes[i] > mainSize) {
      mainSize = regionSizes[i];
      mainRegion = i;
    }
  }

  /** Nearest walkable node to a world point, weighting height heavily. */
  function nearestNode(x, z, y = 0, maxRing = 22) {
    const { cx, cz } = cellOf(x, z);
    let best = null;
    let bestScore = Infinity;
    for (let r = 0; r <= maxRing; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          if (r > 0 && Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const nx = cx + dx;
          const nz = cz + dz;
          if (nx < 0 || nz < 0 || nx >= cols || nz >= rows) continue;
          const base = (nx * rows + nz) * MAX_SURFACES;
          for (let k = 0; k < MAX_SURFACES; k++) {
            const node = base + k;
            if (!flags[node]) continue;
            const horiz = Math.hypot(dx * cell, dz * cell);
            const vert = Math.abs(groundY[node] - y);
            // A ground node 8 m below is not a substitute for a catwalk node.
            const score = horiz + vert * 4;
            if (score < bestScore) {
              bestScore = score;
              best = { node, cx: nx, cz: nz, slot: k, cellI: nx * rows + nz };
            }
          }
        }
      }
      // Stop once the ring is far enough that a closer node cannot be beaten by
      // anything at a plausible height difference.
      if (best && r >= 2 && bestScore < (r + 1) * cell) break;
    }
    return best;
  }

  function walkableAt(x, z, y) {
    return !!nearestNode(x, z, y ?? 0, 2);
  }

  /** Can an agent walk a straight line between two points on one storey? */
  function walkableLine(ax, az, bx, bz, y, step = cell * 0.8) {
    const dx = bx - ax;
    const dz = bz - az;
    const dist = Math.hypot(dx, dz);
    const n = Math.max(1, Math.ceil(dist / step));
    let lastY = null;
    let lastSlot = 0;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const { cx, cz } = cellOf(ax + dx * t, az + dz * t);
      const base = (cx * rows + cz) * MAX_SURFACES;
      let found = null;
      let bestGap = Infinity;
      const ref = lastY ?? y;
      for (let k = 0; k < MAX_SURFACES; k++) {
        if (!flags[base + k]) continue;
        const gap = Math.abs(groundY[base + k] - ref);
        if (gap < bestGap) {
          bestGap = gap;
          found = base + k;
        }
      }
      if (!found || bestGap > maxStep) return false;
      lastY = groundY[found];
      lastSlot = found;
    }
    void lastSlot;
    return true;
  }

  // -- Binary heap A* -----------------------------------------------------
  const heapNodes = [];
  const heapCost = [];
  const gScore = new Float32Array(nodes);
  const cameFrom = new Int32Array(nodes);
  const stamp = new Int32Array(nodes).fill(-1);
  const settled = new Int32Array(nodes).fill(-1);
  let generation = 0;

  function heapPush(node, cost) {
    heapNodes.push(node);
    heapCost.push(cost);
    let i = heapNodes.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heapCost[p] <= heapCost[i]) break;
      [heapNodes[p], heapNodes[i]] = [heapNodes[i], heapNodes[p]];
      [heapCost[p], heapCost[i]] = [heapCost[i], heapCost[p]];
      i = p;
    }
  }

  function heapPop() {
    const top = heapNodes[0];
    const lastN = heapNodes.pop();
    const lastC = heapCost.pop();
    if (heapNodes.length) {
      heapNodes[0] = lastN;
      heapCost[0] = lastC;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < heapNodes.length && heapCost[l] < heapCost[m]) m = l;
        if (r < heapNodes.length && heapCost[r] < heapCost[m]) m = r;
        if (m === i) break;
        [heapNodes[m], heapNodes[i]] = [heapNodes[i], heapNodes[m]];
        [heapCost[m], heapCost[i]] = [heapCost[i], heapCost[m]];
        i = m;
      }
    }
    return top;
  }

  /**
   * Octile distance in cells, ignoring height. Level changes are paid for by the
   * step costs during expansion; keeping the heuristic consistent is what makes
   * the settled set valid so A* cannot thrash and exhaust its node budget.
   */
  const heuristic = (a, b) => {
    const ca = (a / MAX_SURFACES) | 0;
    const cb = (b / MAX_SURFACES) | 0;
    const ax = (ca / rows) | 0;
    const az = ca % rows;
    const bx = (cb / rows) | 0;
    const bz = cb % rows;
    const dx = Math.abs(ax - bx);
    const dz = Math.abs(az - bz);
    return dx + dz + (SQRT2 - 2) * Math.min(dx, dz);
  };

  function findPath(from, to, { maxNodes = 60000, smooth = true } = {}) {
    const s = nearestNode(from[0], from[2], from[1]);
    const e = nearestNode(to[0], to[2], to[1]);
    if (!s || !e) return null;
    if (region[s.node] !== region[e.node]) return null;
    const goalY = groundY[e.node];
    if (s.node === e.node) return [[to[0], goalY, to[2]]];

    generation++;
    heapNodes.length = 0;
    heapCost.length = 0;
    stamp[s.node] = generation;
    gScore[s.node] = 0;
    cameFrom[s.node] = -1;
    heapPush(s.node, heuristic(s.node, e.node));
    let expanded = 0;
    let found = false;

    while (heapNodes.length) {
      const current = heapPop();
      if (settled[current] === generation) continue;
      settled[current] = generation;
      if (current === e.node) {
        found = true;
        break;
      }
      if (++expanded > maxNodes) break;
      const cg = groundY[current];
      neighbours(current, (j, diagonal) => {
        const tentative = gScore[current] + (diagonal ? SQRT2 : 1) + Math.abs(groundY[j] - cg) * 1.6;
        if (stamp[j] !== generation || tentative < gScore[j]) {
          stamp[j] = generation;
          gScore[j] = tentative;
          cameFrom[j] = current;
          heapPush(j, tentative + heuristic(j, e.node));
        }
      });
    }

    if (!found) return null;
    const raw = [];
    let node = e.node;
    let guard = 0;
    while (node !== -1 && guard++ < 40000) {
      raw.push(nodeToWorld(node));
      node = cameFrom[node];
    }
    raw.reverse();
    raw.push([to[0], goalY, to[2]]);
    if (!smooth) return raw;
    return smoothPath(raw);
  }

  function nodeToWorld(node) {
    const cellI = (node / MAX_SURFACES) | 0;
    return [toX((cellI / rows) | 0), groundY[node], toZ(cellI % rows)];
  }

  function smoothPath(points) {
    if (points.length <= 2) return points;
    const out = [points[0]];
    let anchor = 0;
    for (let i = 2; i < points.length; i++) {
      const a = points[anchor];
      const c = points[i];
      if (!walkableLine(a[0], a[2], c[0], c[2], a[1])) {
        out.push(points[i - 1]);
        anchor = i - 1;
      }
    }
    out.push(points[points.length - 1]);
    return out;
  }

  // -- Sampling -----------------------------------------------------------
  const mainNodes = [];
  for (let node = 0; node < nodes; node++) {
    if (flags[node] && region[node] === mainRegion) mainNodes.push(node);
  }

  function randomPoint(rng, spreadAround = null, minDist = 5, maxTries = 50) {
    if (!mainNodes.length) return null;
    for (let t = 0; t < maxTries; t++) {
      const node = mainNodes[Math.floor(rng() * mainNodes.length)];
      const p = nodeToWorld(node);
      if (spreadAround && Math.hypot(p[0] - spreadAround[0], p[2] - spreadAround[2]) < minDist) continue;
      return p;
    }
    return null;
  }

  /** Ground level of the nearest navigable surface (used for bot teleports). */
  function surfaceNear(x, z, y) {
    const n = nearestNode(x, z, y);
    return n ? groundY[n.node] : null;
  }

  let walkableCount = 0;
  for (let i = 0; i < nodes; i++) if (flags[i]) walkableCount++;

  return {
    cell,
    cols,
    rows,
    cells,
    nodes,
    maxSurfaces: MAX_SURFACES,
    groundY,
    flags,
    region,
    regionCount,
    regionSizes,
    mainRegion,
    mainSize,
    nodeToWorld,
    cellToWorld: (cx, cz, slot = 0) => [toX(cx), groundY[(cx * rows + cz) * MAX_SURFACES + slot], toZ(cz)],
    groundAtCell: (cx, cz, slot = 0) => groundY[(cx * rows + cz) * MAX_SURFACES + slot],
    isWalkableCell: (cx, cz, slot = 0) => flags[(cx * rows + cz) * MAX_SURFACES + slot] === 1,
    walkableAt,
    walkableLine,
    nearestNode,
    surfaceNear,
    findPath,
    randomPoint,
    stats: { walkable: walkableCount },
  };
}
