// Finding people already on Budget it (accounts.js, shared with Split it): unique @tags, find by exact tag or
// checked email, friend requests, the friend link, and open invite links you can cancel. Friends come first
// in the list you share an account with. Run with: node --test test/*.test.js
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const SERVER = path.join(__dirname, '..', 'server.js');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-it-friends-'));
const DATA = path.join(DIR, 'data');
let PORT, proc, env, addr = 0;

const freePort = () => new Promise(res => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const cli = (args, input = '') => { const r = spawnSync(process.execPath, [SERVER, ...args], { env, input, encoding: 'utf8' }); return (r.stdout || '') + (r.stderr || ''); };

// One browser: keeps its cookie, and arrives from its own address so wrong guesses in one test never lock out another.
function browser() {
  const from = `10.9.${++addr >> 8}.${addr & 255}`;
  let cookie = '';
  const call = async (method, url, body) => {
    const r = await fetch(`http://127.0.0.1:${PORT}${url}`, { method, redirect: 'manual',
      headers: { 'X-Forwarded-For': from, ...(cookie ? { Cookie: cookie } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const set = r.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    const text = await r.text(); let data = null; try { data = JSON.parse(text); } catch {}
    return { status: r.status, data, text, type: r.headers.get('content-type') };
  };
  return { get: url => call('GET', url), post: (url, body) => call('POST', url, body === undefined ? {} : body) };
}
async function as(name) {
  const b = browser(); const r = await b.post('/api/login', { name, password: name.toLowerCase() + '-password' });
  assert.equal(r.status, 200, `${name} signs in: ${JSON.stringify(r.data)}`);
  b.uid = (await b.get('/api/state')).data.me.id; return b;
}
const peopleOf = async b => (await b.get('/api/state')).data.people;
const friendsWith = async (a, b) => (await peopleOf(a)).find(p => p.id === b.uid)?.friend === true;
async function start() {
  proc = spawn(process.execPath, [SERVER], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((res, rej) => { let out = ''; const t = setTimeout(() => rej(new Error('server did not start: ' + out)), 15000);
    const on = d => { out += d; if (/running at/.test(out)) { clearTimeout(t); res(); } }; proc.stdout.on('data', on); proc.stderr.on('data', on); proc.on('exit', c => rej(new Error('server stopped early (' + c + '): ' + out))); });
}
async function stop() { if (proc && proc.exitCode === null) { const gone = new Promise(r => proc.on('exit', r)); proc.kill(); await gone; } }

let ana, ben, cai;
before(async () => {
  PORT = await freePort();
  env = { ...process.env, DATA_DIR: DATA, PORT: String(PORT), HOST: '127.0.0.1', UPDATE_CHECK: 'off', RESEND_API_KEY: '', GOOGLE_CLIENT_ID: '', PUBLIC_URL: '',
    PLAID_CLIENT_ID: '', PLAID_SECRET: '', SPLIT_IT_URL: '', BACKUP_COPY_DIR: '', BACKUP_PASSPHRASE: '' };
  for (const n of ['Ana', 'Ben', 'Cai']) assert.match(cli(['add-user', n], n.toLowerCase() + '-password\n'), /Added/);
  // Cai checked her email at some point (that needs Resend, so it's written in directly here)
  const f = path.join(DATA, 'users.json'), u = JSON.parse(fs.readFileSync(f, 'utf8'));
  const c = Object.values(u.users).find(x => x.name === 'Cai'); c.email = 'cai@example.com'; c.emailVerified = true;
  const b = Object.values(u.users).find(x => x.name === 'Ben'); b.email = 'ben@example.com';   // added, never checked
  fs.writeFileSync(f, JSON.stringify(u));
  await start();
  ana = await as('Ana'); ben = await as('Ben'); cai = await as('Cai');
});
after(async () => { await stop(); fs.rmSync(DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

test('everyone gets a unique @tag, changeable, and finding is exact', async () => {
  const tags = await Promise.all([ana, ben, cai].map(async b => (await b.get('/api/account')).data.tag));
  assert.deepEqual(tags, ['ana', 'ben', 'cai'], 'picked from their names');
  assert.equal((await ben.post('/api/account/tag', { tag: '@Ana' })).status, 409, 'taken');
  assert.equal((await ben.post('/api/account/tag', { tag: 'b!' })).status, 400);
  assert.equal((await ben.post('/api/account/tag', { tag: '@Ben_K' })).data.tag, 'ben_k');
  assert.equal((await ben.get('/api/account')).data.tag, 'ben_k');
  assert.equal((await ana.post('/api/people/find', { q: '@ben_k' })).data.uid, ben.uid);
  assert.equal((await ana.post('/api/people/find', { q: 'BEN_K' })).data.name, 'Ben');
  assert.equal((await ana.post('/api/people/find', { q: '@ben' })).status, 404, 'the old tag stops working');
  assert.equal((await ana.post('/api/people/find', { q: 'be' })).status, 404, 'no partial matches');
  assert.equal((await ana.post('/api/people/find', { q: 'cai@example.com' })).data.uid, cai.uid, 'a checked email finds them');
  assert.equal((await ana.post('/api/people/find', { q: 'ben@example.com' })).status, 404, 'an unchecked email finds nobody');
  assert.equal((await ana.post('/api/people/find', { q: '@ana' })).status, 400, 'that’s you');
  // someone added from the command line while the app runs gets a tag too, without clashing
  assert.match(cli(['add-user', 'Ana'], 'x\n'), /already exists/);
  assert.match(cli(['add-user', 'Ana B'], 'anab-password\n'), /Added/);
  assert.equal((await ana.post('/api/people/find', { q: '@anab' })).data.name, 'Ana B');
});

test('a friend request needs a yes, and friends come first in the share list', async () => {
  assert.equal(await friendsWith(cai, ben), false);
  assert.equal((await cai.post('/api/friends/request', { to: ben.uid })).data.asked, true);
  assert.equal((await cai.post('/api/friends/request', { to: ben.uid })).data.asked, true, 'asking twice is the same request');
  assert.equal((await cai.post('/api/friends/request', { to: cai.uid })).status, 400);
  const inc = (await ben.get('/api/friends/requests')).data.incoming;
  assert.equal(inc.length, 1); assert.equal(inc[0].uid, cai.uid); assert.equal(inc[0].tag, 'cai');
  assert.equal((await cai.get('/api/friends/requests')).data.outgoing[0].uid, ben.uid);
  assert.equal(await friendsWith(cai, ben), false, 'not friends yet');
  assert.equal((await ana.post('/api/friends/answer', { id: inc[0].id, yes: true })).status, 404, 'only the two of them can answer');
  assert.equal((await ben.post('/api/friends/answer', { id: inc[0].id, yes: true })).status, 200);
  assert.equal(await friendsWith(cai, ben), true); assert.equal(await friendsWith(ben, cai), true);
  assert.equal((await ben.get('/api/friends/requests')).data.incoming.length, 0);
  const list = await peopleOf(cai);
  assert.equal(list[0].id, ben.uid, 'Ben (a friend) comes first'); assert.ok(list.some(p => p.id === ana.uid), 'everyone here is still listed');
  assert.equal((await cai.post('/api/people/find', { q: '@ben_k' })).data.friend, true);
});

test('declining or taking back a request makes nobody friends; asking back says yes', async () => {
  await ana.post('/api/friends/request', { to: cai.uid });
  let r = (await cai.get('/api/friends/requests')).data.incoming.find(x => x.uid === ana.uid);
  assert.equal((await cai.post('/api/friends/answer', { id: r.id, yes: false })).status, 200);
  assert.equal(await friendsWith(ana, cai), false);
  await ana.post('/api/friends/request', { to: cai.uid });
  r = (await ana.get('/api/friends/requests')).data.outgoing.find(x => x.uid === cai.uid);
  assert.equal((await ana.post('/api/friends/answer', { id: r.id, yes: true })).status, 200, 'the sender takes it back');
  assert.equal(await friendsWith(ana, cai), false, 'taking it back never makes friends');
  assert.equal((await cai.get('/api/friends/requests')).data.incoming.length, 0);
  await ana.post('/api/friends/request', { to: cai.uid });
  assert.equal((await cai.post('/api/friends/request', { to: ana.uid })).data.friends, true, 'they asked you already: that’s a yes');
  assert.equal(await friendsWith(ana, cai), true);
});

test('a friend link adds you both right away, and a new link turns off the old one', async () => {
  const d = (await ben.post('/api/friends/link')).data, token = d.url.split('#add=')[1];
  assert.equal(d.tag, 'ben_k'); assert.ok(token && token.length >= 10);
  assert.equal((await ben.post('/api/friends/link')).data.url, d.url, 'the same link until you make a new one');
  assert.equal((await ana.post('/api/friends/link/use', { token: 'nope' + token })).status, 404);
  assert.equal((await ben.post('/api/friends/link/use', { token })).status, 400, 'your own link');
  assert.equal((await ana.post('/api/friends/link/use', { token })).data.uid, ben.uid);
  assert.equal(await friendsWith(ana, ben), true); assert.equal(await friendsWith(ben, ana), true);
  const fresh = (await ben.post('/api/friends/link', { fresh: true })).data.url.split('#add=')[1];
  assert.notEqual(fresh, token);
  assert.equal((await cai.post('/api/friends/link/use', { token })).status, 404, 'the old link stops working');
  assert.equal((await cai.post('/api/friends/link/use', { token: fresh })).status, 200);
  assert.equal((await browser().post('/api/friends/link/use', { token: fresh })).status, 401, 'signed-in people only');
});

test('open invite links are listed and can be cancelled; using one makes you friends', async () => {
  const t1 = (await cai.post('/api/invite')).data.token, t2 = (await cai.post('/api/invite')).data.token;
  let list = (await cai.get('/api/invites')).data.list;
  assert.equal(list.length, 2); assert.ok(list.every(i => /^[0-9a-f]{16}$/.test(i.id) && !JSON.stringify(i).includes(t1)), 'the list never shows the link itself');
  assert.equal((await ana.get('/api/invites')).data.list.length, 0, 'you only see your own');
  const idOf = t => crypto.createHash('sha256').update(t).digest('hex').slice(0, 16);
  assert.deepEqual(list.map(i => i.id).sort(), [idOf(t1), idOf(t2)].sort());
  assert.equal((await ana.post('/api/invites/cancel', { id: idOf(t2) })).status, 404, 'not Ana’s to cancel');
  const join = browser();
  assert.equal((await join.post('/api/join', { token: t2 })).data.from, 'Cai');
  assert.equal((await cai.post('/api/invites/cancel', { id: idOf(t2) })).status, 200);
  assert.equal((await cai.post('/api/invites/cancel', { id: idOf(t2) })).status, 404, 'already gone');
  assert.equal((await join.post('/api/join', { token: t2 })).status, 410, 'a cancelled link stops working');
  assert.deepEqual((await cai.get('/api/invites')).data.list.map(i => i.id), [idOf(t1)]);
  // the other one: Dee joins with it, is friends with Cai right away, and has a tag
  assert.equal((await join.post('/api/join', { token: t1, name: 'Dee', password: 'dee-password' })).status, 200);
  const dee = await as('Dee');
  assert.equal((await dee.get('/api/account')).data.tag, 'dee');
  assert.equal(await friendsWith(dee, cai), true); assert.equal((await peopleOf(dee))[0].id, cai.uid);
  assert.equal((await cai.get('/api/invites')).data.list.length, 0, 'a used link drops off the list');
});

test('friends survive a restart; removing someone clears their friendships and requests', async () => {
  await stop(); await start();
  ana = await as('Ana'); ben = await as('Ben'); cai = await as('Cai');
  assert.equal(await friendsWith(ana, ben), true, 'saved with the budgets');
  assert.equal((await ana.post('/api/people/find', { q: '@ben_k' })).data.uid, ben.uid, 'tags are saved too');
  await ben.post('/api/friends/request', { to: (await ana.post('/api/people/find', { q: '@anab' })).data.uid });
  assert.match(cli(['remove-user', 'Ben'], 'yes\n'), /Removed|removed/);
  assert.equal((await peopleOf(ana)).some(p => p.id === ben.uid), false);
  await new Promise(ok => setTimeout(ok, 700));   // the budgets file is written a moment later
  const db = JSON.parse(fs.readFileSync(path.join(DATA, 'db.json'), 'utf8'));
  assert.ok(db.friends, 'friends are kept with the budgets'); assert.equal(Object.keys(db.friends).some(k => k.includes(ben.uid)), false, 'no friend entries left for Ben');
  const u = JSON.parse(fs.readFileSync(path.join(DATA, 'users.json'), 'utf8'));
  assert.equal(Object.values(u.friendReqs || {}).some(r => r.from === ben.uid || r.to === ben.uid), false);
});

test('the QR code maker is served, and cached for the app', async () => {
  const r = await browser().get('/qr.js');
  assert.equal(r.status, 200); assert.match(r.type, /javascript/); assert.match(r.text, /qrSvg/);
  const { qrSvg, qrMatrix } = require('../public/qr.js');
  assert.match(qrSvg('https://budget.example.test/#add=abcdefghijklmnopqrst'), /^<svg[\s\S]*<\/svg>$/);
  assert.equal(qrMatrix('hello').length, 21, 'a short link fits a version 1 code');
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8'), /'\/qr\.js'/);
});
