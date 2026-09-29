import {
  box,
  ramp,
  cyl,
  light,
  slab,
  flatten,
  surface,
  wall,
  building,
  crateStack,
  container,
  catwalk,
  sandbags,
  barrels,
  fence,
  pipes,
  tower,
} from '../levelutil.js';

/**
 * FOUNDRY -- the competitive four-lane arena.
 *
 * Layout principles taken from arena-shooter level design:
 *   - three distinct routes between team spawns (west / east) with different
 *     risk-reward: the fast trench (low, exposed), the hall (mid, open), and
 *     the catwalk ring (slow, powerful sightlines)
 *   - a hard "power position" (catwalk ring) with exactly two entrances so it
 *     can be contested instead of held forever
 *   - deliberate cover cadence: no sightline longer than ~34 m is unobstructed
 *   - verticality of 0 / 4.6 / 7.9 m giving three readable threat bands
 */

const WALL_H = 9;

// The trench is a real hole in the terrain: the ground is authored as four
// slabs around an open rectangle, with a floor lower down and ramps in the gaps.
const TRENCH = { x0: -14, x1: 14, z0: -2.7, z1: 2.7, floor: -1.8 };

const brushes = flatten([
  // ---------------------------------------------------------------------
  // Ground + boundary. Slab thickness must exceed trench depth so the
  // trench walls are solid rather than see-through ledges.
  // ---------------------------------------------------------------------
  slab(-36, -36, 36, TRENCH.z0, 0, 2.2, 'asphalt'),
  slab(-36, TRENCH.z1, 36, 36, 0, 2.2, 'asphalt'),
  slab(-36, TRENCH.z0, TRENCH.x0, TRENCH.z1, 0, 2.2, 'asphalt'),
  slab(TRENCH.x1, TRENCH.z0, 36, TRENCH.z1, 0, 2.2, 'asphalt'),
  slab(TRENCH.x0, TRENCH.z0, TRENCH.x1, TRENCH.z1, TRENCH.floor, 0.6, 'dirtTrench'),
  surface(TRENCH.x0, TRENCH.z1, TRENCH.x1, TRENCH.z0, TRENCH.floor + 0.03, 'dirtTrench'),
  wall([0, WALL_H / 2, -36], [72, WALL_H, 1.2]),
  wall([0, WALL_H / 2, 36], [72, WALL_H, 1.2]),
  wall([-36, WALL_H / 2, 0], [1.2, WALL_H, 72]),
  wall([36, WALL_H / 2, 0], [1.2, WALL_H, 72]),
  box([0, WALL_H + 0.4, 0], [74, 0.8, 74], 'metalRust', { nav: false, collide: false }),

  // ---------------------------------------------------------------------
  // Team spawn structures (mirrored, identical cover so neither side wins)
  // ---------------------------------------------------------------------
  ...[
    [-27, 'metalBlue'],
    [27, 'metalRed'],
  ].flatMap(([x, mat]) =>
    building({
      x,
      z: 0,
      w: 15,
      d: 17,
      h: 5.2,
      mat: 'concrete',
      roofMat: mat,
      doors: [
        { side: x < 0 ? 'e' : 'w', at: 8.5, width: 3.2, height: 3.2 },
        { side: 'n', at: 7.5, width: 2.6, height: 3 },
        { side: 's', at: 7.5, width: 2.6, height: 3 },
      ],
      windows: [{ side: 'n', at: 3.5, y: 3.2, width: 3, height: 1.1 }, { side: 's', at: 11, y: 3.2, width: 3, height: 1.1 }],
      thickness: 0.4,
    }),
  ),
  // Spawn-side hard cover facing mid. Placed 1.4 m clear of the doorway so the
  // exit is never blocked by its own cover.
  sandbags(-18.4, 0, -4.6, 5, 'z', 1.1),
  sandbags(-18.4, 0, 4.6, 5, 'z', 1.1),
  sandbags(18.4, 0, -4.6, 5, 'z', 1.1),
  sandbags(18.4, 0, 4.6, 5, 'z', 1.1),

  // ---------------------------------------------------------------------
  // Central hall: roofed mid structure, open on the north and south
  // ---------------------------------------------------------------------
  box([0, 4.6, -11], [10, 0.5, 1], 'concrete', { nav: false }),
  box([0, 4.6, 11], [10, 0.5, 1], 'concrete', { nav: false }),
  box([-8.4, 2.3, 0], [1, 4.6, 22], 'concrete'),
  box([8.4, 2.3, 0], [1, 4.6, 22], 'concrete'),
  box([0, 4.9, 0], [16.8, 0.6, 23], 'metalRust', { nav: false }),
  // Pillars give the hall interior cover without closing it off. They are
  // pushed to the walls so they never foul the mezzanine staircase.
  ...[-7, -2.4, 2.4, 7].flatMap((z) => [cyl([-7.2, 2.3, z], 0.5, 4.6, 'concrete'), cyl([7.2, 2.3, z], 0.5, 4.6, 'concrete')]),
  crateStack(-2, 0, -6, 2, 2, 2, 1.1, 3),
  crateStack(6.4, 0, 8.2, 2, 2, 2, 1.1, 17),
  crateStack(-6.2, 0, 8.6, 1, 2, 3, 1.1, 41),
  crateStack(6.6, 0, -8.2, 2, 1, 3, 1.1, 63),
  // Mezzanine deck over the hall's north end. It sits at 2.6 m rather than 3.5
  // because the roof is at 4.6 m and a standing body needs the headroom.
  box([0, 2.4, -9.6], [15.5, 0.4, 2.2], 'metalGrate'),
  box([0, 3.1, -10.6], [15.5, 1.0, 0.14], 'metal', { collide: false, nav: false }),
  // Ramp access landing on the mezzanine's south edge, same reason as the ring.
  ramp([-5.5, 1.3, -6.3], [2.4, 2.6, 4.4], 'metalGrate', 'z', -1),

  // ---------------------------------------------------------------------
  // Mid trench: the fast, dangerous lane. Ramps descend from both end lips.
  // Ramp dir points the way the slope RISES, so the west ramp rises toward -X
  // (its high end is the west lip at y=0, its low end meets the trench floor).
  // ---------------------------------------------------------------------
  // Both ramps span the full trench-mouth: their high end has to sit exactly on
  // the terrain lip (x = +-14) or the nav grid steps straight from 0 to -1.8.
  ramp([-11.75, -0.9, 0], [4.5, 1.8, 5.4], 'concrete', 'x', -1),
  ramp([11.75, -0.9, 0], [4.5, 1.8, 5.4], 'concrete', 'x', 1),
  box([0, 0.35, -3.35], [17, 0.7, 0.5], 'concreteDark'),
  box([0, 0.35, 3.35], [17, 0.7, 0.5], 'concreteDark'),
  // Waist-high cover in the trench, offset into a chicane. Each block covers
  // only part of the channel -- spanning the full width would seal the lane.
  box([-4.5, -1.05, -1.35], [1.6, 1.5, 2.7], 'concreteDark'),
  box([4.5, -1.05, 1.35], [1.6, 1.5, 2.7], 'concreteDark'),
  // Trench floor furniture so the lane reads as a maintenance channel
  pipes(0, -1.35, -2.1, 16, 'x', 2, 0.18),

  // ---------------------------------------------------------------------
  // North lane: container yard
  // ---------------------------------------------------------------------
  container(-16, -20, 0.08, { mat: 'containerBlue', len: 12.2 }),
  container(-9, -22.4, Math.PI / 2, { mat: 'containerGreen', len: 6.1 }),
  container(-13.2, -22.4, Math.PI / 2, { mat: 'containerRed', y: 2.62, len: 6.1 }),
  container(4, -21.5, 0.02, { mat: 'containerRed', len: 6.1, open: true }),
  container(11.5, -23, 0.06, { mat: 'containerBlue', len: 12.2 }),
  container(7.6, -26, Math.PI / 2, { mat: 'containerGreen', len: 12.2 }),
  crateStack(-4, 0, -17.5, 2, 3, 2, 1.1, 7),
  crateStack(14.5, 0, -15, 3, 2, 1, 1.1, 23),
  barrels(-21, 0, -16, [[0, 0], [1.1, 0.4], [0.5, 1.2], [1.7, 1.5]]),
  barrels(20, 0, -19, [[0, 0], [0.9, 0.9]]),
  fence(0, 0, -14.5, 12, 'x'),
  pipes(-2, 6.8, -19, 22, 'x', 3),

  // ---------------------------------------------------------------------
  // South lane: loading docks
  // ---------------------------------------------------------------------
  box([-2, 0.9, 17.5], [18, 1.8, 7], 'concrete'), // raised dock slab
  // Ramp tops deliberately overlap the slab so a nav cell always lands where
  // the ramp surface equals the deck height.
  ramp([-13.4, 0.9, 17.5], [5.8, 1.8, 7], 'concrete', 'x', 1),
  ramp([9.4, 0.9, 17.5], [5.8, 1.8, 7], 'concrete', 'x', -1),
  box([-2, 2.6, 21.4], [18, 1.6, 0.5], 'metalRust'),
  box([-10.4, 1.8, 21.4], [1.6, 1.6, 0.5], 'metalRust'),
  container(10.5, 15.5, Math.PI / 2, { mat: 'containerGreen', len: 6.1 }),
  container(15.5, 19, 0.1, { mat: 'containerRed', len: 6.1 }),
  container(6, 24, 0.04, { mat: 'containerBlue', len: 12.2 }),
  container(12.5, 24, 0.02, { mat: 'containerGreen', y: 2.62, len: 6.1 }),
  crateStack(-19, 0, 15, 2, 2, 3, 1.1, 91),
  crateStack(-8, 1.8, 19.5, 3, 1, 1, 1.1, 55),
  barrels(18.5, 0, 12, [[0, 0], [1.05, 0.5], [0.4, 1.3]]),
  pipes(9, 7.2, 20, 18, 'z', 3),

  // ---------------------------------------------------------------------
  // Catwalk ring: two sniper towers + a bridge that crosses the whole arena.
  // Only two ways up, so it can be contested.
  // ---------------------------------------------------------------------
  tower(-24, -30, 7.9, 5.2),
  tower(24, 30, 7.9, 5.2),
  // A closed rectangle at +-30 forms the ring. Railings open up where the two
  // tower platforms sit on it, otherwise the rails would saw the platforms into
  // unwalkable strips.
  catwalk(0, 7.95, -30, 62, 'x', 2.2, 'metalGrate', [[-28.4, -19.6]]),
  catwalk(0, 7.95, 30, 62, 'x', 2.2, 'metalGrate', [[19.6, 28.4]]),
  catwalk(-30, 7.95, 0, 62, 'z', 2.2),
  catwalk(30, 7.95, 0, 62, 'z', 2.2),
  // Two interior spurs give the ring flanking angles over the lanes. Their own
  // railings are opened where they meet the bridges, otherwise the rails of the
  // spur would slice straight through the deck it joins.
  catwalk(-24, 7.95, 19, 22, 'z', 2.2, 'metalGrate', [[8.5, 12.5]]),
  catwalk(24, 7.95, -19, 22, 'z', 2.2, 'metalGrate', [[-12.5, -8.5]]),
  // Only two ways onto the ring, and both are RAMPS that land exactly on the
  // platform's outer edge. Two constraints drive this:
  //   - a flight passing under a platform is capped by it, so the last metres
  //     lose their headroom and become impassable;
  //   - discrete steps whose run is shorter than a nav cell make consecutive
  //     cells skip a step (a 0.9 m jump), which bots cannot climb.
  // A ramp's surface varies smoothly, so it climbs cleanly at any slope.
  ramp([-24, 4.025, -22.4], [2.4, 8.05, 10], 'metalGrate', 'z', -1),
  ramp([24, 4.025, 22.4], [2.4, 8.05, 10], 'metalGrate', 'z', 1),
  // Sightline breakers pinned to one edge of the deck. They are 0.35 m thick so
  // a full-width walkable channel always survives next to them.
  box([-14, 8.1, -30.85], [2.4, 1.2, 0.35], 'metalRust'),
  box([14, 8.1, 30.85], [2.4, 1.2, 0.35], 'metalRust'),
  box([-30.85, 8.1, -12], [0.35, 1.2, 2.4], 'metalRust'),
  box([30.85, 8.1, 12], [0.35, 1.2, 2.4], 'metalRust'),

  // ---------------------------------------------------------------------
  // Sightline breakers + flanking cover in the outer ring
  // ---------------------------------------------------------------------
  box([-20, 1.3, 0], [6, 2.6, 1.2], 'concreteMid', { top: false }),
  box([20, 1.3, 0], [6, 2.6, 1.2], 'concreteMid', { top: false }),
  box([0, 1.1, -32.5], [10, 2.2, 1], 'concreteMid', { top: false }),
  box([0, 1.1, 32.5], [10, 2.2, 1], 'concreteMid', { top: false }),
  sandbags(-30, 0, 10, 7, 'z'),
  sandbags(30, 0, -10, 7, 'z'),
  sandbags(-32, 0, -10, 7, 'z'),
  sandbags(32, 0, 10, 7, 'z'),
  crateStack(-31, 0, 20, 2, 2, 2, 1.1, 5),
  crateStack(31, 0, -20, 2, 2, 2, 1.1, 13),
  crateStack(31, 0, 20, 2, 2, 2, 1.1, 29),
  crateStack(-31, 0, -20, 2, 2, 2, 1.1, 37),
  barrels(-33, 0, 0, [[0, 0], [1, 0.6]]),
  barrels(33, 0, 0, [[0, 0], [1, 0.6]]),
  fence(-9, 0, 26, 14, 'x'),
  fence(9, 0, -26, 14, 'x'),
]);

const lights = [
  light([0, 6.2, 0], '#ffd9a8', 42, 26),
  light([-24, 6.6, -30], '#9fd4ff', 30, 22),
  light([24, 6.6, 30], '#ffb27a', 30, 22),
  light([-27, 4.2, 0], '#9fd4ff', 26, 20),
  light([27, 4.2, 0], '#ff9a6a', 26, 20),
  light([0, 5.4, -21], '#ffe3b0', 22, 20),
  light([0, 5.4, 20], '#ffe3b0', 22, 20),
];

const environment = {
  name: 'Foundry',
  sky: ['#1b2836', '#8ea6bd', '#c9b28c'],
  sun: { dir: [-0.42, 0.7, 0.28], color: '#fff2dd', intensity: 2.6 },
  ambient: { color: '#5d7794', intensity: 0.55 },
  fog: { color: '#93a6b8', density: 0.0115 },
  exposure: 1.02,
  groundMat: 'asphalt',
  dust: { count: 900, color: '#cbb79a', size: 0.06 },
};

export default {
  id: 'foundry',
  name: 'Foundry',
  subtitle: 'Industrial arena / 4 lanes / 3 threat bands',
  modes: ['tdm', 'ffa', 'practice'],
  recommended: { tdm: [8, 16], ffa: [6, 12] },
  bounds: { min: [-36, -3, -36], max: [36, 14, 36] },
  brushes,
  lights,
  environment,
  spawns: {
    // Team A west, team B east. Spawns sit inside the two staging buildings, so
    // a round never starts with a player exposed in the open.
    a: [
      [-31, 0.1, -5],
      [-31, 0.1, 0],
      [-31, 0.1, 5],
      [-27, 0.1, -6],
      [-27, 0.1, 6],
      [-24, 0.1, -4],
      [-24, 0.1, 4],
      [-28, 0.1, 0],
    ],
    b: [
      [31, 0.1, -5],
      [31, 0.1, 0],
      [31, 0.1, 5],
      [27, 0.1, -6],
      [27, 0.1, 6],
      [24, 0.1, -4],
      [24, 0.1, 4],
      [28, 0.1, 0],
    ],
    // Free-for-all spread across all three threat bands: ground, catwalk ring
    // and the trench floor.
    ffa: [
      [-31, 0.1, 0],
      [31, 0.1, 0],
      [0, -1.75, 0],
      [-13, 0.1, -15],
      [12, 0.1, -16],
      [-4, 1.85, 17.5],
      [14, 0.1, 22],
      [0, 2.65, -9.6],
      [0, 8.05, -30],
      [0, 8.05, 30],
      [-24, 8.05, -30],
      [24, 8.05, 30],
      [-30, 8.05, 0],
      [30, 8.05, 0],
      [-34, 0.1, 16],
      [34, 0.1, -16],
    ],
    // Used by practice mode: calm corner with clear lanes to the range.
    practice: [[0, 0.1, 28]],
    // Bot entry points for warmups on this map.
    enemy: [
      [0, 0.1, -18],
      [-4, 0.1, 29],
      [-16, 0.1, 0],
      [16, 0.1, 0],
      [-20, 0.1, -22],
      [20, 0.1, 22],
    ],
  },
  // Named callouts -- surfaced in the HUD kill feed and the minimap.
  callouts: [
    { name: 'West Spawn', p: [-27, 0, 0], r: 12 },
    { name: 'East Spawn', p: [27, 0, 0], r: 12 },
    { name: 'Hall', p: [0, 0, 0], r: 11 },
    { name: 'Trench', p: [0, 0, 0], r: 3.5 },
    { name: 'Yard', p: [-14, 0, -21], r: 11 },
    { name: 'Docks', p: [0, 0, 20], r: 12 },
    { name: 'North Bridge', p: [0, 7.5, -30], r: 8 },
    { name: 'South Bridge', p: [0, 7.5, 30], r: 8 },
    { name: 'NW Tower', p: [-24, 7.5, -30], r: 6 },
    { name: 'SE Tower', p: [24, 7.5, 30], r: 6 },
    { name: 'West Lane', p: [-30, 0, 15], r: 10 },
    { name: 'East Lane', p: [30, 0, 15], r: 10 },
  ],
};
