/**
 * BREACHPOINT game server.
 *
 * One process serves three things, which keeps deployment to a single Node
 * container with no reverse proxy:
 *
 *   1. the built client from `dist/` (static files + SPA fallback)
 *   2. a small REST API for auth, stats, campaign saves and leaderboards
 *   3. the authoritative WebSocket game server
 *
 * In development Vite serves the client on 5173 and proxies `/api` and `/ws`
 * here, so both modes see exactly one origin from the browser's point of view.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

import { openStore } from './db.js';
import { Auth } from './auth.js';
import { LobbyManager, MAX_PLAYERS } from './lobby.js';
import { MatchRoom } from './room.js';
import { MSG, MODE_LABELS, sanitizeName, clampNumber } from '../src/net/protocol.js';
import { LEVEL_LIST } from '../src/net/shared/levels.js';
import { WEAPONS, LOADOUTS } from '../src/net/shared/weapons.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const DIST = path.join(ROOT, 'dist');

// `|| 8080` rather than `?? 8080`: several sandboxes and CI images export an
// empty or zero PORT, and binding to port 0 would silently move the game
// somewhere the client cannot find it.
const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '0.0.0.0';

const store = await openStore();
const auth = new Auth(store);
const lobbies = new LobbyManager({ store });
/** roomId -> MatchRoom */
const rooms = new Map();
/** playerId -> roomId, for routing input without a lobby round trip */
const roomOfPlayer = new Map();

console.log(`[db] using ${store.kind} storage`);

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function bearer(req) {
  const header = req.headers.authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (match) return match[1].trim();
  const url = new URL(req.url, 'http://localhost');
  return url.searchParams.get('token');
}

function requirePlayer(req, res) {
  const player = auth.fromToken(bearer(req));
  if (!player) {
    sendJson(res, 401, { error: 'Not signed in.' });
    return null;
  }
  return player;
}

// ---------------------------------------------------------------------------
// REST API
// ---------------------------------------------------------------------------

const routes = {
  'GET /api/health': async (req, res) => {
    sendJson(res, 200, {
      ok: true,
      storage: store.kind,
      uptime: Math.round(process.uptime()),
      lobbies: lobbies.lobbies.size,
      matches: rooms.size,
      players: [...rooms.values()].reduce((n, r) => n + r.playerCount, 0),
    });
  },

  'GET /api/catalog': async (req, res) => {
    sendJson(res, 200, {
      levels: LEVEL_LIST,
      weapons: Object.values(WEAPONS).map((w) => ({
        id: w.id,
        name: w.name,
        className: w.className,
        slot: w.slot,
        damage: w.damage,
        fireMode: w.fireMode,
        rpm: w.rpm,
        magSize: w.magSize,
        pellets: w.pellets,
        falloff: w.falloff,
      })),
      loadouts: LOADOUTS,
      modes: MODE_LABELS,
      maxPlayers: MAX_PLAYERS,
    });
  },

  'POST /api/auth/guest': async (req, res, body) => {
    const result = auth.createGuest(sanitizeName(body?.name, 'Recruit'));
    sendJson(res, 200, { token: result.player.token, profile: auth.profile(result.player), stats: store.getStats(result.player.id) });
  },

  'POST /api/auth/register': async (req, res, body) => {
    const result = auth.register(body?.name, body?.password);
    if (!result.ok) return sendJson(res, 400, { error: result.error });
    sendJson(res, 200, { token: result.player.token, profile: auth.profile(result.player), stats: store.getStats(result.player.id) });
  },

  'POST /api/auth/login': async (req, res, body) => {
    const result = auth.login(body?.name, body?.password);
    if (!result.ok) return sendJson(res, 401, { error: result.error });
    sendJson(res, 200, { token: result.player.token, profile: auth.profile(result.player), stats: store.getStats(result.player.id) });
  },

  'POST /api/auth/upgrade': async (req, res, body) => {
    const player = requirePlayer(req, res);
    if (!player) return;
    const result = auth.upgrade(player, body?.password);
    if (!result.ok) return sendJson(res, 400, { error: result.error });
    sendJson(res, 200, { token: player.token, profile: auth.profile(player) });
  },

  'GET /api/me': async (req, res) => {
    const player = requirePlayer(req, res);
    if (!player) return;
    sendJson(res, 200, {
      profile: auth.profile(player),
      stats: store.getStats(player.id),
      saves: store.listSaves(player.id),
    });
  },

  'GET /api/leaderboard': async (req, res) => {
    sendJson(res, 200, { leaderboard: store.getLeaderboard(25) });
  },

  'GET /api/matches': async (req, res) => {
    sendJson(res, 200, { matches: store.recentMatches(12) });
  },

  'GET /api/lobbies': async (req, res) => {
    sendJson(res, 200, { lobbies: lobbies.list() });
  },

  'GET /api/saves': async (req, res) => {
    const player = requirePlayer(req, res);
    if (!player) return;
    sendJson(res, 200, { saves: store.listSaves(player.id) });
  },

  'POST /api/saves': async (req, res, body) => {
    const player = requirePlayer(req, res);
    if (!player) return;
    const slot = typeof body?.slot === 'string' ? body.slot.slice(0, 16) : 'auto';
    const missionId = typeof body?.missionId === 'string' ? body.missionId.slice(0, 40) : 'unknown';
    store.saveCampaign(player.id, slot, missionId, body?.data ?? {});
    sendJson(res, 200, { ok: true, saves: store.listSaves(player.id) });
  },

  'GET /api/load': async (req, res) => {
    const player = requirePlayer(req, res);
    if (!player) return;
    const slot = new URL(req.url, 'http://localhost').searchParams.get('slot') || 'auto';
    sendJson(res, 200, { save: store.getSave(player.id, slot) });
  },
};

async function handleApi(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const key = `${req.method} ${url.pathname}`;
  const handler = routes[key];
  if (!handler) return sendJson(res, 404, { error: 'Not found.' });
  let body = {};
  if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
    try {
      body = await readBody(req);
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }
  try {
    await handler(req, res, body);
  } catch (err) {
    console.error(`[api] ${key} failed:`, err);
    if (!res.headersSent) sendJson(res, 500, { error: 'Server error.' });
  }
}

// ---------------------------------------------------------------------------
// Static files
// ---------------------------------------------------------------------------

function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost');
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';

  const resolved = path.normalize(path.join(DIST, rel));
  // Path traversal guard: anything outside dist/ is refused outright.
  if (!resolved.startsWith(DIST)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.stat(resolved, (err, stat) => {
    if (!err && stat.isFile()) {
      const ext = path.extname(resolved).toLowerCase();
      const immutable = rel.startsWith('/assets/');
      res.writeHead(200, {
        'content-type': MIME[ext] || 'application/octet-stream',
        'content-length': stat.size,
        'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      });
      fs.createReadStream(resolved).pipe(res);
      return;
    }
    // SPA fallback: unknown paths get the app shell so client routing works.
    const shell = path.join(DIST, 'index.html');
    fs.readFile(shell, (readErr, data) => {
      if (readErr) {
        res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(
          'BREACHPOINT server is running, but no client build was found.\n\n' +
            'Run `npm run build` (or use `npm run dev` for the Vite dev server on 5173).\n',
        );
        return;
      }
      res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-cache' });
      res.end(data);
    });
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res);
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end('Method not allowed');
    return;
  }
  serveStatic(req, res);
});

// ---------------------------------------------------------------------------
// WebSocket game layer
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/ws') {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

/** Live connection state. A socket may be in a lobby, a match, or both. */
function makeSession() {
  return { player: null, token: null, roomId: null, rtt: 0, alive: true };
}

wss.on('connection', (ws) => {
  const session = makeSession();
  ws.isAlive = true;
  // The session lives on the socket so the lobby layer can find a player's
  // connection when a match starts, without keeping a second registry in sync.
  ws._session = session;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  const send = (message) => {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify(message));
  };
  session.send = send;

  send({ t: MSG.HELLO, version: 1 });

  ws.on('message', (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString('utf8'));
    } catch {
      return send({ t: MSG.ERROR, error: 'Malformed message.' });
    }
    if (!message || typeof message.t !== 'string') return;
    try {
      route(ws, session, message);
    } catch (err) {
      console.error('[ws] handler failed:', err);
      send({ t: MSG.ERROR, error: 'Internal error.' });
    }
  });

  ws.on('close', () => {
    session.alive = false;
    if (session.player) {
      const room = session.roomId ? rooms.get(session.roomId) : null;
      if (room) room.removeHuman(session.player.id);
      lobbies.leaveByPlayer(session.player.id);
      roomOfPlayer.delete(session.player.id);
    }
  });
});

function route(ws, session, message) {
  const { send } = session;

  // ---- handshake ---------------------------------------------------------
  if (message.t === MSG.HELLO) {
    const result = auth.resume(
      typeof message.token === 'string' ? message.token : null,
      sanitizeName(message.name, 'Recruit'),
    );
    session.player = result.player;
    session.token = result.player.token;
    send({
      t: MSG.WELCOME,
      token: result.player.token,
      profile: auth.profile(result.player),
      stats: store.getStats(result.player.id),
      resumed: result.resumed,
      lobbies: lobbies.list(),
      maxPlayers: MAX_PLAYERS,
    });
    return;
  }

  if (!session.player) {
    return send({ t: MSG.ERROR, error: 'Say hello first.' });
  }
  const player = session.player;

  // ---- ping --------------------------------------------------------------
  if (message.t === MSG.PING) {
    return send({ t: MSG.PONG, id: message.id, c: message.c, s: Date.now() });
  }

  // ---- in-match traffic (routed without touching the lobby) --------------
  if (message.t === MSG.INPUT || message.t === MSG.FIRE || message.t === MSG.RELOAD || message.t === MSG.SWITCH) {
    let roomId = session.roomId;
    if (!roomId) roomId = roomOfPlayer.get(player.id) || null;
    const room = roomId ? rooms.get(roomId) : null;
    if (!room) return;
    session.roomId = roomId;
    if (message.t === MSG.SWITCH && message.slot !== 'primary' && message.slot !== 'secondary') return;
    if (message.t === MSG.FIRE) message.seed = clampNumber(message.seed, 0, 0xffffffff, 1) >>> 0;
    if (message.t === MSG.INPUT) message.lag = clampNumber(message.lag, 0, 0.5, 0);
    room.handle(player.id, message);
    return;
  }

  // ---- lobby -------------------------------------------------------------
  switch (message.t) {
    case MSG.LOBBY_SUBSCRIBE:
      return send({ t: MSG.LOBBY_LIST, lobbies: lobbies.list() });

    case MSG.LOBBY_LIST:
      return send({ t: MSG.LOBBY_LIST, lobbies: lobbies.list() });

    case MSG.LOBBY_CREATE: {
      const mode = message.mode === 'ffa' ? 'ffa' : 'tdm';
      const lobby = lobbies.create({
        player,
        send,
        name: message.name,
        mode,
        mapId: typeof message.mapId === 'string' ? message.mapId : 'foundry',
        maxPlayers: clampNumber(message.maxPlayers, 2, MAX_PLAYERS, MAX_PLAYERS),
        botFill: clampNumber(message.botFill, 0, MAX_PLAYERS, 6),
        difficulty: ['recruit', 'regular', 'veteran', 'elite'].includes(message.difficulty) ? message.difficulty : 'regular',
        isPrivate: !!message.isPrivate,
      });
      send({ t: MSG.LOBBY_JOINED, lobby: lobby.memberView(player.id) });
      broadcastLobbyList();
      return;
    }

    case MSG.LOBBY_JOIN: {
      const result = lobbies.join({ player, send, lobbyId: message.lobbyId, code: message.code });
      if (!result.ok) return send({ t: MSG.ERROR, error: result.error });
      session.roomId = null;
      send({ t: MSG.LOBBY_JOINED, lobby: result.lobby.memberView(player.id) });
      result.lobby.broadcast({ t: MSG.LOBBY_UPDATE, lobby: result.lobby.publicView() }, player.id);
      broadcastLobbyList();
      return;
    }

    case MSG.LOBBY_QUICKJOIN: {
      const mode = message.mode === 'ffa' ? 'ffa' : 'tdm';
      const result = lobbies.quickJoin({ player, send, mode });
      if (!result.ok) return send({ t: MSG.ERROR, error: result.error });
      send({ t: MSG.LOBBY_JOINED, lobby: result.lobby.memberView(player.id), autoStart: true });
      broadcastLobbyList();
      return;
    }

    case MSG.LOBBY_LEAVE: {
      const lobby = lobbies.leaveByPlayer(player.id);
      session.roomId = null;
      send({ t: MSG.LOBBY_LEFT });
      if (lobby) {
        lobby.broadcast({ t: MSG.LOBBY_UPDATE, lobby: lobby.publicView() });
        broadcastLobbyList();
      }
      return;
    }

    case MSG.LOBBY_READY: {
      const lobby = lobbies.lobbyOf(player.id);
      if (!lobby) return;
      const member = lobby.member(player.id);
      if (member) member.ready = !!message.ready;
      lobby.broadcast({ t: MSG.LOBBY_UPDATE, lobby: lobby.memberView(player.id) });
      return;
    }

    case MSG.LOBBY_TEAM: {
      const lobby = lobbies.lobbyOf(player.id);
      if (!lobby || lobby.mode === 'ffa') return;
      const member = lobby.member(player.id);
      if (!member) return;
      const team = message.team === 'b' ? 'b' : 'a';
      // Keep teams within one player of each other so nobody stacks a side.
      let a = 0;
      let b = 0;
      for (const m of lobby.members.values()) {
        if (m.team === 'a') a++;
        else if (m.team === 'b') b++;
      }
      if (team === 'a' && a > b + 1) return send({ t: MSG.ERROR, error: 'Team A is full.' });
      if (team === 'b' && b > a + 1) return send({ t: MSG.ERROR, error: 'Team B is full.' });
      member.team = team;
      lobby.broadcast({ t: MSG.LOBBY_UPDATE, lobby: lobby.memberView(player.id) });
      return;
    }

    case MSG.LOBBY_CONFIG: {
      const lobby = lobbies.lobbyOf(player.id);
      if (!lobby || lobby.hostId !== player.id) return send({ t: MSG.ERROR, error: 'Only the host can change settings.' });
      if (typeof message.mapId === 'string' && LEVEL_LIST.some((l) => l.id === message.mapId)) lobby.mapId = message.mapId;
      if (message.mode === 'tdm' || message.mode === 'ffa') {
        // A map that does not support the new mode would be unplayable.
        const supported = LEVEL_LIST.find((l) => l.id === lobby.mapId && l.modes.includes(message.mode));
        if (!supported) {
          const fallback = LEVEL_LIST.find((l) => l.modes.includes(message.mode));
          if (fallback) lobby.mapId = fallback.id;
        }
        lobby.mode = message.mode;
      }
      if (message.botFill != null) lobby.botFill = clampNumber(message.botFill, 0, MAX_PLAYERS, lobby.botFill);
      if (message.maxPlayers != null) lobby.maxPlayers = clampNumber(message.maxPlayers, 2, MAX_PLAYERS, lobby.maxPlayers);
      if (['recruit', 'regular', 'veteran', 'elite'].includes(message.difficulty)) lobby.difficulty = message.difficulty;
      if (message.name != null) lobby.name = message.name;
      lobby.broadcast({ t: MSG.LOBBY_UPDATE, lobby: lobby.memberView(player.id) });
      broadcastLobbyList();
      return;
    }

    case MSG.LOBBY_START: {
      const lobby = lobbies.lobbyOf(player.id);
      if (!lobby) return;
      if (lobby.hostId !== player.id) return send({ t: MSG.ERROR, error: 'Only the host can start the match.' });
      startMatch(lobby);
      return;
    }

    case MSG.CHAT: {
      const lobby = lobbies.lobbyOf(player.id);
      const text = typeof message.text === 'string' ? message.text.replace(/[\u0000-\u001f]/g, '').slice(0, 160) : '';
      if (!text) return;
      const entry = { from: player.name, id: player.id, text, at: Date.now() };
      if (lobby) {
        lobby.chat.push(entry);
        if (lobby.chat.length > 60) lobby.chat.shift();
        lobby.broadcast({ t: MSG.CHAT, ...entry });
      } else {
        send({ t: MSG.CHAT, ...entry });
      }
      return;
    }

    default:
      return;
  }
}

function broadcastLobbyList() {
  const list = lobbies.list();
  wss.clients.forEach((client) => {
    if (client.readyState === client.OPEN) client.send(JSON.stringify({ t: MSG.LOBBY_LIST, lobbies: list }));
  });
}

/**
 * Turn a lobby into a live match. The room owns the simulation from here on;
 * the lobby survives as a container so the same group can play again.
 */
function startMatch(lobby) {
  if (lobby.status !== 'open') return;
  const room = new MatchRoom({
    lobby,
    store,
    onEmpty: (finished) => {
      rooms.delete(finished.id);
      for (const [pid, rid] of roomOfPlayer) if (rid === finished.id) roomOfPlayer.delete(pid);
      lobby.status = 'open';
      lobby.broadcast({ t: MSG.LOBBY_UPDATE, lobby: lobby.publicView() });
      console.log(`[room] ${finished.id} closed`);
    },
  });
  rooms.set(room.id, room);
  lobby.status = 'playing';

  // Point every member's session at the room before the first snapshot flies.
  for (const member of lobby.members.values()) {
    roomOfPlayer.set(member.id, room.id);
    const session = sessionForPlayer(member.id);
    if (session) session.roomId = room.id;
  }

  room.start();
  console.log(`[room] ${room.id} started on ${room.levelId} (${room.mode}), ${room.playerCount} players`);
  lobby.broadcast({ t: MSG.LOBBY_UPDATE, lobby: lobby.publicView() });
}

function sessionForPlayer(playerId) {
  let found = null;
  wss.clients.forEach((client) => {
    const session = client._session;
    if (session && session.player && session.player.id === playerId) found = session;
  });
  return found;
}

// ---------------------------------------------------------------------------
// Liveness + shutdown
// ---------------------------------------------------------------------------

const heartbeat = setInterval(() => {
  wss.clients.forEach((client) => {
    if (!client.isAlive) {
      client.terminate();
      return;
    }
    client.isAlive = false;
    client.ping();
  });
}, 30000);
heartbeat.unref?.();

server.listen(PORT, HOST, () => {
  console.log(`\n  BREACHPOINT server listening on http://localhost:${PORT}`);
  console.log(`  websocket: ws://localhost:${PORT}/ws`);
  console.log(`  client:    ${fs.existsSync(DIST) ? 'serving dist/' : 'no build yet — run `npm run build`'}\n`);
});

function shutdown(signal) {
  console.log(`\n[server] ${signal} received, shutting down`);
  clearInterval(heartbeat);
  for (const room of rooms.values()) room.stop();
  for (const client of wss.clients) client.close(1001, 'server shutting down');
  server.close(() => {
    store.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 4000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
