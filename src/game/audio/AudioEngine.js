/**
 * Audio engine.
 *
 * Every sound in the game is synthesised at runtime. There are no audio files:
 * a gunshot is a shaped noise burst plus a pitched body resonance plus an
 * environment tail, and the same handful of primitives produce footsteps,
 * reloads, impacts and UI clicks. That keeps the download small and makes it
 * trivial to retune a weapon by changing numbers rather than re-recording.
 *
 * Signal path:
 *   source -> [panner] -> bus gain -> master gain -> compressor -> destination
 *                        \-> reverb send -> convolver -> master
 *
 * Positional sounds use an HRTF panner against the camera-derived listener, so
 * you can hear which side a shot came from. Local sounds (your own weapon, UI)
 * bypass the panner entirely -- your own gun should not sound like it is coming
 * from somewhere in the room.
 */

const WEAPON_VOICE = {
  // body: resonant frequency of the receiver; snap: high transient level;
  // tail: how much environment reverb it excites; decay: length in seconds.
  ar: { level: 1.0, body: 180, snap: 0.9, tail: 0.55, decay: 0.17, pitch: 1.0 },
  smg: { level: 0.85, body: 220, snap: 1.0, tail: 0.4, decay: 0.13, pitch: 1.16 },
  shotgun: { level: 1.25, body: 110, snap: 0.85, tail: 0.8, decay: 0.3, pitch: 0.86 },
  dmr: { level: 1.1, body: 150, snap: 0.95, tail: 0.7, decay: 0.24, pitch: 0.96 },
  sniper: { level: 1.3, body: 120, snap: 1.0, tail: 0.95, decay: 0.4, pitch: 0.88 },
  pistol: { level: 0.8, body: 240, snap: 1.0, tail: 0.35, decay: 0.12, pitch: 1.2 },
};

/** Surface-dependent footstep character. */
const STEP_VOICE = {
  concrete: { body: 150, snap: 0.7, decay: 0.05, level: 0.7 },
  concreteDark: { body: 150, snap: 0.7, decay: 0.05, level: 0.7 },
  concreteMid: { body: 150, snap: 0.7, decay: 0.05, level: 0.7 },
  concretePad: { body: 160, snap: 0.7, decay: 0.06, level: 0.7 },
  asphalt: { body: 140, snap: 0.65, decay: 0.05, level: 0.65 },
  metal: { body: 320, snap: 0.85, decay: 0.09, level: 0.75 },
  metalRust: { body: 320, snap: 0.85, decay: 0.09, level: 0.75 },
  metalGrate: { body: 420, snap: 0.95, decay: 0.12, level: 0.8 },
  metalPlate: { body: 380, snap: 0.9, decay: 0.1, level: 0.78 },
  dirt: { body: 100, snap: 0.45, decay: 0.07, level: 0.6 },
  dirtTrench: { body: 100, snap: 0.45, decay: 0.07, level: 0.6 },
  dirtBerm: { body: 100, snap: 0.45, decay: 0.07, level: 0.6 },
  dirtRoad: { body: 105, snap: 0.4, decay: 0.07, level: 0.6 },
  sand: { body: 90, snap: 0.35, decay: 0.08, level: 0.55 },
  sandbag: { body: 95, snap: 0.35, decay: 0.08, level: 0.55 },
  crate: { body: 240, snap: 0.7, decay: 0.08, level: 0.75 },
  crateDark: { body: 240, snap: 0.7, decay: 0.08, level: 0.75 },
  woodBooth: { body: 240, snap: 0.7, decay: 0.08, level: 0.75 },
  containerRed: { body: 300, snap: 0.9, decay: 0.14, level: 0.85 },
  containerBlue: { body: 300, snap: 0.9, decay: 0.14, level: 0.85 },
  containerGreen: { body: 300, snap: 0.9, decay: 0.14, level: 0.85 },
  tarp: { body: 120, snap: 0.3, decay: 0.05, level: 0.45 },
  tire: { body: 80, snap: 0.25, decay: 0.05, level: 0.45 },
  treeTrunk: { body: 200, snap: 0.4, decay: 0.06, level: 0.55 },
  treeCanopy: { body: 500, snap: 0.5, decay: 0.09, level: 0.35 },
};

const DEFAULT_STEP = STEP_VOICE.concrete;

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.masterVolume = 0.75;
    this.sfxVolume = 1;
    this.musicVolume = 0.5;
    this.muted = false;
    this.noiseCache = new Map();
    this.voicesPlayed = 0;
  }

  /**
   * WebAudio may only start from a user gesture, so this is called on the first
   * click or keypress rather than at load.
   */
  init() {
    if (this.ctx) return this.ctx;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    const ctx = new Ctx({ latencyHint: 'interactive' });
    this.ctx = ctx;

    this.master = ctx.createGain();
    this.master.gain.value = this.masterVolume;

    // A compressor keeps a firefight from clipping when six people shoot at once.
    this.compressor = ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -14;
    this.compressor.knee.value = 22;
    this.compressor.ratio.value = 7;
    this.compressor.attack.value = 0.004;
    this.compressor.release.value = 0.18;

    this.master.connect(this.compressor);
    this.compressor.connect(ctx.destination);

    this.sfxBus = ctx.createGain();
    this.sfxBus.gain.value = this.sfxVolume;

    // A gentle high shelf tames the harshness of synthesised noise bursts, which
    // is the main thing that makes procedural gunshots sound cheap.
    this.tone = ctx.createBiquadFilter();
    this.tone.type = 'highshelf';
    this.tone.frequency.value = 5200;
    this.tone.gain.value = -7;

    this.sfxBus.connect(this.tone);
    this.tone.connect(this.master);

    this.uiBus = ctx.createGain();
    this.uiBus.gain.value = this.sfxVolume * 0.8;
    this.uiBus.connect(this.master);

    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this.makeImpulse(1.7, 2.6);
    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = 0.34;
    this.reverb.connect(this.master);
    this.reverbSend.connect(this.reverb);

    this.ambientBus = ctx.createGain();
    this.ambientBus.gain.value = 0;
    this.ambientBus.connect(this.master);

    this.startAmbient();
    this.ready = true;
    return ctx;
  }

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  }

  setVolumes({ master, sfx, menu } = {}) {
    if (master != null) {
      this.masterVolume = master;
      if (this.master) this.master.gain.value = this.muted ? 0 : master;
    }
    if (sfx != null) {
      this.sfxVolume = sfx;
      if (this.sfxBus) this.sfxBus.gain.value = sfx;
      if (this.uiBus) this.uiBus.gain.value = sfx * 0.8;
    }
    if (menu != null) this.musicVolume = menu;
    return this;
  }

  setMuted(muted) {
    this.muted = muted;
    if (this.master) this.master.gain.value = muted ? 0 : this.masterVolume;
  }

  // ------------------------------------------------------------------ sources

  /** Cached white noise, one buffer reused by every percussive sound. */
  noiseBuffer(seconds = 1) {
    const key = seconds;
    if (this.noiseCache.has(key)) return this.noiseCache.get(key);
    const { ctx } = this;
    const length = Math.max(1, Math.floor(ctx.sampleRate * seconds));
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    this.noiseCache.set(key, buffer);
    return buffer;
  }

  /** An exponentially decaying stereo noise burst standing in for a room's tail. */
  makeImpulse(seconds, decay) {
    const { ctx } = this;
    const rate = ctx.sampleRate;
    const length = Math.max(1, Math.floor(rate * seconds));
    const buffer = ctx.createBuffer(2, length, rate);
    for (let channel = 0; channel < 2; channel++) {
      const data = buffer.getChannelData(channel);
      for (let i = 0; i < length; i++) {
        const t = i / length;
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay);
      }
    }
    return buffer;
  }

  /**
   * A positional node chain. Distance attenuation and culling happen here so no
   * single sound needs its own logic.
   */
  chain(position, { maxDistance = 70, refDistance = 3.5, rolloff = 1.35, reverbSend = 0.3 } = {}) {
    const { ctx } = this;
    const gain = ctx.createGain();
    gain.gain.value = 1;

    if (position) {
      const panner = ctx.createPanner();
      panner.panningModel = 'HRTF';
      panner.distanceModel = 'inverse';
      panner.refDistance = refDistance;
      panner.maxDistance = maxDistance;
      panner.rolloffFactor = rolloff;
      panner.positionX.value = position[0];
      panner.positionY.value = position[1];
      panner.positionZ.value = position[2];
      panner.connect(gain);
      if (reverbSend > 0) {
        const send = ctx.createGain();
        send.gain.value = reverbSend;
        panner.connect(send);
        send.connect(this.reverbSend);
      }
      gain.connect(this.sfxBus);
      return { input: panner, gain, positional: true };
    }
    gain.connect(this.sfxBus);
    return { input: gain, gain, positional: false };
  }

  /** Listener pose, derived from the camera so sounds pan with the view. */
  setListener(position, yaw, pitch) {
    if (!this.ctx) return;
    const l = this.ctx.listener;
    const cosPitch = Math.cos(pitch);
    const fx = -Math.sin(yaw) * cosPitch;
    const fy = Math.sin(pitch);
    const fz = -Math.cos(yaw) * cosPitch;
    const now = this.ctx.currentTime;
    if (l.positionX) {
      l.positionX.setValueAtTime(position[0], now);
      l.positionY.setValueAtTime(position[1], now);
      l.positionZ.setValueAtTime(position[2], now);
      l.forwardX.setValueAtTime(fx, now);
      l.forwardY.setValueAtTime(fy, now);
      l.forwardZ.setValueAtTime(fz, now);
      l.upX.setValueAtTime(0, now);
      l.upY.setValueAtTime(1, now);
      l.upZ.setValueAtTime(0, now);
    } else if (l.setPosition) {
      l.setPosition(position[0], position[1], position[2]);
      l.setOrientation(fx, fy, fz, 0, 1, 0);
    }
  }

  // ------------------------------------------------------------------- sounds

  /**
   * Layered gunshot: a bright crack that gives the weapon its character, a
   * pitched body that gives it weight, and a low thump for the chest punch.
   */
  gunshot(weaponId, position, { isLocal = false, indoor = false } = {}) {
    if (!this.ready) return;
    const voice = WEAPON_VOICE[weaponId] || WEAPON_VOICE.ar;
    const { ctx } = this;
    const chain = this.chain(position, {
      maxDistance: 140,
      refDistance: isLocal ? 1 : 6,
      rolloff: isLocal ? 0.7 : 1.15,
      // Gunfire in a level without a ceiling still excites the tail, just less.
      reverbSend: voice.tail * (indoor ? 0.6 : 0.3),
    });
    const t = ctx.currentTime;
    this.voicesPlayed++;

    // 1. Crack: filtered white noise with a very fast decay.
    const noise = ctx.createBufferSource();
    noise.buffer = this.noiseBuffer(1);
    noise.playbackRate.value = 1 + (Math.random() - 0.5) * 0.12;
    const noiseFilter = ctx.createBiquadFilter();
    noiseFilter.type = 'bandpass';
    noiseFilter.frequency.value = 2600 * voice.pitch;
    noiseFilter.Q.value = 0.55;
    const noiseGain = ctx.createGain();
    const crackLevel = (isLocal ? 0.75 : 0.9) * voice.level * voice.snap;
    noiseGain.gain.setValueAtTime(crackLevel, t);
    noiseGain.gain.exponentialRampToValueAtTime(0.0008, t + voice.decay);
    noise.connect(noiseFilter);
    noiseFilter.connect(noiseGain);
    noiseGain.connect(chain.input);
    noise.start(t);
    noise.stop(t + voice.decay + 0.02);

    // 2. Body: a fast downward sine sweep, the "thump" that makes it a gun.
    const body = ctx.createOscillator();
    body.type = 'triangle';
    body.frequency.setValueAtTime(voice.body * voice.pitch * 1.9, t);
    body.frequency.exponentialRampToValueAtTime(voice.body * 0.55, t + 0.075);
    const bodyGain = ctx.createGain();
    bodyGain.gain.setValueAtTime(0.5 * voice.level, t);
    bodyGain.gain.exponentialRampToValueAtTime(0.0008, t + 0.11);
    body.connect(bodyGain);
    bodyGain.connect(chain.input);
    body.start(t);
    body.stop(t + 0.12);

    // 3. Sub: felt more than heard, sells the calibre.
    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(88, t);
    sub.frequency.exponentialRampToValueAtTime(42, t + 0.1);
    const subGain = ctx.createGain();
    subGain.gain.setValueAtTime(0.34 * voice.level, t);
    subGain.gain.exponentialRampToValueAtTime(0.0008, t + 0.14);
    sub.connect(subGain);
    subGain.connect(chain.input);
    sub.start(t);
    sub.stop(t + 0.15);

    // 4. Mechanical action, audible only on your own gun.
    if (isLocal) this.click(t + 0.012, 0.11, 3200, chain.input);
  }

  /**
   * Footstep: a short filtered noise tap with a surface-dependent body tone.
   * Passing the surface material is what makes the catwalk ring underfoot.
   */
  footstep(position, material = 'concrete', { isLocal = false, sprinting = false } = {}) {
    if (!this.ready) return;
    const voice = STEP_VOICE[material] || DEFAULT_STEP;
    const { ctx } = this;
    const chain = this.chain(position, {
      maxDistance: isLocal ? 2 : 34,
      refDistance: isLocal ? 0.4 : 3.2,
      rolloff: 1.6,
      reverbSend: isLocal ? 0.05 : 0.22,
    });
    const t = ctx.currentTime;
    const level = voice.level * (isLocal ? 0.28 : 0.62) * (sprinting ? 1.25 : 1);

    const noise = ctx.createBufferSource();
    noise.buffer = this.noiseBuffer(0.4);
    noise.playbackRate.value = 0.9 + Math.random() * 0.3;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = voice.body * 4.2 * (0.9 + Math.random() * 0.25);
    filter.Q.value = 0.85;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(level * voice.snap, t);
    gain.gain.exponentialRampToValueAtTime(0.0006, t + voice.decay);
    noise.connect(filter);
    filter.connect(gain);
    gain.connect(chain.input);
    noise.start(t);
    noise.stop(t + voice.decay + 0.02);

    // Low thump for weight.
    const thump = ctx.createOscillator();
    thump.type = 'sine';
    thump.frequency.setValueAtTime(voice.body, t);
    thump.frequency.exponentialRampToValueAtTime(voice.body * 0.6, t + 0.05);
    const thumpGain = ctx.createGain();
    thumpGain.gain.setValueAtTime(level * 0.5, t);
    thumpGain.gain.exponentialRampToValueAtTime(0.0006, t + 0.07);
    thump.connect(thumpGain);
    thumpGain.connect(chain.input);
    thump.start(t);
    thump.stop(t + 0.08);
  }

  /** Short mechanical click: reload stages, weapon switches, dry fire. */
  click(at = 0, level = 0.2, frequency = 2200, destination = null) {
    if (!this.ready) return;
    const { ctx } = this;
    const t = at || ctx.currentTime;
    const dest = destination || this.uiBus;
    const noise = ctx.createBufferSource();
    noise.buffer = this.noiseBuffer(0.2);
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = frequency * (0.92 + Math.random() * 0.16);
    filter.Q.value = 2.4;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(level, t);
    gain.gain.exponentialRampToValueAtTime(0.0004, t + 0.05);
    noise.connect(filter);
    filter.connect(gain);
    gain.connect(dest);
    noise.start(t);
    noise.stop(t + 0.06);

    // A tiny pitched ping gives the click a metallic edge.
    const ping = ctx.createOscillator();
    ping.type = 'square';
    ping.frequency.value = frequency * 0.5;
    const pingGain = ctx.createGain();
    pingGain.gain.setValueAtTime(level * 0.28, t);
    pingGain.gain.exponentialRampToValueAtTime(0.0003, t + 0.035);
    ping.connect(pingGain);
    pingGain.connect(dest);
    ping.start(t);
    ping.stop(t + 0.04);
  }

  magazineOut() {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    this.click(t, 0.18, 1400, this.sfxBus);
    this.click(t + 0.05, 0.12, 900, this.sfxBus);
  }

  magazineIn() {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    this.click(t, 0.24, 1100, this.sfxBus);
    this.click(t + 0.06, 0.3, 700, this.sfxBus);
    this.click(t + 0.09, 0.14, 1800, this.sfxBus);
  }

  /** Charging handle or pump action, before the mag is seated. */
  rack() {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    this.click(t, 0.26, 1500, this.sfxBus);
    this.click(t + 0.11, 0.22, 1100, this.sfxBus);
  }

  dryFire() {
    if (!this.ready) return;
    this.click(this.ctx.currentTime, 0.16, 2600, this.sfxBus);
  }

  /** Non-positional feedback: hit marker, headshot, kill, damage taken. */
  hitMarker(headshot = false) {
    if (!this.ready) return;
    const { ctx } = this;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(headshot ? 1750 : 1120, t);
    osc.frequency.exponentialRampToValueAtTime(headshot ? 2400 : 1500, t + 0.06);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(headshot ? 0.22 : 0.15, t);
    gain.gain.exponentialRampToValueAtTime(0.0004, t + 0.09);
    osc.connect(gain);
    gain.connect(this.uiBus);
    osc.start(t);
    osc.stop(t + 0.1);
  }

  killConfirmed() {
    if (!this.ready) return;
    const { ctx } = this;
    const t = ctx.currentTime;
    for (const [i, freq] of [880, 1320].entries()) {
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = freq;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0, t + i * 0.05);
      gain.gain.linearRampToValueAtTime(0.16, t + i * 0.05 + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0004, t + i * 0.05 + 0.19);
      osc.connect(gain);
      gain.connect(this.uiBus);
      osc.start(t + i * 0.05);
      osc.stop(t + i * 0.05 + 0.2);
    }
  }

  /** Taking a hit: a muffled impact plus a brief ringing in the ears. */
  damageTaken(amount = 20, { headshot = false } = {}) {
    if (!this.ready) return;
    const { ctx } = this;
    const t = ctx.currentTime;
    const scale = Math.min(1.4, 0.5 + amount / 45);

    // Directionless thud.
    const thud = ctx.createOscillator();
    thud.type = 'sine';
    thud.frequency.setValueAtTime(160, t);
    thud.frequency.exponentialRampToValueAtTime(60, t + 0.14);
    const thudGain = ctx.createGain();
    thudGain.gain.setValueAtTime(0.4 * scale, t);
    thudGain.gain.exponentialRampToValueAtTime(0.0004, t + 0.2);
    thud.connect(thudGain);
    thudGain.connect(this.uiBus);
    thud.start(t);
    thud.stop(t + 0.22);

    // Ringing: two detuned high partials that outlast the impact.
    const ringFreqs = headshot ? [3400, 4180] : [2700, 3260];
    for (const freq of ringFreqs) {
      const ring = ctx.createOscillator();
      ring.type = 'sine';
      ring.frequency.value = freq * (1 + (Math.random() - 0.5) * 0.02);
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.05 * scale, t + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0003, t + 0.55);
      ring.connect(gain);
      gain.connect(this.uiBus);
      ring.start(t);
      ring.stop(t + 0.6);
    }
  }

  /** Bullet hitting a body, heard from elsewhere on the map. */
  fleshImpact(position) {
    if (!this.ready) return;
    const { ctx } = this;
    const chain = this.chain(position, { maxDistance: 40, refDistance: 3, rolloff: 1.5, reverbSend: 0.1 });
    const t = ctx.currentTime;
    const noise = ctx.createBufferSource();
    noise.buffer = this.noiseBuffer(0.3);
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 620;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.34, t);
    gain.gain.exponentialRampToValueAtTime(0.0004, t + 0.11);
    noise.connect(filter);
    filter.connect(gain);
    gain.connect(chain.input);
    noise.start(t);
    noise.stop(t + 0.12);
  }

  /** Explosion for barrels and objective blasts. */
  explosion(position, { radius = 5 } = {}) {
    if (!this.ready) return;
    const { ctx } = this;
    const chain = this.chain(position, { maxDistance: 220, refDistance: 8, rolloff: 1.0, reverbSend: 0.7 });
    const t = ctx.currentTime;

    const noise = ctx.createBufferSource();
    noise.buffer = this.noiseBuffer(1.2);
    noise.playbackRate.value = 0.75;
    const low = ctx.createBiquadFilter();
    low.type = 'lowpass';
    low.frequency.setValueAtTime(1800, t);
    low.frequency.exponentialRampToValueAtTime(140, t + 0.5);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.85, t);
    gain.gain.exponentialRampToValueAtTime(0.0005, t + 1.1);
    noise.connect(low);
    low.connect(gain);
    gain.connect(chain.input);
    noise.start(t);
    noise.stop(t + 1.2);

    const boom = ctx.createOscillator();
    boom.type = 'sine';
    boom.frequency.setValueAtTime(120, t);
    boom.frequency.exponentialRampToValueAtTime(28, t + 0.6);
    const boomGain = ctx.createGain();
    boomGain.gain.setValueAtTime(0.9, t);
    boomGain.gain.exponentialRampToValueAtTime(0.0005, t + 0.8);
    boom.connect(boomGain);
    boomGain.connect(chain.input);
    boom.start(t);
    boom.stop(t + 0.85);
    void radius;
  }

  /** Positional UI-free confirmation used by practice targets. */
  targetHit(points = 10, headshot = false) {
    if (!this.ready) return;
    const { ctx } = this;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    const base = headshot ? 1400 : 900;
    osc.frequency.setValueAtTime(base, t);
    osc.frequency.exponentialRampToValueAtTime(base * 1.6, t + 0.07);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(points > 0 ? 0.2 : 0.16, t);
    gain.gain.exponentialRampToValueAtTime(0.0004, t + 0.16);
    osc.connect(gain);
    gain.connect(this.uiBus);
    osc.start(t);
    osc.stop(t + 0.17);
    if (points < 0) this.click(t + 0.02, 0.2, 320, this.uiBus);
  }

  /** Low ambient bed: filtered wind plus a distant industrial drone. */
  startAmbient() {
    const { ctx } = this;
    const t = ctx.currentTime;

    const wind = ctx.createBufferSource();
    wind.buffer = this.noiseBuffer(4);
    wind.loop = true;
    const windFilter = ctx.createBiquadFilter();
    windFilter.type = 'lowpass';
    windFilter.frequency.value = 320;
    const windGain = ctx.createGain();
    windGain.gain.value = 0.05;
    wind.connect(windFilter);
    windFilter.connect(windGain);
    windGain.connect(this.ambientBus);
    wind.start(t);

    // Slight detune between two low oscillators gives a beating drone that reads
    // as machinery rather than a held note.
    for (const [freq, level] of [
      [54, 0.022],
      [55.6, 0.018],
      [82, 0.008],
    ]) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const gain = ctx.createGain();
      gain.gain.value = level;
      osc.connect(gain);
      gain.connect(this.ambientBus);
      osc.start(t);
    }

    this.ambientBus.gain.setTargetAtTime(0.55, t, 2.5);
  }

  stopAmbient(fade = 1.2) {
    if (!this.ready || !this.ambientBus) return;
    this.ambientBus.gain.setTargetAtTime(0, this.ctx.currentTime, fade / 3);
  }

  dispose() {
    this.stopAmbient(0.3);
    if (this.ctx) {
      const ctx = this.ctx;
      setTimeout(() => {
        try {
          ctx.close();
        } catch {
          /* already closed */
        }
      }, 400);
    }
    this.ctx = null;
    this.ready = false;
  }
}

export { WEAPON_VOICE, STEP_VOICE };
