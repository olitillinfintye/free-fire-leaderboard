/* ============================================================
   One command to put the leaderboard on the public internet.

     node tools/deploy.js            (or double-click deploy.bat)

   Starts the server with a control key, opens a Cloudflare quick
   tunnel in front of it, and prints the three links you need.
   Ctrl+C stops both.

   The tunnel is free and needs no account, but the address is
   temporary: it changes every time this is restarted. For a
   permanent address, deploy to Render — see the README.
   ============================================================ */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const KEY_FILE = path.join(ROOT, '.lbkey');
const PORT = process.env.PORT || '8080';

const c = {
  gold: (s) => `\x1b[33m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  pink: (s) => `\x1b[35m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};

/** Reuse the saved key so your control-panel bookmark keeps working. */
function controlKey() {
  try {
    const saved = fs.readFileSync(KEY_FILE, 'utf8').trim();
    if (saved) return saved;
  } catch { /* first run */ }
  const key = crypto.randomBytes(9).toString('base64url');
  fs.writeFileSync(KEY_FILE, key + '\n');
  return key;
}

const KEY = controlKey();
const IS_WIN = process.platform === 'win32';
const children = [];

function stopAll() {
  for (const ch of children) {
    try {
      // On Windows the tunnel runs under a shell, so killing the child leaves
      // cloudflared orphaned — take the whole tree down.
      if (IS_WIN && ch.pid) {
        spawn('taskkill', ['/pid', String(ch.pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        ch.kill();
      }
    } catch { /* already gone */ }
  }
}
process.on('SIGINT', () => { console.log('\n  Shutting down…\n'); stopAll(); process.exit(0); });
process.on('exit', stopAll);

/* ---- 1. the server ---- */

console.log(`\n  ${c.gold('Starting the leaderboard…')}\n`);

const server = spawn(process.execPath, [path.join(ROOT, 'server.js'), '--key', KEY, '--port', PORT], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
});
children.push(server);

server.stderr.on('data', (d) => process.stderr.write(d));
server.on('exit', (code) => {
  if (code) {
    console.error(`\n  Server stopped (exit ${code}). Is port ${PORT} already in use?\n`);
    stopAll();
    process.exit(1);
  }
});

/* ---- 2. the tunnel ---- */

console.log(`  ${c.dim('Opening a public tunnel (first run downloads cloudflared)…')}\n`);

// Node refuses to spawn .cmd shims directly, so npx goes through a shell.
const tunnel = spawn(
  `npx --yes cloudflared tunnel --url http://localhost:${PORT}`,
  { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], shell: true }
);
children.push(tunnel);

let announced = false;

function watch(chunk) {
  const text = chunk.toString();
  const found = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
  if (found && !announced) {
    announced = true;
    announce(found[0]);
  }
}
tunnel.stdout.on('data', watch);
tunnel.stderr.on('data', watch);   // cloudflared logs to stderr

tunnel.on('exit', () => {
  if (!announced) {
    console.error('\n  Could not open the tunnel. The board still works locally at ' +
      `http://localhost:${PORT}/\n`);
  }
});

function announce(url) {
  const line = '─'.repeat(58);
  fs.writeFileSync(path.join(ROOT, 'public-url.txt'),
    `overlay: ${url}/overlay\njoin:    ${url}/join\ncontrol: ${url}/?key=${KEY}\n`);

  console.log(`  ${c.gold(line)}`);
  console.log(`  ${c.gold('  YOUR LEADERBOARD IS LIVE')}`);
  console.log(`  ${c.gold(line)}\n`);
  console.log(`  ${c.green('OBS overlay')}   ${c.green(url + '/overlay')}`);
  console.log(`  ${c.dim('                 paste into a Browser source, 1920x1080')}\n`);
  console.log(`  ${c.pink('Player sign-up')} ${c.pink(url + '/join')}`);
  console.log(`  ${c.dim('                 share this with your players')}\n`);
  console.log(`  ${c.cyan('Your controls')}  ${c.cyan(`${url}/?key=${KEY}`)}`);
  console.log(`  ${c.dim('                 keep this one to yourself')}\n`);
  console.log(`  ${c.dim('Saved to public-url.txt · this address changes on restart')}`);
  console.log(`  ${c.dim('Press Ctrl+C to stop.')}\n`);
}

setTimeout(() => {
  if (!announced) console.log(`  ${c.dim('Still waiting on the tunnel… (this can take ~30s)')}\n`);
}, 20000);
