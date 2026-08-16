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

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf('--' + name);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};

const PORT = parseInt(argOf('port', process.env.PORT || '8080'), 10);
const CONTROL_KEY = argOf('key', process.env.LB_KEY || '') || '';
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_FILE = path.join(__dirname, 'data.json');

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
  },
  players: [],
  rev: 0,
};

const num = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : 0);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

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
  settings.scale = clamp(Number(settings.scale) || 1, 0.4, 3);
  settings.speed = clamp(Number(settings.speed) || 1, 0.25, 4);

  const players = (Array.isArray(s.players) ? s.players : []).slice(0, 200).map((p, i) => ({
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

/** State as the overlay consumes it: ranked highest-score-first and trimmed. */
function projected() {
  const { settings, players } = state;
  const rows = players.map((p) => ({ ...p, total: p.score }));
  if (settings.autoSort) {
    rows.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  }
  rows.forEach((r, i) => (r.rank = i + 1));
  return { settings, players: rows, rev: state.rev };
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

/** Writes are gated only when the server was started with --key. */
function authorized(req, url) {
  if (!CONTROL_KEY) return true;
  const given = req.headers['x-lb-key'] || url.searchParams.get('key') || '';
  return given === CONTROL_KEY;
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
    res.write('retry: 2000\n\n');
    res.write(`event: state\ndata: ${JSON.stringify(projected())}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (p === '/api/state' && req.method === 'GET') return sendJSON(res, 200, projected());

  if (p === '/api/raw' && req.method === 'GET') {
    return sendJSON(res, 200, { ...state, needsKey: !!CONTROL_KEY });
  }

  if (p === '/api/state' && req.method === 'POST') {
    if (!authorized(req, url)) return sendJSON(res, 401, { error: 'bad key' });
    try {
      const body = await readBody(req);
      state = normalize({ ...state, ...body, rev: state.rev + 1 });
      save();
      pushState();
      return sendJSON(res, 200, { ok: true, rev: state.rev });
    } catch (e) {
      return sendJSON(res, 400, { error: String(e.message || e) });
    }
  }

  // Fire-and-forget overlay effects: booyah, flash a row, replay the intro.
  if (p === '/api/action' && req.method === 'POST') {
    if (!authorized(req, url)) return sendJSON(res, 401, { error: 'bad key' });
    try {
      const body = await readBody(req, 20_000);
      broadcast('action', { type: String(body.type || ''), payload: body.payload ?? null });
      return sendJSON(res, 200, { ok: true });
    } catch (e) {
      return sendJSON(res, 400, { error: String(e.message || e) });
    }
  }

  if (p === '/api/links') {
    return sendJSON(res, 200, { port: PORT, addresses: addresses(), needsKey: !!CONTROL_KEY });
  }

  if (p === '/overlay') return serveStatic(req, res, '/overlay.html');
  if (p === '/control') return serveStatic(req, res, '/control.html');

  return serveStatic(req, res, p);
});

function addresses() {
  const out = ['localhost'];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
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
  if (lan.length) {
    console.log('');
    console.log('  Share on your network (other PC / phone / OBS remote):');
    for (const a of lan) console.log(`    \x1b[36mhttp://${a}:${PORT}/\x1b[0m  •  overlay: \x1b[32mhttp://${a}:${PORT}/overlay\x1b[0m`);
  }
  if (CONTROL_KEY) console.log(`\n  Control key required: append ?key=${CONTROL_KEY} to the control panel URL`);
  console.log('\n  Press Ctrl+C to stop.\n');
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use. Try:  node server.js --port ${PORT + 1}\n`);
    process.exit(1);
  }
  throw e;
});
