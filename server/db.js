/**
 * Persistence layer.
 *
 * Uses Node's built-in `node:sqlite` (available from Node 22.5) so the project
 * has zero native dependencies -- `npm install` cannot fail to build a database
 * driver on a machine without a compiler. If the module is missing (an older
 * Node, or a build without experimental SQLite) the store transparently degrades
 * to a JSON file, so the game still boots and still remembers your campaign
 * save.
 *
 * Tables
 *   players  identity: guest tokens, optional password logins
 *   stats    lifetime weapon/handling numbers per player
 *   saves    campaign checkpoints, one row per (player, slot)
 *   matches  finished online matches, for the activity feed and leaderboard
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.BREACHPOINT_DATA_DIR || path.join(HERE, '..', 'data');

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* already exists */
  }
}

/**
 * Normalise a value that came out of SQLite. `node:sqlite` returns BigInt for
 * INTEGER columns, which does not survive `JSON.stringify`. Everything is small
 * here, so widening back to Number is safe and keeps the REST layer simple.
 */
function plain(row) {
  if (!row) return null;
  const out = {};
  for (const [k, v] of Object.entries(row)) out[k] = typeof v === 'bigint' ? Number(v) : v;
  return out;
}

// ---------------------------------------------------------------------------
// SQLite backend
// ---------------------------------------------------------------------------

class SqliteStore {
  constructor(DatabaseSync, file) {
    this.kind = 'sqlite';
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS players (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        token      TEXT    NOT NULL UNIQUE,
        name       TEXT    NOT NULL,
        guest      INTEGER NOT NULL DEFAULT 1,
        pass_hash  TEXT,
        pass_salt  TEXT,
        created_at INTEGER NOT NULL,
        last_seen  INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS stats (
        player_id   INTEGER PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
        kills       INTEGER NOT NULL DEFAULT 0,
        deaths      INTEGER NOT NULL DEFAULT 0,
        assists     INTEGER NOT NULL DEFAULT 0,
        headshots   INTEGER NOT NULL DEFAULT 0,
        shots_fired INTEGER NOT NULL DEFAULT 0,
        shots_hit   INTEGER NOT NULL DEFAULT 0,
        damage      INTEGER NOT NULL DEFAULT 0,
        matches     INTEGER NOT NULL DEFAULT 0,
        wins        INTEGER NOT NULL DEFAULT 0,
        score       INTEGER NOT NULL DEFAULT 0,
        updated_at  INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS saves (
        player_id  INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        slot       TEXT    NOT NULL,
        mission_id TEXT    NOT NULL,
        data       TEXT    NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (player_id, slot)
      );
      CREATE TABLE IF NOT EXISTS matches (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        mode       TEXT    NOT NULL,
        map        TEXT    NOT NULL,
        winner     TEXT,
        duration   INTEGER NOT NULL DEFAULT 0,
        players    INTEGER NOT NULL DEFAULT 0,
        summary    TEXT,
        created_at INTEGER NOT NULL
      );
    `);
  }

  findPlayerByToken(token) {
    return plain(this.db.prepare('SELECT * FROM players WHERE token = ?').get(token));
  }

  findPlayerByName(name) {
    return plain(this.db.prepare('SELECT * FROM players WHERE lower(name) = lower(?)').get(name));
  }

  createPlayer({ token, name, guest = 1, passHash = null, passSalt = null }) {
    const now = Date.now();
    const info = this.db
      .prepare(
        `INSERT INTO players (token, name, guest, pass_hash, pass_salt, created_at, last_seen)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(token, name, guest ? 1 : 0, passHash, passSalt, now, now);
    const id = Number(info.lastInsertRowid);
    this.db.prepare('INSERT OR IGNORE INTO stats (player_id, updated_at) VALUES (?, ?)').run(id, now);
    return this.getPlayer(id);
  }

  getPlayer(id) {
    return plain(this.db.prepare('SELECT * FROM players WHERE id = ?').get(id));
  }

  touchPlayer(id) {
    this.db.prepare('UPDATE players SET last_seen = ? WHERE id = ?').run(Date.now(), id);
  }

  renamePlayer(id, name) {
    this.db.prepare('UPDATE players SET name = ? WHERE id = ?').run(name, id);
  }

  setPassword(id, passHash, passSalt) {
    this.db.prepare('UPDATE players SET guest = 0, pass_hash = ?, pass_salt = ? WHERE id = ?').run(passHash, passSalt, id);
  }

  getStats(id) {
    const existing = plain(this.db.prepare('SELECT * FROM stats WHERE player_id = ?').get(id));
    if (existing) return existing;
    this.db.prepare('INSERT OR IGNORE INTO stats (player_id, updated_at) VALUES (?, ?)').run(id, Date.now());
    return plain(this.db.prepare('SELECT * FROM stats WHERE player_id = ?').get(id));
  }

  /** Add one match's numbers onto a player's lifetime totals. */
  addStats(id, s) {
    this.db
      .prepare(
        `UPDATE stats SET
           kills = kills + ?, deaths = deaths + ?, assists = assists + ?,
           headshots = headshots + ?, shots_fired = shots_fired + ?,
           shots_hit = shots_hit + ?, damage = damage + ?,
           matches = matches + 1, wins = wins + ?, score = score + ?,
           updated_at = ?
         WHERE player_id = ?`,
      )
      .run(
        s.kills | 0, s.deaths | 0, s.assists | 0, s.headshots | 0,
        s.shotsFired | 0, s.shotsHit | 0, s.damage | 0,
        s.won ? 1 : 0, s.score | 0, Date.now(), id,
      );
  }

  getLeaderboard(limit = 25) {
    return this.db
      .prepare(
        `SELECT p.name, s.kills, s.deaths, s.assists, s.headshots, s.matches, s.wins, s.score
           FROM stats s JOIN players p ON p.id = s.player_id
          WHERE s.matches > 0
          ORDER BY s.score DESC, s.kills DESC
          LIMIT ?`,
      )
      .all(limit)
      .map(plain);
  }

  saveCampaign(id, slot, missionId, data) {
    this.db
      .prepare(
        `INSERT INTO saves (player_id, slot, mission_id, data, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(player_id, slot) DO UPDATE SET
           mission_id = excluded.mission_id, data = excluded.data, updated_at = excluded.updated_at`,
      )
      .run(id, slot, missionId, JSON.stringify(data ?? {}), Date.now());
  }

  getSave(id, slot) {
    const row = plain(this.db.prepare('SELECT * FROM saves WHERE player_id = ? AND slot = ?').get(id, slot));
    if (!row) return null;
    return { slot: row.slot, missionId: row.mission_id, data: safeJson(row.data), updatedAt: row.updated_at };
  }

  listSaves(id) {
    return this.db
      .prepare('SELECT slot, mission_id, updated_at FROM saves WHERE player_id = ? ORDER BY updated_at DESC')
      .all(id)
      .map(plain)
      .map((r) => ({ slot: r.slot, missionId: r.mission_id, updatedAt: r.updated_at }));
  }

  deleteSave(id, slot) {
    this.db.prepare('DELETE FROM saves WHERE player_id = ? AND slot = ?').run(id, slot);
  }

  recordMatch({ mode, map, winner, duration, players, summary }) {
    this.db
      .prepare(
        `INSERT INTO matches (mode, map, winner, duration, players, summary, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(mode, map, winner || null, duration | 0, players | 0, JSON.stringify(summary ?? null), Date.now());
  }

  recentMatches(limit = 10) {
    return this.db
      .prepare('SELECT mode, map, winner, duration, players, created_at FROM matches ORDER BY id DESC LIMIT ?')
      .all(limit)
      .map(plain)
      .map((m) => ({ mode: m.mode, map: m.map, winner: m.winner, duration: m.duration, players: m.players, at: m.created_at }));
  }

  close() {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }
}

// ---------------------------------------------------------------------------
// JSON fallback backend
// ---------------------------------------------------------------------------

class JsonStore {
  constructor(file) {
    this.kind = 'json';
    this.file = file;
    this.state = { players: [], stats: [], saves: [], matches: [], seq: 1 };
    try {
      if (fs.existsSync(file)) this.state = { ...this.state, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
    } catch {
      /* corrupt file: start fresh rather than refusing to boot */
    }
    this.flushTimer = null;
  }

  flush() {
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.state));
    } catch {
      /* disk full or read-only: keep playing in memory */
    }
  }

  scheduleFlush() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, 500);
  }

  findPlayerByToken(token) {
    return this.state.players.find((p) => p.token === token) || null;
  }

  findPlayerByName(name) {
    return this.state.players.find((p) => p.name.toLowerCase() === String(name).toLowerCase()) || null;
  }

  createPlayer({ token, name, guest = 1, passHash = null, passSalt = null }) {
    const now = Date.now();
    const player = {
      id: this.state.seq++,
      token,
      name,
      guest: guest ? 1 : 0,
      pass_hash: passHash,
      pass_salt: passSalt,
      created_at: now,
      last_seen: now,
    };
    this.state.players.push(player);
    this.state.stats.push({ player_id: player.id });
    this.scheduleFlush();
    return player;
  }

  getPlayer(id) {
    return this.state.players.find((p) => p.id === id) || null;
  }

  touchPlayer(id) {
    const p = this.getPlayer(id);
    if (p) p.last_seen = Date.now();
    this.scheduleFlush();
  }

  renamePlayer(id, name) {
    const p = this.getPlayer(id);
    if (p) p.name = name;
    this.scheduleFlush();
  }

  setPassword(id, passHash, passSalt) {
    const p = this.getPlayer(id);
    if (p) {
      p.guest = 0;
      p.pass_hash = passHash;
      p.pass_salt = passSalt;
    }
    this.scheduleFlush();
  }

  getStats(id) {
    let s = this.state.stats.find((r) => r.player_id === id);
    if (!s) {
      s = { player_id: id };
      this.state.stats.push(s);
    }
    return s;
  }

  addStats(id, s) {
    const row = this.getStats(id);
    for (const k of ['kills', 'deaths', 'assists', 'headshots', 'shots_fired', 'shots_hit', 'damage', 'matches', 'wins', 'score']) {
      row[k] = (row[k] || 0) + (s[k === 'shots_fired' ? 'shotsFired' : k === 'shots_hit' ? 'shotsHit' : k] | 0 || 0);
    }
    row.matches += 1;
    if (s.won) row.wins += 1;
    row.updated_at = Date.now();
    this.scheduleFlush();
  }

  getLeaderboard(limit = 25) {
    return this.state.stats
      .filter((s) => (s.matches || 0) > 0)
      .map((s) => {
        const p = this.getPlayer(s.player_id) || { name: 'Unknown' };
        return {
          name: p.name,
          kills: s.kills | 0,
          deaths: s.deaths | 0,
          assists: s.assists | 0,
          headshots: s.headshots | 0,
          matches: s.matches | 0,
          wins: s.wins | 0,
          score: s.score | 0,
        };
      })
      .sort((a, b) => b.score - a.score || b.kills - a.kills)
      .slice(0, limit);
  }

  saveCampaign(id, slot, missionId, data) {
    let row = this.state.saves.find((s) => s.player_id === id && s.slot === slot);
    if (!row) {
      row = { player_id: id, slot };
      this.state.saves.push(row);
    }
    row.mission_id = missionId;
    row.data = JSON.stringify(data ?? {});
    row.updated_at = Date.now();
    this.scheduleFlush();
  }

  getSave(id, slot) {
    const row = this.state.saves.find((s) => s.player_id === id && s.slot === slot);
    if (!row) return null;
    return { slot: row.slot, missionId: row.mission_id, data: safeJson(row.data), updatedAt: row.updated_at };
  }

  listSaves(id) {
    return this.state.saves
      .filter((s) => s.player_id === id)
      .map((r) => ({ slot: r.slot, missionId: r.mission_id, updatedAt: r.updated_at }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  deleteSave(id, slot) {
    this.state.saves = this.state.saves.filter((s) => !(s.player_id === id && s.slot === slot));
    this.scheduleFlush();
  }

  recordMatch(m) {
    this.state.matches.push({ ...m, at: Date.now() });
    if (this.state.matches.length > 200) this.state.matches.shift();
    this.scheduleFlush();
  }

  recentMatches(limit = 10) {
    return this.state.matches.slice(-limit).reverse();
  }

  close() {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flush();
  }
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Open the store. SQLite is preferred; the JSON file is a safety net so a
 * missing experimental module never takes the whole server down.
 */
export async function openStore() {
  ensureDir(DATA_DIR);
  try {
    const { DatabaseSync } = await import('node:sqlite');
    return new SqliteStore(DatabaseSync, path.join(DATA_DIR, 'breachpoint.sqlite'));
  } catch (err) {
    console.warn(`[db] node:sqlite unavailable (${err.message}); falling back to JSON storage`);
    return new JsonStore(path.join(DATA_DIR, 'breachpoint.json'));
  }
}
