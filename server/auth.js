/**
 * Identity.
 *
 * The game is playable without an account: a guest gets an opaque token that
 * the browser keeps and re-presents on every visit, so stats and campaign saves
 * persist without a signup wall. Registering a password later upgrades the same
 * player row, which means progression is never lost by creating an account.
 *
 * Passwords are hashed with scrypt and a per-user random salt. Verification is
 * constant time. A guest token is 24 random bytes, so it is not guessable and
 * does not need to be hashed.
 */

import crypto from 'node:crypto';
import { sanitizeName } from '../src/net/protocol.js';

const TOKEN_BYTES = 24;
const SCRYPT_KEYLEN = 32;

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
}

function verifyPassword(password, salt, expectedHex) {
  if (!salt || !expectedHex) return false;
  const actual = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  const expected = Buffer.from(expectedHex, 'hex');
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

export class Auth {
  constructor(store) {
    this.store = store;
    /** Fast path for the common case: token -> player row, already validated. */
    this.sessions = new Map();
  }

  /** Strip secrets before a player row ever reaches the network. */
  profile(player) {
    return {
      id: player.id,
      name: player.name,
      guest: !!player.guest,
      createdAt: player.created_at,
      token: player.token,
    };
  }

  /**
   * Resume an existing session, or mint a brand new guest. Called on every
   * socket hello, so it must be cheap.
   */
  resume(token, requestedName) {
    if (token && typeof token === 'string') {
      const cached = this.sessions.get(token);
      if (cached) {
        this.store.touchPlayer(cached.id);
        return { ok: true, player: cached, resumed: true };
      }
      const player = this.store.findPlayerByToken(token);
      if (player) {
        if (requestedName) {
          const name = sanitizeName(requestedName, player.name);
          if (name !== player.name) {
            this.store.renamePlayer(player.id, name);
            player.name = name;
          }
        }
        this.sessions.set(token, player);
        this.store.touchPlayer(player.id);
        return { ok: true, player, resumed: true };
      }
    }
    return this.createGuest(requestedName);
  }

  createGuest(requestedName) {
    const name = this.uniqueName(sanitizeName(requestedName, 'Recruit'));
    const token = crypto.randomBytes(TOKEN_BYTES).toString('hex');
    const player = this.store.createPlayer({ token, name, guest: 1 });
    this.sessions.set(token, player);
    return { ok: true, player, resumed: false };
  }

  /**
   * Guest names are display names, not identities, so a clash is resolved by
   * suffixing rather than by rejecting the player.
   */
  uniqueName(base) {
    let name = base;
    for (let i = 2; i < 40; i++) {
      if (!this.store.findPlayerByName(name)) return name;
      name = `${base.slice(0, 15)}-${i}`;
    }
    return `${base.slice(0, 10)}-${crypto.randomBytes(2).toString('hex')}`;
  }

  register(name, password) {
    const clean = sanitizeName(name, '');
    if (!clean) return { ok: false, error: 'Enter a name.' };
    if (typeof password !== 'string' || password.length < 6) {
      return { ok: false, error: 'Password must be at least 6 characters.' };
    }
    if (this.store.findPlayerByName(clean)) return { ok: false, error: 'That name is taken.' };
    const salt = crypto.randomBytes(16).toString('hex');
    const token = crypto.randomBytes(TOKEN_BYTES).toString('hex');
    const player = this.store.createPlayer({
      token,
      name: clean,
      guest: 0,
      passHash: hashPassword(password, salt),
      passSalt: salt,
    });
    this.sessions.set(token, player);
    return { ok: true, player };
  }

  login(name, password) {
    const player = this.store.findPlayerByName(sanitizeName(name, ''));
    if (!player || !player.pass_hash) return { ok: false, error: 'No account with that name.' };
    if (!verifyPassword(password || '', player.pass_salt, player.pass_hash)) {
      return { ok: false, error: 'Incorrect password.' };
    }
    this.sessions.set(player.token, player);
    this.store.touchPlayer(player.id);
    return { ok: true, player };
  }

  /**
   * Upgrade the signed-in guest to a full account, keeping the same player id
   * so lifetime stats and campaign saves carry over untouched.
   */
  upgrade(player, password) {
    if (!player) return { ok: false, error: 'Not signed in.' };
    if (!player.guest) return { ok: false, error: 'This account already has a password.' };
    if (typeof password !== 'string' || password.length < 6) {
      return { ok: false, error: 'Password must be at least 6 characters.' };
    }
    const salt = crypto.randomBytes(16).toString('hex');
    this.store.setPassword(player.id, hashPassword(password, salt), salt);
    player.guest = 0;
    player.pass_hash = hashPassword(password, salt);
    player.pass_salt = salt;
    this.sessions.set(player.token, player);
    return { ok: true, player };
  }

  /** Resolve a token to a live player row (used by the REST layer). */
  fromToken(token) {
    if (!token) return null;
    const cached = this.sessions.get(token);
    if (cached) return cached;
    const player = this.store.findPlayerByToken(token);
    if (player) this.sessions.set(token, player);
    return player;
  }

  forget(token) {
    this.sessions.delete(token);
  }
}
