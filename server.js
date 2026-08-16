/* Free Fire Leaderboard — zero-dependency server
 * Serves the control panel, the OBS overlay, and a live SSE stream that pushes
 * every edit to all connected overlays instantly.
 *
 *   node server.js            -> http://localhost:8080
 *   node server.js --port 9000 --key mysecret
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { formatPlayerName } = require('./public/names.js');
const { Users, ROLES } = require('./lib/users.js');

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf('--' + name);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};

const PORT = parseInt(argOf('port', process.env.PORT || '8080'), 10);
const CONTROL_KEY = argOf('key', process.env.LB_KEY || '') || '';
const PUBLIC_DIR = path.join(__dirname, 'public');
// --data lets you keep separate boards (e.g. one file per tournament).
const DATA_FILE = path.resolve(__dirname, argOf('data', process.env.LB_DATA || 'data.json'));

/* ------------------------------------------------------------------ state */

const DEFAULT_STATE = {
  settings: {
    title: 'LEADERBOARD',
    subtitle: 'FREE FIRE MAX',
    maxRows: 10,
    columns: { team: false, avatar: false },
    visible: true,
    autoSort: true,
    accent: '#ffc400',
    theme: 'classic',         // classic | neon | crimson | ice
    scale: 1,
    speed: 1,                 // animation speed multiplier
    align: 'right',           // overlay corner: left | right | center
    cycle: { enabled: false, size: 5, seconds: 8 },
    showRankChange: true,
    numbersRoll: true,
    joinOpen: true,           // players may add themselves at /join
    joinUpper: false,         // force imported/joined names to UPPERCASE
    quickSteps: [100],        // amounts the control panel's +/- buttons add
    effects: null,            // custom show effects; null seeds the defaults
  },
  players: [],
  rev: 0,
};

const num = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : 0);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const MAX_PLAYERS = 200;

const EFFECT_STYLES = ['burst', 'slam', 'sweep', 'flash', 'ticker'];

/** Effects the board starts with — editable and deletable like any other. */
const DEFAULT_EFFECTS = [
  { id: 'booyah', label: 'Booyah', text: 'BOOYAH!', sub: '{top1}', color: '#ffc400', style: 'burst', seconds: 3 },
  { id: 'winner', label: 'Winner', text: '{top1}', sub: 'TAKES THE CROWN', color: '#ffc400', style: 'slam', seconds: 4 },
  { id: 'final', label: 'Final round', text: 'FINAL ROUND', sub: '', color: '#ff3b30', style: 'sweep', seconds: 3 },
];

function normalizeEffects(input) {
  const list = Array.isArray(input) ? input : DEFAULT_EFFECTS;
  const out = list.slice(0, 12).map((e, i) => ({
    id: typeof e?.id === 'string' && e.id ? e.id.slice(0, 40) : `fx${i}-${crypto.randomUUID().slice(0, 8)}`,
    label: String(e?.label ?? 'Effect').slice(0, 24) || 'Effect',
    text: String(e?.text ?? '').slice(0, 40),
    sub: String(e?.sub ?? '').slice(0, 60),
    color: /^#[0-9a-f]{3,8}$/i.test(String(e?.color)) ? e.color : '#ffc400',
    style: EFFECT_STYLES.includes(e?.style) ? e.style : 'burst',
    seconds: clamp(num(e?.seconds) || 3, 1, 15),
  }));
  return out.length ? out : DEFAULT_EFFECTS.map((e) => ({ ...e }));
}

let saveTimer = null;
let state = load();

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return normalize(raw);
  } catch {
    const seeded = normalize({
      ...DEFAULT_STATE,
      players: [
        { name: 'SRX  AXON', score: 9999 },
        { name: 'PLAYER_02', score: 8888 },
        { name: 'PLAYER_03', score: 7777 },
        { name: 'PLAYER_04', score: 6666 },
        { name: 'PLAYER_05', score: 5555 },
        { name: 'PLAYER_06', score: 4444 },
        { name: 'PLAYER_07', score: 3333 },
        { name: 'PLAYER_08', score: 2222 },
        { name: 'PLAYER_09', score: 1111 },
        { name: 'PLAYER_10', score: 0 },
      ],
    });
    save(seeded);
    return seeded;
  }
}

function normalize(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const settings = {
    ...DEFAULT_STATE.settings,
    ...(s.settings || {}),
    columns: { ...DEFAULT_STATE.settings.columns, ...((s.settings || {}).columns || {}) },
    cycle: { ...DEFAULT_STATE.settings.cycle, ...((s.settings || {}).cycle || {}) },
  };
  settings.maxRows = clamp(parseInt(settings.maxRows, 10) || 10, 1, 50);
  settings.quickSteps = (Array.isArray(settings.quickSteps) ? settings.quickSteps : [])
    .map((n) => clamp(num(n), 1, 1_000_000))
    .filter(Boolean)
    .slice(0, 4);
  if (!settings.quickSteps.length) settings.quickSteps = [100];
  settings.effects = normalizeEffects(settings.effects);
  settings.scale = clamp(Number(settings.scale) || 1, 0.4, 3);
  settings.speed = clamp(Number(settings.speed) || 1, 0.25, 4);

  const players = (Array.isArray(s.players) ? s.players : []).slice(0, MAX_PLAYERS).map((p, i) => ({
    id: typeof p.id === 'string' && p.id ? p.id : crypto.randomUUID(),
    name: String(p.name ?? `PLAYER_${i + 1}`).slice(0, 40),
    team: String(p.team ?? '').slice(0, 24),
    score: num(p.score),
    avatar: String(p.avatar ?? '').slice(0, 2048),
    highlight: !!p.highlight,
    eliminated: !!p.eliminated,
  }));

  return { settings, players, rev: num(s.rev) };
}

function save(next) {
  const data = next || state;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2), () => {});
  }, 120);
}

/* ------------------------------------------------- player self sign-up */

/** Per-IP throttle so one person can't spam the board from the join page.
 *  Deliberately loose: a whole lobby signing up over the same venue Wi-Fi
 *  shares one public IP, so this only has to stop a flood, not a crowd. */
const joinLog = new Map();   // ip -> [timestamps]
const JOIN_GAP_MS = 1500;          // stops double-taps on the button
const JOIN_WINDOW_MS = 60 * 60e3;  // rolling hour
const JOIN_MAX_PER_WINDOW = 80;

function clientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.socket.remoteAddress || 'unknown';
}

/** Returns { ok } or { error, code } — never throws. */
function joinPlayer(rawName, ip) {
  if (!state.settings.joinOpen) {
    return { code: 403, error: 'Sign-ups are closed right now.' };
  }
  const name = formatPlayerName(rawName, { upper: !!state.settings.joinUpper });
  if (!name) return { code: 400, error: 'Please enter your name.' };
  if (name.length > 40) return { code: 400, error: 'That name is too long.' };

  if (state.players.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
    return { code: 409, error: `${name} is already on the board.`, name };
  }
  if (state.players.length >= MAX_PLAYERS) {
    return { code: 409, error: 'The board is full.' };
  }

  const now = Date.now();
  const hits = (joinLog.get(ip) || []).filter((t) => now - t < JOIN_WINDOW_MS);
  if (hits.length && now - hits[hits.length - 1] < JOIN_GAP_MS) {
    return { code: 429, error: 'One moment — try again in a couple of seconds.' };
  }
  if (hits.length >= JOIN_MAX_PER_WINDOW) {
    return { code: 429, error: 'Too many sign-ups from this connection. Ask the host to add you.' };
  }
  hits.push(now);
  joinLog.set(ip, hits);
  if (joinLog.size > 5000) joinLog.clear();

  const player = {
    id: crypto.randomUUID(),
    name, team: '', score: 0, avatar: '', highlight: false, eliminated: false,
  };
  state.players.push(player);
  state.rev++;
  save();
  pushState();

  return { ok: true, name, position: state.players.length };
}

/** One-shot overlay effects ride along inside the state rather than as their own
 *  event, so they survive the polling fallback as well as the SSE path. */
let lastAction = { seq: 0, type: null, payload: null };

/** State as the overlay consumes it: ranked highest-score-first and trimmed. */
function projected() {
  const { settings, players } = state;
  const rows = players.map((p) => ({ ...p, total: p.score }));
  if (settings.autoSort) {
    rows.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  }
  rows.forEach((r, i) => (r.rank = i + 1));
  return { settings, players: rows, rev: state.rev, action: lastAction };
}

/* ------------------------------------------------------------------- SSE */

const clients = new Set();

function broadcast(event, payload) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) {
    try { res.write(frame); } catch { clients.delete(res); }
  }
}

const pushState = () => broadcast('state', projected());

setInterval(() => {
  for (const res of clients) { try { res.write(': ping\n\n'); } catch { clients.delete(res); } }
}, 20000).unref();

/* ---------------------------------------------------------------- helpers */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

/* ------------------------------------------------------------ accounts */

const COOKIE = 'lb_session';
const users = new Users(path.resolve(__dirname, argOf('users', process.env.LB_USERS || 'users.json')));

// First run: seed an admin. Its password is --key when given, otherwise random
// and printed once at startup.
const seeded = users.bootstrap(CONTROL_KEY);

function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** Constant-time compare for the legacy shared key. */
function legacyKeyOk(given) {
  if (!CONTROL_KEY || !given) return false;
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(CONTROL_KEY).digest();
  return crypto.timingSafeEqual(a, b);
}

/** Who is making this request? Returns a user-ish object or null.
 *  --key still works as an admin so deploy links and scripts keep running. */
function currentUser(req, url) {
  const session = cookies(req)[COOKIE];
  const viaCookie = users.fromToken(session);
  if (viaCookie) return viaCookie;

  const given = req.headers['x-lb-key'] || url.searchParams.get('key') || '';
  if (legacyKeyOk(given)) {
    return { id: 'legacy-key', username: 'admin', name: 'Admin (key)', role: 'admin' };
  }
  return null;
}

const capsOf = (user) => (user ? (ROLES[user.role] || ROLES.scorer).caps : []);
const can = (user, cap) => capsOf(user).includes(cap);

/** Anyone signed in may open the dashboard; what they see is role-dependent. */
function authorized(req, url) {
  return !!currentUser(req, url);
}

const isHttps = (req) =>
  String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';

function sessionCookie(req, token) {
  return [
    `${COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=' + 60 * 60 * 24 * 30,
    isHttps(req) ? 'Secure' : '',
  ].filter(Boolean).join('; ');
}

/** Apply only the parts of an update this role is allowed to change.
 *  The UI hides what you can't use; this is what actually enforces it. */
function mergeAllowed(body, user) {
  const nextSettings = { ...state.settings };
  const nextPlayers = can(user, 'players') && Array.isArray(body.players)
    ? body.players
    : state.players;

  const incoming = body.settings || {};

  if (can(user, 'board')) {
    Object.assign(nextSettings, incoming);
    // Effects are a show control, not a board setting.
    if (!can(user, 'effects')) nextSettings.effects = state.settings.effects;
  } else {
    if (can(user, 'effects')) {
      if ('effects' in incoming) nextSettings.effects = incoming.effects;
      if ('visible' in incoming) nextSettings.visible = incoming.visible;
    }
    // Scorers own the shortcut buttons they use all match.
    if (can(user, 'players') && 'quickSteps' in incoming) {
      nextSettings.quickSteps = incoming.quickSteps;
    }
  }

  return { settings: nextSettings, players: nextPlayers };
}

/** Slow down password guessing from a single address. */
const loginTries = new Map();   // ip -> [timestamps]
const LOGIN_WINDOW_MS = 10 * 60e3;
const LOGIN_MAX = 10;

function loginThrottled(ip) {
  const now = Date.now();
  const hits = (loginTries.get(ip) || []).filter((t) => now - t < LOGIN_WINDOW_MS);
  loginTries.set(ip, hits);
  if (loginTries.size > 5000) loginTries.clear();
  return hits.length >= LOGIN_MAX;
}
function noteLoginTry(ip) {
  const hits = loginTries.get(ip) || [];
  hits.push(Date.now());
  loginTries.set(ip, hits);
}

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'control.html' : decodeURIComponent(urlPath).replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403).end('forbidden'); return; }

  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('404 — not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  });
}

/* ---------------------------------------------------------------- routing */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,X-LB-Key',
    });
    return res.end();
  }

  // Live stream consumed by the overlay and by the control panel's preview.
  if (p === '/api/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': '*',
    });
    // Some proxies hold a response until their buffer fills; a padding comment
    // pushes the first real event straight through.
    res.write(':' + ' '.repeat(2048) + '\n\n');
    res.write('retry: 2000\n\n');
    res.write(`event: state\ndata: ${JSON.stringify(projected())}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (p === '/api/state' && req.method === 'GET') return sendJSON(res, 200, projected());

  // Everything the dashboard needs to boot — admin only.
  if (p === '/api/raw' && req.method === 'GET') {
    if (!authorized(req, url)) return sendJSON(res, 401, { error: 'not signed in' });
    return sendJSON(res, 200, { ...state, needsKey: !!CONTROL_KEY });
  }

  if (p === '/api/login' && req.method === 'POST') {
    const ip = clientIp(req);
    try {
      if (loginThrottled(ip)) {
        return sendJSON(res, 429, { error: 'Too many attempts. Wait a few minutes.' });
      }
      const body = await readBody(req, 4_000);
      const user = users.authenticate(body.username, body.password);
      if (!user) {
        noteLoginTry(ip);
        return sendJSON(res, 401, { error: 'Wrong username or password.' });
      }
      loginTries.delete(ip);
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Set-Cookie': sessionCookie(req, users.sign(user)),
        'Cache-Control': 'no-store',
      });
      return res.end(JSON.stringify({ ok: true, user: users.publicView(user) }));
    } catch (e) {
      return sendJSON(res, 400, { error: String(e.message || e) });
    }
  }

  if (p === '/api/logout' && req.method === 'POST') {
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
    });
    return res.end(JSON.stringify({ ok: true }));
  }

  /* ---- who am I, and what may I do ---- */

  if (p === '/api/me' && req.method === 'GET') {
    const me = currentUser(req, url);
    if (!me) return sendJSON(res, 401, { error: 'not signed in' });
    return sendJSON(res, 200, {
      user: { id: me.id, username: me.username, name: me.name, role: me.role },
      caps: capsOf(me),
      roles: ROLES,
    });
  }

  if (p === '/api/me/profile' && req.method === 'POST') {
    const me = currentUser(req, url);
    if (!me) return sendJSON(res, 401, { error: 'not signed in' });
    if (me.id === 'legacy-key') return sendJSON(res, 400, { error: 'Sign in with an account to edit a profile.' });
    try {
      const body = await readBody(req, 4_000);
      const updated = users.update(me.id, { name: body.name, username: body.username });
      return sendJSON(res, 200, { ok: true, user: updated });
    } catch (e) {
      return sendJSON(res, 400, { error: String(e.message || e) });
    }
  }

  if (p === '/api/me/password' && req.method === 'POST') {
    const me = currentUser(req, url);
    if (!me) return sendJSON(res, 401, { error: 'not signed in' });
    if (me.id === 'legacy-key') return sendJSON(res, 400, { error: 'Sign in with an account to change a password.' });
    try {
      const body = await readBody(req, 4_000);
      if (!Users.verifyPassword(body.current, me.salt, me.hash)) {
        return sendJSON(res, 401, { error: 'Your current password is wrong.' });
      }
      users.update(me.id, { password: body.next });
      // Re-issue so this browser stays signed in after the change.
      const fresh = users.byId(me.id);
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Set-Cookie': sessionCookie(req, users.sign(fresh)),
      });
      return res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      return sendJSON(res, 400, { error: String(e.message || e) });
    }
  }

  /* ---- account management, admins only ---- */

  if (p.startsWith('/api/users')) {
    const me = currentUser(req, url);
    if (!me) return sendJSON(res, 401, { error: 'not signed in' });
    if (!can(me, 'users')) return sendJSON(res, 403, { error: 'Admins only.' });

    try {
      if (p === '/api/users' && req.method === 'GET') {
        return sendJSON(res, 200, { users: users.list(), roles: ROLES });
      }
      if (p === '/api/users' && req.method === 'POST') {
        const body = await readBody(req, 4_000);
        return sendJSON(res, 200, { ok: true, user: users.create(body) });
      }
      if (p === '/api/users/update' && req.method === 'POST') {
        const body = await readBody(req, 4_000);
        if (body.id === me.id && body.role && body.role !== me.role) {
          return sendJSON(res, 400, { error: 'You cannot change your own role.' });
        }
        const { id, ...patch } = body;
        return sendJSON(res, 200, { ok: true, user: users.update(id, patch, { actingAdmin: true }) });
      }
      if (p === '/api/users/delete' && req.method === 'POST') {
        const body = await readBody(req, 4_000);
        if (body.id === me.id) return sendJSON(res, 400, { error: 'You cannot delete your own account.' });
        users.remove(body.id);
        return sendJSON(res, 200, { ok: true });
      }
    } catch (e) {
      return sendJSON(res, 400, { error: String(e.message || e) });
    }
    return sendJSON(res, 404, { error: 'unknown endpoint' });
  }

  if (p === '/api/state' && req.method === 'POST') {
    const me = currentUser(req, url);
    if (!me) return sendJSON(res, 401, { error: 'not signed in' });
    if (!can(me, 'players') && !can(me, 'board') && !can(me, 'effects')) {
      return sendJSON(res, 403, { error: 'Your role cannot change the board.' });
    }
    try {
      const body = await readBody(req);
      state = normalize({ ...state, ...mergeAllowed(body, me), rev: state.rev + 1 });
      save();
      pushState();
      return sendJSON(res, 200, { ok: true, rev: state.rev });
    } catch (e) {
      return sendJSON(res, 400, { error: String(e.message || e) });
    }
  }

  // Fire-and-forget overlay effects: booyah, flash a row, replay the intro.
  if (p === '/api/action' && req.method === 'POST') {
    const me = currentUser(req, url);
    if (!me) return sendJSON(res, 401, { error: 'not signed in' });
    if (!can(me, 'effects')) return sendJSON(res, 403, { error: 'Your role cannot run show effects.' });
    try {
      const body = await readBody(req, 20_000);
      lastAction = {
        seq: lastAction.seq + 1,
        type: String(body.type || ''),
        payload: body.payload ?? null,
      };
      state.rev++;
      pushState();
      return sendJSON(res, 200, { ok: true });
    } catch (e) {
      return sendJSON(res, 400, { error: String(e.message || e) });
    }
  }

  // Public: this is the endpoint the shareable /join page posts to. No key —
  // that is the point of it — but it is rate limited and can be switched off.
  if (p === '/api/join' && req.method === 'POST') {
    try {
      const body = await readBody(req, 4_000);
      const result = joinPlayer(body.name, clientIp(req));
      return sendJSON(res, result.ok ? 200 : result.code, result);
    } catch (e) {
      return sendJSON(res, 400, { error: String(e.message || e) });
    }
  }

  if (p === '/api/join/status') {
    return sendJSON(res, 200, {
      open: !!state.settings.joinOpen,
      count: state.players.length,
      title: state.settings.title,
      subtitle: state.settings.subtitle,
      theme: state.settings.theme,
      accent: state.settings.accent,
      upper: !!state.settings.joinUpper,
    });
  }

  // Pulls a Google Sheet (a Form's response sheet) server-side, which dodges
  // the CORS wall the browser would hit.
  if (p === '/api/import/sheet' && req.method === 'POST') {
    const me = currentUser(req, url);
    if (!me) return sendJSON(res, 401, { error: 'not signed in' });
    if (!can(me, 'players')) return sendJSON(res, 403, { error: 'Your role cannot import players.' });
    try {
      const body = await readBody(req, 4_000);
      const csv = await fetchSheetCsv(String(body.url || ''));
      return sendJSON(res, 200, { csv });
    } catch (e) {
      return sendJSON(res, 400, { error: String(e.message || e) });
    }
  }

  if (p === '/api/links') {
    return sendJSON(res, 200, { port: PORT, addresses: addresses(), needsKey: !!CONTROL_KEY });
  }

  if (p === '/overlay') return serveStatic(req, res, '/overlay.html');
  if (p === '/join') return serveStatic(req, res, '/join.html');

  // The dashboard itself is admin-only: without a valid key the sign-in page is
  // served instead, so the controls are never even delivered to the browser.
  if (p === '/' || p === '/control' || p === '/control.html') {
    if (!authorized(req, url)) return serveStatic(req, res, '/login.html');
    // A key in the URL becomes a session cookie so it can be dropped from the
    // address bar and doesn't linger in history or a screen share.
    const me = currentUser(req, url);
    if (me && me.id !== 'legacy-key' && url.searchParams.get('key')) {
      res.setHeader('Set-Cookie', sessionCookie(req, users.sign(me)));
    }
    return serveStatic(req, res, '/control.html');
  }

  // Dashboard-only assets stay behind the same gate.
  if (p === '/control.js' || p === '/control.css') {
    if (!authorized(req, url)) { res.writeHead(404).end('404 — not found'); return; }
  }

  return serveStatic(req, res, p);
});

/** Rewrite any Google Sheets link into its CSV export form. */
function toCsvUrl(input) {
  let u;
  try { u = new URL(input.trim()); }
  catch { throw new Error('That is not a valid link.'); }

  if (!/^docs\.google\.com$/.test(u.hostname)) {
    throw new Error('Only Google Sheets links are supported (docs.google.com).');
  }
  const gid = u.searchParams.get('gid') || (u.hash.match(/gid=(\d+)/) || [])[1] || '';

  // Already published to the web: /spreadsheets/d/e/2PACX-…/pubhtml
  const published = u.pathname.match(/\/spreadsheets\/d\/e\/([^/]+)\//);
  if (published) {
    return `https://docs.google.com/spreadsheets/d/e/${published[1]}/pub?output=csv` +
      (gid ? `&gid=${gid}` : '');
  }
  // Normal sheet: /spreadsheets/d/<id>/edit#gid=0
  const normal = u.pathname.match(/\/spreadsheets\/d\/([^/]+)/);
  if (normal) {
    return `https://docs.google.com/spreadsheets/d/${normal[1]}/export?format=csv` +
      (gid ? `&gid=${gid}` : '');
  }
  throw new Error('That does not look like a Google Sheets link.');
}

async function fetchSheetCsv(input) {
  const target = toCsvUrl(input);
  const resp = await fetch(target, { redirect: 'follow', signal: AbortSignal.timeout(12000) });
  if (!resp.ok) {
    throw new Error(`Google returned ${resp.status}. Is the sheet shared with "Anyone with the link"?`);
  }
  const text = (await resp.text()).slice(0, 2_000_000);
  // A sheet that isn't shared serves a sign-in page instead of CSV.
  if (/^\s*<(!doctype|html)/i.test(text)) {
    throw new Error('That sheet is private. In Sheets: Share → General access → Anyone with the link.');
  }
  return text;
}

/** Virtual adapters (VirtualBox, Docker, WSL, Hyper-V) hand out addresses that
 *  look local but are unreachable from a player's phone. Rank them last so the
 *  address we suggest first is the one on the real Wi-Fi. */
function addressRank(ip) {
  if (/^192\.168\.(56|57)\./.test(ip)) return 4;       // VirtualBox host-only, never reachable
  if (/^169\.254\./.test(ip)) return 5;                // link-local, no DHCP
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 3; // Docker/WSL — but also real VPNs
  if (/^192\.168\./.test(ip)) return 0;                // ordinary home Wi-Fi
  if (/^10\./.test(ip)) return 1;
  return 2;
}

function addresses() {
  const found = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) found.push(ni.address);
    }
  }
  found.sort((a, b) => addressRank(a) - addressRank(b));
  return ['localhost', ...found];
}

server.listen(PORT, '0.0.0.0', () => {
  const lan = addresses().filter((a) => a !== 'localhost');
  console.log('');
  console.log('  \x1b[33m╔══════════════════════════════════════════════╗\x1b[0m');
  console.log('  \x1b[33m║   FREE FIRE LEADERBOARD — server running     ║\x1b[0m');
  console.log('  \x1b[33m╚══════════════════════════════════════════════╝\x1b[0m');
  console.log('');
  console.log(`  Control panel : \x1b[36mhttp://localhost:${PORT}/\x1b[0m`);
  console.log(`  OBS overlay   : \x1b[32mhttp://localhost:${PORT}/overlay\x1b[0m`);
  console.log(`  Player sign-up: \x1b[35mhttp://localhost:${PORT}/join\x1b[0m`);
  if (lan.length) {
    console.log('');
    console.log('  Share on your network (other PC / phone / players):');
    for (const a of lan) {
      console.log(`    panel \x1b[36mhttp://${a}:${PORT}/\x1b[0m`);
      console.log(`    OBS   \x1b[32mhttp://${a}:${PORT}/overlay\x1b[0m`);
      console.log(`    join  \x1b[35mhttp://${a}:${PORT}/join\x1b[0m`);
    }
  }
  console.log('');
  console.log('  \x1b[32mThe dashboard needs a sign-in.\x1b[0m Accounts live in users.json.');
  if (seeded) {
    console.log('');
    console.log('  \x1b[33m┌─ first run — your admin account ─────────────┐\x1b[0m');
    console.log(`  \x1b[33m│\x1b[0m  username: \x1b[36m${seeded.username}\x1b[0m`);
    console.log(`  \x1b[33m│\x1b[0m  password: \x1b[36m${CONTROL_KEY || '(printed once above)'}\x1b[0m`);
    console.log('  \x1b[33m└──────────────────────────────────────────────┘\x1b[0m');
    console.log('  Change it under \x1b[36mProfile\x1b[0m once you are in.');
  } else {
    console.log(`  ${users.list().length} account(s). Sign in at the control panel.`);
  }
  console.log('\n  Press Ctrl+C to stop.\n');
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use. Try:  node server.js --port ${PORT + 1}\n`);
    process.exit(1);
  }
  throw e;
});
