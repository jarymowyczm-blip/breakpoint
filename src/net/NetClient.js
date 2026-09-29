/**
 * Browser-side network client.
 *
 * Owns one WebSocket and exposes two very different interfaces:
 *
 *   - a small observable state object (status, lobbies, lobby, chat, ping) that
 *     React subscribes to for the menus
 *   - a stream of snapshots and events that the game layer consumes
 *
 * Clock handling: snapshots are interpolated against LOCAL arrival time rather
 * than the server's clock. The server's `t` is still used for lag compensation
 * and is kept as `simTime`. This deliberately avoids implementing clock sync --
 * in a fast shooter, "how long ago did this arrive" is the only timing fact that
 * actually matters for smooth remote motion.
 */

import { MSG, makeInput } from './protocol.js';
import { NET } from './shared/constants.js';
import { SnapshotBuffer } from '../game/prediction.js';

const STORAGE_KEY = 'breachpoint.identity';

export function loadIdentity() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { token: null, name: null };
    const parsed = JSON.parse(raw);
    return { token: parsed.token || null, name: parsed.name || null };
  } catch {
    return { token: null, name: null };
  }
}

export function saveIdentity(token, name) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ token, name }));
  } catch {
    /* private browsing: the session simply will not persist */
  }
}

export class NetClient {
  constructor() {
    this.ws = null;
    this.status = 'offline';
    this.error = null;
    this.profile = null;
    this.token = null;
    this.lobbies = [];
    this.lobby = null;
    this.chat = [];
    this.ping = 0;
    this.match = null;
    this.matchResult = null;
    this.stats = null;

    this.snapshots = new SnapshotBuffer({ interpDelay: NET.interpDelay });
    this.interpDelay = NET.interpDelay;
    this.events = [];
    this.eventSeq = 0;
    this.sounds = [];

    this.inputSeq = 0;
    this.pingId = 0;
    this.pingSentAt = new Map();
    this.pingTimer = null;
    this.lastArrival = 0;
    this.arrivalInterval = 1 / NET.snapshotRate;
    this.jitter = 0;
    this.snapCount = 0;
    this.bytesIn = 0;
    this.bytesOut = 0;

    /** Called with no arguments whenever observable state changes. */
    this.listeners = new Set();
    /** Called for transient game-layer events (match start/end, errors). */
    this.onEvent = null;
  }

  // ------------------------------------------------------------ observability

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  notify() {
    for (const fn of this.listeners) fn(this.snapshotState());
  }

  snapshotState() {
    return {
      status: this.status,
      error: this.error,
      profile: this.profile,
      lobbies: this.lobbies,
      lobby: this.lobby,
      chat: this.chat,
      ping: this.ping,
      match: this.match,
      stats: this.stats,
      bytesIn: this.bytesIn,
      bytesOut: this.bytesOut,
      interpDelay: this.interpDelay,
    };
  }

  // ---------------------------------------------------------------- lifecycle

  connect({ name } = {}) {
    if (this.ws && (this.status === 'online' || this.status === 'connecting')) return;
    const identity = loadIdentity();
    this.status = 'connecting';
    this.error = null;
    this.notify();

    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      this.fail(`Could not open a connection: ${err.message}`);
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.send({ t: MSG.HELLO, token: identity.token, name: name || identity.name });
    };

    ws.onmessage = (event) => {
      this.bytesIn += event.data.length;
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      this.receive(message);
    };

    ws.onerror = () => {
      // The close handler carries the useful information; an error event on its
      // own does not say whether the server was even reachable.
    };

    ws.onclose = () => {
      const wasOnline = this.status === 'online';
      this.status = 'offline';
      this.lobby = null;
      this.match = null;
      this.stopPing();
      if (wasOnline) this.emit({ type: 'disconnected' });
      this.notify();
    };
  }

  fail(message) {
    this.status = 'error';
    this.error = message;
    this.notify();
  }

  disconnect() {
    this.stopPing();
    if (this.ws) {
      this.ws.onclose = null;
      try {
        this.ws.close();
      } catch {
        /* already closing */
      }
    }
    this.ws = null;
    this.status = 'offline';
    this.lobby = null;
    this.match = null;
    this.snapshots.clear();
    this.notify();
  }

  send(message) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    const text = JSON.stringify(message);
    this.bytesOut += text.length;
    this.ws.send(text);
    return true;
  }

  emit(event) {
    if (this.onEvent) this.onEvent(event);
  }

  // ------------------------------------------------------------------- inbox

  receive(message) {
    switch (message.t) {
      case MSG.WELCOME:
        this.status = 'online';
        this.token = message.token;
        this.profile = message.profile;
        this.stats = message.stats;
        this.lobbies = message.lobbies || [];
        saveIdentity(message.token, message.profile?.name);
        this.startPing();
        this.emit({ type: 'welcome', profile: this.profile });
        this.notify();
        break;

      case MSG.LOBBY_LIST:
        this.lobbies = message.lobbies || [];
        this.notify();
        break;

      case MSG.LOBBY_JOINED:
        this.lobby = message.lobby;
        this.match = null;
        this.matchResult = null;
        this.snapshots.clear();
        this.events.length = 0;
        this.chat = message.lobby.chat || [];
        this.notify();
        break;

      case MSG.LOBBY_UPDATE:
        if (this.lobby && message.lobby && message.lobby.id === this.lobby.id) {
          // Keep the local roster if the update is a bare public view.
          this.lobby = message.roster ? { ...this.lobby, roster: message.roster } : { ...this.lobby, ...message.lobby };
        }
        this.notify();
        break;

      case MSG.LOBBY_LEFT:
        this.lobby = null;
        this.match = null;
        this.notify();
        break;

      case MSG.MATCH_START:
        this.match = {
          ...message,
          startedAt: performance.now() / 1000,
          rosterById: new Map((message.roster || []).map((r) => [r.id, r])),
        };
        this.snapshots.clear();
        this.events.length = 0;
        this.sounds.length = 0;
        this.emit({ type: 'match:start', match: this.match });
        this.notify();
        break;

      case MSG.SNAPSHOT: {
        // Stamp with local arrival time: interpolation runs on our own clock.
        message.arrivedAt = performance.now() / 1000;
        this.trackTiming(message.arrivedAt);
        message.t = message.arrivedAt;
        this.snapshots.push(message);
        this.snapCount++;
        if (message.events) for (const e of message.events) this.events.push({ ...e, seq: ++this.eventSeq });
        if (message.sounds) for (const s of message.sounds) this.sounds.push(s);
        // Keep the queues bounded even if the game layer pauses.
        if (this.events.length > 900) this.events.splice(0, this.events.length - 900);
        if (this.sounds.length > 200) this.sounds.splice(0, this.sounds.length - 200);
        this.notify();
        break;
      }

      case MSG.MATCH_END:
        this.matchResult = message;
        this.emit({ type: 'match:end', result: message });
        this.notify();
        break;

      case MSG.CHAT:
        this.chat = [...this.chat, message].slice(-40);
        this.emit({ type: 'chat', message });
        this.notify();
        break;

      case MSG.PONG: {
        const sent = this.pingSentAt.get(message.id);
        if (sent != null) {
          const rtt = performance.now() - sent;
          this.pingSentAt.delete(message.id);
          // Exponential smoothing keeps the number stable enough to display.
          this.ping = this.ping === 0 ? rtt : this.ping * 0.7 + rtt * 0.3;
          this.notify();
        }
        break;
      }

      case MSG.ERROR:
        this.error = message.error;
        this.emit({ type: 'error', message: message.error });
        this.notify();
        // Errors are transient; clear the banner once it has been noticed.
        setTimeout(() => {
          if (this.error === message.error) {
            this.error = null;
            this.notify();
          }
        }, 5000);
        break;

      default:
        break;
    }
  }

  clearError() {
    if (this.error) {
      this.error = null;
      this.notify();
    }
  }

  /**
   * Track arrival spacing so interpolation can adapt. On a jittery connection
   * a fixed 100 ms window produces visible stutter, so the buffer widens to
   * cover roughly two snapshot intervals plus the observed jitter.
   */
  trackTiming(arrivedAt) {
    if (this.lastArrival > 0) {
      const dt = arrivedAt - this.lastArrival;
      if (dt > 0 && dt < 1) {
        const intervalErr = Math.abs(dt - this.arrivalInterval);
        this.jitter = this.jitter * 0.9 + intervalErr * 0.1;
        this.arrivalInterval = this.arrivalInterval * 0.9 + dt * 0.1;
      }
    }
    this.lastArrival = arrivedAt;
    const wanted = Math.min(0.3, Math.max(0.075, this.arrivalInterval * 2 + this.jitter * 2.5));
    this.interpDelay = this.interpDelay * 0.95 + wanted * 0.05;
    this.snapshots.interpDelay = this.interpDelay;
  }

  /** The time remote entities are rendered at, in local seconds. */
  get renderTime() {
    return performance.now() / 1000 - this.interpDelay;
  }

  // ------------------------------------------------------------------- ping

  startPing() {
    this.stopPing();
    const tick = () => {
      const id = ++this.pingId;
      this.pingSentAt.set(id, performance.now());
      this.send({ t: MSG.PING, id, c: Math.round(performance.now()) });
      // Drop unanswered pings so the map cannot leak.
      if (this.pingSentAt.size > 8) {
        const oldest = this.pingSentAt.keys().next().value;
        this.pingSentAt.delete(oldest);
      }
    };
    tick();
    this.pingTimer = setInterval(tick, 1000);
  }

  stopPing() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.pingSentAt.clear();
  }

  /** One-way latency estimate used by the server for lag compensation. */
  get lagSeconds() {
    return Math.min(NET.maxRewind, this.ping / 2000 + this.interpDelay * 0.25);
  }

  // ------------------------------------------------------------------ actions

  setName(name) {
    this.send({ t: MSG.HELLO, token: this.token, name });
  }

  refreshLobbies() {
    this.send({ t: MSG.LOBBY_LIST });
  }

  createLobby(options) {
    this.send({ t: MSG.LOBBY_CREATE, ...options });
  }

  joinLobby({ code, lobbyId }) {
    this.send({ t: MSG.LOBBY_JOIN, code, lobbyId });
  }

  quickJoin(mode) {
    this.send({ t: MSG.LOBBY_QUICKJOIN, mode });
  }

  leaveLobby() {
    this.send({ t: MSG.LOBBY_LEAVE });
  }

  setReady(ready) {
    this.send({ t: MSG.LOBBY_READY, ready });
  }

  setTeam(team) {
    this.send({ t: MSG.LOBBY_TEAM, team });
  }

  configureLobby(config) {
    this.send({ t: MSG.LOBBY_CONFIG, ...config });
  }

  startMatch() {
    this.send({ t: MSG.LOBBY_START });
  }

  say(text) {
    this.send({ t: MSG.CHAT, text });
  }

  sendInput(input, { yaw, pitch, ads }) {
    const seq = ++this.inputSeq;
    this.send({
      t: MSG.INPUT,
      seq,
      lag: this.lagSeconds,
      input: makeInput({ ...input, yaw, pitch, ads }),
    });
    return seq;
  }

  sendFire(seed) {
    this.send({ t: MSG.FIRE, seq: ++this.inputSeq, seed: seed >>> 0, lag: this.lagSeconds });
  }

  sendReload() {
    this.send({ t: MSG.RELOAD });
  }

  sendSwitch(slot) {
    this.send({ t: MSG.SWITCH, slot });
  }

  // ---------------------------------------------------------------- accessors

  /** The newest authoritative row for a player, as a positional array. */
  latestRow(playerId) {
    const latest = this.snapshots.latest;
    if (!latest) return null;
    for (const row of latest.players) if (row[0] === playerId) return row;
    return null;
  }

  takeEvents() {
    if (!this.events.length) return [];
    const out = this.events;
    this.events = [];
    return out;
  }

  takeSounds() {
    if (!this.sounds.length) return [];
    const out = this.sounds;
    this.sounds = [];
    return out;
  }
}
