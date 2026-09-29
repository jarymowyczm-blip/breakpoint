import { buildWorld, playerHitboxes, raycastPlayers } from './world.js';
import { buildNav } from './nav.js';
import { stepPlayer, makePlayerState, eyePosition, fallDamage } from './movement.js';
import {
  getWeapon,
  makeWeaponState,
  updateWeapon,
  startReload,
  cancelReload,
  finishReload,
  releaseTrigger,
  shotDirections,
  computeDamage,
  weaponMoveMultiplier,
  LOADOUTS,
} from './weapons.js';
import { createBotBrain, updateBot, resetBrain, botName, botSpread } from './ai.js';
import { PLAYER, COMBAT, NET, DIFFICULTY } from './constants.js';
import { clamp, makeRng, randRange, vdist, rayBox, raySphere, EPS } from './math.js';

/**
 * The authoritative simulation.
 *
 * One instance owns the truth for one match. The Node server runs it for
 * online play; the browser runs the exact same class in-process for practice
 * and campaign, which is why offline play needs no separate code path and
 * behaves identically to the network version.
 *
 * Everything time-related uses the simulation clock (`this.time`), never
 * wall-clock time, so a match can be replayed and the client can predict against
 * the identical model.
 */

const FLAG = {
  grounded: 1,
  crouching: 2,
  sprinting: 4,
  ads: 8,
  reloading: 16,
  firing: 32,
  sprintLock: 64,
};

const KILL_SCORE = 100;
const HEADSHOT_BONUS = 25;
const ASSIST_SCORE = 30;
const OBJECTIVE_SCORE = 150;

export const MODES = {
  // `killLimit` is deliberately in KILLS, not in scoreboard points: points are
  // 100 per kill and comparing the two would end a match on the first frag.
  tdm: { name: 'Team Deathmatch', teams: 2, respawn: true, killLimit: 50, timeLimit: 600, friendlyFire: false },
  ffa: { name: 'Free For All', teams: 0, respawn: true, killLimit: 20, timeLimit: 600, friendlyFire: false },
  practice: { name: 'Practice', teams: 1, respawn: true, respawnTime: 1.2, killLimit: 0, timeLimit: 0, friendlyFire: false, infiniteAmmo: false },
  campaign: { name: 'Campaign', teams: 1, respawn: true, respawnTime: 3.5, killLimit: 0, timeLimit: 0, friendlyFire: false },
};

export class Sim {
  constructor({ level, mode = 'tdm', levelId = null, seed = 1, botFill = 0, difficulty = 'regular', practiceDistance = 15, practiceBots = 0, campaign = false }) {
    this.level = level;
    this.levelId = levelId || level.id;
    this.mode = MODES[mode] ? mode : 'tdm';
    this.rules = MODES[this.mode];
    this.rng = makeRng(seed);
    this.time = 0;
    this.tickCount = 0;
    this.dt = 0;

    this.world = buildWorld(level);
    this.nav = buildNav(this.world);

    this.players = new Map();
    this.bots = new Map();
    this.events = [];
    this.sounds = [];
    this.frames = [];
    this.nextId = 1;

    this.matchState = 'live';
    this.timeLeft = this.rules.timeLimit;
    this.teamScores = { a: 0, b: 0 };
    this.winner = null;
    this.matchOverAt = 0;

    this.botFill = botFill;
    this.difficulty = difficulty;
    this.usedSpawns = new Map();
    this.assistWindow = COMBAT.assistWindow;

    // Practice-mode extras
    this.targets = new Map();
    this.practice = {
      distance: practiceDistance,
      shots: 0,
      hits: 0,
      headshots: 0,
      score: 0,
      streak: 0,
      bestStreak: 0,
      startedAt: 0,
      lastHitAt: -99,
    };

    if (this.mode === 'practice') this.buildTargets();
    if (this.mode === 'campaign') this.setupCampaign();

    this.nextBotIndex = 0;
  }

  // -----------------------------------------------------------------------
  // Setup helpers
  // -----------------------------------------------------------------------

  buildTargets() {
    const list = this.level.targets || [];
    for (const t of list) {
      this.targets.set(t.id, {
        ...t,
        // `p` is mutated by rail movers, so the authored position is kept as the
        // oscillation origin rather than being read back out of the live state.
        p: [t.p[0], t.p[1], t.p[2]],
        baseP: [t.p[0], t.p[1], t.p[2]],
        up: t.type !== 'popup',
        hitAt: -99,
        hits: 0,
        phase: this.rng() * 10,
      });
    }
  }

  setupCampaign() {
    const lvl = this.level;
    const obj = lvl.objectives || {};
    this.campaign = {
      missionId: `${lvl.id}-01`,
      missionName: lvl.name,
      phase: 0,
      objectiveText: obj.clear ? obj.clear.label : 'Advance',
      clearTarget: 6,
      cleared: 0,
      defendSeconds: obj.defend ? obj.defend.seconds : 90,
      defendLeft: obj.defend ? obj.defend.seconds : 90,
      waveIndex: 0,
      nextWaveAt: 2,
      escortStarted: false,
      complete: false,
      failed: false,
      checkpoint: 0,
      zones: {
        clear: obj.clear || { p: [0, 0, 0], r: 20 },
        defend: obj.defend || { p: [0, 0, 0], r: 14 },
        escort: obj.escort || { from: [0, 0, 0], to: [20, 0, 20], r: 6 },
      },
      hvtId: null,
    };
    this.waves = lvl.waves || [];
  }

  // -----------------------------------------------------------------------
  // Membership
  // -----------------------------------------------------------------------

  addPlayer({ id = null, name = 'Player', team = null, isBot = false, difficulty = null, archetype = 'assault', loadout = null, skill = 0 }) {
    const pid = id ?? this.nextId++;
    const assignedTeam = this.assignTeam(team);
    const spawn = this.pickSpawn(assignedTeam);
    const state = makePlayerState(spawn, this.spawnYawFor(assignedTeam, spawn));
    const lo = loadout || LOADOUTS[this.mode === 'campaign' ? 'campaign' : 'default'];

    const player = {
      id: pid,
      name,
      team: assignedTeam,
      isBot,
      skill,
      state,
      pos: state.pos,
      vel: state.vel,
      health: PLAYER.maxHealth,
      maxHealth: PLAYER.maxHealth,
      armor: this.mode === 'campaign' ? 40 : 0,
      alive: true,
      crouching: false,
      grounded: true,
      sprinting: false,
      ads: false,
      eye: [spawn[0], spawn[1] + PLAYER.eyeStand, spawn[2]],
      kills: 0,
      deaths: 0,
      assists: 0,
      score: 0,
      shotsFired: 0,
      shotsHit: 0,
      damageDealt: 0,
      headshots: 0,
      lastDamageAt: -99,
      lastDamageBy: null,
      damageLog: new Map(),
      respawnAt: 0,
      protectionUntil: this.time + COMBAT.spawnProtection,
      loadout: lo,
      slot: 'primary',
      weapons: {
        primary: makeWeaponState(lo.primary),
        secondary: makeWeaponState(lo.secondary),
      },
      switchEndsAt: 0,
      switchTo: null,
      pendingInput: null,
      inputSeq: 0,
      inputLag: 0.06,
      lastInputAt: 0,
      firingUntil: -99,
      muzzleFlashUntil: -99,
      lastFootstepAt: -99,
      isHvt: false,
      escortHold: false,
    };
    this.players.set(pid, player);
    this.events.push({ t: 'join', id: pid, name, team: assignedTeam, isBot });
    return pid;
  }

  addBot({ team = null, difficulty = null, archetype = 'assault', name = null } = {}) {
    const diff = difficulty || this.difficulty;
    const assignedTeam = this.assignTeam(team);
    const seed = (this.rng() * 1e9) | 0;
    const pid = this.nextId++;
    const brain = createBotBrain({ team: assignedTeam, archetype, difficulty: diff, seed });
    const displayName = name || botName(this.rng, assignedTeam);
    const id = this.addPlayer({ id: pid, name: displayName, team: assignedTeam, isBot: true, difficulty: diff, archetype, loadout: { primary: brain.weaponId, secondary: 'pistol' } });
    const p = this.players.get(id);
    p.brain = brain;
    brain.weaponId = p.loadout.primary;
    brain.escort = false;
    this.bots.set(id, brain);
    return id;
  }

  assignTeam(requested) {
    // FFA ignores team requests entirely: every player is their own faction.
    if (this.mode === 'ffa') return `solo${this.players.size}`;
    // An explicit team always wins. Campaign spawns its enemies onto team 'b',
    // and silently rewriting that to 'a' would make every enemy a teammate --
    // which is exactly as broken as it sounds.
    if (requested) return requested;
    if (this.mode === 'practice' || this.mode === 'campaign') return 'a';
    let a = 0;
    let b = 0;
    for (const p of this.players.values()) {
      if (p.team === 'a') a++;
      else if (p.team === 'b') b++;
    }
    return a <= b ? 'a' : 'b';
  }

  spawnsFor(team) {
    const s = this.level.spawns || {};
    if (this.mode === 'ffa') return s.ffa || s.a || [[0, 0, 0]];
    if (this.mode === 'practice') return s.practice || s.ffa || [[0, 0, 0]];
    if (this.mode === 'campaign') return s.campaign || s.a || [[0, 0, 0]];
    return s[team] || s.a || [[0, 0, 0]];
  }

  /**
   * Spawn choice: furthest from living enemies, with a small penalty for points
   * recently used, so a spawn never drops you in someone's crosshair and never
   * repeats the same corner twice in a row.
   */
  pickSpawn(team) {
    const list = this.spawnsFor(team);
    if (list.length === 1) return list[0];
    let best = list[0];
    let bestScore = -Infinity;
    for (const sp of list) {
      let nearest = Infinity;
      for (const p of this.players.values()) {
        if (!p.alive) continue;
        const hostile = this.mode === 'ffa' || p.team !== team;
        const d = Math.hypot(p.pos[0] - sp[0], p.pos[2] - sp[2]);
        if (hostile) nearest = Math.min(nearest, d);
      }
      const used = this.usedSpawns.get(sp[0] * 1000 + sp[2]) || 0;
      const score = (nearest === Infinity ? 40 : Math.min(nearest, 60)) - used * 6 - this.rng() * 4;
      if (score > bestScore) {
        bestScore = score;
        best = sp;
      }
    }
    this.usedSpawns.set(best[0] * 1000 + best[2], (this.usedSpawns.get(best[0] * 1000 + best[2]) || 0) + 1);
    return best;
  }

  spawnYawFor(team, spawn) {
    // Face the middle of the map so players are not staring at a wall.
    return Math.atan2(-(0 - spawn[0]), -(0 - spawn[2])) + Math.PI;
  }

  removePlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    this.players.delete(id);
    this.bots.delete(id);
    this.events.push({ t: 'leave', id, name: p.name });
  }

  getPlayer(id) {
    return this.players.get(id);
  }

  alivePlayers() {
    const out = [];
    for (const p of this.players.values()) if (p.alive) out.push(p);
    return out;
  }

  // -----------------------------------------------------------------------
  // Networking input
  // -----------------------------------------------------------------------

  setInput(id, cmd) {
    const p = this.players.get(id);
    if (!p) return;
    // Keep only the newest command: the server integrates at its own tick rate,
    // and every command carries the dt the client used to produce it.
    p.pendingInput = { input: cmd.input, dt: cmd.dt, seq: cmd.seq, at: this.time };
    p.inputSeq = cmd.seq;
    p.lastInputAt = this.time;
  }

  setInputLag(id, lag) {
    const p = this.players.get(id);
    if (p) p.inputLag = clamp(lag, 0, NET.maxRewind);
  }

  currentWeapon(p) {
    return getWeapon(p.loadout[p.slot]);
  }

  weaponState(p) {
    return p.weapons[p.slot];
  }

  setSlot(id, slot) {
    const p = this.players.get(id);
    if (!p || !p.alive) return;
    if (slot !== 'primary' && slot !== 'secondary') return;
    if (p.slot === slot) return;
    const w = getWeapon(p.loadout[slot]);
    cancelReload(this.weaponState(p));
    releaseTrigger(getWeapon(p.loadout[p.slot]), this.weaponState(p));
    p.switchTo = slot;
    p.switchEndsAt = this.time + w.switchTime;
    this.events.push({ t: 'switch', id, slot, weapon: w.id });
  }

  requestReload(id) {
    const p = this.players.get(id);
    if (!p || !p.alive) return;
    const w = this.currentWeapon(p);
    const st = this.weaponState(p);
    if (startReload(w, st, this.time)) {
      this.events.push({ t: 'reload', id, weapon: w.id, duration: st.reloadEndsAt - this.time });
    }
  }

  /**
   * A client asks to fire. The server owns the outcome: it validates the rate,
   * generates the pellet cone from the client's seed (so the client's tracer and
   * the server's bullet agree) and rewinds other players for lag compensation.
   */
  requestFire(id, cmd = {}) {
    const p = this.players.get(id);
    if (!p || !p.alive) return false;
    if (p.switchEndsAt > this.time) return false;
    if (p.sprinting && p.mode !== 'practice') {
      // Sprinting players cannot shoot: this is what makes sprint a commitment.
      p.sprinting = false;
    }
    const w = this.currentWeapon(p);
    const st = this.weaponState(p);
    const ctx = this.stanceFor(p);
    const result = this.fireWeapon(p, w, st, ctx, cmd);
    return result;
  }

  stanceFor(p) {
    const speed = Math.hypot(p.vel[0], p.vel[2]);
    return {
      speed,
      airborne: !p.grounded,
      crouching: p.crouching,
      ads: p.ads,
    };
  }

  fireWeapon(p, w, st, ctx, cmd) {
    const now = this.time;
    if (st.reloading) return false;
    if (st.ammo <= 0) {
      // Dry fire: audible click, and auto-reload for convenience.
      if (now - (st.lastDryFireAt || -9) > 0.35) {
        st.lastDryFireAt = now;
        this.events.push({ t: 'dryfire', id: p.id });
      }
      this.requestReload(p.id);
      return false;
    }
    if (st.pumpEndsAt && now < st.pumpEndsAt) return false;
    if (now < st.nextFireAt) return false;
    if (w.fireMode !== 'auto') {
      if (st.triggerWasDown) return false;
      st.triggerWasDown = true;
    }
    if (!this.rules.infiniteAmmo) st.ammo--;
    else if (st.ammo <= 0) st.ammo = w.magSize;

    st.shotIndex++;
    st.nextFireAt = now + 60 / w.rpm;
    st.lastShotAt = now;
    st.bloom = Math.min(w.spread.max * 1.4, st.bloom + w.spread.perShot);
    if (w.fireMode === 'pump' || w.fireMode === 'bolt') st.pumpEndsAt = now + (60 / w.rpm) * 0.92;
    p.shotsFired++;
    p.firingUntil = now + 0.09;

    let spread = this.spreadFor(p, w, st, ctx);
    if (p.isBot && p.brain) spread += botSpread(p.brain);

    const seed = (cmd.seed ?? ((this.rng() * 1e9) | 0)) >>> 0;
    eyePosition(p.state, p.eye);
    const baseDir = [
      -Math.sin(p.state.yaw) * Math.cos(p.state.pitch),
      Math.sin(p.state.pitch),
      -Math.cos(p.state.yaw) * Math.cos(p.state.pitch),
    ];
    const dirs = shotDirections(w, baseDir, spread, seed);

    this.events.push({
      t: 'shot',
      id: p.id,
      weapon: w.id,
      origin: [p.eye[0], p.eye[1], p.eye[2]],
      dir: baseDir,
      spread,
      seed,
      pellets: dirs.length,
      // The first pellet's direction is what remote clients draw as a tracer;
      // sending the seed lets the client regenerate the whole cone if it wants.
    });
    this.sounds.push({ kind: 'shot', pos: [p.pos[0], p.pos[1] + 1.5, p.pos[2]], team: p.team, weapon: w.id, at: now });

    // Recoil kick applied to the shooter's view (authoritative so the client's
    // predicted view and the server's agree closely).
    const pattern = w.recoil.pattern[Math.min(st.shotIndex - 1, w.recoil.pattern.length - 1)];
    p.recoilPitch = (p.recoilPitch || 0) + pattern[1] * 0.0115;
    p.recoilYaw = (p.recoilYaw || 0) + pattern[0] * 0.0115 * (this.rng() < 0.5 ? 1 : -1);

    // Resolve every pellet.
    const rewind = this.rewindTargets(p);
    let hitSomething = false;
    for (let i = 0; i < dirs.length; i++) {
      const dir = dirs[i];
      const worldHit = this.world.raycast([p.eye[0], p.eye[1], p.eye[2]], dir, COMBAT.maxRange);
      const maxDist = worldHit ? worldHit.t : COMBAT.maxRange;
      const targetHit = this.raycastRewound(rewind, [p.eye[0], p.eye[1], p.eye[2]], dir, maxDist, p);
      if (targetHit) {
        hitSomething = true;
        const dmg = computeDamage(w, targetHit.distance, targetHit.part);
        this.applyDamage(targetHit.player, p, dmg, targetHit.part, w.id, targetHit.point, dir);
      }
    }
    if (hitSomething) p.shotsHit++;
    this.checkTargetHits(p, w, [p.eye[0], p.eye[1], p.eye[2]], dirs);
    return true;
  }

  /** Spread for a shot: weapon cone + stance, plus a small locomotion penalty. */
  spreadFor(p, w, st, ctx) {
    const sp = w.spread;
    let value = ctx.ads ? sp.ads : sp.base;
    if (ctx.crouching && !ctx.ads) value *= sp.crouch;
    if (!ctx.ads) value += sp.move * clamp(ctx.speed / COMBAT.movingSpreadRefSpeed, 0, 1.35);
    else value += sp.move * clamp(ctx.speed / COMBAT.movingSpreadRefSpeed, 0, 1.35) * 0.45;
    if (ctx.airborne) value += sp.air;
    value += st.bloom;
    return Math.min(value, sp.max + Math.max(sp.base, sp.ads));
  }

  /**
   * Snapshot the positions of every other player as they were when the shooter
   * pulled the trigger. Without this, anyone with latency would have to lead
   * their targets against a simulation that already moved on.
   */
  rewindTargets(shooter) {
    const rewindTime = clamp(shooter.inputLag + NET.interpDelay, 0, NET.maxRewind);
    const target = this.time - rewindTime;
    const out = [];
    if (!this.frames.length) {
      for (const p of this.players.values()) out.push({ player: p, pos: [p.pos[0], p.pos[1], p.pos[2]], crouching: p.crouching });
      return out;
    }
    // Find the two frames bracketing the rewind instant and lerp between them.
    let hi = this.frames.length - 1;
    while (hi > 0 && this.frames[hi].t > target) hi--;
    const a = this.frames[hi];
    const b = this.frames[Math.min(hi + 1, this.frames.length - 1)];
    const span = Math.max(EPS, b.t - a.t);
    const alpha = clamp((target - a.t) / span, 0, 1);
    for (const p of this.players.values()) {
      if (p.id === shooter.id || !p.alive) continue;
      const pa = a.players.get(p.id);
      const pb = b.players.get(p.id);
      if (!pa || !pb) continue;
      out.push({
        player: p,
        pos: [
          pa.pos[0] + (pb.pos[0] - pa.pos[0]) * alpha,
          pa.pos[1] + (pb.pos[1] - pa.pos[1]) * alpha,
          pa.pos[2] + (pb.pos[2] - pa.pos[2]) * alpha,
        ],
        crouching: alpha < 0.5 ? pa.crouching : pb.crouching,
      });
    }
    return out;
  }

  /** Raycast the rewound player capsules, respecting team rules. */
  raycastRewound(targets, origin, dir, maxDist, shooter) {
    let best = null;
    for (const t of targets) {
      const p = t.player;
      if (!p.alive) continue;
      if (!this.rules.friendlyFire && this.sameTeam(p, shooter)) continue;
      if (this.time < p.protectionUntil) continue;
      const boxes = playerHitboxes(t.pos, PLAYER.heightStand, t.crouching);
      const head = raySphere(origin, dir, boxes.head.center, boxes.head.radius, maxDist);
      const torso = capsuleRay(origin, dir, boxes.torso.base, boxes.torso.radius, boxes.torso.height, maxDist);
      const legsHit = rayBox(origin, dir, boxes.legs, maxDist);
      const legs = legsHit === -1 ? -1 : legsHit.t;
      for (const [part, d] of [
        ['head', head],
        ['torso', torso],
        ['legs', legs],
      ]) {
        if (d < 0 || d > maxDist) continue;
        if (!best || d < best.distance) {
          best = {
            player: p,
            part,
            distance: d,
            point: [origin[0] + dir[0] * d, origin[1] + dir[1] * d, origin[2] + dir[2] * d],
          };
        }
      }
    }
    return best;
  }

  sameTeam(a, b) {
    if (!a || !b) return false;
    if (this.mode === 'ffa') return a.id === b.id;
    return a.team === b.team;
  }

  // -----------------------------------------------------------------------
  // Damage / death
  // -----------------------------------------------------------------------

  applyDamage(victim, attacker, amount, part, weaponId, point, dir) {
    if (!victim.alive || amount <= 0) return;
    if (this.time < victim.protectionUntil) return;
    if (attacker && !this.rules.friendlyFire && attacker !== victim && this.sameTeam(victim, attacker)) return;

    let remaining = amount;
    if (victim.armor > 0) {
      const absorbed = Math.min(victim.armor, amount * 0.6);
      victim.armor -= absorbed;
      remaining = amount - absorbed;
    }
    victim.health -= remaining;
    victim.lastDamageAt = this.time;
    victim.lastDamageBy = attacker ? attacker.id : null;

    if (attacker && attacker !== victim) {
      attacker.damageDealt += amount;
      const log = victim.damageLog;
      const entry = log.get(attacker.id) || { amount: 0, at: 0 };
      entry.amount += amount;
      entry.at = this.time;
      log.set(attacker.id, entry);
      // Being shot makes a bot look at you immediately.
      if (victim.brain && attacker.alive) {
        victim.brain.alertness = 1;
        victim.brain.lastKnown = [attacker.pos[0], attacker.pos[1], attacker.pos[2]];
        victim.brain.lastSeenAt = this.time - 0.2;
        victim.brain.targetId = attacker.id;
        victim.brain.reactUntil = Math.min(victim.brain.reactUntil, this.time + victim.brain.diff.reactionTime * 0.6);
      }
      if (attacker.brain) {
        attacker.brain.alertness = 1;
      }
    }

    this.events.push({
      t: 'hit',
      attacker: attacker ? attacker.id : null,
      victim: victim.id,
      part,
      amount: Math.round(amount * 10) / 10,
      weapon: weaponId,
      point,
      dir,
      health: Math.max(0, Math.round(victim.health)),
      armor: Math.max(0, Math.round(victim.armor)),
    });

    if (victim.health <= 0) {
      victim.health = 0;
      this.kill(victim, attacker, weaponId, part);
    }
  }

  kill(victim, killer, weaponId, part) {
    victim.alive = false;
    victim.deaths++;
    victim.respawnAt = this.time + (this.rules.respawnTime || COMBAT.respawnTime);
    const headshot = part === 'head';

    let killerName = null;
    if (killer && killer !== victim) {
      killer.kills++;
      killer.score += KILL_SCORE + (headshot ? HEADSHOT_BONUS : 0);
      if (headshot) killer.headshots++;
      killerName = killer.name;
      if (this.mode === 'tdm') {
        if (killer.team === 'a') this.teamScores.a++;
        else if (killer.team === 'b') this.teamScores.b++;
      }
      // Assists for everyone else who did meaningful damage in the window.
      for (const [id, entry] of victim.damageLog) {
        if (id === killer.id) continue;
        if (this.time - entry.at > this.assistWindow) continue;
        const helper = this.players.get(id);
        if (!helper || helper.team === victim.team) continue;
        helper.assists++;
        helper.score += ASSIST_SCORE;
        this.events.push({ t: 'assist', id, victim: victim.id });
      }
    }

    if (this.mode === 'campaign' && victim.brain && victim.team !== 'a') {
      const cz = this.campaign.zones.clear;
      const d = Math.hypot(victim.pos[0] - cz.p[0], victim.pos[2] - cz.p[2]);
      if (d <= cz.r + 6) {
        this.campaign.cleared++;
        const p = this.firstHuman();
        if (p) p.score += OBJECTIVE_SCORE * 0.5;
      }
    }

    this.events.push({
      t: 'death',
      id: victim.id,
      name: victim.name,
      killer: killer ? killer.id : null,
      killerName,
      weapon: weaponId,
      headshot,
      pos: [victim.pos[0], victim.pos[1], victim.pos[2]],
      yaw: victim.state.yaw,
      distance: killer ? Math.hypot(killer.pos[0] - victim.pos[0], killer.pos[1] - victim.pos[1], killer.pos[2] - victim.pos[2]) : 0,
    });
    victim.damageLog.clear();
    victim.recoilPitch = 0;
    victim.recoilYaw = 0;
  }

  respawn(p) {
    const spawn = this.pickSpawn(p.team);
    const st = p.state;
    st.pos[0] = spawn[0];
    st.pos[1] = spawn[1] + 0.02;
    st.pos[2] = spawn[2];
    st.vel[0] = 0;
    st.vel[1] = 0;
    st.vel[2] = 0;
    st.height = PLAYER.heightStand;
    st.grounded = false;
    st.yaw = this.spawnYawFor(p.team, spawn);
    st.pitch = 0;
    p.pos = st.pos;
    p.health = p.maxHealth;
    p.armor = this.mode === 'campaign' ? 40 : 0;
    p.alive = true;
    p.crouching = false;
    p.ads = false;
    p.damageLog.clear();
    p.lastDamageBy = null;
    p.protectionUntil = this.time + COMBAT.spawnProtection;
    p.switchEndsAt = 0;
    p.weapons.primary = makeWeaponState(p.loadout.primary);
    p.weapons.secondary = makeWeaponState(p.loadout.secondary);
    p.slot = 'primary';
    if (p.brain) resetBrain(p.brain, st.yaw);
    this.events.push({ t: 'respawn', id: p.id, pos: [spawn[0], spawn[1], spawn[2]] });
  }

  firstHuman() {
    for (const p of this.players.values()) if (!p.isBot) return p;
    return null;
  }

  // -----------------------------------------------------------------------
  // Practice targets
  // -----------------------------------------------------------------------

  checkTargetHits(p, w, origin, dirs) {
    if (this.mode !== 'practice') return;
    for (const dir of dirs) {
      let bestT = COMBAT.maxRange;
      let bestTarget = null;
      for (const t of this.targets.values()) {
        if (!t.up) continue;
        const box = targetBox(t);
        const hit = rayBox(origin, dir, box, bestT);
        if (hit !== -1 && hit.t < bestT) {
          bestT = hit.t;
          bestTarget = t;
        }
      }
      if (!bestTarget) continue;
      // Only count it if the world does not block the shot.
      const worldHit = this.world.raycast(origin, dir, bestT);
      if (worldHit && worldHit.t < bestT - 0.05) continue;
      const pr = this.practice;
      const hitPoint = [origin[0] + dir[0] * bestT, origin[1] + dir[1] * bestT, origin[2] + dir[2] * bestT];
      const head = hitPoint[1] > bestTarget.p[1] + 0.55;
      const pts = (bestTarget.points ?? 10) * (head ? 1.5 : 1);
      if (pts < 0) {
        pr.score += pts;
        pr.streak = 0;
        this.events.push({ t: 'target', id: bestTarget.id, hit: true, points: pts, head, penalty: true, point: hitPoint });
      } else {
        pr.hits += 1;
        pr.score += pts;
        pr.streak += 1;
        pr.bestStreak = Math.max(pr.bestStreak, pr.streak);
        if (head) pr.headshots += 1;
        this.events.push({ t: 'target', id: bestTarget.id, hit: true, points: pts, head, point: hitPoint });
      }
      bestTarget.hitAt = this.time;
      bestTarget.hits++;
      if (bestTarget.type === 'popup') bestTarget.up = false;
    }
    if (this.firstHuman()) this.practice.shots = this.firstHuman().shotsFired;
  }

  updateTargets(dt) {
    if (this.mode !== 'practice') return;
    for (const t of this.targets.values()) {
      if (t.type === 'popup') {
        const cycle = t.interval || 2;
        const phase = (this.time + t.phase) % cycle;
        const want = phase < (t.upTime || 1.5);
        if (want !== t.up) t.up = want;
      } else if (t.type === 'mover') {
        const range = t.range || 10;
        const speed = t.speed || 3;
        const s = Math.sin((this.time * speed) / range) * range;
        if (t.axis === 'x') t.p[0] = t.baseP[0] + s;
        else t.p[2] = t.baseP[2] + s;
      }
    }
  }

  // -----------------------------------------------------------------------
  // Campaign
  // -----------------------------------------------------------------------

  updateCampaign(dt) {
    const c = this.campaign;
    if (!c || c.complete || c.failed) return;
    const human = this.firstHuman();
    if (!human) return;

    if (c.phase === 0) {
      c.objectiveText = `Clear the courtyard  (${c.cleared}/${c.clearTarget})`;
      if (!c.spawnedInitial) {
        c.spawnedInitial = true;
        for (let i = 0; i < 6; i++) this.spawnCampaignEnemy();
      }
      if (c.cleared >= c.clearTarget) {
        c.phase = 1;
        c.checkpoint = 1;
        c.objectiveText = 'Hold the HQ';
        c.nextWaveAt = this.time + 3;
        this.events.push({ t: 'objective', text: 'Objective complete: courtyard clear', state: 'done' });
        this.events.push({ t: 'objective', text: 'New objective: hold the HQ for 90 seconds', state: 'new' });
        this.saveProgress();
      }
    } else if (c.phase === 1) {
      c.defendLeft = Math.max(0, c.defendLeft - dt);
      c.objectiveText = `Hold the HQ  (${Math.ceil(c.defendLeft)}s)`;
      const liveEnemies = this.countEnemies();
      if (this.waves.length && c.waveIndex < this.waves.length && this.time >= c.nextWaveAt) {
        const wave = this.waves[c.waveIndex];
        for (let i = 0; i < wave.size; i++) {
          this.spawnCampaignEnemy(wave.types[i % wave.types.length]);
        }
        c.waveIndex++;
        const next = this.waves[c.waveIndex];
        c.nextWaveAt = this.time + (next ? next.at - wave.at : 9999);
        this.events.push({ t: 'wave', index: c.waveIndex, total: this.waves.length, enemies: wave.size });
      }
      if (liveEnemies === 0 && c.waveIndex >= this.waves.length && c.defendLeft > 0) {
        // All waves dealt with: accelerate the clock rather than making the
        // player stand around waiting for a timer.
        c.defendLeft = Math.max(0, c.defendLeft - dt * 4);
      }
      if (c.defendLeft <= 0) {
        c.phase = 2;
        c.checkpoint = 2;
        c.objectiveText = 'Escort the HVT to extraction';
        this.spawnHvt();
        this.events.push({ t: 'objective', text: 'Objective complete: HQ held', state: 'done' });
        this.events.push({ t: 'objective', text: 'New objective: escort the HVT to the extraction pad', state: 'new' });
        this.saveProgress();
      }
    } else if (c.phase === 2) {
      const hvt = this.players.get(c.hvtId);
      const escort = c.zones.escort;
      const to = escort.to;
      if (!hvt || !hvt.alive) {
        c.objectiveText = 'HVT down -- regrouping';
        if (!c.hvtRespawnAt) c.hvtRespawnAt = this.time + 5;
        if (this.time >= c.hvtRespawnAt) {
          c.hvtRespawnAt = 0;
          this.spawnHvt();
        }
        return;
      }
      const distToHvt = Math.hypot(human.pos[0] - hvt.pos[0], human.pos[2] - hvt.pos[2]);
      const hvtToExit = Math.hypot(hvt.pos[0] - to[0], hvt.pos[2] - to[2]);
      c.objectiveText = `Escort HVT to extraction  (${Math.round(hvtToExit)}m)`;
      // The HVT only advances while the player is close enough to cover it.
      hvt.brain.assignedPoint = distToHvt < 14 ? [to[0], to[1], to[2]] : null;
      hvt.brain.escortHold = distToHvt >= 14;
      if (hvtToExit < escort.r + 1.5) {
        c.phase = 3;
        c.complete = true;
        c.objectiveText = 'Mission complete';
        c.checkpoint = 3;
        human.score += OBJECTIVE_SCORE * 4;
        this.events.push({ t: 'objective', text: 'Mission complete', state: 'done' });
        this.events.push({ t: 'mission', state: 'complete', mission: c.missionId });
        this.saveProgress();
      }
    }
  }

  countEnemies() {
    let n = 0;
    for (const p of this.players.values()) {
      if (p.alive && p.isBot && p.team !== 'a' && !p.isHvt) n++;
    }
    return n;
  }

  spawnCampaignEnemy(archetype = 'assault') {
    const spawns = (this.level.spawns && this.level.spawns.enemy) || [];
    if (!spawns.length) return null;
    const human = this.firstHuman();
    // Spawn at an entry point that is not right on top of the player, biased
    // toward the objective so enemies come from where the mission says they do.
    let best = spawns[0];
    let bestScore = -Infinity;
    for (const sp of spawns) {
      const dPlayer = human ? Math.hypot(sp[0] - human.pos[0], sp[2] - human.pos[2]) : 30;
      if (dPlayer < 18) continue;
      const score = Math.min(dPlayer, 70) + this.rng() * 10;
      if (score > bestScore) {
        bestScore = score;
        best = sp;
      }
    }
    const diff = this.pickWaveDifficulty();
    const id = this.addBot({ team: 'b', difficulty: diff, archetype });
    const p = this.players.get(id);
    p.state.pos[0] = best[0];
    p.state.pos[1] = best[1] + 0.02;
    p.state.pos[2] = best[2];
    p.eye[0] = best[0];
    p.eye[2] = best[2];
    p.protectionUntil = this.time + 0.5;
    // Most enemies push the objective; a couple hold ground.
    if (p.brain) {
      p.brain.assignedPoint = this.campaign.zones.defend.p;
      p.brain.patrolToPlayer = archetype === 'aggressive';
    }
    return id;
  }

  pickWaveDifficulty() {
    const base = DIFFICULTY[this.difficulty] ? this.difficulty : 'regular';
    const order = ['recruit', 'regular', 'veteran', 'elite'];
    const idx = order.indexOf(base);
    const c = this.campaign;
    const bump = c && c.phase >= 1 ? 1 : 0;
    return order[clamp(idx + bump, 0, order.length - 1)];
  }

  spawnHvt() {
    const c = this.campaign;
    if (c.hvtId && this.players.has(c.hvtId)) this.removePlayer(c.hvtId);
    const from = c.zones.escort.from;
    const id = this.addBot({ team: 'a', difficulty: 'veteran', archetype: 'defensive', name: 'HVT "COLDSTORE"' });
    const p = this.players.get(id);
    p.isHvt = true;
    p.health = 150;
    p.maxHealth = 150;
    p.armor = 60;
    p.loadout = { primary: 'pistol', secondary: 'pistol' };
    p.weapons.primary = makeWeaponState('pistol');
    p.weapons.secondary = makeWeaponState('pistol');
    p.state.pos[0] = from[0];
    p.state.pos[1] = from[1] + 0.02;
    p.state.pos[2] = from[2];
    p.eye[0] = from[0];
    p.eye[2] = from[2];
    p.brain.assignedPoint = null;
    c.hvtId = id;
    this.events.push({ t: 'objective', text: 'HVT is on the move -- stay close', state: 'new' });
    return id;
  }

  saveProgress() {
    const c = this.campaign;
    if (!c) return null;
    const human = this.firstHuman();
    const save = {
      missionId: c.missionId,
      missionName: c.missionName,
      levelId: this.levelId,
      checkpoint: c.checkpoint,
      phase: c.phase,
      score: human ? human.score : 0,
      kills: human ? human.kills : 0,
      deaths: human ? human.deaths : 0,
      accuracy: human && human.shotsFired ? human.shotsHit / human.shotsFired : 0,
      savedAt: Date.now(),
    };
    this.save = save;
    this.events.push({ t: 'save', save });
    return save;
  }

  // -----------------------------------------------------------------------
  // Match flow
  // -----------------------------------------------------------------------

  checkMatchEnd() {
    if (this.matchState !== 'live') return;
    const rules = this.rules;
    if (rules.killLimit > 0) {
      if (this.mode === 'tdm' && (this.teamScores.a >= rules.killLimit || this.teamScores.b >= rules.killLimit)) {
        this.endMatch(this.teamScores.a >= rules.killLimit ? 'a' : 'b');
        return;
      }
      if (this.mode === 'ffa') {
        for (const p of this.players.values()) {
          if (p.kills >= rules.killLimit) {
            this.endMatch(p.id);
            return;
          }
        }
      }
    }
    if (rules.timeLimit > 0 && this.timeLeft <= 0) {
      if (this.mode === 'tdm') this.endMatch(this.teamScores.a === this.teamScores.b ? 'draw' : this.teamScores.a > this.teamScores.b ? 'a' : 'b');
      else {
        let best = null;
        for (const p of this.players.values()) if (!best || p.score > best.score) best = p;
        this.endMatch(best ? best.id : 'draw');
      }
    }
  }

  endMatch(winner) {
    this.matchState = 'over';
    this.winner = winner;
    this.matchOverAt = this.time;
    this.events.push({ t: 'match', state: 'over', winner, scores: { ...this.teamScores } });
  }

  resetMatch() {
    this.matchState = 'live';
    this.winner = null;
    this.timeLeft = this.rules.timeLimit;
    this.teamScores.a = 0;
    this.teamScores.b = 0;
    for (const p of this.players.values()) {
      p.kills = 0;
      p.deaths = 0;
      p.assists = 0;
      p.score = 0;
      p.shotsFired = 0;
      p.shotsHit = 0;
      if (!p.alive) this.respawn(p);
    }
    this.events.push({ t: 'match', state: 'live' });
  }

  // -----------------------------------------------------------------------
  // Tick
  // -----------------------------------------------------------------------

  tick(dt) {
    this.dt = dt;
    this.time += dt;
    this.tickCount++;
    if (this.rules.timeLimit > 0 && this.matchState === 'live') this.timeLeft = Math.max(0, this.timeLeft - dt);

    this.updateTargets(dt);
    if (this.mode === 'campaign') this.updateCampaign(dt);

    for (const p of this.players.values()) {
      this.updatePlayer(p, dt);
    }

    this.recordFrame();
    this.checkMatchEnd();

    // A finished match rolls into a fresh one automatically, which is what you
    // want on a public server: no lobby round trip between games.
    if (this.matchState === 'over' && this.time - this.matchOverAt > 9 && this.rules.killLimit > 0) {
      this.resetMatch();
    }

    // Age out stale sounds (used for bot hearing) and cap the event queue.
    const cutoff = this.time - 0.6;
    while (this.sounds.length && this.sounds[0].at < cutoff) this.sounds.shift();
    if (this.events.length > 512) this.events.splice(0, this.events.length - 512);
  }

  updatePlayer(p, dt) {
    const now = this.time;

    // Respawn handling.
    if (!p.alive) {
      if (this.rules.respawn && now >= p.respawnAt) this.respawn(p);
      else return;
    }

    // Weapon switching completes after the swap animation.
    if (p.switchEndsAt && now >= p.switchEndsAt) {
      if (p.switchTo) p.slot = p.switchTo;
      p.switchTo = null;
      p.switchEndsAt = 0;
    }

    const w = this.currentWeapon(p);
    const st = this.weaponState(p);
    updateWeapon(w, st, dt, now);

    // Bots decide for themselves.
    let input = null;
    let wantFire = false;
    if (p.isBot) {
      const ctx = {
        world: this.world,
        nav: this.nav,
        enemies: this.enemiesOf(p),
        byId: this.players,
        now,
        weapon: w,
        sounds: this.sounds,
        level: this.level,
      };
      const out = updateBot(p, this.botView(p), ctx, dt);
      input = out.input;
      wantFire = out.wantFire;
      if (out.wantReload) this.requestReload(p.id);
      p.brain.wantReload = out.wantReload && st.ammo < w.magSize * 0.9;
      p.state.yaw = input.yaw;
      p.state.pitch = input.pitch;
    } else if (p.pendingInput) {
      input = p.pendingInput.input;
      // A client that has gone quiet stops moving rather than teleporting.
      if (now - p.lastInputAt > 0.5) input = { ...input, forward: 0, right: 0 };
    } else {
      input = { forward: 0, right: 0, jump: false, crouch: false, sprint: false, walk: false, yaw: p.state.yaw, pitch: p.state.pitch, ads: false };
    }

    p.ads = !!input.ads && !p.sprinting;

    const moveMult = weaponMoveMultiplier(w, { ads: p.ads, sprinting: p.sprinting });
    const events = stepPlayer(this.world, p.state, input, dt, {
      moveMult,
      canJump: true,
      canSprint: true,
    });

    p.pos = p.state.pos;
    p.vel = p.state.vel;
    p.crouching = p.state.crouching;
    p.grounded = p.state.grounded;
    p.sprinting = p.state.sprinting;
    eyePosition(p.state, p.eye);

    // Recoil decay.
    if (p.recoilPitch || p.recoilYaw) {
      const dec = Math.exp(-w.recoil.recovery * dt);
      p.recoilPitch = (p.recoilPitch || 0) * dec;
      p.recoilYaw = (p.recoilYaw || 0) * dec;
      if (Math.abs(p.recoilPitch) < 1e-4) p.recoilPitch = 0;
      if (Math.abs(p.recoilYaw) < 1e-4) p.recoilYaw = 0;
    }

    if (events.jumped) this.events.push({ t: 'jump', id: p.id, pos: [p.pos[0], p.pos[1], p.pos[2]] });
    if (events.landed) {
      const dmg = fallDamage(events.landSpeed);
      this.events.push({ t: 'land', id: p.id, pos: [p.pos[0], p.pos[1], p.pos[2]], speed: events.landSpeed, damage: dmg });
      if (dmg > 0) this.applyDamage(p, null, dmg, 'torso', 'fall', [p.pos[0], p.pos[1], p.pos[2]], [0, -1, 0]);
    }
    if (events.footstep) {
      p.lastFootstepAt = now;
      this.events.push({ t: 'footstep', id: p.id, pos: [p.pos[0], p.pos[1], p.pos[2]], speed: Math.hypot(p.vel[0], p.vel[2]) });
      this.sounds.push({ kind: 'step', pos: [p.pos[0], p.pos[1] + 0.2, p.pos[2]], team: p.team, at: now });
    }

    // Firing. A bot fires on its own decision; a human's shot arrives as a
    // `requestFire` message handled elsewhere, so this only covers bots.
    if (wantFire) this.requestFire(p.id, {});

    // Health regeneration.
    if (p.health < p.maxHealth && now - p.lastDamageAt > PLAYER.healthRegenDelay) {
      p.health = Math.min(p.maxHealth, p.health + PLAYER.healthRegenRate * dt);
    }

    // Out-of-bounds protection: a player who falls out of the world comes back.
    if (p.pos[1] < this.level.bounds.min[1] - 8) {
      this.applyDamage(p, null, 999, 'torso', 'void', [p.pos[0], p.pos[1], p.pos[2]], [0, 1, 0]);
    }
  }

  /** A read-only view of a bot for its own AI (it must not see hidden state). */
  botView(p) {
    return {
      id: p.id,
      team: p.team,
      pos: p.pos,
      eye: p.eye,
      health: p.health,
      maxHealth: p.maxHealth,
      crouching: p.crouching,
      grounded: p.grounded,
      weaponAmmo: this.weaponState(p).ammo,
      brain: p.brain,
    };
  }

  enemiesOf(p) {
    const out = [];
    for (const other of this.players.values()) {
      if (other.id === p.id) continue;
      if (!this.rules.friendlyFire && this.sameTeam(other, p) && this.mode !== 'ffa') continue;
      if (other.isHvt && other.team === p.team) continue;
      out.push({
        id: other.id,
        team: other.team,
        pos: other.pos,
        alive: other.alive,
        crouching: other.crouching,
      });
    }
    return out;
  }

  /** Ring buffer of player positions used for lag compensation. */
  recordFrame() {
    const players = new Map();
    for (const p of this.players.values()) {
      players.set(p.id, { pos: [p.pos[0], p.pos[1], p.pos[2]], crouching: p.crouching });
    }
    this.frames.push({ t: this.time, players });
    const keep = Math.ceil(NET.lagCompHistory / Math.max(1 / 120, this.dt)) + 2;
    while (this.frames.length > Math.max(4, keep)) this.frames.shift();
  }

  // -----------------------------------------------------------------------
  // Snapshots
  // -----------------------------------------------------------------------

  /**
   * Compact state for the wire. Positions are rounded to millimetres and angles
   * to ~0.02 degrees, which is well below anything a player can perceive but
   * cuts the payload roughly in half compared to full floats.
   */
  snapshot() {
    const players = [];
    for (const p of this.players.values()) {
      players.push([
        p.id,
        r3(p.pos[0]),
        r3(p.pos[1]),
        r3(p.pos[2]),
        r3(p.state.yaw),
        r3(p.state.pitch),
        r3(p.recoilPitch || 0),
        r3(p.recoilYaw || 0),
        this.flagsFor(p),
        Math.round(p.health),
        Math.round(p.armor),
        p.team,
        p.loadout[p.slot],
        p.weapons[p.slot].ammo,
        p.weapons.primary.ammo,
        p.weapons.secondary.ammo,
        p.kills,
        p.deaths,
        p.assists,
        Math.round(p.score),
        p.firingUntil > this.time ? 1 : 0,
        p.ads ? 1 : 0,
        r2(p.state.height),
      ]);
    }
    const targets = [];
    if (this.mode === 'practice') {
      for (const t of this.targets.values()) {
        targets.push([t.id, t.up ? 1 : 0, r3(t.p[0]), r3(t.p[1]), r3(t.p[2])]);
      }
    }
    return {
      tick: this.tickCount,
      t: r3(this.time),
      players,
      targets,
      teamScores: { ...this.teamScores },
      timeLeft: Math.round(this.timeLeft * 10) / 10,
      state: this.matchState,
      winner: this.winner,
      limits: { killLimit: this.rules.killLimit, timeLimit: this.rules.timeLimit },
      practice: this.mode === 'practice' ? { ...this.practice, shots: this.practice.shots } : null,
      campaign: this.mode === 'campaign' && this.campaign
        ? {
            objective: this.campaign.objectiveText,
            phase: this.campaign.phase,
            defendLeft: Math.round(this.campaign.defendLeft),
            cleared: this.campaign.cleared,
            clearTarget: this.campaign.clearTarget,
            wave: this.campaign.waveIndex,
            waves: this.waves.length,
            complete: this.campaign.complete,
            hvtId: this.campaign.hvtId,
          }
        : null,
    };
  }

  flagsFor(p) {
    let f = 0;
    if (p.grounded) f |= FLAG.grounded;
    if (p.crouching) f |= FLAG.crouching;
    if (p.sprinting) f |= FLAG.sprinting;
    if (p.ads) f |= FLAG.ads;
    if (p.weapons[p.slot].reloading) f |= FLAG.reloading;
    if (p.firingUntil > this.time) f |= FLAG.firing;
    if (!p.alive) f |= 128;
    return f;
  }

  drainEvents() {
    if (!this.events.length) return [];
    const out = this.events;
    this.events = [];
    return out;
  }

  /** Roster for the lobby UI and the scoreboard. */
  roster() {
    const out = [];
    for (const p of this.players.values()) {
      out.push({
        id: p.id,
        name: p.name,
        team: p.team,
        isBot: p.isBot,
        kills: p.kills,
        deaths: p.deaths,
        assists: p.assists,
        score: p.score,
        alive: p.alive,
        health: Math.round(p.health),
        isHvt: !!p.isHvt,
      });
    }
    return out.sort((a, b) => b.score - a.score || b.kills - a.kills);
  }

  /** Fill free slots with bots, keeping team sizes level. */
  fillWithBots(targetCount, { difficulty = null, archetypes = ['assault', 'defensive', 'aggressive', 'sniper'] } = {}) {
    let guard = 0;
    while (this.humanlessSlotsLeft(targetCount) && guard++ < 32) {
      const archetype = archetypes[Math.floor(this.rng() * archetypes.length)];
      this.addBot({ difficulty, archetype });
    }
  }

  humanlessSlotsLeft(target) {
    let count = 0;
    for (const p of this.players.values()) if (!p.isHvt) count++;
    return count < target;
  }
}

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

function r2(v) {
  return Math.round(v * 100) / 100;
}

function r3(v) {
  return Math.round(v * 1000) / 1000;
}

/** Target AABB from a target descriptor. */
function targetBox(t) {
  const size = t.size === 'small' ? 0.28 : t.size === 'popup' ? 0.42 : 0.5;
  const height = t.size === 'small' ? 0.5 : 1.15;
  return [t.p[0] - size, t.p[1] - size, t.p[2] - size, t.p[0] + size, t.p[1] - size + height, t.p[2] + size];
}

/** Ray vs a vertical capsule; kept local so sim.js has no import cycle. */
function capsuleRay(origin, dir, base, radius, height, maxDist) {
  const inside = (t) => {
    const py = origin[1] + dir[1] * t;
    const cy = clamp(py, base[1], base[1] + height);
    const dx = origin[0] + dir[0] * t - base[0];
    const dy = py - cy;
    const dz = origin[2] + dir[2] * t - base[2];
    return dx * dx + dy * dy + dz * dz <= radius * radius;
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

export { FLAG, targetBox };
