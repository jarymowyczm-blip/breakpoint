/**
 * Wire protocol shared by the browser client and the Node game server.
 *
 * Both sides import this file so a message can never mean two different things.
 * The protocol is plain JSON over a single WebSocket. It is deliberately
 * explicit rather than clever: a hand-written protocol is trivial to debug in
 * the network tab, needs no schema tooling, and costs very little bandwidth at
 * these rates (20 snapshots/second, 60 input messages/second).
 *
 * Message shape is always `{ t: <type>, ...payload }`.
 */

export const MSG = {
  // ---- session -----------------------------------------------------------
  HELLO: 'hello',
  WELCOME: 'welcome',
  PING: 'ping',
  PONG: 'pong',
  ERROR: 'error',

  // ---- lobby -------------------------------------------------------------
  LOBBY_LIST: 'lobby:list',
  LOBBY_SUBSCRIBE: 'lobby:subscribe',
  LOBBY_CREATE: 'lobby:create',
  LOBBY_JOIN: 'lobby:join',
  LOBBY_LEAVE: 'lobby:leave',
  LOBBY_JOINED: 'lobby:joined',
  LOBBY_UPDATE: 'lobby:update',
  LOBBY_LEFT: 'lobby:left',
  LOBBY_READY: 'lobby:ready',
  LOBBY_TEAM: 'lobby:team',
  LOBBY_CONFIG: 'lobby:config',
  LOBBY_START: 'lobby:start',
  LOBBY_KICK: 'lobby:kick',
  LOBBY_QUICKJOIN: 'lobby:quickjoin',

  // ---- match -------------------------------------------------------------
  MATCH_START: 'match:start',
  MATCH_END: 'match:end',
  SNAPSHOT: 'snap',
  INPUT: 'input',
  FIRE: 'fire',
  RELOAD: 'reload',
  SWITCH: 'switch',
  CHAT: 'chat',
  SPAWN: 'spawn',
};

export const LOBBY_STATUS = {
  OPEN: 'open',
  COUNTDOWN: 'countdown',
  PLAYING: 'playing',
};

export const GAME_MODES = ['tdm', 'ffa'];

export const MODE_LABELS = {
  tdm: 'Team Deathmatch',
  ffa: 'Free For All',
};

/** Input command sent 60x/second. This is the whole client->server authority. */
export function makeInput({ forward = 0, right = 0, jump = false, crouch = false, sprint = false, walk = false, ads = false, yaw = 0, pitch = 0 }) {
  return { forward, right, jump, crouch, sprint, walk, ads, yaw, pitch };
}

/** Names are shown in the kill feed, so they must not be able to break layout. */
export function sanitizeName(raw, fallback = 'Operator') {
  if (typeof raw !== 'string') return fallback;
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 18);
  return cleaned.length ? cleaned : fallback;
}

export function sanitizeLobbyName(raw) {
  if (typeof raw !== 'string') return 'Breachpoint Lobby';
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 28);
  return cleaned.length ? cleaned : 'Breachpoint Lobby';
}

/** Clamp a value that arrived from the network into a sane range. */
export function clampNumber(v, min, max, fallback = 0) {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return n < min ? min : n > max ? max : n;
}

/**
 * A lobby join code. Ambiguous characters (0/O, 1/I/L) are excluded so a code
 * can be read out loud over voice chat without confusion.
 */
export function makeJoinCode(rng = Math.random) {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 5; i++) out += alphabet[Math.floor(rng() * alphabet.length)];
  return out;
}

/**
 * Decode one snapshot row. Rows are positional rather than keyed because a
 * 16-player map at 20 Hz adds up, and the field order is fixed here once for
 * both sides.
 */
export const SNAP_FIELDS = [
  'id', 'x', 'y', 'z', 'yaw', 'pitch', 'recoilPitch', 'recoilYaw',
  'flags', 'health', 'armor', 'team', 'weapon', 'ammo', 'ammoPrimary',
  'ammoSecondary', 'kills', 'deaths', 'assists', 'score', 'firing', 'ads', 'height',
];

export function decodeSnapRow(row) {
  const out = {};
  for (let i = 0; i < SNAP_FIELDS.length; i++) out[SNAP_FIELDS[i]] = row[i];
  return out;
}

export const FLAG_BITS = {
  grounded: 1,
  crouching: 2,
  sprinting: 4,
  ads: 8,
  reloading: 16,
  firing: 32,
  sprintLock: 64,
  dead: 128,
};
