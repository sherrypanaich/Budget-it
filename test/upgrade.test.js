// Upgrading from Budget it 1.0.0: its data folder and backup (test/fixtures/v1.0.0, made by running 1.0.0 itself,
// see test/fixtures/make-v1.0.0.js) open in this version with nobody signed out and nothing lost.
// Run with: node --test test/*.test.js
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const SERVER = path.join(__dirname, '..', 'server.js');
const FIX = path.join(__dirname, 'fixtures', 'v1.0.0');
const OLD = JSON.parse(fs.readFileSync(path.join(FIX, 'made-up-sign-ins.json'), 'utf8'));
const OLD_DB = JSON.parse(fs.readFileSync(path.join(FIX, 'data', 'db.json'), 'utf8'));
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-it-upgrade-'));
const DATA = path.join(DIR, 'data');
const DAY = 864e5;
process.env.DATA_DIR = path.join(DIR, 'here');   // for require('../server.js') in this process: never the repo's own data folder
let PORT, proc, env;

const freePort = () => new Promise(res => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const cli = (args, input = '') => { const r = spawnSync(process.execPath, [SERVER, ...args], { env, input, encoding: 'utf8', cwd: DIR }); return (r.stdout || '') + (r.stderr || ''); };
async function start() {
  proc = spawn(process.execPath, [SERVER], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((res, rej) => { let out = ''; const t = setTimeout(() => rej(new Error('server did not start: ' + out)), 15000);
    const on = d => { out += d; if (/running at/.test(out)) { clearTimeout(t); res(); } }; proc.stdout.on('data', on); proc.stderr.on('data', on); proc.on('exit', c => rej(new Error('server stopped early (' + c + '): ' + out))); });
}
async function stop() { if (proc && proc.exitCode === null) { const gone = new Promise(r => proc.on('exit', r)); proc.kill(); await gone; } }
const call = async (method, url, { cookie, body, headers = {} } = {}) => {
  const r = await fetch(`http://127.0.0.1:${PORT}${url}`, { method, redirect: 'manual',
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body !== undefined ? { 'Content-Type': typeof body === 'string' ? 'application/x-www-form-urlencoded' : 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  const text = await r.text(); let data = null; try { data = JSON.parse(text); } catch {}
  return { status: r.status, data, text };
};
const state = cookie => call('GET', '/api/state', { cookie });
const ping = token => call('POST', '/mcp', { body: { jsonrpc: '2.0', id: 1, method: 'tools/list' }, headers: { Authorization: 'Bearer ' + token, Accept: 'application/json, text/event-stream' } });
const readJson = f => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));
const OLD_USERS = JSON.parse(fs.readFileSync(path.join(FIX, 'data', 'users.json'), 'utf8')).users;
const uidOf = name => Object.keys(OLD_USERS).find(id => OLD_USERS[id].name === name);

// The fixture was made on one day; move its clocks so it reads as an install that's been running a while.
// The assistant key is 120 days old: 1.0 never noted when a key was used, so it mustn't count as idle.
function ageCopy(dir) {
  const u = JSON.parse(fs.readFileSync(path.join(dir, 'users.json'), 'utf8'));
  for (const s of Object.values(u.sessions)) s.exp = Date.now() + 60 * DAY;
  for (const v of Object.values(u.invites || {})) { v.at = Date.now() - DAY; v.exp = Date.now() + 6 * DAY; }
  fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify(u));
  const o = JSON.parse(fs.readFileSync(path.join(dir, 'oauth.json'), 'utf8'));
  for (const t of Object.values(o.tokens)) {
    if (t.kind === 'key') t.at = Date.now() - 120 * DAY;
    else { t.at = Date.now() - 2 * DAY; t.exp = Date.now() + (t.kind === 'access' ? 28 : 300) * DAY; }
  }
  for (const c of Object.values(o.clients)) c.at = Date.now() - 2 * DAY;
  fs.writeFileSync(path.join(dir, 'oauth.json'), JSON.stringify(o));
}

before(async () => {
  PORT = await freePort();
  env = { ...process.env, DATA_DIR: DATA, PORT: String(PORT), HOST: '127.0.0.1', UPDATE_CHECK: 'off', RESEND_API_KEY: '', GOOGLE_CLIENT_ID: '', PUBLIC_URL: '',
    PLAID_CLIENT_ID: '', PLAID_SECRET: '', SPLIT_IT_URL: '', BACKUP_COPY_DIR: '', BACKUP_PASSPHRASE: '', TZ: 'UTC' };
  fs.cpSync(path.join(FIX, 'data'), DATA, { recursive: true });
  ageCopy(DATA);
  await start();
});
after(async () => { await stop(); fs.rmSync(DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

test('everyone signed in on 1.0 is still signed in, and only hashed sign-ins are kept', async () => {
  for (const name of ['Ana', 'Ben']) {
    const r = await state(OLD.cookies[name]);
    assert.equal(r.status, 200, name + ' was signed out by the upgrade');
    assert.equal(r.data.me.name, name);
  }
  const u = readJson('users.json'), raw = OLD.cookies.Ana.split('=')[1];
  assert.equal(u.sessionsHashed, true);
  assert.ok(!Object.hasOwn(u.sessions, raw), 'the sign-in token itself is still on disk');
  assert.equal(Object.keys(u.sessions).length, 2);
  // passwords from 1.0 still work, and the invite link Ana made is still there
  assert.equal((await call('POST', '/api/login', { body: { name: 'Ben', password: OLD.passwords.Ben } })).status, 200);
  assert.ok(Object.hasOwn(u.invites, OLD.invite));
});

test('1.0’s “shared with the household” becomes the people who were here, and nothing is lost', async () => {
  const ana = uidOf('Ana'), ben = uidOf('Ben');
  const db = readJson('db.json');
  const shared = db.people[ana].accounts.filter(a => a.shared && a.shared.length).map(a => a.name).sort();
  assert.deepEqual(shared, ['Cash box', 'Everyday Chequing']);
  for (const a of db.people[ana].accounts) assert.ok(a.shared === false || a.shared.length === 0 || (a.shared.length === 1 && a.shared[0] === ben), a.name);
  // Ben still sees exactly those two, view only
  const b = (await state(OLD.cookies.Ben)).data.state;
  assert.deepEqual(b.accounts.filter(a => a.other).map(a => a.name).sort(), ['Cash box', 'Everyday Chequing']);
  assert.ok(b.txns.some(t => t.m === 'Coffee beans' && t.a === -12.5));
  // every transaction, budget and goal from 1.0 is still there
  for (const [uid, old] of Object.entries(OLD_DB.people)) {
    assert.deepEqual(db.people[uid].txns.map(t => t.id).sort(), old.txns.map(t => t.id).sort());
    assert.deepEqual(db.people[uid].budgets, old.budgets);
    assert.deepEqual((db.people[uid].goals || []).map(g => g.id), (old.goals || []).map(g => g.id));
  }
  const a = (await state(OLD.cookies.Ana)).data.state;
  assert.equal(a.txns.filter(t => !t.other).length, OLD_DB.people[ana].txns.length);
});

test('assistants connected on 1.0 keep working: a 120-day-old key, and an OAuth sign-in with its refresh', async () => {
  const k = await ping(OLD.mcpKey);
  assert.equal(k.status, 200, 'the 1.0 key stopped working: ' + k.text);
  assert.match(k.text, /add_cash_purchase/);
  assert.equal((await ping(OLD.oauth.access_token)).status, 200);
  const r = await call('POST', '/oauth/token', { body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: OLD.oauth.refresh_token, client_id: OLD.oauth.client_id }).toString() });
  assert.equal(r.status, 200, r.text);
  assert.equal((await ping(r.data.access_token)).status, 200);
  // the idle clock started at the upgrade, and it's written down so it doesn't restart every time
  const o = readJson('oauth.json'), key = Object.values(o.tokens).find(t => t.kind === 'key');
  assert.equal(o.usedNoted, true);
  assert.ok(Date.now() - key.used < 3600e3);
});

test('a backup zip made by 1.0 restores into this version', async () => {
  await stop();
  fs.writeFileSync(path.join(DATA, 'db.json'), JSON.stringify({ people: {}, items: {} }));   // so a restore that did nothing would show
  const out = cli(['restore', path.join(FIX, 'backup.zip')]);
  assert.match(out, /Restored 2 budgets/);
  await start();
  // the people signed in now stay signed in (sessions aren't taken from a backup), with their 1.0 data and shares back
  const b = await state(OLD.cookies.Ben);
  assert.equal(b.status, 200);
  assert.deepEqual(b.data.state.accounts.filter(a => a.other).map(a => a.name).sort(), ['Cash box', 'Everyday Chequing']);
  const db = readJson('db.json'), ana = uidOf('Ana');
  assert.ok(db.people[ana].txns.length > 100);
  assert.ok(!db.people[ana].accounts.some(a => a.shared === true));
  // the backup's assistant key came back too, with its idle clock started
  assert.equal((await ping(OLD.mcpKey)).status, 200);
  assert.equal(readJson('oauth.json').usedNoted, true);
  assert.equal((await state(OLD.cookies.Ana)).status, 200);
});

test('a backup from the command line while the app runs has the change made a moment before', async () => {
  const r = await call('POST', '/api/op', { cookie: OLD.cookies.Ben, body: { op: 'txn.add', args: { amount: 3.25, m: 'Just now', date: '2026-11-02' } } });
  assert.equal(r.status, 200, r.text);
  const f = path.join(DIR, 'now.zip');
  assert.match(cli(['backup', f], '\n'), /Wrote/);
  const { zipRead } = require('../server.js');
  const db = JSON.parse(zipRead(fs.readFileSync(f))['db.json'].toString('utf8'));
  assert.ok(db.people[uidOf('Ben')].txns.some(t => t.m === 'Just now'), 'the backup missed the last change');
});
