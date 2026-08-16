/* ============================================================
   Accounts, roles and sessions.

   Stored in users.json next to the board. Passwords are kept as
   scrypt hashes with a per-user salt — never in the clear.

   Sessions are stateless: the cookie carries a signed
   {uid, exp} payload, so a server restart doesn't sign
   everybody out and there's no session table to keep.
   ============================================================ */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/** What each role is allowed to touch. The admin oversees everything. */
const ROLES = {
  admin: {
    label: 'Admin',
    blurb: 'Full control — players, board, effects and accounts.',
    caps: ['players', 'effects', 'board', 'users'],
  },
  scorer: {
    label: 'Score adder',
    blurb: 'Can add players and change scores. Cannot touch the board or effects.',
    caps: ['players'],
  },
  supervisor: {
    label: 'Supervisor',
    blurb: 'Runs the show effects and can hide or show the overlay. Cannot change scores.',
    caps: ['effects'],
  },
};

const roleCaps = (role) => (ROLES[role] || ROLES.scorer).caps;

class Users {
  constructor(file) {
    this.file = path.resolve(file);
    this.data = this._load();
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!Array.isArray(raw.users)) throw new Error('bad shape');
      if (!raw.secret) raw.secret = crypto.randomBytes(32).toString('hex');
      return raw;
    } catch {
      return { secret: crypto.randomBytes(32).toString('hex'), users: [] };
    }
  }

  _save() {
    // 0600 so the hashes aren't world-readable on a shared machine.
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), { mode: 0o600 });
  }

  /* ---------------------------------------------------- passwords */

  static hash(password, salt = crypto.randomBytes(16).toString('hex')) {
    const derived = crypto.scryptSync(String(password), salt, 64).toString('hex');
    return { salt, hash: derived };
  }

  static verifyPassword(password, salt, expected) {
    if (!salt || !expected) return false;
    const { hash } = Users.hash(password, salt);
    const a = Buffer.from(hash, 'hex');
    const b = Buffer.from(expected, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  /* ---------------------------------------------------- accounts */

  /** Creates the first admin if the file is empty. Returns it, or null. */
  bootstrap(password) {
    if (this.data.users.length) return null;
    const admin = this.create({
      username: 'admin',
      name: 'Admin',
      role: 'admin',
      password: password || crypto.randomBytes(6).toString('base64url'),
    });
    return admin;
  }

  list() {
    return this.data.users.map((u) => this.publicView(u));
  }

  publicView(u) {
    return {
      id: u.id,
      username: u.username,
      name: u.name,
      role: u.role,
      caps: roleCaps(u.role),
      disabled: !!u.disabled,
      createdAt: u.createdAt,
      lastLogin: u.lastLogin || null,
    };
  }

  byId(id) { return this.data.users.find((u) => u.id === id) || null; }
  byUsername(name) {
    const key = String(name || '').trim().toLowerCase();
    return this.data.users.find((u) => u.username.toLowerCase() === key) || null;
  }

  create({ username, name, role, password }) {
    const clean = String(username || '').trim();
    if (!/^[a-zA-Z0-9._-]{3,24}$/.test(clean)) {
      throw new Error('Username must be 3–24 letters, numbers, dot, dash or underscore.');
    }
    if (this.byUsername(clean)) throw new Error('That username is taken.');
    if (String(password || '').length < 4) throw new Error('Password must be at least 4 characters.');
    if (!ROLES[role]) throw new Error('Unknown role.');

    const { salt, hash } = Users.hash(password);
    const user = {
      id: crypto.randomUUID(),
      username: clean,
      name: String(name || clean).trim().slice(0, 40),
      role,
      salt,
      hash,
      disabled: false,
      createdAt: new Date().toISOString(),
      lastLogin: null,
    };
    this.data.users.push(user);
    this._save();
    return this.publicView(user);
  }

  update(id, patch, { actingAdmin } = {}) {
    const u = this.byId(id);
    if (!u) throw new Error('No such account.');

    if (patch.username !== undefined) {
      const clean = String(patch.username).trim();
      if (!/^[a-zA-Z0-9._-]{3,24}$/.test(clean)) {
        throw new Error('Username must be 3–24 letters, numbers, dot, dash or underscore.');
      }
      const taken = this.byUsername(clean);
      if (taken && taken.id !== id) throw new Error('That username is taken.');
      u.username = clean;
    }
    if (patch.name !== undefined) u.name = String(patch.name).trim().slice(0, 40) || u.username;

    if (patch.role !== undefined) {
      if (!ROLES[patch.role]) throw new Error('Unknown role.');
      if (u.role === 'admin' && patch.role !== 'admin' && this.adminCount() <= 1) {
        throw new Error('There has to be at least one admin.');
      }
      u.role = patch.role;
    }
    if (patch.disabled !== undefined) {
      if (u.role === 'admin' && patch.disabled && this.adminCount() <= 1) {
        throw new Error('You cannot disable the only admin.');
      }
      u.disabled = !!patch.disabled;
    }
    if (patch.password !== undefined) {
      if (String(patch.password).length < 4) throw new Error('Password must be at least 4 characters.');
      const { salt, hash } = Users.hash(patch.password);
      u.salt = salt;
      u.hash = hash;
      // An admin resetting someone's password boots that person's sessions.
      if (actingAdmin) u.tokenEpoch = (u.tokenEpoch || 0) + 1;
    }

    this._save();
    return this.publicView(u);
  }

  remove(id) {
    const u = this.byId(id);
    if (!u) throw new Error('No such account.');
    if (u.role === 'admin' && this.adminCount() <= 1) throw new Error('There has to be at least one admin.');
    this.data.users = this.data.users.filter((x) => x.id !== id);
    this._save();
  }

  adminCount() {
    return this.data.users.filter((u) => u.role === 'admin' && !u.disabled).length;
  }

  /** Returns the user on success, or null. */
  authenticate(username, password) {
    const u = this.byUsername(username);
    if (!u || u.disabled) return null;
    if (!Users.verifyPassword(password, u.salt, u.hash)) return null;
    u.lastLogin = new Date().toISOString();
    this._save();
    return u;
  }

  /* ---------------------------------------------------- sessions */

  sign(user, days = 30) {
    const payload = Buffer.from(JSON.stringify({
      uid: user.id,
      ep: user.tokenEpoch || 0,
      exp: Date.now() + days * 86400e3,
    })).toString('base64url');
    const mac = crypto.createHmac('sha256', this.data.secret).update(payload).digest('base64url');
    return `${payload}.${mac}`;
  }

  /** Verifies a cookie and returns the live user, or null. */
  fromToken(token) {
    const [payload, mac] = String(token || '').split('.');
    if (!payload || !mac) return null;

    const expected = crypto.createHmac('sha256', this.data.secret).update(payload).digest('base64url');
    const a = Buffer.from(mac);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

    let claim;
    try { claim = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); }
    catch { return null; }

    if (!claim || claim.exp < Date.now()) return null;
    const u = this.byId(claim.uid);
    if (!u || u.disabled) return null;
    if ((u.tokenEpoch || 0) !== (claim.ep || 0)) return null;   // password was reset
    return u;
  }
}

module.exports = { Users, ROLES, roleCaps };
