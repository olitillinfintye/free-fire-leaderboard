/* Role enforcement tests. Spins up its own server on a spare port with
   throwaway data and account files, then checks that each role can do
   exactly what it should — and nothing more.

   The point is that the server rejects out-of-role changes even when the
   client sends them deliberately. Hiding buttons is not security.

   Run: node tools/test-roles.js
*/

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 8100 + Math.floor(Math.random() * 300);
const B = `http://localhost:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-roles-'));
const DATA = path.join(tmp, 'board.json');
const USERS = path.join(tmp, 'users.json');

let pass = 0;
let fail = 0;
function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n         expected ${e}\n         actual   ${a}`); }
}

fs.writeFileSync(DATA, JSON.stringify({
  settings: { title: 'LEADERBOARD', theme: 'classic', joinOpen: false },
  players: [{ name: 'Bino', score: 629 }, { name: 'Bobby', score: 900 }],
}));

const server = spawn(process.execPath, [
  path.join(__dirname, '..', 'server.js'),
  '--port', String(PORT), '--data', DATA, '--users', USERS, '--key', 'adminpass',
], { stdio: ['ignore', 'ignore', 'pipe'] });

let serverErr = '';
server.stderr.on('data', (d) => (serverErr += d));

const cleanup = () => {
  try { server.kill(); } catch {}
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
};
process.on('exit', cleanup);

/* ---- tiny cookie-aware client ---- */
function client() {
  let cookie = '';
  return {
    async call(method, p, body) {
      const res = await fetch(B + p, {
        method,
        headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      let data = null;
      try { data = await res.json(); } catch {}
      return { status: res.status, data };
    },
    get(p) { return this.call('GET', p); },
    post(p, b) { return this.call('POST', p, b); },
  };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let up = false;
  for (let i = 0; i < 60; i++) {
    try { await fetch(B + '/api/state'); up = true; break; } catch { await wait(150); }
  }
  if (!up) {
    console.error(`\n  Test server never came up on ${PORT}.\n${serverErr}\n`);
    cleanup();
    process.exit(1);
  }

  const admin = client();
  const scorer = client();
  const sup = client();
  const nobody = client();

  console.log('\nsign-in');
  eq((await admin.post('/api/login', { username: 'admin', password: 'adminpass' })).status, 200, 'admin signs in');
  eq((await admin.post('/api/login', { username: 'admin', password: 'nope' })).status, 401, 'wrong password refused');

  await admin.post('/api/users', { name: 'Bereket', username: 'bereket', password: 'score123', role: 'scorer' });
  await admin.post('/api/users', { name: 'Hanna', username: 'hanna', password: 'show123', role: 'supervisor' });
  eq((await scorer.post('/api/login', { username: 'bereket', password: 'score123' })).status, 200, 'scorer signs in');
  eq((await sup.post('/api/login', { username: 'hanna', password: 'show123' })).status, 200, 'supervisor signs in');

  console.log('\ncapabilities reported');
  eq((await admin.get('/api/me')).data.caps, ['players', 'effects', 'board', 'users'], 'admin sees everything');
  eq((await scorer.get('/api/me')).data.caps, ['players'], 'scorer: players only');
  eq((await sup.get('/api/me')).data.caps, ['effects'], 'supervisor: effects only');

  console.log('\nthe dashboard needs a session');
  eq((await nobody.get('/api/me')).status, 401, 'signed out gets 401 from /api/me');
  eq((await nobody.get('/api/raw')).status, 401, 'signed out cannot read the board settings');
  eq((await nobody.post('/api/state', { players: [] })).status, 401, 'signed out cannot write');

  console.log('\nshow effects');
  eq((await sup.post('/api/action', { type: 'replay' })).status, 200, 'supervisor may fire effects');
  eq((await admin.post('/api/action', { type: 'replay' })).status, 200, 'admin may fire effects');
  eq((await scorer.post('/api/action', { type: 'replay' })).status, 403, 'scorer may NOT fire effects');

  console.log('\nscorer sends a payload reaching outside its role');
  {
    const raw = (await scorer.get('/api/raw')).data;
    const settings = { ...raw.settings, title: 'HACKED', theme: 'neon', joinOpen: true,
      effects: [{ id: 'x', label: 'evil', text: 'X', color: '#ffffff', style: 'burst', seconds: 2 }] };
    const players = raw.players.map((p) => (p.name === 'Bino' ? { ...p, score: 8888 } : p));
    eq((await scorer.post('/api/state', { settings, players })).status, 200, 'request is accepted…');

    const now = (await nobody.get('/api/state')).data;
    eq(now.settings.title, 'LEADERBOARD', '…but the title change was dropped');
    eq(now.settings.theme, 'classic', '…theme dropped');
    eq(now.settings.joinOpen, false, '…sign-up toggle dropped');
    eq(now.settings.effects.map((e) => e.label), ['Booyah', 'Winner', 'Final round'], '…effects untouched');
    eq(now.players.find((p) => p.name === 'Bino').total, 8888, '…and the score DID change, which is its job');
  }

  console.log('\nsupervisor sends a payload reaching outside its role');
  {
    const raw = (await sup.get('/api/raw')).data;
    const players = raw.players
      .map((p) => (p.name === 'Bino' ? { ...p, score: 1 } : p))
      .concat([{ name: 'GHOST', score: 99999 }]);
    const settings = { ...raw.settings, title: 'ALSO HACKED', visible: false,
      effects: [{ id: 'ok', label: 'Halftime', text: 'HALFTIME', color: '#00e5ff', style: 'sweep', seconds: 3 }] };
    eq((await sup.post('/api/state', { settings, players })).status, 200, 'request is accepted…');

    const now = (await nobody.get('/api/state')).data;
    eq(now.players.find((p) => p.name === 'Bino').total, 8888, '…score change dropped');
    eq(now.players.some((p) => p.name === 'GHOST'), false, '…injected player dropped');
    eq(now.settings.title, 'LEADERBOARD', '…title dropped');
    eq(now.settings.effects.map((e) => e.label), ['Halftime'], '…effects DID change, which is its job');
    eq(now.settings.visible, false, '…and it may hide the overlay');
  }

  console.log('\naccount management is admin-only');
  eq((await scorer.get('/api/users')).status, 403, 'scorer cannot list accounts');
  eq((await sup.post('/api/users', { username: 'sneak', password: 'x1234', role: 'admin', name: 'S' })).status, 403,
     'supervisor cannot create an admin');
  eq((await admin.get('/api/users')).data.users.length, 3, 'admin sees all three accounts');

  console.log('\nguard rails on accounts');
  {
    const meAdmin = (await admin.get('/api/me')).data.user;
    eq((await admin.post('/api/users/update', { id: meAdmin.id, role: 'scorer' })).status, 400,
       'admin cannot demote themselves');
    eq((await admin.post('/api/users/delete', { id: meAdmin.id })).status, 400,
       'admin cannot delete themselves');
    const bereket = (await admin.get('/api/users')).data.users.find((u) => u.username === 'bereket');
    eq((await admin.post('/api/users/update', { id: bereket.id, username: 'admin' })).status, 400,
       'usernames stay unique');
  }

  console.log('\nprofile');
  {
    eq((await scorer.post('/api/me/password', { current: 'wrong', next: 'newpass' })).status, 401,
       'wrong current password is refused');
    eq((await scorer.post('/api/me/password', { current: 'score123', next: 'newpass1' })).status, 200,
       'own password change works');
    const again = client();
    eq((await again.post('/api/login', { username: 'bereket', password: 'newpass1' })).status, 200,
       'new password signs in');
    eq((await again.post('/api/login', { username: 'bereket', password: 'score123' })).status, 401,
       'old password no longer works');
    eq((await scorer.get('/api/me')).status, 200, 'the session that changed it stays signed in');
  }

  console.log('\nadmin resetting a password kicks that user out');
  {
    const hanna = (await admin.get('/api/users')).data.users.find((u) => u.username === 'hanna');
    eq((await admin.post('/api/users/update', { id: hanna.id, password: 'reset999' })).status, 200, 'admin resets it');
    eq((await sup.get('/api/me')).status, 401, "supervisor's old session is now invalid");
  }

  console.log('\ndisabled accounts');
  {
    const bereket = (await admin.get('/api/users')).data.users.find((u) => u.username === 'bereket');
    await admin.post('/api/users/update', { id: bereket.id, disabled: true });
    const tryIt = client();
    eq((await tryIt.post('/api/login', { username: 'bereket', password: 'newpass1' })).status, 401,
       'a disabled account cannot sign in');
  }

  console.log('\npublic surface is untouched by all this');
  eq((await nobody.get('/api/state')).status, 200, 'the overlay can still read the board');
  eq((await fetch(B + '/overlay')).status, 200, 'overlay page is public');
  eq((await fetch(B + '/join')).status, 200, 'sign-up page is public');
  eq((await fetch(B + '/control.js')).status, 404, 'dashboard script is not served to strangers');

  console.log(`\n${pass} passed, ${fail} failed\n`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); cleanup(); process.exit(1); });
