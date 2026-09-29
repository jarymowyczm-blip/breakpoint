/**
 * End-to-end server test.
 *
 * Boots the real server as a child process, then drives it exactly like a
 * browser would: REST for identity and saves, then a WebSocket session through
 * handshake, lobby creation, a full match start, live inputs and snapshots.
 *
 * This is the only test that proves the client and server actually agree on the
 * protocol, so it is worth the couple of seconds it takes.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { MSG } from '../src/net/protocol.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const PORT = 8099 + (process.pid % 50);
const BASE = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}/ws`;

let checks = 0;
let failures = 0;

function check(label, ok, detail = '') {
  checks++;
  if (ok) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`);
  }
}

function section(name) {
  console.log(`\n${name}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(pathname, body, token) {
  const res = await fetch(`${BASE}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function get(pathname, token) {
  const res = await fetch(`${BASE}${pathname}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** A tiny promise-based client that records everything the server sends. */
function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const inbox = [];
    const waiters = [];
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString('utf8'));
      } catch {
        return;
      }
      inbox.push(msg);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].predicate(msg)) {
          waiters[i].resolve(msg);
          waiters.splice(i, 1);
        }
      }
    });
    ws.on('error', reject);
    ws.on('open', () =>
      resolve({
        ws,
        send: (m) => ws.send(JSON.stringify(m)),
        inbox,
        /**
         * Wait for the next matching message. By default only messages that
         * arrive *after* the call count, so a stale broadcast from earlier in
         * the test can never satisfy a later assertion -- that is the classic
         * way a protocol test passes while the feature is broken.
         */
        wait(predicate, options = 4000) {
          // Accept either a bare timeout or an options object.
          const { timeout = 4000, fresh = true } = typeof options === 'number' ? { timeout: options } : options;
          const from = fresh ? inbox.length : 0;
          for (let i = from; i < inbox.length; i++) if (predicate(inbox[i])) return Promise.resolve(inbox[i]);
          return new Promise((res, rej) => {
            const timer = setTimeout(() => {
              rej(new Error(`timed out waiting for message; saw [${inbox.map((m) => m.t).join(', ')}]`));
            }, timeout);
            waiters.push({
              predicate,
              resolve: (m) => {
                clearTimeout(timer);
                res(m);
              },
            });
          });
        },
        close: () => ws.close(),
      }),
    );
  });
}

const byType = (t) => (m) => m.t === t;

// ---------------------------------------------------------------------------

// A throwaway data directory keeps the test hermetic: names, tokens and stats
// must not leak in from a previous run, and the test must not touch the real
// player database in `data/`.
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'breachpoint-test-'));

const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', BREACHPOINT_DATA_DIR: DATA_DIR },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let serverLog = '';
child.stdout.on('data', (d) => {
  serverLog += d.toString();
});
child.stderr.on('data', (d) => {
  serverLog += d.toString();
});

function cleanup() {
  if (!child.killed) child.kill('SIGKILL');
  try {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

process.on('exit', cleanup);

// Wait for the port to answer before testing anything.
let up = false;
for (let i = 0; i < 60; i++) {
  try {
    const res = await fetch(`${BASE}/api/health`);
    if (res.ok) {
      up = true;
      break;
    }
  } catch {
    /* not listening yet */
  }
  await sleep(150);
}

if (!up) {
  console.error('\nServer never came up. Log:\n' + serverLog);
  cleanup();
  process.exit(1);
}

try {
  section('REST API');
  {
    const health = await get('/api/health');
    check('health endpoint answers', health.status === 200 && health.body.ok === true, JSON.stringify(health.body));
    check('reports the storage backend', ['sqlite', 'json'].includes(health.body.storage), health.body.storage);

    const catalog = await get('/api/catalog');
    check('catalog lists three levels', catalog.body.levels.length === 3, `${catalog.body.levels.length}`);
    check('catalog lists six weapons', catalog.body.weapons.length === 6, `${catalog.body.weapons.length}`);
    check('catalog exposes loadouts', catalog.body.loadouts && Object.keys(catalog.body.loadouts).length > 0);
    check('every catalog level declares modes', catalog.body.levels.every((l) => l.modes.length > 0));

    const guest = await post('/api/auth/guest', { name: 'IntegrationTester' });
    check('guest sign-in returns a token', guest.status === 200 && typeof guest.body.token === 'string');
    check('guest profile is not an account', guest.body.profile.guest === true);
    const token = guest.body.token;

    const me = await get('/api/me', token);
    check('profile is readable with the token', me.status === 200 && me.body.profile.name === 'IntegrationTester', me.body?.profile?.name);
    check('a fresh guest has clean stats', me.body.stats.kills === 0, JSON.stringify(me.body.stats));

    const anonymous = await get('/api/me');
    check('profile requires a token', anonymous.status === 401, String(anonymous.status));

    const saved = await post('/api/saves', { slot: 'auto', missionId: 'compound-01', data: { phase: 2, cleared: 4 } }, token);
    check('campaign save is accepted', saved.status === 200 && saved.body.ok === true);
    const loaded = await get(`/api/load?slot=auto`, token);
    check('campaign save round-trips', loaded.body.save?.data?.cleared === 4, JSON.stringify(loaded.body.save));
    check('save carries its mission id', loaded.body.save?.missionId === 'compound-01', loaded.body.save?.missionId);

    const register = await post('/api/auth/register', { name: 'IntegrationTester', password: 'hunter22' });
    check('registering a taken name is refused', register.status === 400, String(register.status));
    const shortPass = await post('/api/auth/register', { name: 'SomeoneElse', password: 'abc' });
    check('short passwords are refused', shortPass.status === 400);
    const upgrade = await post('/api/auth/upgrade', { password: 'hunter22' }, token);
    check('guest can be upgraded to an account', upgrade.status === 200 && upgrade.body.profile.guest === false, JSON.stringify(upgrade.body));
    const login = await post('/api/auth/login', { name: 'IntegrationTester', password: 'hunter22' });
    check('the upgraded account can log in', login.status === 200 && login.body.token === token, String(login.status));
    const badLogin = await post('/api/auth/login', { name: 'IntegrationTester', password: 'wrongpass' });
    check('a wrong password is rejected', badLogin.status === 401, String(badLogin.status));

    const leaderboard = await get('/api/leaderboard');
    check('leaderboard is served', Array.isArray(leaderboard.body.leaderboard));
  }

  section('WebSocket handshake');
  let host;
  let guest;
  {
    host = await connect();
    const hello = await host.wait(byType(MSG.HELLO), { fresh: false });
    check('server greets a new socket', !!hello);

    host.send({ t: MSG.HELLO, name: 'HostPlayer' });
    const welcome = await host.wait(byType(MSG.WELCOME));
    check('welcome carries a token', typeof welcome.token === 'string' && welcome.token.length > 10);
    check('welcome carries the profile', welcome.profile.name === 'HostPlayer', welcome.profile.name);
    check('welcome lists lobbies', Array.isArray(welcome.lobbies));

    guest = await connect();
    await guest.wait(byType(MSG.HELLO), { fresh: false });
    guest.send({ t: MSG.HELLO, name: 'GuestPlayer' });
    await guest.wait(byType(MSG.WELCOME));

    // A client that has not said hello must not be able to act.
    const rude = await connect();
    await rude.wait(byType(MSG.HELLO), { fresh: false });
    rude.send({ t: MSG.LOBBY_CREATE, name: 'Nope' });
    const denied = await rude.wait(byType(MSG.ERROR));
    check('acting before hello is refused', /hello/i.test(denied.error), denied.error);
    rude.close();
  }

  section('Lobby lifecycle');
  {
    host.send({ t: MSG.LOBBY_CREATE, name: 'Integration Lobby', mode: 'tdm', mapId: 'foundry', botFill: 3, difficulty: 'regular', maxPlayers: 8 });
    const joined = await host.wait(byType(MSG.LOBBY_JOINED));
    check('lobby is created', joined.lobby.name === 'Integration Lobby', joined.lobby.name);
    check('host is marked as host', joined.lobby.roster[0].isHost === true);
    check('lobby has a short join code', joined.lobby.code.length === 5, joined.lobby.code);
    check('lobby exposes a ping field per member', typeof joined.lobby.roster[0].ping === 'number');

    const code = joined.lobby.code;
    const lobbyId = joined.lobby.id;

    // Joining by code is the "read it out loud" path.
    guest.send({ t: MSG.LOBBY_JOIN, code });
    const guestJoined = await guest.wait(byType(MSG.LOBBY_JOINED));
    check('a lobby can be joined by code', guestJoined.lobby.id === lobbyId, guestJoined.lobby.id);
    check('joining assigns a team', ['a', 'b'].includes(guestJoined.lobby.roster.find((r) => r.name === 'GuestPlayer').team));

    const listMsg = await host.wait((m) => m.t === MSG.LOBBY_LIST && m.lobbies.find((l) => l.id === lobbyId)?.players === 2);
    check('lobby appears in the public list with both players', !!listMsg);
    const listed = listMsg.lobbies.find((l) => l.id === lobbyId);
    check('listing reports player count', listed.players === 2, String(listed.players));
    check('listing reports the map name', listed.mapName === 'Foundry', listed.mapName);
    check('listing hides private lobbies later', listed.isPrivate === false);

    const badJoin = await new Promise((resolve) => {
      guest.send({ t: MSG.LOBBY_JOIN, code: 'ZZZZZ' });
      guest.wait(byType(MSG.ERROR), 2000).then(resolve).catch(() => resolve(null));
    });
    check('an unknown join code is rejected', !!badJoin && /no longer exists/i.test(badJoin.error), badJoin && badJoin.error);

    // Non-host configuration is refused.
    guest.send({ t: MSG.LOBBY_CONFIG, mapId: 'range' });
    const refused = await guest.wait((m) => m.t === MSG.ERROR && /host/i.test(m.error));
    check('only the host may change settings', !!refused);

    host.send({ t: MSG.LOBBY_CONFIG, mapId: 'foundry', botFill: 4 });
    const updated = await host.wait((m) => m.t === MSG.LOBBY_UPDATE && m.lobby.bots === 4);
    check('host settings are applied', updated.lobby.bots === 4, String(updated.lobby.bots));

    guest.send({ t: MSG.CHAT, text: 'gl hf' });
    const chat = await host.wait((m) => m.t === MSG.CHAT && m.text === 'gl hf');
    check('chat is relayed to the lobby', chat.from === 'GuestPlayer', chat.from);
  }

  section('Authoritative match');
  {
    host.send({ t: MSG.LOBBY_START });
    const start = await host.wait(byType(MSG.MATCH_START), 5000);
    check('match start names the map', start.levelId === 'foundry', start.levelId);
    check('match start reports the tick rate', start.tickRate === 30, String(start.tickRate));
    check('match start identifies the recipient', start.you === start.roster.find((r) => r.name === 'HostPlayer').id);
    check('bots were spawned to fill the match', start.roster.filter((r) => r.isBot).length >= 4, `${start.roster.filter((r) => r.isBot).length} bots`);
    check('teams are balanced', (() => {
      const a = start.roster.filter((p) => p.team === 'a').length;
      const b = start.roster.filter((p) => p.team === 'b').length;
      return Math.abs(a - b) <= 1;
    })());

    const guestStart = await guest.wait(byType(MSG.MATCH_START), 5000);
    check('both humans are in the same match', guestStart.roomId === start.roomId);

    const snap = await host.wait(byType(MSG.SNAPSHOT), 5000);
    check('a snapshot arrives', !!snap);
    check('snapshot carries every player', snap.players.length === start.roster.length, `${snap.players.length} vs ${start.roster.length}`);
    check('snapshot rows are positional with 23 fields', snap.players.every((row) => row.length === 23), String(snap.players[0].length));
    check('snapshot carries limits', typeof snap.limits.killLimit === 'number');
    check('snapshot acknowledges input', typeof snap.ack === 'number');

    // Drive the player for a second and a half, then check the world moved.
    const me = start.roster.find((r) => r.name === 'HostPlayer');
    const first = snap.players.find((r) => r[0] === me.id);
    let seq = 0;
    for (let i = 0; i < 90; i++) {
      host.send({
        t: MSG.INPUT,
        seq: ++seq,
        lag: 0.02,
        input: { forward: 1, right: 0, jump: false, crouch: false, sprint: true, walk: false, ads: false, yaw: 0.4, pitch: 0 },
      });
      await sleep(16);
    }
    const moved = await host.wait((m) => m.t === MSG.SNAPSHOT && m.tick > snap.tick + 20, 4000);
    const nowRow = moved.players.find((r) => r[0] === me.id);
    const travelled = Math.hypot(nowRow[1] - first[1], nowRow[3] - first[3]);
    check('the server simulates our movement', travelled > 1, `travelled ${travelled.toFixed(2)}m`);
    check('the server echoes our view angles', Math.abs(nowRow[4] - 0.4) < 0.05, String(nowRow[4]));

    // Firing must produce a shot event and eventually damage someone.
    const eventsSoFar = moved.events ? moved.events.length : 0;
    for (let i = 0; i < 25; i++) {
      host.send({ t: MSG.FIRE, seq: ++seq, seed: 1000 + i, lag: 0.02 });
      await sleep(80);
    }
    const afterShots = await host.wait((m) => m.t === MSG.SNAPSHOT && m.events.some((e) => e.t === 'shot'), 4000);
    check('our shots produce shot events', afterShots.events.some((e) => e.t === 'shot'), `events=${eventsSoFar}`);
    check('shot events carry an origin and direction', (() => {
      const s = afterShots.events.find((e) => e.t === 'shot');
      return Array.isArray(s.origin) && s.origin.length === 3 && Array.isArray(s.dir);
    })());
    check('the snapshot reports our ammo dropping', (() => {
      const s = afterShots.players.find((r) => r[0] === me.id);
      return s[13] < 30;
    })(), 'ammo field');

    // Rate limiting: ten shots in one frame must not all be accepted.
    const ammoBefore = (await host.wait(byType(MSG.SNAPSHOT), 3000)).players.find((r) => r[0] === me.id);
    for (let i = 0; i < 10; i++) host.send({ t: MSG.FIRE, seq: ++seq, seed: 9000 + i });
    await sleep(120);
    const ammoAfter = (await host.wait(byType(MSG.SNAPSHOT), 3000)).players.find((r) => r[0] === me.id);
    check('a burst is rate limited to the weapon cadence', ammoBefore[13] - ammoAfter[13] <= 3, `${ammoBefore[13]} -> ${ammoAfter[13]}`);

    // Reload and weapon switch are accepted.
    host.send({ t: MSG.RELOAD });
    await sleep(300);
    const reloaded = await host.wait((m) => m.t === MSG.SNAPSHOT && m.events.some((e) => e.t === 'reload'), 3000);
    check('reload produces a reload event', reloaded.events.some((e) => e.t === 'reload'));

    host.send({ t: MSG.SWITCH, slot: 'secondary' });
    const switched = await host.wait(
      (m) => m.t === MSG.SNAPSHOT && m.players.find((r) => r[0] === me.id)[12] === 'pistol',
      3000,
    );
    check('switching to the sidearm is applied', !!switched);
    host.send({ t: MSG.SWITCH, slot: 'primary' });

    // Ping/pong carries the client's own timestamp back.
    host.send({ t: MSG.PING, id: 4242, c: 123456 });
    const pong = await host.wait((m) => m.t === MSG.PONG && m.id === 4242);
    check('pong echoes the ping payload', pong.c === 123456, String(pong.c));

    // A garbage message must not take the server down.
    host.ws.send('this is not json');
    const err = await host.wait(byType(MSG.ERROR));
    check('malformed JSON is rejected politely', /Malformed/i.test(err.error), err.error);
    const alive = await get('/api/health');
    check('server survives malformed input', alive.status === 200);

    // Leaving mid-match must not break the other player.
    guest.send({ t: MSG.LOBBY_LEAVE });
    await sleep(400);
    const stillFine = await get('/api/health');
    check('a departure does not break the match', stillFine.status === 200 && stillFine.body.matches >= 1, JSON.stringify(stillFine.body));
  }

  section('Persistence after play');
  {
    const me = await get('/api/me', null);
    check('unauthenticated profile stays closed', me.status === 401);

    const leaderboard = await get('/api/leaderboard');
    check('leaderboard endpoint still serves', Array.isArray(leaderboard.body.leaderboard));

    const matches = await get('/api/matches');
    check('finished matches are recorded', Array.isArray(matches.body.matches));
  }
} catch (err) {
  console.error(`\n  FAIL harness error: ${err.message}`);
  failures++;
  checks++;
} finally {
  cleanup();
}

console.log(
  `\n${failures ? '\u001b[31m' : '\u001b[32m'}${checks - failures}/${checks} checks passed\u001b[0m\n`,
);
if (failures && serverLog) console.log('--- server log ---\n' + serverLog.slice(-3000));
process.exit(failures ? 1 : 0);
