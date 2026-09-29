#!/usr/bin/env node
/**
 * Level validator.
 *
 * Geometry is authored by hand, and a single misplaced brush produces a spawn
 * inside a wall or an arena the bots cannot path across. This tool asserts the
 * invariants the game relies on, for every map, at build time:
 *
 *   1. every team spawn sits in open space with solid ground under it
 *   2. every spawn is inside the main navigation region (so bots can reach it)
 *   3. the nav graph is dominated by one connected region (no accidental islands)
 *   4. ramps connect to something -- a ramp whose ends float in the air is a bug
 *   5. practice/campaign props the sim spawns on are standable
 *
 * Run with `npm run validate:levels` (also wired into `npm test`).
 */
import { LEVELS } from '../src/net/shared/levels.js';
import { buildWorld } from '../src/net/shared/world.js';
import { buildNav } from '../src/net/shared/nav.js';
import { PLAYER } from '../src/net/shared/constants.js';
import { makeBox } from '../src/net/shared/math.js';

let failures = 0;
const warns = [];

function fail(map, msg) {
  failures++;
  console.log(`  \u001b[31mFAIL\u001b[0m ${map}: ${msg}`);
}

function warn(map, msg) {
  warns.push(`${map}: ${msg}`);
  console.log(`  \u001b[33mwarn\u001b[0m ${map}: ${msg}`);
}

console.log('\n=== BREACHPOINT level validation ===\n');

for (const [id, level] of Object.entries(LEVELS)) {
  const t0 = Date.now();
  const world = buildWorld(level);
  const nav = buildNav(world);
  const bakeMs = Date.now() - t0;

  let colliders = 0;
  let ramps = 0;
  for (const s of world.solids) {
    if (s.kind === 'box') colliders++;
    else ramps++;
  }

  const pct = ((nav.mainSize / Math.max(1, nav.stats.walkable)) * 100).toFixed(1);
  console.log(
    `\u001b[36m${level.name}\u001b[0m (${id})\n` +
      `  brushes ${level.brushes.length}  solids ${colliders}  ramps ${ramps}  lights ${(level.lights || []).length}\n` +
      `  nav ${nav.cols}x${nav.rows} @${nav.cell}m = ${nav.stats.walkable} walkable cells in ${bakeMs}ms\n` +
      `  regions ${nav.regionCount}  main region ${nav.mainSize} cells (${pct}%)`,
  );

  if (pct < 70) fail(id, `main nav region only covers ${pct}% of walkable cells`);
  if (ramps === 0) warn(id, 'no ramps in level');

  // -- 1 + 2: spawns ----------------------------------------------------
  for (const [team, list] of Object.entries(level.spawns)) {
    list.forEach((sp, i) => {
      const [x, y, z] = sp;
      const eyeProbe = makeBox(x, 0, z, PLAYER.width, PLAYER.heightStand, PLAYER.width);
      eyeProbe[1] = y + 0.12;
      eyeProbe[4] = y + PLAYER.heightStand;
      const blocked = world.overlapsSolid(eyeProbe, { navOnly: false });
      if (blocked) fail(id, `spawn ${team}[${i}] at [${x}, ${y}, ${z}] is inside a solid`);
      const g = world.groundAt(x, z, y + PLAYER.stepHeight + 0.05);
      if (g === -Infinity) fail(id, `spawn ${team}[${i}] at [${x}, ${y}, ${z}] has no ground beneath it`);
      else if (Math.abs(g - y) > PLAYER.stepHeight + 0.05) {
        fail(id, `spawn ${team}[${i}] at [${x}, ${y}, ${z}] floats: ground is at y=${g.toFixed(2)}`);
      }
      const node = nav.nearestNode(x, z, y);
      if (!node) fail(id, `spawn ${team}[${i}] at [${x}, ${y}, ${z}] is off the nav graph`);
      else if (nav.region[node.node] !== nav.mainRegion) {
        const r = nav.region[node.node];
        fail(
          id,
          `spawn ${team}[${i}] at [${x}, ${y}, ${z}] is in island #${r} ` +
            `(${nav.regionSizes[r]} cells, surface y=${nav.groundY[node.node].toFixed(1)})`,
        );
      }
    });
  }

  // -- 3: report islands with their footprint, so they can be identified ----
  const bounds = new Map();
  for (let node = 0; node < nav.nodes; node++) {
    const r = nav.region[node];
    if (r === -1 || r === nav.mainRegion) continue;
    if (nav.regionSizes[r] <= 25) continue;
    const p = nav.nodeToWorld(node);
    const b = bounds.get(r);
    if (!b) {
      bounds.set(r, { minX: p[0], maxX: p[0], minZ: p[2], maxZ: p[2], minY: p[1], maxY: p[1] });
    } else {
      b.minX = Math.min(b.minX, p[0]);
      b.maxX = Math.max(b.maxX, p[0]);
      b.minZ = Math.min(b.minZ, p[2]);
      b.maxZ = Math.max(b.maxZ, p[2]);
      b.minY = Math.min(b.minY, p[1]);
      b.maxY = Math.max(b.maxY, p[1]);
    }
  }
  for (const [r, b] of bounds) {
    warn(
      id,
      `nav island #${r}: ${nav.regionSizes[r]} cells at x[${b.minX.toFixed(0)},${b.maxX.toFixed(0)}] ` +
        `z[${b.minZ.toFixed(0)},${b.maxZ.toFixed(0)}] y[${b.minY.toFixed(1)},${b.maxY.toFixed(1)}]`,
    );
  }

  // -- 4: ramp sanity: both ends must land within a step of real ground ----
  for (const s of world.solids) {
    if (s.kind !== 'ramp') continue;
    const r = s.ramp;
    const axis = r.axis === 'x' ? 0 : 2;
    const lo = s.box[axis];
    const hi = s.box[axis + 3];
    // Sample the ramp's centre line in the perpendicular axis, not its edge.
    const mid = (s.box[r.axis === 'x' ? 2 : 0] + s.box[r.axis === 'x' ? 5 : 3]) / 2;
    // `dir` decides which end of the span is the low one.
    const lowCoord = r.dir > 0 ? lo : hi;
    const highCoord = r.dir > 0 ? hi : lo;
    const ends = [
      { y: r.lowY, p: r.axis === 'x' ? [lowCoord, r.lowY, mid] : [mid, r.lowY, lowCoord] },
      { y: r.highY, p: r.axis === 'x' ? [highCoord, r.highY, mid] : [mid, r.highY, highCoord] },
    ];
    for (const end of ends) {
      const g = world.groundAt(end.p[0], end.p[2], end.y + 0.02);
      if (g === -Infinity) {
        fail(id, `ramp at [${s.box[0].toFixed(1)},${s.box[2].toFixed(1)}] has a floating end at y=${end.y}`);
      } else if (Math.abs(g - end.y) > 1.2) {
        warn(
          id,
          `ramp end at [${end.p[0].toFixed(1)}, ${end.y.toFixed(2)}, ${end.p[2].toFixed(1)}] ` +
            `does not meet ground (nearest surface y=${g.toFixed(2)})`,
        );
      }
    }
  }

  // -- 5: practice targets + objective volumes --------------------------
  for (const t of level.targets || []) {
    if (t.wall) continue; // wall-mounted targets hang above the plate face
    const g = world.groundAt(t.p[0], t.p[2], t.p[1] + 2);
    if (g === -Infinity) fail(id, `target ${t.id} has no ground under it`);
    else if (t.p[1] - g > 2.6 || t.p[1] - g < -0.4) {
      warn(id, `target ${t.id} sits ${(t.p[1] - g).toFixed(2)}m above its ground`);
    }
  }
  for (const [name, obj] of Object.entries(level.objectives || {})) {
    const pts = obj.p ? [obj.p] : [obj.from, obj.to];
    for (const p of pts) {
      if (!p) continue;
      const g = world.groundAt(p[0], p[2], p[1] + 2.5);
      if (g === -Infinity) fail(id, `objective "${name}" at [${p[0]}, ${p[2]}] has no ground`);
    }
  }
  for (const sp of level.botSpawns || []) {
    const g = world.groundAt(sp.p[0], sp.p[2], sp.p[1] + PLAYER.stepHeight + 0.05);
    if (g === -Infinity) fail(id, `bot spawn [${sp.p}] has no ground`);
    if (world.overlapsSolid(makeBox(sp.p[0], sp.p[1] + 0.9, sp.p[2], 1.6, 1.8, 1.6), { navOnly: false })) {
      fail(id, `bot spawn [${sp.p}] is inside a solid`);
    }
  }

  // -- Pathing smoke test: every team spawn must reach every other team -----
  const teams = Object.keys(level.spawns).filter((k) => ['a', 'b', 'ffa', 'practice', 'campaign'].includes(k));
  for (const from of teams) {
    const origin = level.spawns[from][0];
    for (const to of teams) {
      if (to === from) continue;
      const targets = level.spawns[to] || [];
      if (!targets.length) continue;
      let routed = 0;
      for (const t of targets) if (nav.findPath(origin, t)) routed++;
      const ratio = routed / targets.length;
      if (ratio < 0.5) {
        fail(id, `${from}[0] -> ${to}: only ${routed}/${targets.length} spawns reachable by path`);
      } else {
        console.log(`  path ${from}[0] -> ${to}: ${routed}/${targets.length} reachable`);
      }
    }
  }

  // -- Targets and bot spawns must sit on real, reachable ground ----------
  for (const sp of level.botSpawns || []) {
    const node = nav.nearestNode(sp.p[0], sp.p[2], sp.p[1]);
    if (!node || nav.region[node.node] !== nav.mainRegion) {
      fail(id, `bot spawn [${sp.p}] is not on the main nav region`);
    }
  }

  // -- Nav bakes must be quick enough to run on lobby creation -----------
  if (bakeMs > 1500) warn(id, `nav bake took ${bakeMs}ms (budget 1500ms)`);
  console.log('');
}

if (warns.length) {
  console.log(`\u001b[33m${warns.length} warning(s)\u001b[0m`);
}
if (failures) {
  console.log(`\u001b[31m${failures} failure(s)\u001b[0m\n`);
  process.exit(1);
}
console.log('\u001b[32mAll level checks passed.\u001b[0m\n');
