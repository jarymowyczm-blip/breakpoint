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
  truck,
  tower,
  pipes,
} from '../levelutil.js';

// Northern dead ground: a genuine 1.8 m excavation in the terrain.
const TRENCH = { x0: -17, x1: 17, z0: -43, z1: -25, floor: -1.8 };

/**
 * COMPOUND -- campaign mission 1, "Coldstore".
 *
 * A 110 x 110 m outdoor site with three staged objectives read left to right:
 *   A) insert from the treeline and clear the courtyard
 *   B) hold the HQ building against two counter-attack waves
 *   C) escort the HVT from the HQ to the extraction pad
 *
 * Objective volumes live in `objectives`, enemy entry points in `spawns.enemy`
 * and the wave table in `waves`. `missions.js` consumes them; the level itself
 * stays pure data.
 */

const brushes = flatten([
  // -- Terrain: four slabs around the trench, then the trench floor ------
  slab(-65, -65, 65, TRENCH.z0, 0, 2.6, 'dirt'),
  slab(-65, TRENCH.z1, 65, 65, 0, 2.6, 'dirt'),
  slab(-65, TRENCH.z0, TRENCH.x0, TRENCH.z1, 0, 2.6, 'dirt'),
  slab(TRENCH.x1, TRENCH.z0, 65, TRENCH.z1, 0, 2.6, 'dirt'),
  slab(TRENCH.x0, TRENCH.z0, TRENCH.x1, TRENCH.z1, TRENCH.floor, 0.6, 'dirtTrench'),
  surface(TRENCH.x0, TRENCH.z1, TRENCH.x1, TRENCH.z0, TRENCH.floor + 0.03, 'dirtTrench'),
  // Descending ramps inside the excavation, one per flank
  ramp([-12, -0.9, -27], [4.4, 1.8, 4], 'dirt', 'z', 1),
  ramp([11, -0.9, -27], [4.4, 1.8, 4], 'dirt', 'z', 1),
  // Road decals sit 2 cm proud of the terrain
  surface(-65, 9, 65, 39, 0.02, 'dirtRoad'),
  surface(TRENCH.x0, -65, TRENCH.x1, TRENCH.z0, 0.02, 'dirtRoad'),
  surface(-15, -65, 15, 65, 0.021, 'dirtRoad'),

  // Perimeter berms + vehicle barriers
  wall([0, 3.5, -55], [130, 7, 2.4], 'dirtBerm'),
  wall([0, 3.5, 55], [130, 7, 2.4], 'dirtBerm'),
  wall([-55, 3.5, 0], [2.4, 7, 130], 'dirtBerm'),
  wall([55, 3.5, 0], [2.4, 7, 130], 'dirtBerm'),

  // -- Insertion treeline (west, player spawns) ------------------------
  ...[
    [-44, 34],
    [-47, 26],
    [-42, 20],
    [-46, 12],
    [-43, 4],
    [-47, -4],
    [-42, -12],
    [-46, -20],
    [-44, -30],
  ].flatMap(([x, z], i) => [
    cyl([x, 3.1, z], 0.45, 6.2, 'treeTrunk', { collide: false, nav: false }),
    box([x, 4.2 + (i % 3) * 0.4, z], [4.6, 4.2, 4.6], 'treeCanopy', { collide: false, nav: false, rot: i }),
  ]),
  // Low stone wall giving the player a first covered firing position
  box([-32, 0.6, 20], [0.7, 1.2, 26], 'concreteMid'),
  box([-32, 0.6, -18], [0.7, 1.2, 22], 'concreteMid'),
  sandbags(-34, 0, 6, 6, 'z'),

  // -- Outer compound wall (44 x 44) with a gate on the west face ------
  wall([0, 2.2, -22], [44, 4.4, 0.8]),
  wall([0, 2.2, 22], [44, 4.4, 0.8]),
  wall([-22, 2.2, -12], [0.8, 4.4, 20]),
  wall([-22, 2.2, 12], [0.8, 4.4, 20]),
  wall([22, 2.2, -22], [0.8, 4.4, 24]),
  wall([22, 2.2, 22], [0.8, 4.4, 24]),
  // Gate: a lintel ABOVE the opening, never a solid block across it
  box([-22, 5.2, 0], [2.7, 2.8, 5.5], 'metalRust', { nav: false }),
  box([-25.5, 1, -5.5], [2, 2, 4], 'concreteMid'),
  box([-25.5, 1, 5.5], [2, 2, 4], 'concreteMid'),
  // Watchtower covering the courtyard approach
  tower(-17, 12, 6.4, 4.6, 'metalGrate'),
  // Razor wire dressing along the wall tops
  box([0, 4.8, -22], [44, 0.5, 0.5], 'mesh', { collide: false, nav: false }),
  box([0, 4.8, 22], [44, 0.5, 0.5], 'mesh', { collide: false, nav: false }),

  // -- Courtyard: objective A -----------------------------------------
  // Barracks block (north-west corner of the compound)
  building({
    x: -12,
    z: -13,
    w: 14,
    d: 11,
    h: 4.2,
    mat: 'concrete',
    roofMat: 'metalRust',
    doors: [
      { side: 's', at: 7, width: 2.4, height: 2.8 },
      { side: 'e', at: 5.5, width: 2.4, height: 2.8 },
    ],
    windows: [{ side: 's', at: 2.5, y: 2.6, width: 2.4, height: 1 }],
  }),
  // HQ block (objective B) -- single storey with a defensible roof deck.
  // `roof: false` because the default roof is not navigable and objective B
  // needs bots to be able to fight from up there.
  building({
    x: 11,
    z: -11,
    w: 16,
    d: 12,
    h: 3.6,
    mat: 'concrete',
    roof: false,
    doors: [
      { side: 'w', at: 6, width: 2.6, height: 3 },
      { side: 's', at: 8, width: 2.6, height: 3 },
      { side: 'n', at: 8, width: 2.6, height: 3 },
    ],
    windows: [
      { side: 's', at: 3, y: 2.4, width: 3, height: 1.2 },
      { side: 's', at: 13, y: 2.4, width: 3, height: 1.2 },
      { side: 'w', at: 3, y: 2.4, width: 2.4, height: 1.2 },
    ],
  }),
  box([11, 3.75, -11], [16.4, 0.3, 12.4], 'concreteMid', { nav: true }),
  // Parapet + sandbags: cover on the roof without making it a bunker
  box([11, 4.3, -17], [16.4, 0.8, 0.3], 'concreteMid', { top: false }),
  box([11, 4.3, -5], [16.4, 0.8, 0.3], 'concreteMid', { top: false }),
  sandbags(4, 3.9, -16.5, 6, 'x', 1.0),
  sandbags(18, 3.9, -5.5, 6, 'x', 1.0),
  // Access ramp along the east face, landing exactly on the roof deck's edge
  // (bots cannot climb staircases whose steps are narrower than a nav cell).
  ramp([17.4, 1.95, -0.85], [2.4, 3.9, 7.9], 'metalGrate', 'z', -1),
  // Motor pool: hard cover and a couple of parked technicals
  truck(-6, 12, Math.PI / 2),
  truck(-2, 16, Math.PI / 2 + 0.15),
  truck(13, 15, Math.PI / 2 - 0.1, 'metalRust'),
  crateStack(-19, 0, 18, 3, 2, 2, 1.1, 5),
  crateStack(6, 0, 3, 2, 2, 2, 1.1, 13),
  crateStack(17.5, 0, 8, 2, 1, 3, 1.1, 27),
  barrels(9, 0, 18, [[0, 0], [1, 0.7], [0.3, 1.4]]),
  barrels(-9, 0, -5, [[0, 0], [1, 0.7]]),
  container(-16, 4, Math.PI / 2, { mat: 'containerGreen', len: 6.1 }),
  container(-16, 9, Math.PI / 2, { mat: 'containerRed', y: 2.62, len: 6.1 }),
  pipes(0, 6.2, -20.5, 30, 'x', 3),
  fence(16, 0, 20, 12, 'x'),

  // -- Eastern jungle + extraction pad (objective C) -------------------
  ...[
    [34, 20],
    [38, 12],
    [33, 4],
    [40, -4],
    [35, -12],
    [41, -20],
    [36, -28],
    [44, 26],
    [45, 6],
    [44, -32],
  ].flatMap(([x, z], i) => [
    cyl([x, 3.4, z], 0.42, 6.8, 'treeTrunk', { collide: false, nav: false }),
    box([x, 4.6 + (i % 3) * 0.5, z], [5, 4.6, 5], 'treeCanopy', { collide: false, nav: false, rot: i * 0.7 }),
  ]),
  // Clearing: dirt pad, landing markers, sandbag ring for the last stand
  box([40, 0.05, -34], [22, 0.14, 22], 'concreteDark', { collide: false }),
  box([40, 0.16, -34], [18, 0.04, 0.35], 'marker', { collide: false, nav: false }),
  box([40, 0.16, -34], [0.35, 0.04, 18], 'marker', { collide: false, nav: false }),
  // The last stand ring is deliberately NOT closed: the 5 m gap in the southern
  // face is the only way in, which is what makes it defensible.
  sandbags(31, 0, -38, 10, 'z', 1.2),
  sandbags(40, 0, -44, 12, 'x', 1.2),
  sandbags(49, 0, -36, 10, 'z', 1.2),
  sandbags(35, 0, -28, 5, 'x', 1.2),
  sandbags(45, 0, -28, 5, 'x', 1.2),
  crateStack(36, 0, -40, 2, 2, 2, 1.1, 9),
  barrels(45, 0, -40, [[0, 0], [1, 0.6]]),

  // -- Northern approach: trench furniture + lip cover ------------------
  box([-8, TRENCH.floor + 0.4, -34], [10, 0.8, 0.5], 'sandbag'),
  box([8, TRENCH.floor + 0.4, -38], [12, 0.8, 0.5], 'sandbag'),
  box([-6, TRENCH.floor + 0.35, -34], [2, 0.7, 12], 'concreteMid'),
  box([5, TRENCH.floor + 0.35, -31], [8, 0.7, 0.5], 'concreteMid'),
  // Sandbags on the lip itself, firing over the excavation
  sandbags(-21, 0, -30, 10, 'z', 1.0),
  sandbags(16, 0, -24.5, 10, 'x', 1.0),
  sandbags(-16, 0, -44, 8, 'x', 1.0),
]);

const lights = [
  light([-22, 3.4, 0], '#ffd9a0', 34, 26),
  light([0, 3.6, 0], '#ffd9a0', 30, 28),
  light([11, 3.2, -11], '#fff0cf', 26, 22),
  light([-12, 3.2, -13], '#fff0cf', 22, 20),
  light([-19, 6.6, -19], '#cfe6ff', 26, 22),
  light([40, 4.5, -34], '#9fd4ff', 36, 30),
  light([-6, 2.6, 12], '#ffcc88', 18, 16),
];

const environment = {
  name: 'Coldstore',
  sky: ['#233246', '#7f9bb4', '#e0c79b'],
  sun: { dir: [0.5, 0.55, -0.35], color: '#ffe9c4', intensity: 3.2 },
  ambient: { color: '#7289a3', intensity: 0.6 },
  fog: { color: '#b3c2cf', density: 0.0055 },
  exposure: 1.08,
  groundMat: 'dirt',
  dust: { count: 1400, color: '#dcc9a4', size: 0.07 },
};

export default {
  id: 'compound',
  name: 'Coldstore Compound',
  subtitle: 'Campaign / clear / defend / escort',
  modes: ['campaign'],
  recommended: { campaign: [1, 1] },
  bounds: { min: [-62, -4, -62], max: [62, 20, 62] },
  brushes,
  lights,
  environment,
  spawns: {
    // Player insertion point, behind the treeline wall
    campaign: [[-38, 0.1, 14]],
    practice: [[-38, 0.1, 14]],
    a: [[-38, 0.1, 14]],
    b: [[40, 0.1, -34]],
    ffa: [
      [-38, 0.1, 14],
      [40, 0.1, -34],
      [0, 0.1, 10],
      [0, -1.75, -34],
      [-30, 0.1, 32],
      [30, 0.1, 30],
      [-30, 0.1, 30],
      [10, 0.1, 48],
    ],
    // Enemy entry points: the gate channel, the south approach, the trench and
    // the two treelines. `waves` decides which of these is used when.
    enemy: [
      [-27, 0.1, 0],
      [-19, 0.1, 16],
      [21, 0.1, -6],
      [0, 0.1, 30],
      [18, 0.1, 24],
      [-14, 0.1, 24],
      [0, -1.75, -32],
      [30, 0.1, -30],
      [36, 0.1, 24],
      [-40, 0.1, -34],
    ],
  },
  objectives: {
    clear: { p: [0, 0, 0], r: 20, label: 'Clear the courtyard' },
    defend: { p: [11, 0, -11], r: 13, label: 'Hold the HQ', seconds: 90 },
    escort: { from: [11, 0, -11], to: [40, 0, -34], r: 6, label: 'Escort the HVT to extraction' },
  },
  waves: [
    { at: 0, size: 3, types: ['assault', 'assault', 'defender'] },
    { at: 26, size: 4, types: ['assault', 'defender', 'sniper', 'assault'] },
    { at: 56, size: 5, types: ['assault', 'assault', 'sniper', 'defender', 'aggressive'] },
  ],
  callouts: [
    { name: 'Insertion', p: [-38, 0, 14], r: 12 },
    { name: 'Gate', p: [-22, 0, 0], r: 8 },
    { name: 'Courtyard', p: [0, 0, 6], r: 12 },
    { name: 'HQ', p: [11, 0, -11], r: 12 },
    { name: 'Barracks', p: [-12, 0, -13], r: 10 },
    { name: 'Motor Pool', p: [2, 0, 14], r: 11 },
    { name: 'Trenches', p: [0, 0, -34], r: 14 },
    { name: 'Extraction', p: [40, 0, -34], r: 12 },
  ],
};
