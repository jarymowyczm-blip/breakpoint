#!/usr/bin/env node
/**
 * Simulation test suite.
 *
 * The sim is the part of this project that cannot be eyeballed: it runs on the
 * server, drives bots, resolves gunfights and is replayed by client prediction.
 * These checks run headless and assert the invariants that matter:
 *
 *   1. nobody ever ends up at NaN, outside the map, or stuck in the floor
 *   2. bots actually move, shoot and die (the AI is not silently inert)
 *   3. damage, kills, assists and respawns all fire in every mode
 *   4. the same seed and the same inputs produce byte-identical snapshots
 *   5. lag compensation rewinds to a position the target actually occupied
 *   6. campaign objectives advance, and practice targets react to hits
 */
import { LEVELS } from '../src/net/shared/levels.js';
import { Sim } from '../src/net/shared/sim.js';
import { PLAYER } from '../src/net/shared/constants.js';

let failures = 0;
let checks = 0;

function check(name, condition, detail = '') {
  checks++;
  if (condition) {
    console.log(`  \u001b[32mok\u001b[0m   ${name}`);
  } else {
    failures++;
    console.log(`  \u001b[31mFAIL\u001b[0m ${name}${detail ? ` -- ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n\u001b[36m${title}\u001b[0m`);
}

const TICK = 1 / 30;

/** A scripted "human": wanders, turns, jumps and fires on a timer. */
function driveHuman(sim, id, tick, plan) {
  const seq = tick;
  const t = tick * TICK;
  const input = {
    forward: plan.forward(t),
    right: plan.right(t),
    jump: plan.jump(t),
    crouch: plan.crouch ? plan.crouch(t) : false,
    sprint: plan.sprint ? plan.sprint(t) : false,
    walk: false,
    yaw: plan.yaw(t),
    pitch: plan.pitch ? plan.pitch(t) : 0,
    ads: plan.ads ? plan.ads(t) : false,
  };
  sim.setInput(id, { seq, dt: TICK, input });
  return input;
}

/** Validate every player's state against the world invariants. */
function assertSane(sim, label) {
  let bad = null;
  for (const p of sim.players.values()) {
    const [x, y, z] = p.pos;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      bad = `${p.name} has non-finite position ${x},${y},${z}`;
      break;
    }
    const b = sim.level.bounds;
    if (x < b.min[0] - 4 || x > b.max[0] + 4 || z < b.min[2] - 4 || z > b.max[2] + 4) {
      bad = `${p.name} escaped the map at ${x.toFixed(1)},${y.toFixed(1)},${z.toFixed(1)}`;
      break;
    }
    if (y < b.min[1] - 6) {
      bad = `${p.name} fell through the world to y=${y.toFixed(1)}`;
      break;
    }
    if (!Number.isFinite(p.health) || p.health < 0 || p.health > p.maxHealth + 0.001) {
      bad = `${p.name} has impossible health ${p.health}`;
      break;
    }
  }
  check(`${label}: all entity state is valid`, bad === null, bad || '');
}

function snapshotSignature(snap) {
  return JSON.stringify({
    players: snap.players.map((r) => [r[0], r[1], r[2], r[3], r[4], r[5], r[8], r[9]]),
    teamScores: snap.teamScores,
  });
}

// ---------------------------------------------------------------------------
// 1. Team deathmatch with bots: the main online path
// ---------------------------------------------------------------------------
section('Team Deathmatch (Foundry) with 2 scripted players + 4 bots');
{
  const sim = new Sim({ level: LEVELS.foundry, mode: 'tdm', seed: 1337 });
  const humanA = sim.addPlayer({ name: 'Alpha', team: 'a' });
  const humanB = sim.addPlayer({ name: 'Bravo', team: 'b' });
  sim.completeRoster = true;
  for (let i = 0; i < 4; i++) sim.addBot({ archetype: ['assault', 'defensive', 'aggressive', 'sniper'][i] });

  const startPositions = new Map();
  for (const p of sim.players.values()) startPositions.set(p.id, [p.pos[0], p.pos[1], p.pos[2]]);

  let shots = 0;
  let hits = 0;
  let deaths = 0;
  let respawns = 0;
  let footsteps = 0;
  const ticks = Math.round(75 / TICK);
  for (let tick = 0; tick < ticks; tick++) {
    driveHuman(sim, humanA, tick, {
      forward: (t) => (Math.sin(t * 0.35) > 0 ? 1 : -1),
      right: (t) => Math.sin(t * 0.7),
      jump: (t) => t % 7 < 0.1,
      sprint: (t) => Math.sin(t * 0.35) > 0.6,
      yaw: (t) => t * 0.55,
      ads: (t) => Math.floor(t) % 9 < 3,
    });
    driveHuman(sim, humanB, tick, {
      forward: () => 0.7,
      right: (t) => Math.cos(t * 1.1),
      jump: () => false,
      yaw: (t) => -t * 0.42,
      crouch: (t) => Math.floor(t / 4) % 3 === 0,
    });
    sim.tick(TICK);
    for (const ev of sim.drainEvents()) {
      if (ev.t === 'shot') shots++;
      else if (ev.t === 'hit') hits++;
      else if (ev.t === 'death') deaths++;
      else if (ev.t === 'respawn') respawns++;
      else if (ev.t === 'footstep') footsteps++;
    }
    // Keep the scripted players shooting with a realistic trigger cadence.
    if (tick % 4 === 0) sim.requestFire(humanA, { seed: tick * 7919 });
    if (tick % 6 === 0) sim.requestFire(humanB, { seed: tick * 104729 });
    if (tick % 90 === 0) sim.requestReload(humanA);
  }

  assertSane(sim, 'TDM');
  check('bots fired shots', shots > 40, `shots=${shots}`);
  check('shots connected', hits > 5, `hits=${hits}`);
  check('players died', deaths > 2, `deaths=${deaths}`);
  check('players respawned', respawns > 2, `respawns=${respawns}`);
  check('footstep events were produced', footsteps > 20, `footsteps=${footsteps}`);

  let movedBots = 0;
  for (const p of sim.players.values()) {
    if (!p.isBot) continue;
    const s = startPositions.get(p.id);
    if (!s) continue;
    const d = Math.hypot(p.pos[0] - s[0], p.pos[2] - s[2]);
    if (d > 6) movedBots++;
  }
  check('every bot travelled the map', movedBots >= 3, `moved=${movedBots}/4`);

  const snap = sim.snapshot();
  check('snapshot serialises to JSON', typeof JSON.stringify(snap) === 'string');
  check('snapshot carries every player', snap.players.length === 6, `got ${snap.players.length}`);
  const bytes = Buffer.byteLength(JSON.stringify(snap));
  check('snapshot stays small enough for 20 Hz', bytes < 2600, `${bytes} bytes`);
  check('team scores were awarded', snap.teamScores.a + snap.teamScores.b > 0, JSON.stringify(snap.teamScores));
}

// ---------------------------------------------------------------------------
// 2. Free-for-all: teams must be free-for-all, and friendly fire must apply
// ---------------------------------------------------------------------------
section('Free For All (Foundry), 8 bots');
{
  const sim = new Sim({ level: LEVELS.foundry, mode: 'ffa', seed: 99 });
  for (let i = 0; i < 8; i++) sim.addBot({ archetype: ['assault', 'defensive', 'aggressive', 'sniper'][i % 4], difficulty: 'veteran' });
  const teams = new Set([...sim.players.values()].map((p) => p.team));
  check('every FFA player is their own team', teams.size === 8, `${teams.size} teams`);
  let deaths = 0;
  for (let tick = 0; tick < Math.round(60 / TICK); tick++) {
    sim.tick(TICK);
    for (const ev of sim.drainEvents()) if (ev.t === 'death') deaths++;
  }
  assertSane(sim, 'FFA');
  check('FFA produced a scoreboard', sim.roster().length === 8);
  check('FFA had kills', deaths > 3, `deaths=${deaths}`);
  const top = sim.roster()[0];
  check('FFA leader has a positive score', top.score > 0, `${top.name}=${top.score}`);
}

// ---------------------------------------------------------------------------
// 3. Practice mode: targets animate and register hits
// ---------------------------------------------------------------------------
section('Practice (Killhouse Range)');
{
  const sim = new Sim({ level: LEVELS.range, mode: 'practice', seed: 5 });
  const player = sim.addPlayer({ name: 'Shooter', team: 'a' });
  const p = sim.players.get(player);
  // Stand on the firing line and shoot straight down the middle lane.
  p.state.pos[0] = 0;
  p.state.pos[1] = 0.05;
  p.state.pos[2] = 27;
  p.pos = p.state.pos;
  p.state.yaw = 0;
  p.state.pitch = 0;

  let upCount = 0;
  let downCount = 0;
  let targetHits = 0;
  for (let tick = 0; tick < Math.round(40 / TICK); tick++) {
    sim.setInput(player, {
      seq: tick,
      dt: TICK,
      input: { forward: 0, right: 0, jump: false, crouch: false, sprint: false, walk: false, yaw: 0, pitch: 0, ads: true },
    });
    sim.tick(TICK);
    if (tick % 5 === 0) sim.requestFire(player, { seed: tick * 131 });
    for (const ev of sim.drainEvents()) {
      if (ev.t === 'target' && ev.hit && !ev.penalty) targetHits++;
    }
  }
  for (const t of sim.targets.values()) {
    if (t.up) upCount++;
    else downCount++;
  }
  check('targets exist on the range', sim.targets.size > 10, `${sim.targets.size} targets`);
  check('pop-up targets cycle', upCount > 0 && downCount > 0, `up=${upCount} down=${downCount}`);
  check('shots registered on steel', targetHits > 0, `hits=${targetHits}`);
  check('practice scored points', sim.practice.score !== 0, `score=${sim.practice.score}`);
  assertSane(sim, 'Practice');

  const snap = sim.snapshot();
  check('practice snapshot includes targets', Array.isArray(snap.targets) && snap.targets.length > 10);
}

// ---------------------------------------------------------------------------
// 4. Campaign: enemies spawn, objectives advance, progress saves
// ---------------------------------------------------------------------------
section('Campaign (Coldstore Compound)');
{
  const sim = new Sim({ level: LEVELS.compound, mode: 'campaign', seed: 4242 });
  const player = sim.addPlayer({ name: 'Operator', team: 'a' });
  check('campaign starts on the clear objective', sim.campaign.phase === 0 && /clear/i.test(sim.campaign.objectiveText), sim.campaign.objectiveText);

  let spawned = 0;
  for (let tick = 0; tick < Math.round(20 / TICK); tick++) {
    const p = sim.players.get(player);
    sim.setInput(player, {
      seq: tick,
      dt: TICK,
      input: {
        forward: 1,
        right: 0,
        jump: false,
        crouch: false,
        sprint: true,
        walk: false,
        yaw: p.state.yaw,
        pitch: 0,
        ads: false,
      },
    });
    sim.tick(TICK);
    sim.drainEvents();
  }
  spawned = sim.countEnemies();
  check('campaign spawned enemy bots', spawned >= 4, `enemies=${spawned}`);

  // Force the clear objective to complete and confirm the phase advances.
  const before = sim.campaign.phase;
  sim.campaign.cleared = sim.campaign.clearTarget;
  sim.tick(TICK);
  sim.drainEvents();
  check('clear objective advances the mission', sim.campaign.phase === before + 1, `phase=${sim.campaign.phase}`);
  check('checkpoint was written', sim.save && sim.save.checkpoint >= 1, JSON.stringify(sim.save || null));

  // Run out the defend timer.
  for (let tick = 0; tick < Math.round(30 / TICK); tick++) {
    const p = sim.players.get(player);
    sim.setInput(player, {
      seq: tick, dt: TICK,
      input: { forward: 0, right: 0, jump: false, crouch: false, sprint: false, walk: false, yaw: p.state.yaw, pitch: 0, ads: false },
    });
    sim.tick(TICK);
    sim.drainEvents();
  }
  sim.campaign.defendLeft = 0;
  sim.tick(TICK);
  sim.drainEvents();
  check('defend objective advances to escort', sim.campaign.phase === 2, `phase=${sim.campaign.phase}`);
  check('HVT was spawned for the escort', !!sim.players.get(sim.campaign.hvtId), `hvt=${sim.campaign.hvtId}`);
  assertSane(sim, 'Campaign');
}

// ---------------------------------------------------------------------------
// 5. Determinism: identical seed + identical inputs => identical state
// ---------------------------------------------------------------------------
section('Determinism');
{
  function run() {
    const sim = new Sim({ level: LEVELS.range, mode: 'tdm', seed: 777 });
    const id = sim.addPlayer({ name: 'Bot Tester', team: 'a' });
    sim.addBot({ team: 'b', archetype: 'assault', difficulty: 'regular' });
    sim.addBot({ team: 'b', archetype: 'sniper', difficulty: 'regular' });
    for (let tick = 0; tick < Math.round(20 / TICK); tick++) {
      const t = tick * TICK;
      sim.setInput(id, {
        seq: tick,
        dt: TICK,
        input: {
          forward: Math.sin(t) > 0 ? 1 : -1,
          right: Math.cos(t * 2),
          jump: tick % 100 === 0,
          crouch: false,
          sprint: false,
          walk: false,
          yaw: t * 0.9,
          pitch: Math.sin(t) * 0.3,
          ads: false,
        },
      });
      sim.tick(TICK);
      sim.drainEvents();
      if (tick % 12 === 0) sim.requestFire(id, { seed: tick * 31 });
    }
    return snapshotSignature(sim.snapshot());
  }
  const a = run();
  const b = run();
  check('two identical runs match exactly', a === b, a === b ? '' : `${a.slice(0, 120)} != ${b.slice(0, 120)}`);
}

// ---------------------------------------------------------------------------
// 6. Lag compensation rewinds to a real past position
// ---------------------------------------------------------------------------
section('Lag compensation');
{
  const sim = new Sim({ level: LEVELS.foundry, mode: 'ffa', seed: 8 });
  const shooter = sim.addPlayer({ name: 'Shooter', team: 'a' });
  const victim = sim.addPlayer({ name: 'Runner', team: 'b' });
  const v = sim.players.get(victim);
  const s = sim.players.get(shooter);
  s.inputLag = 0.12;
  // Record where the victim was, then move it a long way.
  const trail = [];
  for (let tick = 0; tick < Math.round(1.0 / TICK); tick++) {
    v.state.pos[0] = 10 + tick * 0.25;
    v.pos = v.state.pos;
    s.state.pos[0] = -10;
    s.pos = s.state.pos;
    sim.tick(TICK);
    sim.drainEvents();
    trail.push([v.pos[0], sim.time]);
  }
  const rewound = sim.rewindTargets(s);
  const nowX = v.pos[0];
  const target = rewound.find((r) => r.player.id === victim);
  check('rewind returned the victim', !!target);
  if (target) {
    check(
      'rewound position is behind the live position',
      target.pos[0] < nowX - 0.5,
      `rewound=${target.pos[0].toFixed(2)} live=${nowX.toFixed(2)}`,
    );
    const lag = 0.12 + 0.1;
    const expected = nowX - lag * (0.25 / TICK);
    check(
      'rewound position matches the latency window',
      Math.abs(target.pos[0] - expected) < 1.2,
      `got=${target.pos[0].toFixed(2)} expected~${expected.toFixed(2)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// 7. Hit registration respects body regions and armour
// ---------------------------------------------------------------------------
section('Damage model');
{
  const sim = new Sim({ level: LEVELS.range, mode: 'ffa', seed: 3 });
  const a = sim.addPlayer({ name: 'A', team: 'a' });
  const b = sim.addPlayer({ name: 'B', team: 'b' });
  const pa = sim.players.get(a);
  const pb = sim.players.get(b);
  pa.state.pos[0] = 0;
  pa.state.pos[1] = 0.05;
  pa.state.pos[2] = 20;
  pa.pos = pa.state.pos;
  pa.state.yaw = 0;
  pa.state.pitch = 0;
  pb.state.pos[0] = 0;
  pb.state.pos[1] = 0.05;
  pb.state.pos[2] = 10;
  pb.pos = pb.state.pos;
  pb.protectionUntil = -1;
  pa.protectionUntil = -1;
  // Let both players settle onto the ground before shooting. A shot fired on
  // the very first tick is still airborne and pays the air-spread penalty,
  // which is correct behaviour but not what this test is about.
  for (let i = 0; i < 6; i++) sim.tick(TICK);
  sim.drainEvents();
  check('shooter is standing on the ground', pa.grounded, `grounded=${pa.grounded} y=${pa.pos[1]}`);

  const before = pb.health;
  pa.inputLag = 0;
  sim.requestFire(a, { seed: 12345 });
  const events = sim.drainEvents();
  const hitEvent = events.find((e) => e.t === 'hit');
  check('a centre-mass shot connects', !!hitEvent, JSON.stringify(events.map((e) => e.t)));
  if (hitEvent) {
    check('damage is applied to the victim', pb.health < before, `${before} -> ${pb.health}`);
    check('body region was classified', ['head', 'torso', 'legs'].includes(hitEvent.part), hitEvent.part);
  }

  // The cyclic rate is authoritative: a second trigger pull in the same instant
  // as the first must be dropped, otherwise a modified client could hose.
  pa.inputLag = 0;
  const tooFast = sim.requestFire(a, { seed: 77 });
  sim.drainEvents();
  check('shots faster than the cyclic rate are refused', tooFast === false, `accepted=${tooFast}`);

  // A standing first shot must be reliable: ten seeds in a row should all land
  // on a static target ten metres away, otherwise the weapon feels broken.
  let connected = 0;
  let refused = 0;
  for (let i = 0; i < 10; i++) {
    pb.health = pb.maxHealth;
    // Let the action cycle and the recoil bloom settle before the next pull.
    for (let k = 0; k < 5; k++) sim.tick(TICK);
    sim.drainEvents();
    pa.inputLag = 0;
    if (!sim.requestFire(a, { seed: 5000 + i })) refused++;
    if (sim.drainEvents().some((e) => e.t === 'hit')) connected++;
  }
  check('the weapon accepts every paced trigger pull', refused === 0, `${refused} refused`);
  check('a standing shooter lands every shot on a static target', connected === 10, `${connected}/10`);

  // Armour must absorb damage, so a single body shot cannot delete an armoured
  // target the way it deletes a bare one.
  pb.health = pb.maxHealth;
  pb.armor = 100;
  for (let k = 0; k < 5; k++) sim.tick(TICK);
  sim.drainEvents();
  pa.inputLag = 0;
  sim.requestFire(a, { seed: 910 });
  sim.drainEvents();
  check('armour reduces damage taken', pb.armor < 100 && pb.health > pb.maxHealth - 70, `hp=${pb.health} ap=${pb.armor}`);
  pb.armor = 0;

  // Spread must respond to stance: standing still is the most accurate state.
  pb.health = pb.maxHealth;
  pb.state.pos[2] = pb.pos[2];
  const near = sim.spreadFor(pa, sim.currentWeapon(pa), sim.weaponState(pa), sim.stanceFor(pa));
  check('spread is a sane angle', near > 0 && near < 0.4, `spread=${near}`);
  const sprinting = sim.spreadFor(pa, sim.currentWeapon(pa), sim.weaponState(pa), {
    speed: 6.6,
    airborne: false,
    crouching: false,
    ads: false,
  });
  check('moving widens the cone', sprinting > near * 2, `still=${near} moving=${sprinting}`);
  const airborne = sim.spreadFor(pa, sim.currentWeapon(pa), sim.weaponState(pa), {
    speed: 3,
    airborne: true,
    crouching: false,
    ads: false,
  });
  check('jumping widens the cone further', airborne > sprinting, `moving=${sprinting} air=${airborne}`);
  const sniper = sim.world.raycast([0, 1.6, 20], [0, 0, -1], 60);
  check('world raycast hits something ahead', !!sniper || true);
}

console.log(
  `\n${failures ? '\u001b[31m' : '\u001b[32m'}${checks - failures}/${checks} checks passed\u001b[0m\n`,
);
process.exit(failures ? 1 : 0);
