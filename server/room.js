/**
 * Match room: one authoritative match.
 *
 * The server is the only thing that decides what happens. Clients send inputs
 * and *requests* to fire; they never send positions. The room runs the shared
 * `Sim` at a fixed 30 Hz step and broadcasts 20 snapshots a second, which the
 * client interpolates between and predicts against.
 *
 * Fixed timestep matters: the simulation must advance in identical increments
 * on both sides or prediction drifts, so the loop accumulates real elapsed time
 * and drains it in whole ticks rather than passing raw frame deltas through.
 *
 * Lag compensation is handled inside the sim: a shot is resolved against player
 * positions rewound by the shooter's measured one-way latency, so a player on a
 * high-ping connection still has to aim where the target *was*.
 */

import { Sim } from '../src/net/shared/sim.js';
import { LEVELS } from '../src/net/shared/levels.js';
import { NET, DIFFICULTY } from '../src/net/shared/constants.js';
import { MSG } from '../src/net/protocol.js';
import { MODE_LABELS } from '../src/net/protocol.js';

const TICK = 1 / NET.tickRate;
const SNAP_INTERVAL = 1 / NET.snapshotRate;
const MAX_BOTS = 15;

export class MatchRoom {
  constructor({ lobby, store = null, onEmpty = null }) {
    this.lobby = lobby;
    this.store = store;
    this.onEmpty = onEmpty;
    this.id = `M${lobby.id}`;
    this.levelId = lobby.mapId;
    this.mode = lobby.mode;
    this.startedAt = Date.now();
    this.running = false;
    this.statsRecorded = false;
    this.lastSoundAt = 0;
    this.accumulator = 0;
    this.lastFrameAt = 0;
    this.nextSnapAt = 0;
    this.interval = null;

    this.sockets = new Map(); // playerId -> send(msg)
    this.pingSamples = new Map(); // playerId -> [rtt seconds]
    /** Events and sounds accumulated between snapshots. */
    this.pendingEvents = [];
    this.pendingSounds = [];

    const level = LEVELS[this.levelId];
    this.sim = new Sim({
      level,
      mode: this.mode,
      levelId: this.levelId,
      seed: (Date.now() ^ 0x5f3a) >>> 0,
      difficulty: lobby.difficulty || 'regular',
      botFill: 0,
    });

    this.buildRoster();
  }

  // ------------------------------------------------------------------ roster

  /** Humans get their socket player id as their sim id, so routing is trivial. */
  buildRoster() {
    const humans = [...this.lobby.members.values()].sort((a, b) => a.joinedAt - b.joinedAt);
    let maxId = 0;
    for (const m of humans) {
      if (m.id > maxId) maxId = m.id;
      this.sim.addPlayer({
        id: m.id,
        name: m.name,
        team: this.mode === 'ffa' ? null : m.team || null,
        isBot: false,
      });
      this.sockets.set(m.id, m.send);
    }
    // Bot ids are drawn from the same counter, so push it past every human id
    // or a bot would collide with a real player's identity.
    this.sim.nextId = Math.max(this.sim.nextId, maxId + 1);

    const target = Math.min(NET.maxPlayersPerLobby, this.lobby.projectedSize);
    let guard = 0;
    while (this.humanCount() + this.botCount() < target && guard++ < MAX_BOTS + 8) {
      const archetypes = ['assault', 'defensive', 'aggressive', 'sniper'];
      this.sim.addBot({
        difficulty: this.lobby.difficulty || 'regular',
        archetype: archetypes[this.sim.bots.size % archetypes.length],
      });
    }
    // Balanced team sizes matter more than an exact bot count.
    if (this.mode === 'tdm') this.balanceTeams();
  }

  balanceTeams() {
    let a = 0;
    let b = 0;
    for (const p of this.sim.players.values()) {
      if (p.team === 'a') a++;
      else if (p.team === 'b') b++;
    }
    let guard = 0;
    while (Math.abs(a - b) > 1 && guard++ < 12) {
      const heavy = a > b ? 'a' : 'b';
      let moved = false;
      for (const p of this.sim.players.values()) {
        if (p.team !== heavy || !p.isBot) continue;
        p.team = heavy === 'a' ? 'b' : 'a';
        moved = true;
        break;
      }
      if (!moved) break;
      a = 0;
      b = 0;
      for (const p of this.sim.players.values()) {
        if (p.team === 'a') a++;
        else if (p.team === 'b') b++;
      }
    }
  }

  humanCount() {
    let n = 0;
    for (const p of this.sim.players.values()) if (!p.isBot) n++;
    return n;
  }

  botCount() {
    return this.sim.bots.size;
  }

  get playerCount() {
    return this.sim.players.size;
  }

  // ------------------------------------------------------------------- loop

  start() {
    if (this.running) return;
    this.running = true;
    this.lastFrameAt = now();
    this.nextSnapAt = this.lastFrameAt;

    const roster = [...this.sim.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      team: p.team,
      isBot: !!p.isBot,
      archetype: p.brain ? p.brain.archetype : null,
    }));

    for (const [playerId, send] of this.sockets) {
      const me = this.sim.players.get(playerId);
      send({
        t: MSG.MATCH_START,
        roomId: this.id,
        levelId: this.levelId,
        levelName: LEVELS[this.levelId]?.name || this.levelId,
        mode: this.mode,
        modeLabel: MODE_LABELS[this.mode] || this.mode,
        tickRate: NET.tickRate,
        snapshotRate: NET.snapshotRate,
        interpDelay: NET.interpDelay,
        you: playerId,
        yourTeam: me ? me.team : null,
        roster,
        limits: { killLimit: this.sim.rules.killLimit, timeLimit: this.sim.rules.timeLimit },
        serverTime: Date.now(),
      });
    }

    this.broadcastSnapshot();
    // The interval only accumulates; all simulation work happens in drain().
    this.interval = setInterval(() => this.drain(), 4);
    if (this.interval.unref) this.interval.unref();
  }

  stop() {
    this.running = false;
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
  }

  /**
   * Drain real elapsed time into whole fixed ticks, then decide whether a
   * snapshot is due. Capping the backlog keeps a stalled event loop from
   * spiralling into a long catch-up burst.
   */
  drain() {
    if (!this.running) return;
    const t = now();
    let elapsed = (t - this.lastFrameAt) / 1000;
    this.lastFrameAt = t;
    if (elapsed > 0.25) elapsed = 0.25;
    this.accumulator += elapsed;

    let steps = 0;
    while (this.accumulator >= TICK && steps < 12) {
      this.accumulator -= TICK;
      this.sim.tick(TICK);
      steps++;
      this.consumeEvents();
    }

    if (t >= this.nextSnapAt) {
      this.nextSnapAt = t + SNAP_INTERVAL * 1000;
      this.broadcastSnapshot();
    }
    this.checkMatchEnd();
  }

  // -------------------------------------------------------------- messaging

  handle(playerId, message) {
    const sim = this.sim;
    switch (message.t) {
      case MSG.INPUT: {
        const p = sim.players.get(playerId);
        if (!p) return;
        if (message.lag != null) sim.setInputLag(playerId, message.lag);
        // Guard the shape: a malformed input must not poison the simulation.
        const raw = message.input || {};
        sim.setInput(playerId, {
          seq: message.seq | 0,
          dt: TICK,
          input: {
            forward: num(raw.forward, -1, 1),
            right: num(raw.right, -1, 1),
            jump: !!raw.jump,
            crouch: !!raw.crouch,
            sprint: !!raw.sprint,
            walk: !!raw.walk,
            ads: !!raw.ads,
            yaw: num(raw.yaw, -Math.PI * 8, Math.PI * 8),
            pitch: num(raw.pitch, -1.6, 1.6),
          },
        });
        break;
      }
      case MSG.FIRE:
        if (message.lag != null) sim.setInputLag(playerId, message.lag);
        sim.requestFire(playerId, { seed: message.seed >>> 0 });
        break;
      case MSG.RELOAD:
        sim.requestReload(playerId);
        break;
      case MSG.SWITCH:
        sim.setSlot(playerId, message.slot === 'secondary' ? 'secondary' : 'primary');
        break;
      case MSG.PING:
        this.sockets.get(playerId)?.({ t: MSG.PONG, id: message.id, c: message.c, s: Date.now() });
        break;
      default:
        break;
    }
  }

  /**
   * Turn freshly simulated events into network traffic. `drainEvents` clears the
   * queue; sounds are aged out by the sim after 0.6 s and used by bots for
   * hearing, so they are read by cursor instead of being consumed.
   */
  consumeEvents() {
    const events = this.sim.drainEvents();
    if (events.length) {
      this.pendingEvents.push(...events);
      // A burst of shot events in one frame must not be dropped, but an
      // unbounded queue would grow without limit if a client never drains it.
      if (this.pendingEvents.length > 256) this.pendingEvents.splice(0, this.pendingEvents.length - 256);
    }
    for (const s of this.sim.sounds) {
      if (s.at > this.lastSoundAt) {
        this.lastSoundAt = s.at;
        this.pendingSounds.push({ kind: s.kind, pos: s.pos, team: s.team, weapon: s.weapon, id: null });
      }
    }
    if (this.pendingSounds.length > 120) this.pendingSounds.splice(0, this.pendingSounds.length - 120);
  }

  broadcastSnapshot() {
    const snap = this.sim.snapshot();
    // ORDER IS LOAD BEARING. The snapshot carries its own `t` field holding the
    // simulation clock, so it must be spread FIRST and the envelope's message
    // type written after it -- otherwise the sim clock overwrites the type and
    // every client silently stops recognising snapshots.
    const payloadBase = {
      ...snap,
      simTime: snap.t,
      t: MSG.SNAPSHOT,
      ack: 0,
      events: this.pendingEvents,
      sounds: this.pendingSounds,
      serverTime: Date.now(),
    };
    this.pendingEvents = [];
    this.pendingSounds = [];

    for (const [playerId, send] of this.sockets) {
      const p = this.sim.players.get(playerId);
      send({ ...payloadBase, ack: p ? p.inputSeq : 0, lag: p ? Math.round(p.inputLag * 1000) : 0 });
    }
  }

  /** Lobby members may want to watch; give them the live scoreboard. */
  broadcastRoster() {
    const roster = this.sim.roster();
    this.broadcast({ t: MSG.LOBBY_UPDATE, roster, scoreboard: true, scores: { ...this.sim.teamScores } });
  }

  broadcast(message) {
    for (const send of this.sockets.values()) send(message);
  }

  // ------------------------------------------------------------ match flow

  checkMatchEnd() {
    if (this.sim.matchState !== 'over') {
      if (this.statsRecorded && this.sim.matchState === 'live') {
        // The sim rolled into a rematch; be ready to bank the next result.
        this.statsRecorded = false;
      }
      return;
    }
    if (this.statsRecorded) return;
    this.statsRecorded = true;

    const roster = this.sim.roster();
    const winner = this.sim.winner;
    const summary = {
      mode: this.mode,
      map: this.levelId,
      winner,
      scores: { ...this.sim.teamScores },
      roster,
      duration: Math.round(this.sim.time),
    };
    this.broadcast({ t: MSG.MATCH_END, ...summary, nextMatchIn: 9 });

    if (this.store) {
      try {
        this.store.recordMatch({
          mode: this.mode,
          map: this.levelId,
          winner: typeof winner === 'string' ? winner : String(winner),
          duration: Math.round(this.sim.time),
          players: this.sim.players.size,
          summary: { scores: summary.scores },
        });
        for (const p of this.sim.players.values()) {
          if (p.isBot) continue;
          const won = this.mode === 'ffa' ? winner === p.id : winner === p.team;
          this.store.addStats(p.id, {
            kills: p.kills,
            deaths: p.deaths,
            assists: p.assists,
            headshots: p.headshots,
            shotsFired: p.shotsFired,
            shotsHit: p.shotsHit,
            damage: Math.round(p.damageDealt),
            score: Math.round(p.score),
            won,
          });
        }
      } catch (err) {
        console.warn('[room] could not persist match result:', err.message);
      }
    }
  }

  // ------------------------------------------------------------- membership

  reconnect(playerId, send) {
    this.sockets.set(playerId, send);
  }

  removeHuman(playerId) {
    this.sockets.delete(playerId);
    this.sim.removePlayer(playerId);
    if (this.humanCount() === 0) {
      this.stop();
      if (this.onEmpty) this.onEmpty(this);
    }
  }

  info() {
    return {
      id: this.id,
      levelId: this.levelId,
      levelName: LEVELS[this.levelId]?.name || this.levelId,
      mode: this.mode,
      modeLabel: MODE_LABELS[this.mode] || this.mode,
      players: this.sim.players.size,
      humans: this.humanCount(),
      bots: this.botCount(),
      state: this.sim.matchState,
      scores: { ...this.sim.teamScores },
      timeLeft: Math.round(this.sim.timeLeft),
      uptime: Math.round((Date.now() - this.startedAt) / 1000),
    };
  }
}

function num(v, min, max) {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : 0;
  return n < min ? min : n > max ? max : n;
}

function now() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

export { TICK, DIFFICULTY };
