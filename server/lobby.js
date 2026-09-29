/**
 * Lobby manager.
 *
 * A lobby is a waiting room that becomes a match. It deliberately owns no
 * sockets: each member carries a `send` callback supplied by the socket layer,
 * so this module is pure logic and can be unit-tested or reused by a different
 * transport without change.
 *
 * Lifecycle:
 *   open ──(host starts, or countdown hits zero)──> countdown ──> playing
 *
 * Matchmaking is deliberately simple and honest: `quickJoin` finds the fullest
 * joinable lobby that still has room for you (so matches fill up instead of
 * scattering players across a hundred empty rooms), and only creates a new one
 * when nothing suitable exists.
 */

import { LOBBY_STATUS, MODE_LABELS, makeJoinCode, sanitizeLobbyName } from '../src/net/protocol.js';
import { LEVELS, LEVEL_LIST } from '../src/net/shared/levels.js';
import { NET } from '../src/net/shared/constants.js';

export const MAX_PLAYERS = NET.maxPlayersPerLobby;
export const MIN_PLAYERS = 1; // bots fill the rest, so one human is a valid match

let lobbySeq = 1;

export class Lobby {
  constructor({ name, mode, mapId, host, maxPlayers = MAX_PLAYERS, botFill = 0, difficulty = 'regular', isPrivate = false }) {
    this.id = `L${lobbySeq++}`;
    this.code = makeJoinCode();
    this.name = sanitizeLobbyName(name);
    this.mode = mode;
    this.mapId = mapId;
    this.hostId = host.id;
    this.maxPlayers = Math.max(2, Math.min(maxPlayers, MAX_PLAYERS));
    this.botFill = Math.max(0, Math.min(botFill | 0, MAX_PLAYERS));
    this.difficulty = difficulty;
    this.isPrivate = !!isPrivate;
    this.status = LOBBY_STATUS.OPEN;
    this.countdown = 0;
    this.createdAt = Date.now();
    this.members = new Map();
    this.chat = [];
  }

  add(player, send) {
    this.members.set(player.id, {
      id: player.id,
      name: player.name,
      guest: !!player.guest,
      team: null,
      ready: false,
      ping: 0,
      send,
      joinedAt: Date.now(),
    });
  }

  remove(playerId) {
    this.members.delete(playerId);
    if (this.hostId === playerId) {
      // Host migration: the longest-standing member takes over rather than the
      // lobby dying because one person alt-tabbed.
      let oldest = null;
      for (const m of this.members.values()) if (!oldest || m.joinedAt < oldest.joinedAt) oldest = m;
      this.hostId = oldest ? oldest.id : null;
    }
  }

  member(playerId) {
    return this.members.get(playerId) || null;
  }

  get size() {
    return this.members.size;
  }

  /** Humans plus the bots that will be spawned to fill the match. */
  get projectedSize() {
    return Math.min(this.maxPlayers, this.size + this.botFill);
  }

  get isFull() {
    return this.size >= this.maxPlayers;
  }

  /** Only humans count for a start: bots exist to fill, not to instigate. */
  get humansReady() {
    let n = 0;
    for (const m of this.members.values()) if (m.ready || m.id === this.hostId) n++;
    return n;
  }

  assignTeams() {
    // Balanced alternating assignment. FFA ignores teams entirely.
    if (this.mode === 'ffa') {
      for (const m of this.members.values()) m.team = `solo${m.id}`;
      return;
    }
    let a = 0;
    let b = 0;
    for (const m of this.members.values()) {
      if (m.team !== 'a' && m.team !== 'b') {
        m.team = a <= b ? 'a' : 'b';
      }
      if (m.team === 'a') a++;
      else b++;
    }
  }

  broadcast(message, exceptId = null) {
    for (const m of this.members.values()) {
      if (m.id === exceptId) continue;
      m.send(message);
    }
  }

  /** Public listing: no sockets, no tokens, no private lobbies. */
  publicView() {
    const map = LEVELS[this.mapId];
    const pings = [...this.members.values()].map((m) => m.ping).filter((p) => p > 0);
    return {
      id: this.id,
      code: this.code,
      name: this.name,
      mode: this.mode,
      modeLabel: MODE_LABELS[this.mode] || this.mode,
      mapId: this.mapId,
      mapName: map ? map.name : this.mapId,
      hostName: this.member(this.hostId)?.name || '—',
      players: this.size,
      humans: this.size,
      bots: this.botFill,
      maxPlayers: this.maxPlayers,
      status: this.status,
      countdown: Math.ceil(this.countdown),
      isPrivate: this.isPrivate,
      difficulty: this.difficulty,
      avgPing: pings.length ? Math.round(pings.reduce((a, b) => a + b, 0) / pings.length) : 0,
      createdAt: this.createdAt,
    };
  }

  /** Detail view sent to members: includes the roster and their own identity. */
  memberView(forId) {
    return {
      ...this.publicView(),
      code: this.code, // members are allowed to share the code
      hostId: this.hostId,
      you: forId,
      roster: [...this.members.values()].map((m) => ({
        id: m.id,
        name: m.name,
        team: m.team,
        ready: m.ready,
        ping: Math.round(m.ping),
        isHost: m.id === this.hostId,
        isBot: false,
      })),
      chat: this.chat.slice(-24),
    };
  }
}

export class LobbyManager {
  constructor({ store = null } = {}) {
    this.store = store;
    this.lobbies = new Map();
    this.byPlayer = new Map();
    /** Removed once the match they were watching is gone. */
    this.sweepTimer = setInterval(() => this.sweep(), 20000).unref?.() ?? null;
  }

  /** Drop empty lobbies, and open lobbies nobody ever joined. */
  sweep() {
    const now = Date.now();
    for (const lobby of [...this.lobbies.values()]) {
      const stale = lobby.size === 0 && now - lobby.createdAt > 30000;
      const abandoned = lobby.size === 0 && lobby.status === LOBBY_STATUS.OPEN && now - lobby.createdAt > 120000;
      if (stale || abandoned) this.destroy(lobby);
    }
  }

  destroy(lobby) {
    this.lobbies.delete(lobby.id);
    for (const m of lobby.members.values()) this.byPlayer.delete(m.id);
    lobby.members.clear();
    lobby.status = LOBBY_STATUS.OPEN;
  }

  create({ player, send, name, mode = 'tdm', mapId = 'foundry', maxPlayers = MAX_PLAYERS, botFill = 6, difficulty = 'regular', isPrivate = false }) {
    // A player may only ever be in one lobby; joining a new one leaves the old.
    this.leaveByPlayer(player.id);

    const level = LEVELS[mapId] && LEVELS[mapId].modes.includes(mode) ? mapId : this.defaultMapFor(mode);
    const lobby = new Lobby({ name, mode, mapId: level, host: player, maxPlayers, botFill, difficulty, isPrivate });
    lobby.add(player, send);
    lobby.assignTeams();
    this.lobbies.set(lobby.id, lobby);
    this.byPlayer.set(player.id, lobby);
    return lobby;
  }

  defaultMapFor(mode) {
    const candidates = LEVEL_LIST.filter((l) => l.modes.includes(mode));
    return candidates.length ? candidates[0].id : 'foundry';
  }

  join({ player, send, lobbyId = null, code = null }) {
    const lobby = lobbyId ? this.lobbies.get(lobbyId) : code ? this.byCode(code) : null;
    if (!lobby) return { ok: false, error: 'That lobby no longer exists.' };
    if (lobby.status === LOBBY_STATUS.PLAYING) return { ok: false, error: 'That match already started.' };
    const existing = this.byPlayer.get(player.id);
    if (existing && existing.id === lobby.id) return { ok: true, lobby };
    if (lobby.isFull && !lobby.member(player.id)) return { ok: false, error: 'That lobby is full.' };

    this.leaveByPlayer(player.id);
    lobby.add(player, send);
    lobby.assignTeams();
    this.byPlayer.set(player.id, lobby);
    return { ok: true, lobby };
  }

  /**
   * Find the best existing match, or make one. "Best" is the fullest open lobby
   * of the requested mode, which keeps players together instead of alone.
   */
  quickJoin({ player, send, mode = 'tdm' }) {
    let best = null;
    for (const lobby of this.lobbies.values()) {
      if (lobby.isPrivate || lobby.mode !== mode) continue;
      if (lobby.status !== LOBBY_STATUS.OPEN) continue;
      if (lobby.isFull) continue;
      if (!best || lobby.size > best.size) best = lobby;
    }
    if (best) return { ok: true, lobby: this.join({ player, send, lobbyId: best.id }).lobby, joined: true };
    const lobby = this.create({
      player,
      send,
      name: `${player.name}'s ${MODE_LABELS[mode] || mode}`,
      mode,
      mapId: this.defaultMapFor(mode),
      botFill: Math.max(4, MAX_PLAYERS - 8),
      difficulty: 'regular',
    });
    return { ok: true, lobby, joined: false, created: true };
  }

  byCode(code) {
    if (!code) return null;
    const needle = String(code).trim().toUpperCase();
    for (const lobby of this.lobbies.values()) if (lobby.code === needle) return lobby;
    return null;
  }

  lobbyOf(playerId) {
    return this.byPlayer.get(playerId) || null;
  }

  leaveByPlayer(playerId) {
    const lobby = this.byPlayer.get(playerId);
    if (!lobby) return null;
    lobby.remove(playerId);
    this.byPlayer.delete(playerId);
    if (lobby.size === 0) this.destroy(lobby);
    else lobby.broadcast({ t: 'lobby:update', lobby: lobby.publicView(), absentId: playerId });
    return lobby;
  }

  list() {
    return [...this.lobbies.values()]
      .filter((l) => !l.isPrivate)
      .map((l) => l.publicView())
      .sort((a, b) => {
        // Playable lobbies first, then fullest, then newest.
        if ((a.status === 'open') !== (b.status === 'open')) return a.status === 'open' ? -1 : 1;
        return b.players - a.players || b.createdAt - a.createdAt;
      });
  }
}
