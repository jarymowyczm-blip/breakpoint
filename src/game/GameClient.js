/**
 * Game client.
 *
 * The single owner of a running match, whether that match is offline (practice
 * and campaign run the authoritative simulation in this process) or online (the
 * server owns it and we predict against snapshots). Everything either side needs
 * is behind the same interface, so the renderer, audio, HUD and effects never
 * learn which one they are driving.
 *
 * Frame order matters and is deliberate:
 *   1. input -> view angles, movement command, fire/reload/switch intents
 *   2. advance the local player through the shared movement code (prediction)
 *   3. online: send input; offline: tick the simulation and step in lockstep
 *   4. reconcile against authority
 *   5. consume events (shots, hits, kills, footsteps) -> effects and audio
 *   6. update characters from interpolated remote state
 *   7. render world, then the weapon overlay, then the 2D HUD
 */

import * as THREE from 'three';

import { Renderer } from './renderer/Renderer.js';
import { Viewmodel } from './renderer/Viewmodel.js';
import { CharacterManager } from './renderer/CharacterView.js';
import { Effects } from './renderer/Effects.js';
import { PracticeTargets } from './renderer/PracticeTargets.js';
import { Minimap } from './renderer/Minimap.js';
import { HudCanvas } from './renderer/HudCanvas.js';
import { AudioEngine } from './audio/AudioEngine.js';
import { Input } from './Input.js';
import { LocalPredictor } from './prediction.js';

import { Sim } from '../net/shared/sim.js';
import { buildWorld } from '../net/shared/world.js';
import { LEVELS } from '../net/shared/levels.js';
import { PLAYER, NET, COMBAT } from '../net/shared/constants.js';
import {
  getWeapon,
  makeWeaponState,
  updateWeapon,
  tryFire,
  releaseTrigger,
  currentSpread,
  aimDirection,
  startReload,
  shotInterval,
  LOADOUTS,
  WEAPONS,
} from '../net/shared/weapons.js';
import { clamp } from '../net/shared/math.js';

const TICK = 1 / NET.tickRate;
const MAX_STEP_MS = 90;
const SAVE_KEY = 'breachpoint.campaign';

export class GameClient {
  constructor({
    canvas,
    overlayCanvas,
    minimapCanvas,
    settings = {},
    net = null,
    onHud = null,
    onEvent = null,
  }) {
    this.canvas = canvas;
    this.overlayCanvas = overlayCanvas;
    this.minimapCanvas = minimapCanvas;
    this.settings = {
      sensitivity: 1,
      invertY: false,
      fov: 88,
      scopeSensitivity: 0.7,
      shadows: true,
      bloom: true,
      ambientOcclusion: true,
      renderScale: 1,
      shadowQuality: 2048,
      masterVolume: 0.75,
      sfxVolume: 1,
      showMinimap: true,
      showNameplates: true,
      ...settings,
    };
    this.net = net;
    this.onHud = onHud;
    this.onEvent = onEvent;

    this.running = false;
    this.paused = false;
    this.mode = 'practice';
    this.offline = true;
    this.level = null;
    this.levelId = null;
    this.world = null;
    this.sim = null;
    this.match = null;
    this.localId = 1;

    this.time = 0;
    this.frame = 0;
    this.accumulator = 0;
    this.lastFrameAt = 0;
    this.fps = 0;
    this.fpsSamples = [];
    this.hudTimer = 0;
    this.inputTimer = 0;

    // View state (owned here, not by the reducer, so prediction can drive it).
    this.yaw = 0;
    this.pitch = 0;
    this.crouching = false;
    this.ads = false;

    // Local weapon state for HUD/feel. Online this is a mirror that is corrected
    // by every snapshot; offline it IS the authoritative state.
    this.weaponState = makeWeaponState('ar');
    this.secondaryState = makeWeaponState('pistol');
    this.slot = 'primary';
    this.localAmmo = 30;
    this.localReserve = 240;

    // Feedback state.
    this.hitFlash = 0;
    this.damageFlash = 0;
    this.healFlash = 0;
    this.lowHealth = 0;
    this.lastHealth = PLAYER.maxHealth;
    this.killFeed = [];
    this.prevAlive = new Map();
    this.recentDamageTo = new Map();
    this.spectateId = null;
    this.respawnAt = 0;

    this.pendingFireCheck = [];
    this.lastFireSent = 0;
    this.inputSeq = 0;
    this.localShotSeq = 0;

    this.onlineStates = new Map();
    this.reloadingStartedAt = 0;
    this.reloadDuration = 0;

    this.handleResize = () => this.resize();
  }

  // ------------------------------------------------------------------- setup

  /**
   * Start a match. `config` differs by mode:
   *   { mode: 'practice', levelId, difficulty, bots, infiniteAmmo, distance }
   *   { mode: 'campaign', levelId, difficulty, resume }
   *   { mode: 'tdm'|'ffa', online: true }  -- joined from a lobby
   */
  start(config) {
    this.config = config;
    this.mode = config.mode || 'practice';
    this.levelId = config.levelId || (this.mode === 'campaign' ? 'compound' : this.mode === 'practice' ? 'range' : 'foundry');
    this.level = LEVELS[this.levelId] || LEVELS.foundry;
    this.offline = !config.online;

    // Collision world. Offline the simulation owns one; online we build our own
    // for prediction, which is the same code over the same declarative level.
    if (this.offline) {
      this.buildOfflineSim(config);
      this.world = this.sim.world;
    } else {
      this.world = buildWorld(this.level);
    }

    this.setupRenderer();
    this.setupAudio();
    this.setupInput();

    // Spawn: offline we know it; online the first snapshot tells us.
    const spawn = this.offline
      ? this.sim.players.get(this.localId).state.pos
      : (this.level.spawns?.ffa && this.level.spawns.ffa[0]) || [0, 0, 0];
    this.yaw = this.offline ? this.sim.players.get(this.localId).state.yaw : 0;
    this.pitch = 0;
    this.predictor = new LocalPredictor({ world: this.world, spawn: [spawn[0], spawn[1], spawn[2]], yaw: this.yaw });
    this.predictor.history.clear();

    this.matchStartAt = performance.now();
    this.running = true;
    this.paused = false;
    this.lastFrameAt = performance.now();
    this.loop = () => this.tickFrame();
    this.rafHandle = requestAnimationFrame(this.loop);

    this.emit({ type: 'started', mode: this.mode, levelId: this.levelId });
    return this;
  }

  /** Offline practice and campaign: the authoritative simulation runs here. */
  buildOfflineSim(config) {
    const infiniteAmmo = !!config.infiniteAmmo;
    this.sim = new Sim({
      level: this.level,
      mode: this.mode === 'campaign' ? 'campaign' : 'practice',
      levelId: this.levelId,
      seed: (Math.random() * 1e9) | 0,
      difficulty: config.difficulty || 'regular',
      practiceDistance: config.distance || 15,
    });
    this.sim.rules = { ...this.sim.rules, infiniteAmmo };

    const loadout = config.loadout || LOADOUTS.default;
    this.localId = this.sim.addPlayer({ name: config.name || 'Operator', team: null, loadout });
    const me = this.sim.players.get(this.localId);

    // Restore a campaign checkpoint before anything else, so the objective list
    // and enemy waves line up with the saved phase.
    if (this.mode === 'campaign' && config.resume) this.restoreCampaign(me);

    if (this.mode === 'practice') {
      const bots = config.bots ?? 0;
      const archetypes = ['assault', 'defensive', 'aggressive', 'sniper'];
      const spawns = this.level.botSpawns || [];
      for (let i = 0; i < bots; i++) {
        const botId = this.sim.addBot({
          difficulty: config.difficulty || 'regular',
          archetype: archetypes[i % archetypes.length],
          team: 'b',
        });
        // Practice bots stand where the range says, facing the firing line, so a
        // training session is repeatable instead of random.
        const spot = spawns[i % Math.max(1, spawns.length)];
        if (spot) {
          const p = this.sim.players.get(botId);
          p.state.pos = [spot.p[0], spot.p[1], spot.p[2]];
          p.state.yaw = spot.facing ?? 0;
          p.pos = p.state.pos;
          p.eye[0] = spot.p[0];
          p.eye[1] = spot.p[1] + p.state.height * 0.9;
          p.eye[2] = spot.p[2];
        }
      }
    }

    this.slot = 'primary';
    const w = getWeapon(me.loadout.primary);
    this.weaponState = me.weapons.primary;
    this.secondaryState = me.weapons.secondary;
    this.localAmmo = this.weaponState.ammo;
    this.localReserve = w.reserveMax;
  }

  setupRenderer() {
    this.renderer = new Renderer(this.canvas, {
      settings: {
        shadows: this.settings.shadows,
        bloom: this.settings.bloom,
        ambientOcclusion: this.settings.ambientOcclusion,
        renderScale: this.settings.renderScale,
        shadowQuality: this.settings.shadowQuality,
        fov: this.settings.fov,
      },
    });
    this.levelInfo = this.renderer.setLevel(this.level);

    this.viewmodel = new Viewmodel();
    this.renderer.setViewmodel(this.viewmodel.scene, this.viewmodel.camera);
    this.viewmodel.setFov(this.settings.fov);

    this.characters = new CharacterManager(this.renderer.scene);
    this.effects = new Effects(this.renderer.scene);
    this.targets = this.mode === 'practice' ? new PracticeTargets(this.renderer.scene) : null;

    this.minimap = this.minimapCanvas
      ? new Minimap(this.minimapCanvas, this.level, this.levelInfo.footprint)
      : null;
    this.hud = this.overlayCanvas ? new HudCanvas(this.overlayCanvas) : null;

    // Campaign objective markers live in the world.
    this.objectiveMarkers = [];
    if (this.mode === 'campaign' && this.sim?.campaign) {
      this.buildCampaignMarkers();
    }
    this.hvtMarker = null;

    this.resize();
  }

  setupAudio() {
    this.audio = new AudioEngine();
    this.audio.setVolumes({ master: this.settings.masterVolume, sfx: this.settings.sfxVolume });
  }

  setupInput() {
    this.input = new Input(this.canvas, {
      sensitivity: this.settings.sensitivity,
      invertY: this.settings.invertY,
    });
    this.input.enabled = true;
    this.input.onLockChange = (locked) => {
      if (!locked && this.running && !this.paused) this.pause('focus-lost');
      this.emit({ type: 'lockchange', locked });
    };
    this.input.onAction = (action, down) => this.handleAction(action, down);
  }

  // ---------------------------------------------------------------- lifecycle

  pause(reason = 'user') {
    if (this.paused) return;
    this.paused = true;
    if (this.input) this.input.releaseLock();
    this.audio.setVolumes({ sfx: this.settings.sfxVolume * 0.25 });
    this.emit({ type: 'paused', reason });
  }

  resume() {
    if (!this.running) return;
    this.paused = false;
    this.audio.init();
    this.audio.resume();
    this.audio.setVolumes({ sfx: this.settings.sfxVolume });
    this.lastFrameAt = performance.now();
    this.input.requestLock();
    this.emit({ type: 'resumed' });
  }

  stop() {
    this.running = false;
    if (this.rafHandle) cancelAnimationFrame(this.rafHandle);
    window.removeEventListener('resize', this.handleResize);
    this.input?.detach();
    this.audio?.dispose();
    this.characters?.clear();
    this.effects?.dispose();
    this.targets?.dispose();
    this.renderer?.dispose();
    this.emit({ type: 'stopped' });
  }

  resize() {
    this.renderer?.resize();
    const aspect = this.canvas.clientWidth / Math.max(1, this.canvas.clientHeight);
    this.viewmodel?.resize(aspect);
    this.minimap?.resize();
    this.hud?.resize();
  }

  applySettings(settings) {
    this.settings = { ...this.settings, ...settings };
    this.renderer?.applySettings({
      shadows: this.settings.shadows,
      bloom: this.settings.bloom,
      ambientOcclusion: this.settings.ambientOcclusion,
      renderScale: this.settings.renderScale,
      shadowQuality: this.settings.shadowQuality,
    });
    if (this.input) {
      this.input.setSensitivity(this.settings.sensitivity);
      this.input.invertY = this.settings.invertY;
    }
    if (this.renderer) this.renderer.camera.fov = this.settings.fov;
    if (this.viewmodel) this.viewmodel.setFov(this.settings.fov);
    this.audio?.setVolumes({ master: this.settings.masterVolume, sfx: this.settings.sfxVolume });
  }

  // ------------------------------------------------------------------- frame

  tickFrame() {
    if (!this.running) return;
    this.rafHandle = requestAnimationFrame(this.loop);

    const now = performance.now();
    let dt = (now - this.lastFrameAt) / 1000;
    this.lastFrameAt = now;
    // A tab switch or a long GC pause must not fast-forward the match.
    if (!Number.isFinite(dt) || dt <= 0) return;
    if (dt > MAX_STEP_MS / 1000) dt = MAX_STEP_MS / 1000;
    if (this.paused) {
      this.renderer?.render();
      return;
    }

    this.time += dt;
    this.frame++;
    this.updateFps(dt);

    this.readInput(dt);
    if (this.offline) this.stepOffline(dt);
    else this.stepOnline(dt);

    this.updateAuthoritativeState(dt);
    this.updateCamera(dt);
    this.updateEntities(dt);
    this.effects.update(dt, this.renderer.camera);
    this.viewmodel.update(dt, this.predictor.state, {
      yaw: this.yaw,
      pitch: this.pitch,
      speed: this.predictor.speed,
      grounded: this.predictor.state.grounded,
      ads: this.ads,
      weaponId: this.currentWeaponId(),
    });
    this.updateGrade(dt);
    this.updateObjectiveMarkers(dt);

    // World first, then the weapon overlay pass, then the 2D HUD on top.
    this.renderer.update(dt, this.predictor.renderPos());
    this.renderer.decayPulse();
    this.renderer.render();
    this.drawOverlay(dt);

    this.input.endFrame();
    this.publishHud(dt);
  }

  updateFps(dt) {
    this.fpsSamples.push(1 / dt);
    if (this.fpsSamples.length > 30) this.fpsSamples.shift();
    if (this.frame % 15 === 0) {
      this.fps = this.fpsSamples.reduce((a, b) => a + b, 0) / this.fpsSamples.length;
    }
  }

  // ------------------------------------------------------------------- input

  readInput(dt) {
    const input = this.input;
    if (!input) return;

    // Look. ADS scales sensitivity so aiming is not twitchy.
    const weapon = this.currentWeapon();
    const zoom = weapon.ads.zoom;
    const adsMult = this.ads ? weapon.ads.sensMult * (this.settings.scopeSensitivity ?? 1) / Math.max(1, zoom * 0.55) : 1;
    const look = input.applyLook(this.yaw, this.pitch, adsMult);
    this.yaw = look.yaw;
    this.pitch = look.pitch;

    this.ads = !!input.mouse.right && !input.isDown('sprint');
    input.adsActive = this.ads;

    // Weapon swap via keys and wheel.
    if (input.wasPressed('primary')) this.switchSlot('primary');
    if (input.wasPressed('secondary')) this.switchSlot('secondary');
    if (input.wasPressed('quickSwitch')) this.switchSlot(this.slot === 'primary' ? 'secondary' : 'primary');
    if (input.wheel !== 0) this.switchSlot(input.wheel > 0 ? 'secondary' : 'primary');

    if (input.wasPressed('reload')) this.requestReload();

    this.crouching = input.isDown('crouch');
    void dt;
  }

  handleAction(action, down) {
    if (action === 'scoreboard') this.emit({ type: 'scoreboard', visible: down });
    if (action === 'map') {
      this.mapOpen = down;
      this.emit({ type: 'map', visible: down });
    }
    if (action === 'pause' && down) this.emit({ type: 'pauseRequested' });
  }

  /** Build the movement command for the shared simulation. */
  moveCommand() {
    return this.input.moveCommand(this.yaw, this.pitch);
  }

  currentWeaponId() {
    if (this.offline && this.sim) {
      const me = this.sim.players.get(this.localId);
      return me ? me.loadout[this.slot] : this.weaponState.id;
    }
    return this.slot === 'secondary' ? (this.loadoutSecondary || 'pistol') : (this.loadoutPrimary || 'ar');
  }

  currentWeapon() {
    return getWeapon(this.currentWeaponId());
  }

  /** The weapon state the HUD and spread indicator should read. */
  activeWeaponState() {
    if (this.offline && this.sim) {
      const me = this.sim.players.get(this.localId);
      if (me) return me.weapons[this.slot];
    }
    return this.slot === 'secondary' ? this.secondaryState : this.weaponState;
  }

  // ------------------------------------------------------------------ offline

  /**
   * Offline: tick the simulation at a fixed rate and advance prediction in
   * lockstep, so the local player's state and the authoritative state are the
   * same computation and cannot drift.
   */
  stepOffline(dt) {
    const sim = this.sim;
    this.accumulator += dt;
    let steps = 0;
    while (this.accumulator >= TICK && steps < 5) {
      this.accumulator -= TICK;
      steps++;

      const cmd = this.moveCommand();
      sim.setInput(this.localId, { seq: ++this.inputSeq, dt: TICK, input: cmd });
      sim.tick(TICK);

      // Prediction uses the identical input and timestep.
      this.predictor.stepOnce(cmd, this.currentWeapon());
      this.syncLocalFromSim();
      // History is recorded per tick, not per frame, because interpolation
      // needs two authoritative endpoints to blend between.
      this.recordOfflineHistory();
    }
    if (this.accumulator > TICK * 5) this.accumulator = 0;

    this.processEvents(sim.drainEvents(), true);
    this.processSounds(sim.sounds);
    this.syncLocalFromSim();
  }

  /**
   * Keep the predicted state and the simulation's player in agreement. This
   * should be exact; the threshold exists only so a floating-point wobble does
   * not cause a visible correction.
   */
  syncLocalFromSim() {
    const me = this.sim.players.get(this.localId);
    if (!me) return;
    const st = this.predictor.state;
    const err = Math.hypot(
      st.pos[0] - me.pos[0],
      st.pos[1] - me.pos[1],
      st.pos[2] - me.pos[2],
    );
    if (err > 0.05) {
      st.pos[0] = me.pos[0];
      st.pos[1] = me.pos[1];
      st.pos[2] = me.pos[2];
      st.vel[0] = me.vel[0];
      st.vel[1] = me.vel[1];
      st.vel[2] = me.vel[2];
    }
    this.slot = me.slot;
    this.weaponState = me.weapons.primary;
    this.secondaryState = me.weapons.secondary;
    this.localAmmo = me.weapons[me.slot].ammo;
    this.localReserve = me.weapons[me.slot].reserve;
  }

  // ------------------------------------------------------------------- online

  stepOnline(dt) {
    const net = this.net;
    if (!net || !net.match) return;

    // Snapshot-driven identity: the server tells us who we are.
    if (this.localId !== net.match.you) {
      this.localId = net.match.you;
      this.syncLoadoutFromRoster(net.match);
      this.predictor.reset(this.predictor.state.pos, this.yaw);
      this.predictor.enabled = true;
    }

    const cmd = this.moveCommand();

    // Prediction advances every frame on the fixed-step accumulator.
    this.predictor.update(dt, cmd, this.currentWeapon());

    // Input goes out at 60 Hz regardless of frame rate.
    this.inputTimer += dt;
    const inputInterval = 1 / Math.min(120, NET.inputRate);
    if (this.inputTimer >= inputInterval) {
      this.inputTimer = 0;
      this.inputSeq++;
      net.sendInput(cmd, { yaw: this.yaw, pitch: this.pitch, ads: this.ads });
    }

    // Fire intent. The seed is generated here and sent, so the server's pellet
    // cone matches the tracer we draw immediately.
    this.serviceFireIntent(true);

    // Optimistic local weapon state, corrected by snapshots.
    const w = this.currentWeapon();
    updateWeapon(w, this.activeWeaponState(), dt, this.time);

    this.processEvents(net.takeEvents(), false);
    this.processSounds(net.takeSounds());
  }

  syncLoadoutFromRoster(match) {
    const row = match.roster?.find((r) => r.id === match.you);
    this.playerName = row?.name || 'Operator';
    // The roster does not carry loadouts; the weapon id comes from the snapshot
    // on the first frame, which is authoritative and always correct.
    this.loadoutPrimary = this.loadoutPrimary || 'ar';
    this.loadoutSecondary = this.loadoutSecondary || 'pistol';
    this.weaponState = makeWeaponState(this.loadoutPrimary);
    this.secondaryState = makeWeaponState(this.loadoutSecondary);
  }

  // ------------------------------------------------------------------ actions

  switchSlot(slot) {
    if (slot !== 'primary' && slot !== 'secondary') return;
    if (this.slot === slot) return;
    const w = this.offline && this.sim ? getWeapon(this.sim.players.get(this.localId).loadout[slot]) : getWeapon(slot === 'secondary' ? this.loadoutSecondary : this.loadoutPrimary);
    const st = this.activeWeaponState();
    releaseTrigger(this.currentWeapon(), st);
    this.slot = slot;
    this.viewmodel.draw(w.switchTime);
    this.audio.click(this.audio.ctx ? this.audio.ctx.currentTime : 0, 0.12, 1800, this.audio.sfxBus);

    if (this.offline) {
      this.sim.setSlot(this.localId, slot);
    } else {
      this.net?.sendSwitch(slot);
    }
  }

  requestReload() {
    const w = this.currentWeapon();
    const st = this.activeWeaponState();
    if (st.reloading || st.ammo >= w.magSize) return;
    if (this.offline) {
      this.sim.requestReload(this.localId);
      const state = this.sim.weaponState(this.sim.players.get(this.localId));
      if (state.reloading) {
        this.reloadDuration = state.reloadEndsAt - this.sim.time;
        this.viewmodel.reload(this.reloadDuration);
        this.audio.magazineOut();
        window.setTimeout(() => this.audio.rack(), 220);
      }
    } else {
      // Optimistic: start the animation now, let the snapshot confirm.
      const empty = st.ammo <= 0;
      const duration = empty ? w.reloadEmptyTime : w.reloadTime;
      if (!startReload(w, st, this.time)) return;
      this.reloadDuration = duration;
      this.viewmodel.reload(duration);
      this.audio.magazineOut();
      window.setTimeout(() => this.audio.rack(), 220);
      this.net.sendReload();
    }
  }

  /**
   * Firing.
   *
   * Trigger discipline is evaluated locally so a semi-auto weapon does not
   * auto-fire when the button is held, and so the muzzle flash is instant. The
   * server still decides whether the shot happened and what it hit.
   */
  serviceFireIntent(sendToServer) {
    const input = this.input;
    if (!input) return;
    const wantFire = input.mouse.left;
    const w = this.currentWeapon();
    const st = this.activeWeaponState();
    const me = this.offline ? this.sim.players.get(this.localId) : null;

    if (me && !me.alive) {
      releaseTrigger(w, st);
      return;
    }
    if (!wantFire) {
      releaseTrigger(w, st);
      return;
    }
    // Sprinting cannot shoot; the sim enforces this too, but checking here keeps
    // the viewmodel honest.
    if (!this.offline && this.predictor.state.sprinting) return;

    if (this.offline) {
      const accepted = this.sim.requestFire(this.localId, { seed: this.makeSeed() });
      if (accepted) this.onShotAccepted(w, st);
      else if (st.ammo <= 0 && !st.reloading) this.requestReload();
    } else {
      const result = tryFire(w, st, this.time, {
        ads: this.ads,
        crouching: this.predictor.state.crouching,
        airborne: !this.predictor.state.grounded,
        speed: this.predictor.speed,
      });
      if (result.ok) {
        const seed = this.makeSeed();
        this.onShotAccepted(w, st);
        if (sendToServer) this.net.sendFire(seed);
      } else if (result.reason === 'empty') {
        this.audio.dryFire();
        this.requestReload();
      }
    }
  }

  /**
   * Everything that happens the instant a shot goes out: viewmodel kick, sound,
   * flash, and the recoil that moves the player's actual aim.
   *
   * Applying recoil to `yaw`/`pitch` is what makes a pattern something you learn
   * to pull down against; the simulation's own `recoilPitch` field is only a
   * presentation channel and never feeds back into the shot direction.
   */
  onShotAccepted(w, st) {
    this.viewmodel.fire();
    this.audio.gunshot(w.id, null, { isLocal: true });
    this.renderer.pulse(this.muzzleWorld(), 0xffcf8a, 9, 14, 0.05);
    this.hitFlash = 0;

    const pattern = w.recoil.pattern[Math.min(Math.max(0, st.shotIndex - 1), w.recoil.pattern.length - 1)] || [0, 0];
    const swing = Math.random() < 0.5 ? 1 : -1;
    this.pitch = clamp(this.pitch + pattern[1] * 0.0115, -1.55, 1.55);
    this.yaw += pattern[0] * 0.0115 * swing;
  }

  makeSeed() {
    // A client-chosen seed lets us draw the tracer immediately; the server
    // regenerates the identical cone from it, so the two always agree.
    this.localShotSeq = (this.localShotSeq + 1) >>> 0;
    return ((this.localShotSeq * 2654435761) ^ (this.time * 1000)) >>> 0;
  }

  // ---------------------------------------------------------- authoritative

  /** Fold the server's answer into the predicted player. */
  updateAuthoritativeState(dt) {
    if (!this.offline) {
      const net = this.net;
      const latest = net?.snapshots.latest;
      if (latest) {
        const row = latest.players.find((r) => r[0] === this.localId);
        if (row) {
          // A respawn or death is a discontinuity: adopt it wholesale.
          const hard = row[8] & 128 ? true : !this.wasAlive;
          this.predictor.reconcile(row, latest.ack, { hard });
          this.wasAlive = !(row[8] & 128);
          this.applyAuthoritativeRow(row);
        }
      }
      this.processServerEffects();
    } else {
      // Offline there is no authority to reconcile against: the local
      // prediction IS the authority, so we only mirror the HUD values.
      const me = this.sim.players.get(this.localId);
      if (me) {
        this.health = me.health;
        this.armor = me.armor;
        this.kills = me.kills;
        this.deaths = me.deaths;
        this.assists = me.assists;
        this.score = me.score;
        this.dead = !me.alive;
        this.lastHealth = me.health;
      }
    }
    void dt;
  }

  /** Copy the parts of a snapshot row that the HUD and audio need. */
  applyAuthoritativeRow(row) {
    const health = row[9];
    const armor = row[10];
    if (health < this.lastHealth - 0.5) {
      const lost = this.lastHealth - health;
      this.damageFlash = Math.min(1, this.damageFlash + lost / 55);
      this.audio.damageTaken(lost, { headshot: this.lastHitWasHead });
      // Direction: from the last damage source, relative to the view.
      const src = this.lastDamageSource;
      if (src) {
        const angle = Math.atan2(src[0] - this.predictor.renderPos()[0], -(src[2] - this.predictor.renderPos()[2])) - this.yaw;
        this.hud?.showDamage(-angle, lost);
      }
    } else if (health > this.lastHealth + 0.5) {
      this.healFlash = Math.min(0.6, this.healFlash + (health - this.lastHealth) / 60);
    }
    this.lastHealth = health;
    this.health = health;
    this.armor = armor;
    this.kills = row[16];
    this.deaths = row[17];
    this.assists = row[18];
    this.score = row[19];
    this.flags = row[8];
    this.dead = (row[8] & 128) !== 0;
    this.authoritativeAmmo = row[13];
    this.authoritativeWeapon = row[12];

    // Online, mirror ammo and slot from authority so the HUD cannot drift.
    if (!this.offline) {
      if (this.authoritativeWeapon && this.authoritativeWeapon !== this.currentWeaponId()) {
        // The server still considers us on another weapon (usually a switch that
        // has not completed). Adopt it rather than fighting it.
        this.slot = this.authoritativeWeapon === this.loadoutSecondary ? 'secondary' : 'primary';
      }
      const st = this.activeWeaponState();
      if (Math.abs(st.ammo - this.authoritativeAmmo) > 0) st.ammo = this.authoritativeAmmo;
      const reloading = (row[8] & 16) !== 0;
      if (reloading && !st.reloading) {
        st.reloading = true;
        st.reloadEndsAt = this.time + this.currentWeapon().reloadTime;
      } else if (!reloading && st.reloading) {
        this.finishLocalReload();
      }
    }
  }

  finishLocalReload() {
    const w = this.currentWeapon();
    const st = this.activeWeaponState();
    const needed = w.magSize - st.ammo;
    const taken = Math.min(needed, st.reserve);
    st.ammo += taken;
    st.reserve -= taken;
    st.reloading = false;
    st.bloom = 0;
    this.viewmodel.cancelReload();
  }

  // ------------------------------------------------------------------ events

  /**
   * Translate simulation events into sound and pixels.
   *
   * `isLocal` means we are driving the simulation ourselves, in which case our
   * own shot was already drawn and heard the instant the trigger was pressed.
   */
  processEvents(events, isLocalSim) {
    if (!events || !events.length) return;
    for (const e of events) {
      switch (e.t) {
        // --- gunfire ------------------------------------------------------
        case 'shot': {
          if (e.id === this.localId) break; // already drawn at trigger time
          const muzzle = [e.origin[0], e.origin[1] - 0.12, e.origin[2]];
          const end = this.traceEndFor(e);
          this.effects.tracer(muzzle, end, { color: 0xffd9a0, width: 0.032, life: 0.07 });
          this.effects.muzzleFlash(muzzle, { size: 0.4, color: 0xffd9a0, life: 0.045 });
          this.audio.gunshot(e.weapon || 'ar', [e.origin[0], e.origin[1], e.origin[2]]);
          break;
        }

        // --- damage -------------------------------------------------------
        case 'hit': {
          const mine = e.attacker === this.localId;
          if (mine) {
            this.hud?.showHitmarker({ kill: false, headshot: e.part === 'head' });
            this.audio.hitMarker(e.part === 'head');
            this.lastHitWasHead = e.part === 'head';
            this.hitFlash = 0.12;
          }
          if (e.point) {
            if (mine || e.victim === this.localId) this.effects.spray(e.point, e.dir || [0, 0, 0], e.part);
            else this.audio.fleshImpact(e.point);
          }
          if (e.victim === this.localId) {
            this.lastDamageSource = e.point || null;
            this.lastHitWasHead = e.part === 'head';
          }
          break;
        }
        case 'death': {
          this.addKillFeed(e);
          const mine = e.killer === this.localId;
          const aboutMe = e.id === this.localId;
          if (mine) {
            this.hud?.showHitmarker({ kill: true, headshot: !!e.headshot });
            this.hud?.showKillConfirm(e.headshot ? 'HEADSHOT +25' : 'ELIMINATED');
            this.audio.killConfirmed();
          }
          if (aboutMe) {
            this.deathAt = this.time;
            this.lastDamageSource = null;
            if (this.mode === 'campaign') this.saveCampaign();
          }
          break;
        }
        case 'respawn': {
          if (e.id === this.localId) {
            // A respawn invalidates the local simulation; adopt the new spawn
            // outright rather than letting prediction argue with it.
            this.predictor.hardSnap(e.pos);
            this.predictor.state.vel[0] = 0;
            this.predictor.state.vel[1] = 0;
            this.predictor.state.vel[2] = 0;
            this.damageFlash = 0;
            this.deathAt = 0;
          }
          break;
        }

        // --- practice -----------------------------------------------------
        case 'target': {
          this.targets?.markHit(e.id);
          this.hud?.showHitmarker({ kill: false, headshot: !!e.head });
          this.audio.hitMarker(!!e.head);
          this.audio.targetHit(e.points, !!e.head);
          if (e.penalty) this.hud?.showKillConfirm(`${e.points}`);
          break;
        }

        // --- campaign -----------------------------------------------------
        case 'objective':
        case 'wave':
        case 'mission': {
          this.emit({ type: 'campaign', event: e });
          if (e.t === 'objective') this.saveCampaign();
          break;
        }
        case 'save': {
          break;
        }

        // --- locomotion ---------------------------------------------------
        case 'footstep': {
          if (e.id === this.localId) break;
          this.audio.footstep([e.pos[0], e.pos[1] + 0.2, e.pos[2]], this.surfaceAt(e.pos), { sprinting: e.speed > 5.2 });
          break;
        }
        case 'jump': {
          if (e.id === this.localId) {
            this.audio.footstep([e.pos[0], e.pos[1], e.pos[2]], this.surfaceAt(e.pos), { isLocal: true });
          }
          break;
        }
        case 'land': {
          this.audio.footstep([e.pos[0], e.pos[1], e.pos[2]], this.surfaceAt(e.pos), { isLocal: e.id === this.localId });
          if (e.id === this.localId) {
            this.landDip = Math.min(0.16, (e.speed || 0) / 90);
            if (e.damage > 0) this.damageFlash = Math.min(1, this.damageFlash + e.damage / 60);
          }
          break;
        }

        // --- weapons ------------------------------------------------------
        case 'dryfire': {
          if (e.id === this.localId) this.audio.dryFire();
          break;
        }
        case 'reload': {
          if (e.id !== this.localId) break;
          // The simulation owns the timing; the animation follows it.
          this.reloadDuration = e.duration;
          this.viewmodel.reload(e.duration);
          this.audio.magazineOut();
          window.setTimeout(() => this.audio.rack(), Math.min(600, e.duration * 380));
          break;
        }

        case 'match': {
          this.emit({ type: 'match', state: e.state, winner: e.winner });
          break;
        }

        case 'join':
        case 'leave':
        case 'switch':
        case 'assist':
        default:
          break;
      }
    }
    void isLocalSim;
  }

  /**
   * Where a remote shot's tracer should end: the nearest of the event's aim
   * point, the world, or a hit. Falls back to maximum range so a shot into the
   * sky still draws.
   */
  traceEndFor(event) {
    const origin = event.origin;
    const dir = event.dir || [0, 0, -1];
    const hit = this.world.raycast(origin, dir, COMBAT.maxRange);
    const distance = hit ? hit.t : 120;
    return [origin[0] + dir[0] * distance, origin[1] + dir[1] * distance, origin[2] + dir[2] * distance];
  }

  /**
   * Positional sound events carried in the snapshot stream. The server sends
   * these because bots only exist there -- but offline we already played them
   * from the event stream, so this is a no-op when driving our own simulation.
   */
  processSounds(sounds) {
    if (this.offline || !sounds || !sounds.length) return;
    for (const s of sounds) {
      if (s.kind === 'shot') this.audio.gunshot(s.weapon || 'ar', s.pos);
    }
  }

  /** Ammo/reload corrections and hit confirmation derived from snapshots. */
  processServerEffects() {
    // Nothing extra today: `applyAuthoritativeRow` handles the mirror and the
    // event stream handles feedback. Kept as a seam for future state channels.
  }

  addKillFeed(event) {
    this.killFeed.unshift({
      killer: event.killerName || this.nameOf(event.killer),
      victim: event.victimName || this.nameOf(event.victim),
      weapon: event.weapon || 'ar',
      headshot: !!event.headshot,
      at: this.time,
      killerId: event.killer,
      victimId: event.victim,
    });
    if (this.killFeed.length > 6) this.killFeed.pop();
  }

  nameOf(id) {
    if (id === this.localId) return this.playerName || 'You';
    if (this.offline && this.sim) return this.sim.players.get(id)?.name || 'Bot';
    const row = this.net?.match?.rosterById?.get(id);
    return row ? row.name : 'Operator';
  }

  surfaceAt(pos) {
    // Probe straight down for the material the footstep should sound like.
    const hit = this.world.raycast([pos[0], pos[1] + 0.4, pos[2]], [0, -1, 0], 1.4);
    return hit?.solid?.mat || 'concrete';
  }

  // --------------------------------------------------------------- rendering

  updateCamera(dt) {
    const cam = this.renderer.camera;
    const weapon = this.currentWeapon();

    // ADS pulls the camera in and zooms.
    const adsEase = this.viewmodel.adsAmount;
    const baseFov = this.settings.fov;
    const targetFov = baseFov / (1 + (weapon.ads.zoom - 1) * adsEase);
    const currentFov = cam.fov + (targetFov - cam.fov) * Math.min(1, dt * 18);

    const renderPos = this.predictor.renderPos();
    // Head bob is driven by the simulation's travelled distance, so it is in
    // step with the footsteps other players hear.
    const bobAmount = Math.min(1, this.predictor.speed / 5.4) * (1 - adsEase * 0.8) * (this.predictor.state.grounded ? 1 : 0.2);
    const bobPhase = this.predictor.state.bob * 2.1;
    const bobY = Math.abs(Math.sin(bobPhase)) * 0.032 * bobAmount;
    const bobRoll = Math.sin(bobPhase) * 0.012 * bobAmount;

    // Landing dip and strafe lean.
    this.landDip = Math.max(0, (this.landDip || 0) - dt * 3.6);
    const strafeLean = clamp(-this.input.moveCommand().right * 0.012, -0.02, 0.02);

    this.renderer.updateCamera({
      position: renderPos,
      yaw: this.yaw,
      pitch: this.pitch,
      fov: currentFov,
      roll: bobRoll + strafeLean,
      eyeHeight: this.predictor.eyeHeight - this.landDip,
    });
    void bobY;
  }

  /** Update every character rig from the authoritative or interpolated state. */
  updateEntities(dt) {
    const seen = new Set();
    const players = this.remoteStates(dt);
    const myTeam = this.offline
      ? this.sim.players.get(this.localId)?.team
      : this.net?.match?.yourTeam;

    for (const state of players) {
      if (state.id === this.localId) continue;
      seen.add(state.id);
      const info = this.playerInfo(state.id);
      this.characters.ensure(state.id, info);
      this.characters.update(state.id, state, dt, {
        showNameplates: this.settings.showNameplates && this.mode !== 'practice',
        isEnemy: myTeam != null && state.team !== myTeam,
      });
    }
    this.cachedRemote = players;
    // Reap rigs for players who are gone, so a long lobby does not leak meshes.
    for (const id of [...this.characters.rigs.keys()]) {
      if (!seen.has(id)) this.characters.remove(id);
    }

    if (this.targets && this.sim) {
      this.targets.sync(this.serializeTargets(), dt);
    }
  }

  playerInfo(id) {
    if (this.offline && this.sim) {
      const p = this.sim.players.get(id);
      return { team: p?.team || 'b', isBot: !!p?.isBot, name: p?.name || 'Bot' };
    }
    const row = this.net?.match?.rosterById?.get(id);
    return { team: row?.team || 'b', isBot: !!row?.isBot, name: row?.name || 'Operator' };
  }

  /**
   * Interpolated remote players, in the renderer's expected shape. Called once
   * per frame and cached, because the minimap and the nameplate pass both need
   * it and re-sampling would corrupt the speed estimate.
   */
  remoteStates(dt) {
    if (!this.offline) {
      const net = this.net;
      if (!net) return [];
      const rows = net.snapshots.sample(net.renderTime);
      const out = [];
      for (const row of rows) {
        // Estimate horizontal speed from the previous frame for animation.
        const prev = this.onlineStates.get(row.id);
        const speed = prev ? Math.hypot(row.x - prev.x, row.z - prev.z) / Math.max(1e-4, dt) : 0;
        this.onlineStates.set(row.id, { x: row.x, z: row.z });
        out.push({ ...row, speed: Math.min(speed, 9) });
      }
      return out;
    }

    // Offline: interpolate the simulation's own history between ticks.
    const out = [];
    const alpha = this.accumulator / TICK;
    for (const p of this.sim.players.values()) {
      const cur = this.currStates?.get(p.id) || this.captureState(p);
      const prev = this.prevStates?.get(p.id) || cur;
      out.push({
        id: p.id,
        x: prev.x + (cur.x - prev.x) * alpha,
        y: prev.y + (cur.y - prev.y) * alpha,
        z: prev.z + (cur.z - prev.z) * alpha,
        yaw: shortLerp(prev.yaw, cur.yaw, alpha),
        pitch: prev.pitch + (cur.pitch - prev.pitch) * alpha,
        team: cur.team,
        crouching: cur.crouching,
        sprinting: cur.sprinting,
        ads: cur.ads,
        reloading: cur.reloading,
        firing: cur.firing,
        grounded: cur.grounded,
        dead: cur.dead,
        health: cur.health,
        speed: cur.speed,
      });
    }
    return out;
  }

  captureState(p) {
    return {
      id: p.id,
      x: p.pos[0],
      y: p.pos[1],
      z: p.pos[2],
      yaw: p.state.yaw,
      pitch: p.state.pitch,
      team: p.team,
      crouching: p.crouching,
      sprinting: p.sprinting,
      ads: p.ads,
      reloading: p.weapons[p.slot].reloading,
      firing: p.firingUntil > this.sim.time,
      grounded: p.grounded,
      dead: !p.alive,
      health: p.health,
      speed: Math.hypot(p.vel[0], p.vel[2]),
    };
  }

  /**
   * Snapshot the offline state each tick. Interpolation blends between the
   * previous tick and the current one, so both endpoints must come from the
   * simulation rather than from the render frame.
   */
  recordOfflineHistory() {
    const next = new Map();
    for (const p of this.sim.players.values()) next.set(p.id, this.captureState(p));
    this.prevStates = this.currStates || next;
    this.currStates = next;
  }

  serializeTargets() {
    if (!this.sim) return [];
    const out = [];
    for (const t of this.sim.targets.values()) {
      out.push({ id: t.id, type: t.type, size: t.size, up: t.up, p: [t.p[0], t.p[1], t.p[2]], points: t.points, axis: t.axis, range: t.range });
    }
    return out;
  }

  // ---------------------------------------------------------------- overlays

  updateGrade(dt) {
    this.damageFlash = Math.max(0, this.damageFlash - dt * 1.6);
    this.healFlash = Math.max(0, this.healFlash - dt * 1.2);
    const health = this.health ?? PLAYER.maxHealth;
    const target = health < 35 ? (35 - health) / 35 : 0;
    this.lowHealth += (target - this.lowHealth) * Math.min(1, dt * 4);
    this.renderer.setGradeUniform('damage', Math.min(1, this.damageFlash));
    this.renderer.setGradeUniform('heal', Math.min(0.7, this.healFlash));
    this.renderer.setGradeUniform('lowHealth', this.lowHealth);
    if (this.hitFlash > 0) this.hitFlash = Math.max(0, this.hitFlash - dt * 3);
  }

  buildCampaignMarkers() {
    const zones = this.sim.campaign.zones;
    const color = '#ffd166';
    this.objectiveDefs = [];
    if (zones.clear) this.objectiveDefs.push({ id: 'clear', label: 'CLEAR', p: zones.clear.p, color });
    if (zones.defend) this.objectiveDefs.push({ id: 'defend', label: 'HOLD', p: zones.defend.p, color: '#7fd1ff' });
    if (zones.escort) this.objectiveDefs.push({ id: 'escort', label: 'EXTRACT', p: zones.escort.to, color: '#9cf28c' });
  }

  updateObjectiveMarkers(dt) {
    if (!this.objectiveDefs) return;
    const phase = this.sim?.campaign?.phase ?? 0;
    // Only the marker for the current phase is shown: one objective at a time.
    const wanted = phase <= 0 ? 'clear' : phase === 1 ? 'defend' : 'escort';
    const def = this.objectiveDefs.find((d) => d.id === wanted);
    this.objectiveMarkers = def ? [def] : [];
    void dt;
  }

  drawOverlay(dt) {
    const cam = this.renderer.camera;
    const project = (x, y, z) => this.project(cam, x, y, z);

    const objectives = [];
    for (const def of this.objectiveMarkers) {
      const point = project(def.p[0], def.p[1] + 1.4, def.p[2]);
      const distance = Math.hypot(def.p[0] - cam.position.x, def.p[2] - cam.position.z);
      objectives.push({ ...point, label: def.label, color: def.color, distance });
    }

    const nameplates = [];
    if (this.settings.showNameplates && this.mode !== 'practice') {
      const myTeam = this.offline ? this.sim.players.get(this.localId)?.team : this.net?.match?.yourTeam;
      for (const [id, rig] of this.characters.rigs) {
        const state = rig.group.position;
        const info = this.playerInfo(id);
        if (myTeam != null && info.team !== myTeam) continue;
        const point = project(state.x, state.y + 1.95, state.z);
        if (!point.visible) continue;
        const distance = point.distance;
        // Fade with distance so a crowded map does not become a wall of names.
        nameplates.push({
          ...point,
          name: info.name,
          team: info.team,
          distance,
          alpha: Math.max(0, Math.min(1, (70 - distance) / 24)),
        });
      }
    }

    const w = this.currentWeapon();
    const st = this.activeWeaponState();
    const spread = currentSpread(w, st, {
      ads: this.ads,
      crouching: this.predictor.state.crouching,
      airborne: !this.predictor.state.grounded,
      speed: this.predictor.speed,
    });
    const reloading = st.reloading || (this.flags & 16) !== 0;
    const reloadProgress = reloading
      ? 1 - Math.max(0, (st.reloadEndsAt - (this.offline ? this.sim.time : this.time))) / Math.max(0.01, this.reloadDuration || w.reloadTime)
      : 0;

    this.hud?.draw(dt, {
      dead: !!this.dead,
      ads: this.ads,
      fov: cam.fov,
      spread,
      precise: w.pellets === 1 && w.rpm < 400,
      reloading,
      reloadProgress: clamp(reloadProgress, 0, 1),
      time: this.time,
      hitFlash: this.hitFlash > 0,
      lowAmmo: st.ammo <= Math.max(3, w.magSize * 0.2),
      nameplates,
      objectives,
    });

    if (this.minimap && this.settings.showMinimap) {
      const players = [];
      const mine = this.predictor.renderPos();
      players.push({ id: this.localId, x: mine[0], z: mine[2], yaw: this.yaw, team: this.localTeam(), isLocal: true, dead: !!this.dead });
      for (const state of this.cachedRemote || []) {
        players.push({
          id: state.id,
          x: state.x,
          z: state.z,
          yaw: state.yaw,
          team: state.team,
          dead: state.dead,
          isBot: false,
        });
      }
      this.minimap.draw(players, {
        mode: this.mapOpen ? 'full' : 'radar',
        localTeam: this.localTeam(),
        viewRange: 44,
        callouts: this.level.callouts || [],
      });
    }
  }

  localTeam() {
    if (this.offline) return this.sim.players.get(this.localId)?.team || 'a';
    return this.net?.match?.yourTeam || 'a';
  }

  /** World point to screen pixels, plus whether it is in front of the camera. */
  project(camera, x, y, z) {
    const v = new THREE.Vector3(x, y, z).project(camera);
    const ndcX = v.x;
    const ndcY = -v.y;
    const visible = v.z < 1 && Math.abs(ndcX) < 1.15 && Math.abs(ndcY) < 1.15;
    const width = this.hud?.width || window.innerWidth;
    const height = this.hud?.height || window.innerHeight;
    const distance = Math.hypot(camera.position.x - x, camera.position.y - y, camera.position.z - z);
    return {
      x: (ndcX * 0.5 + 0.5) * width,
      y: (ndcY * 0.5 + 0.5) * height,
      ndcX,
      ndcY,
      distance,
      visible,
    };
  }

  muzzleWorld() {
    return this.viewmodel.muzzleWorldPosition(this.renderer.camera).toArray();
  }

  // --------------------------------------------------------------------- HUD

  publishHud(dt) {
    this.hudTimer += dt;
    if (this.hudTimer < 0.05) return;
    this.hudTimer = 0;
    if (!this.onHud) return;

    const w = this.currentWeapon();
    const st = this.activeWeaponState();
    const me = this.offline ? this.sim.players.get(this.localId) : null;

    let respawnIn = 0;
    let alive = true;
    if (me) {
      alive = me.alive;
      if (!alive) respawnIn = Math.max(0, me.respawnAt - this.sim.time);
    } else {
      alive = !this.dead;
    }

    const practice = this.mode === 'practice' && this.sim ? { ...this.sim.practice } : null;
    const campaign = this.mode === 'campaign' && this.sim?.campaign
      ? {
          objective: this.sim.campaign.objectiveText,
          phase: this.sim.campaign.phase,
          defendLeft: Math.round(this.sim.campaign.defendLeft),
          cleared: this.sim.campaign.cleared,
          clearTarget: this.sim.campaign.clearTarget,
          wave: this.sim.campaign.waveIndex,
          waves: this.sim.waves?.length || 0,
          complete: this.sim.campaign.complete,
          failed: this.sim.campaign.failed,
        }
      : null;

    const roster = this.buildScoreboard();

    this.onHud({
      mode: this.mode,
      you: this.localId,
      levelId: this.levelId,
      levelName: this.level.name,
      alive,
      dead: !alive,
      respawnIn,
      health: Math.round(this.health ?? PLAYER.maxHealth),
      maxHealth: me ? me.maxHealth : PLAYER.maxHealth,
      armor: Math.round(this.armor ?? 0),
      ammo: st.ammo,
      reserve: st.reserve,
      magSize: w.magSize,
      weaponId: w.id,
      weaponName: w.name,
      weaponClass: w.className,
      reloading: st.reloading,
      slot: this.slot,
      kills: this.kills || 0,
      deaths: this.deaths || 0,
      assists: this.assists || 0,
      score: this.score || 0,
      teamScores: this.offline ? { ...this.sim.teamScores } : { ...(this.net?.snapshots.latest?.teamScores || { a: 0, b: 0 }) },
      timeLeft: this.offline ? Math.round(this.sim.timeLeft) : Math.round(this.net?.snapshots.latest?.timeLeft || 0),
      killLimit: this.offline ? this.sim.rules.killLimit : this.net?.snapshots.latest?.limits?.killLimit || 0,
      matchState: this.offline ? this.sim.matchState : this.net?.snapshots.latest?.state || 'live',
      localTeam: this.localTeam(),
      ping: this.offline ? 0 : Math.round(this.net?.ping || 0),
      fps: Math.round(this.fps),
      spread: currentSpread(w, st, {
        ads: this.ads,
        crouching: this.predictor.state.crouching,
        airborne: !this.predictor.state.grounded,
        speed: this.predictor.speed,
      }),
      sprinting: this.predictor.state.sprinting,
      crouching: this.predictor.state.crouching,
      ads: this.ads,
      grounded: this.predictor.state.grounded,
      speed: this.predictor.speed,
      killFeed: this.killFeed,
      practice,
      campaign,
      roster,
      targetsRemaining: this.sim?.targets?.size || 0,
      loadout: this.offline && me ? me.loadout : { primary: this.loadoutPrimary || 'ar', secondary: this.loadoutSecondary || 'pistol' },
      interpDelay: this.offline ? 0 : Math.round((this.net?.interpDelay || 0) * 1000),
      killsToWin: this.mode === 'tdm' ? 50 : 20,
      mapOpen: !!this.mapOpen,
    });
  }

  buildScoreboard() {
    if (this.offline && this.sim) {
      return this.sim.roster().map((r) => ({ ...r, isYou: r.id === this.localId }));
    }
    const latest = this.net?.snapshots.latest;
    if (!latest) return [];
    const roster = this.net?.match?.rosterById;
    return latest.players
      .map((row) => {
        const info = roster?.get(row[0]);
        return {
          id: row[0],
          name: info?.name || 'Operator',
          team: row[11],
          isBot: !!info?.isBot,
          kills: row[16],
          deaths: row[17],
          assists: row[18],
          score: row[19],
          isYou: row[0] === this.localId,
          dead: (row[8] & 128) !== 0,
        };
      })
      .sort((a, b) => b.score - a.score);
  }

  setMapOpen(open) {
    this.mapOpen = open;
  }

  // -------------------------------------------------------------- campaign

  restoreCampaign(me) {
    const raw = safeReadLocal(SAVE_KEY);
    if (!raw) return;
    const campaign = this.sim.campaign;
    if (raw.phase != null) campaign.phase = raw.phase;
    if (raw.cleared != null) campaign.cleared = raw.cleared;
    if (raw.defendLeft != null) campaign.defendLeft = raw.defendLeft;
    if (raw.objectiveText) campaign.objectiveText = raw.objectiveText;
    if (raw.waveIndex != null) campaign.waveIndex = raw.waveIndex;
    campaign.checkpoint = raw.checkpoint || 0;
    if (me) {
      me.kills = raw.kills || 0;
      me.deaths = raw.deaths || 0;
    }
  }

  saveCampaign() {
    if (this.mode !== 'campaign' || !this.sim?.campaign) return;
    const c = this.sim.campaign;
    const payload = {
      phase: c.phase,
      cleared: c.cleared,
      defendLeft: c.defendLeft,
      objectiveText: c.objectiveText,
      waveIndex: c.waveIndex,
      checkpoint: c.checkpoint,
      kills: this.sim.players.get(this.localId)?.kills || 0,
      deaths: this.sim.players.get(this.localId)?.deaths || 0,
      savedAt: Date.now(),
    };
    // localStorage is the always-available path; the server copy is an upgrade,
    // not a requirement, so single-player works with no connection at all.
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(payload));
    } catch {
      /* storage disabled */
    }
    const token = this.net?.token;
    if (token) {
      fetch('/api/saves', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ slot: 'auto', missionId: `${this.levelId}-01`, data: payload }),
      }).catch(() => {
        /* offline is fine */
      });
    }
  }

  static loadCampaignSave() {
    return safeReadLocal(SAVE_KEY);
  }

  static clearCampaignSave() {
    try {
      localStorage.removeItem(SAVE_KEY);
    } catch {
      /* ignore */
    }
  }

  emit(event) {
    if (this.onEvent) this.onEvent(event);
  }
}

function shortLerp(a, b, t) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

function safeReadLocal(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export { TICK, WEAPONS, shotInterval, aimDirection };
