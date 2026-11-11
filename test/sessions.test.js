// Sign-ins kept hashed and sliding (accounts.js, shared with Split it), and changing your email needing your password.
// Run with: node --test test/*.test.js
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
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-it-sessions-'));
const DATA = path.join(DIR, 'data');
let PORT, proc, env, addr = 0;

const freePort = () => new Promise(res => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const cli = (args, input = '') => { const r = spawnSync(process.execPath, [SERVER, ...args], { env, input, encoding: 'utf8' }); return (r.stdout || '') + (r.stderr || ''); };

// One browser: keeps its cookie, and arrives from its own address so wrong guesses in one test never lock out another.
function browser() {
  const from = `10.10.${++addr >> 8}.${addr & 255}`;
  let cookie = '';
  const call = async (method, url, body) => {
    const r = await fetch(`http://127.0.0.1:${PORT}${url}`, { method, redirect: 'manual',
      headers: { 'X-Forwarded-For': from, ...(cookie ? { Cookie: cookie } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const set = r.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    const text = await r.text(); let data = null; try { data = JSON.parse(text); } catch {}
    return { status: r.status, data, text, type: r.headers.get('content-type'), setCookie: r.headers.get('set-cookie') };
  };
  return { cookie: () => cookie, setCookie: c => { cookie = c; }, get: url => call('GET', url), post: (url, body) => call('POST', url, body === undefined ? {} : body) };
}
async function start() {
  proc = spawn(process.execPath, [SERVER], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((res, rej) => { let out = ''; const t = setTimeout(() => rej(new Error('server did not start: ' + out)), 15000);
    const on = d => { out += d; if (/running at/.test(out)) { clearTimeout(t); res(); } }; proc.stdout.on('data', on); proc.stderr.on('data', on); proc.on('exit', c => rej(new Error('server stopped early (' + c + '): ' + out))); });
}
async function stop() { if (proc && proc.exitCode === null) { const gone = new Promise(r => proc.on('exit', r)); proc.kill(); await gone; } }

const USERS = () => path.join(DATA, 'users.json');
const readUsers = () => JSON.parse(fs.readFileSync(USERS(), 'utf8'));
const sha = t => crypto.createHash('sha256').update(t).digest('hex');

before(async () => {
  PORT = await freePort();
  env = { ...process.env, DATA_DIR: DATA, PORT: String(PORT), HOST: '127.0.0.1', UPDATE_CHECK: 'off', RESEND_API_KEY: '', GOOGLE_CLIENT_ID: '', PUBLIC_URL: '',
    PLAID_CLIENT_ID: '', PLAID_SECRET: '', SPLIT_IT_URL: '', BACKUP_COPY_DIR: '', BACKUP_PASSPHRASE: '' };
  for (const n of ['Ana', 'Ben']) assert.match(cli(['add-user', n], n.toLowerCase() + '-password\n'), /Added/);
});
after(async () => { await stop(); fs.rmSync(DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

test('a users.json from before hashing still signs people in, and only hashes are kept', async () => {
  // an older Budget it kept the token itself as the key
  const u = readUsers(), ana = Object.entries(u.users).find(([, x]) => x.name === 'Ana')[0];
  const old = crypto.randomBytes(32).toString('hex');
  u.sessions = { [old]: { uid: ana, exp: Date.now() + 30 * 864e5 } }; delete u.sessionsHashed;
  fs.writeFileSync(USERS(), JSON.stringify(u));
  await start();
  const b = browser(); b.setCookie('bi=' + old);
  assert.equal((await b.get('/api/state')).data.me.name, 'Ana', 'still signed in after the upgrade');
  const now = readUsers();
  assert.equal(now.sessionsHashed, true); assert.ok(now.sessions[sha(old)]); assert.equal(now.sessions[old], undefined, 'the token itself is not on disk');
  // a fresh sign-in is stored hashed too, and signing out drops it
  const c = browser(); assert.equal((await c.post('/api/login', { name: 'Ben', password: 'ben-password' })).status, 200);
  const tok = c.cookie().split('=')[1];
  assert.ok(readUsers().sessions[sha(tok)]); assert.equal(readUsers().sessions[tok], undefined);
  await c.get('/api/logout');
  assert.equal(readUsers().sessions[sha(tok)], undefined);
  assert.equal((await b.get('/api/state')).status, 200, 'other sign-ins carry on');
  await stop();
});

test('a sign-in in use keeps going: once a day it runs another 90 days', async () => {
  const b = browser();
  await start();
  assert.equal((await b.post('/api/login', { name: 'Ana', password: 'ana-password' })).status, 200);
  const tok = b.cookie().split('=')[1];
  let r = await b.get('/api/state'); assert.equal(r.setCookie, null, 'not sent again the same day');
  await stop();
  // pretend it was signed in 80 days ago: 10 days left
  const u = readUsers(), s = u.sessions[sha(tok)]; s.at = s.slid = Date.now() - 80 * 864e5; s.exp = Date.now() + 10 * 864e5;
  fs.writeFileSync(USERS(), JSON.stringify(u));
  await start();
  r = await b.get('/api/state');
  assert.equal(r.status, 200); assert.match(r.setCookie || '', /^bi=[0-9a-f]{64}; .*Max-Age=7776000/, 'the cookie comes again with 90 days');
  const exp = readUsers().sessions[sha(tok)].exp;
  assert.ok(exp > Date.now() + 89 * 864e5, 'and the sign-in runs 90 days from now');
  // an expired one does not come back
  const v = readUsers(); v.sessions[sha(tok)].exp = Date.now() - 1000; fs.writeFileSync(USERS(), JSON.stringify(v));
  await stop(); await start();
  assert.equal((await b.get('/api/state')).status, 401);
  await stop();
});

test('changing your email needs your current password', async () => {
  await start();
  const b = browser(); await b.post('/api/login', { name: 'Ben', password: 'ben-password' });
  let r = await b.post('/api/account/email', { email: 'ben@example.com' });
  assert.equal(r.status, 403); assert.equal(r.data.need, 'password');
  r = await b.post('/api/account/email', { email: 'ben@example.com', current: 'not-it' });
  assert.equal(r.status, 401);
  r = await b.post('/api/account/email', { email: 'ben@example.com', current: 'ben-password' });
  assert.equal(r.status, 400, 'past the check (email just isn’t set up here)'); assert.match(r.data.error, /isn’t set up/);
  assert.equal((await b.post('/api/account/email', { email: '', current: 'ben-password' })).status, 200);
  await stop();
});
