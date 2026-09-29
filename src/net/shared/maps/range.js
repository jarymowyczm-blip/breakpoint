import {
  box,
  ramp,
  cyl,
  light,
  flatten,
  wall,
  building,
  crateStack,
  catwalk,
  stairs,
  sandbags,
  barrels,
  fence,
  tower,
} from '../levelutil.js';

/**
 * RANGE -- the offline training facility.
 *
 * Four zones in one map so nothing ever has to load to warm up:
 *   1. Live-fire lanes     static, pop-up and rail-moving targets at 10/20/35 m
 *   2. Recoil wall         flat steel face + target grid for pattern practice
 *   3. Movement course     strafe corridor, gap jumps, crouch tunnel, vault
 *   4. Kill house          small CQB arena for bot deathmatch at any difficulty
 */const brushes = flatten([
  // -- Ground ----------------------------------------------------------
  box([0, -0.5, 0], [70, 1, 80], 'concretePad'),
  wall([0, 6, -41], [70, 12, 2]),
  wall([0, 6, 41], [70, 12, 2]),
  wall([-35, 6, 0], [2, 12, 80]),
  wall([35, 6, 0], [2, 12, 80]),
  // Firing line marker + overhead baffles catching stray rounds
  box([0, 0.06, 26], [30, 0.12, 0.4], 'marker', { collide: false, nav: false }),
  box([0, 3.6, 14], [32, 0.5, 3.5], 'metalRust', { nav: false }),
  box([0, 3.6, 0], [32, 0.5, 3.5], 'metalRust', { nav: false }),
  box([0, 3.6, -16], [32, 0.5, 3.5], 'metalRust', { nav: false }),

  // -- Lanes 1-5: shooting positions at the line, targets downrange -----
  ...[0, 1, 2, 3, 4].flatMap((i) => {
    const x = -12 + i * 6;
    return [
      box([x - 1.5, 0.5, 27], [0.25, 1, 3], 'woodBooth'),
      box([x + 1.5, 0.5, 27], [0.25, 1, 3], 'woodBooth'),
      box([x, 0.55, 25.6], [3.2, 0.14, 0.7], 'woodBooth'),
      cyl([x, 1.1, 24.6], 0.09, 2.2, 'metal', { collide: false, nav: false }),
    ];
  }),
  // Berms separating lanes downrange
  ...[0, 1, 2, 3].flatMap((i) => {
    const x = -9 + i * 6;
    return [box([x, 1.1, 8], [1.2, 2.2, 32], 'dirtBerm', { top: false })];
  }),
  // The lanes stay open at the far end so shooters can walk downrange to reset
  // steel. The 12 m perimeter wall behind them is the backstop.

  // -- Recoil wall (west range) ----------------------------------------
  box([-28, 2.6, 6], [8, 5.2, 18], 'concreteMid', { top: false }),
  box([-23.6, 2.6, 6], [0.4, 5.2, 18], 'metalPlate'),
  box([-23.5, 3.4, 6], [0.2, 3.2, 12], 'targetWhite', { collide: false, nav: false }),
  box([-22.8, 0.5, 6], [0.3, 1, 12], 'woodBooth'),
  box([-23.1, 1.05, 6], [0.25, 0.1, 12], 'marker', { collide: false, nav: false }),
  rangeBench(),

  // -- Movement course (east side) -------------------------------------
  // 1: strafe corridor between two walls (kept clear of the kill house)
  box([21, 1.2, 19], [1, 2.4, 10], 'concreteMid'),
  box([29, 1.2, 19], [1, 2.4, 10], 'concreteMid'),
  // 2: gap jumps -- four platforms climbing northward with a ~2.9 m gap each,
  // reached by a ramp from the ground and left by a longer ramp down.
  box([25, 0.8, 10], [5, 1.6, 5], 'concretePad'),
  box([25, 1.4, 2.6], [5, 1.6, 5], 'concretePad'),
  box([25, 2.0, -5.6], [5, 1.6, 5], 'concretePad'),
  box([25, 2.6, -16], [5, 1.6, 5], 'concretePad'),
  ramp([25, 0.8, 15.6], [4, 1.6, 6], 'concretePad', 'z', -1),
  ramp([25, 1.7, -21.5], [4, 3.4, 6], 'concretePad', 'z', 1),
  // 3: crouch tunnel -- 1.2 m clearance forces a crouch
  box([25, 0.6, -30], [6, 1.2, 6], 'concreteMid', { nav: false }),
  box([22, 1.9, -30], [1.2, 1.6, 6], 'concreteMid'),
  box([28, 1.9, -30], [1.2, 1.6, 6], 'concreteMid'),
  // 4: vault + window climb
  box([25, 0.9, -36], [6, 1.8, 0.6], 'woodBooth'),
  box([25, 1.6, -38.5], [6, 3.2, 0.6], 'concreteMid', { nav: false }),
  box([23.6, 1.9, -38.5], [2.2, 1.2, 0.4], 'glass', { collide: false, nav: false }),

  // -- Kill house (south-east CQB arena) -------------------------------
  building({
    x: 20,
    z: 32,
    w: 20,
    d: 14,
    h: 3.4,
    mat: 'concrete',
    roofMat: 'metalRust',
    doors: [
      { side: 'w', at: 4, width: 2.2, height: 2.8 },
      { side: 'n', at: 5, width: 2.2, height: 2.8 },
      { side: 'n', at: 15, width: 2.2, height: 2.8 },
      { side: 'e', at: 10, width: 2.2, height: 2.8 },
    ],
  }),
  // Interior partitions -- CQB needs corners to clear
  box([16, 1.4, 32], [0.3, 2.8, 8], 'woodBooth'),
  box([24, 1.4, 32], [0.3, 2.8, 8], 'woodBooth'),
  box([20, 1.4, 28.4], [6, 2.8, 0.3], 'woodBooth'),
  crateStack(20, 0, 36, 2, 1, 2, 1.1, 3),
  // Props are kept OUT of the firing lanes: a fence post on the centreline
  // stopped every shot down lane 3, which is a level bug the sim test caught.
  sandbags(-16, 0, 29, 6, 'z', 1.1),
  sandbags(31, 0, 26, 8, 'x', 1.1),
  rangeContainer(),
  barrels(2.6, 0, 20, [[0, 0], [1, 0.6], [0.5, 1.3]]),
  fence(-32, 0, 14, 16, 'z'),

  // -- Steel targets on rails / stands (visual bodies; sim drives them) --
  ...railDecor(),
]);

/** Recoil-wall shooting bench: somewhere to actually stand while you train. */
function rangeBench() {
  return box([-27.5, 0.45, 12], [3, 0.9, 1.2], 'woodBooth');
}

/** Stacked container closing off the east end of the kill house approach. */
function rangeContainer() {
  return box([30, 1.3, 16], [6.1, 2.6, 2.7], 'containerRed', { rot: Math.PI / 2 });
}

function railDecor() {
  const out = [];
  // Rail tracks + carrier plates for the moving targets on lanes 1 and 5
  for (const [x, z] of [[-12, 6], [12, 6]]) {
    out.push(box([x, 0.08, z], [0.5, 0.16, 26], 'metalRust', { collide: false, nav: false }));
    out.push(box([x, 0.9, z - 13], [0.4, 1.8, 0.4], 'metalRust', { collide: false, nav: false }));
    out.push(box([x, 0.9, z + 13], [0.4, 1.8, 0.4], 'metalRust', { collide: false, nav: false }));
  }
  return out;
}

const lights = [
  light([0, 5.4, 24], '#fff4dd', 46, 40),
  light([-26, 4.5, 6], '#ffe0b0', 30, 26),
  light([25, 5.6, 6], '#e8f2ff', 34, 30),
  light([25, 5.6, -26], '#e8f2ff', 26, 24),
  light([20, 4.2, 32], '#fff0cf', 30, 24),
  light([0, 5.2, -22], '#ffd9a8', 30, 30),
];

const environment = {
  name: 'Range',
  sky: ['#1a2430', '#6b8299', '#cdd6de'],
  sun: { dir: [-0.3, 0.78, 0.35], color: '#fdf3e2', intensity: 2.4 },
  ambient: { color: '#68809a', intensity: 0.7 },
  fog: { color: '#9aabba', density: 0.008 },
  exposure: 1.05,
  groundMat: 'concretePad',
  dust: { count: 700, color: '#d8d2c6', size: 0.05 },
};

// Static / animated targets consumed by practice mode.
const targets = [
  // Lane 1 (-12): rail mover
  { id: 'l1-move', type: 'mover', p: [-12, 1.15, -2], axis: 'z', range: 12, speed: 3.2, size: 'plate', points: 15 },
  { id: 'l1-a', type: 'popup', p: [-12, 1.0, 12], size: 'popup', points: 10, interval: 1.6, upTime: 1.9 },
  { id: 'l1-b', type: 'static', p: [-12, 1.35, -8], size: 'plate', points: 12 },
  // Lane 2 (-6)
  { id: 'l2-a', type: 'popup', p: [-6, 1.0, 16], size: 'popup', points: 10, interval: 2.1, upTime: 1.6 },
  { id: 'l2-b', type: 'static', p: [-6, 1.35, 4], size: 'plate', points: 12 },
  { id: 'l2-c', type: 'popup', p: [-6, 1.0, -4], size: 'popup', points: 15, interval: 2.6, upTime: 1.4 },
  // Lane 3 (0): the long shots
  { id: 'l3-a', type: 'static', p: [0, 1.35, -2], size: 'plate', points: 18 },
  { id: 'l3-b', type: 'popup', p: [0, 1.0, -7], size: 'popup', points: 20, interval: 3.2, upTime: 1.3 },
  // Lane 4 (6): hostage style -- small plates, penalty for misses next to them
  { id: 'l4-a', type: 'static', p: [6, 1.6, 8], size: 'small', points: 25 },
  { id: 'l4-b', type: 'static', p: [6.9, 1.6, 8], size: 'small', points: -15 },
  { id: 'l4-c', type: 'popup', p: [6, 1.0, 0], size: 'popup', points: 15, interval: 1.9, upTime: 1.5 },
  // Lane 5 (12): rail mover + plate rack
  { id: 'l5-move', type: 'mover', p: [12, 1.15, -2], axis: 'z', range: 12, speed: 4.1, size: 'plate', points: 20 },
  { id: 'l5-a', type: 'static', p: [12, 1.35, 12], size: 'plate', points: 12 },
  { id: 'l5-b', type: 'popup', p: [12, 1.0, 4], size: 'popup', points: 12, interval: 2.3, upTime: 1.7 },
  // Recoil wall
  { id: 'rw-1', type: 'static', p: [-23.4, 4.6, 6], size: 'small', points: 20, wall: true },
  { id: 'rw-2', type: 'static', p: [-23.4, 3.4, 6], size: 'small', points: 20, wall: true },
  { id: 'rw-3', type: 'static', p: [-23.4, 2.2, 6], size: 'small', points: 20, wall: true },
  { id: 'rw-4', type: 'static', p: [-23.4, 1.0, 6], size: 'small', points: 20, wall: true },
  // Kill house infill, kept clear of the interior partitions
  { id: 'kh-1', type: 'popup', p: [19, 1.0, 31], size: 'popup', points: 15, interval: 2.4, upTime: 1.5 },
  { id: 'kh-2', type: 'popup', p: [27, 1.0, 34], size: 'popup', points: 15, interval: 2.8, upTime: 1.5 },
];

export default {
  id: 'range',
  name: 'Killhouse Range',
  subtitle: 'Practice / targets / movement / bots',
  modes: ['practice'],
  recommended: { practice: [1, 8] },
  bounds: { min: [-35, -3, -41], max: [35, 14, 41] },
  brushes,
  lights,
  environment,
  targets,
  // Practice ranges: the sim spawns bots at the requested distance & skill
  botSpawns: [
    { p: [-12, 0.1, 10], facing: Math.PI },
    { p: [0, 0.1, 6], facing: Math.PI },
    { p: [12, 0.1, 10], facing: Math.PI },
    { p: [25, 0.1, 20], facing: Math.PI },
    { p: [20, 0.1, 32], facing: Math.PI / 2 },
    { p: [0, 0.1, -30], facing: Math.PI },
  ],
  spawns: {
    practice: [[0, 0.1, 30]],
    campaign: [[0, 0.1, 30]],
    ffa: [
      [0, 0.1, 30],
      [-12, 0.1, 20],
      [12, 0.1, 20],
      [25, 0.1, 19],
      [-26, 0.1, 30],
      [30, 0.1, 6],
      [20, 0.1, 32],
      [0, 0.1, -30],
    ],
    a: [[0, 0.1, 30]],
    b: [[0, 0.1, -30]],
    enemy: [
      [-12, 0.1, 10],
      [0, 0.1, 6],
      [12, 0.1, 10],
      [20, 0.1, 32],
      [25, 0.1, -25],
      [0, 0.1, -30],
      [-20, 0.1, 6],
      [30, 0.1, -6],
    ],
  },
  callouts: [
    { name: 'Firing Line', p: [0, 0, 27], r: 16 },
    { name: 'Live Lanes', p: [0, 0, 8], r: 18 },
    { name: 'Recoil Wall', p: [-26, 0, 6], r: 8 },
    { name: 'Movement', p: [25, 0, 6], r: 10 },
    { name: 'Crouch Tunnel', p: [25, 0, -26], r: 6 },
    { name: 'Killhouse', p: [20, 0, 32], r: 14 },
  ],
};
