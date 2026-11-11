// Signing in, the owner's tools, backups and the laptop commands, against the real server on a spare port.
// (test/server.test.js covers budgets, banks and the assistant.) Run with: node --test test/*.test.js
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

const SERVER = path.join(__dirname, '..', 'server.js');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-it-safety-'));
const DATA = path.join(DIR, 'data'), COPIES = path.join(DIR, 'copies');
process.env.DATA_DIR = path.join(DIR, 'here');   // for require('../server.js') in this process: never the repo's own data folder
const PASS = 'correct horse battery';
let PORT, proc, env, addr = 0;
const plaidCalls = [], splitCalls = [];

const freePort = () => new Promise(res => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const listen = srv => new Promise(ok => srv.listen(0, '127.0.0.1', () => ok(srv.address().port)));
const cli = (args, input = '', extra = {}) => { const r = spawnSync(process.execPath, [SERVER, ...args], { env: { ...env, ...extra }, input, encoding: 'utf8' }); return (r.stdout || '') + (r.stderr || ''); };

// A tiny Plaid: enough to connect a bank and see what Budget it asks for.
const fakePlaid = http.createServer((req, res) => {
  let body = ''; req.on('data', c => body += c); req.on('end', () => {
    const j = JSON.parse(body || '{}'); plaidCalls.push({ path: req.url, body: j });
    const send = x => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(x)); };
    if (req.url === '/link/token/create') return send({ link_token: 'link-abc' });
    if (req.url === '/item/public_token/exchange') return send({ access_token: 'access-' + j.public_token, item_id: 'item-' + j.public_token });
    if (req.url === '/accounts/get') return send({ accounts: [{ account_id: 'chk-' + j.access_token, name: 'Chequing', mask: '0001', type: 'depository', subtype: 'checking', balances: { current: 500 } }] });
    if (req.url === '/transactions/sync') return send({ added: [], modified: [], removed: [], next_cursor: 'c1', has_more: false });
    if (req.url === '/transactions/recurring/get') return send({ outflow_streams: [], inflow_streams: [] });
    send({ removed: true });
  });
});
// A tiny Split it. "House" answers like an older Split it (shares in a list), "Trip" like a newer one ("Your share").
const SPLIT_KEY = 'hsk_test_key_abcdefghijklmnop';
const fakeSplit = http.createServer((req, res) => {
  let body = ''; req.on('data', c => body += c); req.on('end', () => {
    const j = JSON.parse(body); splitCalls.push(j.params); const a = j.params.arguments || {};
    const third = a.amount ? (a.amount / 3).toFixed(2) : '0';
    const text = j.params.name === 'list_groups' ? 'House: you, Mika, Jo. You’re all square in this group.\nTrip: you, Jo. You’re all square in this group.'
      : a.group === 'Trip' ? `Added "${a.title}" $${a.amount.toFixed(2)} in Trip, paid by you, split equally between you, Jo ($${(a.amount / 2).toFixed(2)} / $${(a.amount / 2).toFixed(2)}). Your share: $${(a.amount / 2).toFixed(2)}.`
      : a.group === 'Theirs' ? `Added "${a.title}" $${a.amount.toFixed(2)} in Theirs, paid by you, split equally between Mika, Jo ($${(a.amount / 2).toFixed(2)} / $${(a.amount / 2).toFixed(2)}). You’re not in this split.`
      : `Added "${a.title}" $${a.amount.toFixed(2)} in House, paid by you, split equally between you, Mika, Jo ($${third} / $${third} / $${third}).`;
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id, result: { content: [{ type: 'text', text }] } }));
  });
});
const fakeFx = http.createServer((req, res) => { const u = new URL(req.url, 'http://x'); res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ base: u.searchParams.get('from'), date: '2026-11-06', rates: { CAD: 1.4, EUR: 0.92 } })); });

// One browser: keeps its cookie, and arrives from its own address so one test's wrong passwords never lock out another.
function browser(ip) {
  const from = ip || `10.8.${++addr >> 8}.${addr & 255}`;
  let cookie = '';
  const call = async (method, url, body, raw, headers = {}) => {
    const r = await fetch(`http://127.0.0.1:${PORT}${url}`, { method, redirect: 'manual',
      headers: { 'X-Forwarded-For': from, ...(cookie ? { Cookie: cookie } : {}), ...(body !== undefined && !raw ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body) });
    const set = r.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    const buf = Buffer.from(await r.arrayBuffer());
    let data = null; try { data = JSON.parse(buf.toString('utf8')); } catch {}
    return { status: r.status, data, buf, type: r.headers.get('content-type') };
  };
  const me = { get: url => call('GET', url), post: (url, body) => call('POST', url, body === undefined ? {} : body),
    upload: (url, buf, pass) => call('POST', url, buf, true, pass ? { 'X-Backup-Passphrase': encodeURIComponent(pass) } : {}),
    signIn: (name, password) => me.post('/api/login', { name, password }), op: (op, args) => me.post('/api/op', { op, args }),
    cookie: () => cookie };
  return me;
}
async function as(name, password = name.toLowerCase() + '-password') {
  const b = browser(); const r = await b.signIn(name, password);
  assert.equal(r.status, 200, `${name} signs in: ${JSON.stringify(r.data)}`); assert.ok(r.data.ok, 'no second step expected');
  b.uid = (await b.get('/api/state')).data.me.id; return b;
}
// The code an authenticator app would show (RFC 6238), written again here so the server's maths is checked against it.
function appCode(secret, at = Date.now()) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = '';
  for (const c of secret) bits += A.indexOf(c).toString(2).padStart(5, '0');
  const key = Buffer.from((bits.match(/.{8}/g) || []).map(b => parseInt(b, 2)));
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(Math.floor(at / 30000)));
  const mac = crypto.createHmac('sha1', key).update(msg).digest(), o = mac[19] & 15;
  return String((mac.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
}
// Is this person's live-update stream still open a moment from now?
async function streamOpen(b) {
  const ctl = new AbortController();
  const r = await fetch(`http://127.0.0.1:${PORT}/api/events`, { headers: { Cookie: b.cookie() }, signal: ctl.signal });
  if (r.status !== 200) return { open: false, close() {} };
  const reader = r.body.getReader(); let ended = false;
  (async () => { try { for (;;) { const { done } = await reader.read(); if (done) break; } } catch {} ended = true; })();
  return { get open() { return !ended; }, close() { ctl.abort(); } };
}
const wait = ms => new Promise(ok => setTimeout(ok, ms));

let ana, ben;   // Ana runs it (owner). Ben is a housemate with his own, private budget.
before(async () => {
  PORT = await freePort();
  env = { ...process.env, DATA_DIR: DATA, PORT: String(PORT), HOST: '127.0.0.1', BACKUP_COPY_DIR: COPIES, BACKUP_PASSPHRASE: PASS, UPDATE_CHECK: 'off', RESEND_API_KEY: '', GOOGLE_CLIENT_ID: '', PUBLIC_URL: '',
    PLAID_CLIENT_ID: 'id', PLAID_SECRET: 'secret', PLAID_ENV: 'production', PLAID_URL: `http://127.0.0.1:${await listen(fakePlaid)}`, PLAID_REDIRECT_URI: 'https://budget.example.test/plaid/return',
    FX_URL: `http://127.0.0.1:${await listen(fakeFx)}`, BOC_URL: 'http://127.0.0.1:9' };
  env.SPLIT_IT_URL = `http://127.0.0.1:${await listen(fakeSplit)}`;   // a Split it on this laptop has to be named
  for (const n of ['Ana', 'Ben']) assert.match(cli(['add-user', n], n.toLowerCase() + '-password\n'), /Added/);
  for (let tries = 1; ; tries++) {   // another program can take the free port in the moment before the server does: then another one
    if (tries > 1) env.PORT = String(PORT = await freePort());
    proc = spawn(process.execPath, [SERVER], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const up = await new Promise((res, rej) => { let out = ''; const t = setTimeout(() => rej(new Error('server did not start: ' + out)), 15000);
      const on = d => { out += d; if (/running at/.test(out)) { clearTimeout(t); res(true); } }; proc.stdout.on('data', on); proc.stderr.on('data', on);
      proc.once('close', c => { clearTimeout(t); if (/already in use/.test(out) && tries < 5) res(false); else rej(new Error('server stopped early (' + c + '): ' + out)); }); });
    if (up) break;
  }
  ana = await as('Ana'); ben = await as('Ben');
});
after(async () => {
  if (proc && proc.exitCode === null && proc.signalCode === null) { const gone = new Promise(r => proc.once('exit', r)); proc.kill(); await gone; }   // never wait for an exit that already happened
  for (const s of [fakePlaid, fakeSplit, fakeFx]) s.close();
  fs.rmSync(DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// ---------- signing in ----------
test('wrong passwords lock out an address, and only slow an account down', async () => {
  const b = browser('10.70.0.1');
  for (let i = 0; i < 5; i++) assert.equal((await b.signIn('Ben', 'wrong-guess-' + i)).status, 401);
  assert.equal((await b.signIn('Ben', 'ben-password')).status, 429, 'that address waits, even with the right password');
  assert.equal((await browser('10.70.0.2').signIn('Ben', 'ben-password')).status, 200);
  assert.match(cli(['add-user', 'Target'], 'target-password\n'), /Added/);
  for (let i = 0; i < 10; i++) assert.equal((await browser(`10.71.0.${i + 1}`).signIn('Target', 'wrong-guess-' + i)).status, 401);
  const t0 = Date.now();
  assert.equal((await browser('10.71.1.1').signIn('Target', 'target-password')).status, 200, 'ten misses from anywhere never lock the account');
  assert.ok(Date.now() - t0 >= 900, 'but its sign-in waits a moment first');
  assert.equal((await browser('10.71.1.2').signIn('Ana', 'ana-password')).status, 200, 'other people still get in');
});

test('changing a password signs out the other phones, their live updates and any assistant', async () => {
  assert.match(cli(['add-user', 'Eve'], 'eve-password\n'), /Added/);
  const here = await as('Eve'), there = await as('Eve');
  const key = /(bik_[A-Za-z0-9_-]+)/.exec(cli(['mcp-key', 'Eve']))[1];
  const assistant = () => fetch(`http://127.0.0.1:${PORT}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: 'Bearer ' + key }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  assert.equal((await assistant()).status, 200);
  const mine = await streamOpen(here), theirs = await streamOpen(there);
  await wait(150); assert.ok(mine.open && theirs.open);
  assert.equal((await here.post('/api/account/password', { current: 'eve-password', next: 'eve-new-password' })).status, 200);
  await wait(250);
  assert.equal((await here.get('/api/state')).status, 200, 'this phone stays signed in');
  assert.ok(mine.open, 'and keeps its live updates');
  assert.equal((await there.get('/api/state')).status, 401, 'the other phone is signed out');
  assert.equal(theirs.open, false, 'and its live updates stop at once');
  assert.equal((await assistant()).status, 200, 'changing the password alone leaves the assistant');
  // "sign out on all devices" and a reset both take the assistant too
  assert.equal((await here.post('/api/account/signout-all')).status, 200);
  await wait(250);
  assert.equal(mine.open, false); assert.equal((await assistant()).status, 401);
  mine.close(); theirs.close();
});

test('a sign-in code is asked for after the password, and a reset link does not skip it', async () => {
  assert.match(cli(['add-user', 'Dan'], 'dan-password\n'), /Added/);
  const dan = await as('Dan');
  const start = await dan.post('/api/account/code/start');
  assert.match(start.data.uri, /^otpauth:\/\/totp\/Budget%20it%3ADan\?secret=[A-Z2-7]{32}&issuer=Budget%20it/);
  const at = Date.now(), used = appCode(start.data.secret, at), next = appCode(start.data.secret, at + 30000);
  assert.equal((await dan.post('/api/account/code/confirm', { code: '000000' })).status, 401);
  const on = await dan.post('/api/account/code/confirm', { code: used });
  assert.equal(on.status, 200, JSON.stringify(on.data)); assert.equal(on.data.backup.length, 8);

  const phone = browser(), step1 = await phone.signIn('Dan', 'dan-password');
  assert.equal(step1.data.need, 'code');
  assert.equal((await phone.get('/api/state')).status, 401, 'the password alone is not enough');
  assert.equal((await phone.post('/api/login/code', { ticket: step1.data.ticket, code: used })).status, 401, 'a code works once');
  assert.equal((await phone.post('/api/login/code', { ticket: step1.data.ticket, code: next })).status, 200);
  assert.equal((await phone.get('/api/state')).data.me.name, 'Dan');

  const tablet = browser(), t1 = await tablet.signIn('Dan', 'dan-password');
  assert.equal((await tablet.post('/api/login/code', { ticket: t1.data.ticket, code: on.data.backup[0] })).status, 200, 'a backup code works');
  const again = browser(), t2 = await again.signIn('Dan', 'dan-password');
  assert.equal((await again.post('/api/login/code', { ticket: t2.data.ticket, code: on.data.backup[0] })).status, 401, 'but only once');

  const link = (await ana.post('/api/admin/reset-link', { id: dan.uid })).data.url;
  const reset = await browser().post('/api/reset', { token: link.split('#reset=')[1], password: 'dan-new-password' });
  assert.deepEqual([reset.status, reset.data.signin], [200, true]);
  assert.equal((await dan.get('/api/state')).status, 401, 'the reset signs out the other phones');

  assert.equal((await ben.post('/api/admin/code-off', { id: dan.uid })).status, 403, 'only the owner can turn someone’s code off');
  assert.match(cli(['code-off', 'Dan']), /turned off for Dan/);
  assert.equal((await browser().signIn('Dan', 'dan-new-password')).data.ok, true);
});

// ---------- the owner's page ----------
test('the owner sees people and health, never anyone’s money', async () => {
  await ben.op('txn.add', { amount: 61.25, m: 'Secret Dinner Place', c: 'dining' });
  for (const p of ['/api/admin/overview', '/api/admin/backup', '/api/admin/update']) assert.equal((await ben.get(p)).status, 403, p);
  for (const p of ['/api/admin/remove', '/api/admin/owner', '/api/admin/reset-link', '/api/admin/signout', '/api/admin/copy-now', '/api/admin/restore', '/api/admin/rename', '/api/admin/backup'])
    assert.equal((await ben.post(p, { id: ana.uid, owner: false, name: 'X' })).status, 403, p);
  const o = await ana.get('/api/admin/overview'), text = JSON.stringify(o.data);
  assert.equal(o.status, 200);
  assert.ok(o.data.people.find(p => p.name === 'Ben'));
  assert.ok(!/Secret Dinner|61\.25|"hash"|"salt"|"totp"/.test(text), 'no budgets, no password hashes: ' + text.slice(0, 200));
  assert.equal(o.data.health.plaid.env, 'production'); assert.equal(o.data.health.copyLocked, true);
  assert.ok(!JSON.stringify((await ana.get('/api/state')).data).includes('Secret Dinner'), 'and the owner’s own page shows only their budget');

  assert.equal((await ana.post('/api/admin/owner', { id: ana.uid, owner: false })).status, 400, 'there is always an owner');
  assert.equal((await ana.post('/api/admin/remove', { id: ana.uid })).status, 400);
  assert.equal((await ana.post('/api/admin/rename', { id: ben.uid, name: 'Ana' })).status, 400, 'names stay unique');
  assert.equal((await ana.post('/api/admin/rename', { id: ben.uid, name: 'Benny' })).status, 200);
  assert.equal((await browser().signIn('Benny', 'ben-password')).status, 200);
  assert.equal((await ana.post('/api/admin/rename', { id: ben.uid, name: 'Ben' })).status, 200);
  assert.deepEqual((await ana.get('/api/admin/update')).data.off, true, 'the update check can be turned off');
});

// ---------- backups ----------
test('a backup can be locked with a passphrase, and comes back whole', async () => {
  await ana.op('txn.add', { amount: 12.5, m: 'Kept Coffee', c: 'dining' });
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const t = (await ana.get('/api/state')).data.state.txns.find(x => x.m === 'Kept Coffee');
  const receipt = (await ana.post('/api/receipt', { id: t.id, data: png })).data.state.txns.find(x => x.id === t.id).receipt;

  assert.equal((await ana.post('/api/admin/backup', { passphrase: 'short' })).status, 400);
  const locked = await ana.post('/api/admin/backup', { passphrase: 'my long passphrase' });
  assert.equal(locked.status, 200); assert.equal(locked.buf.subarray(0, 5).toString(), 'BIBK1');
  assert.ok(!locked.buf.includes('Kept Coffee') && !locked.buf.includes('db.json'), 'nothing readable inside');
  const plain = await ana.get('/api/admin/backup');
  assert.equal(plain.buf.readUInt32LE(0), 0x04034b50);
  assert.equal('secret.key' in require('../server.js').zipRead(plain.buf), fs.existsSync(path.join(DATA, 'secret.key')), 'a downloaded zip holds the key to the bank connections, which is why locking matters');

  await ana.op('txn.add', { amount: 99, m: 'Added Later', c: 'shopping' });
  fs.rmSync(path.join(DATA, 'receipts', receipt));
  let r = await ana.upload('/api/admin/restore', locked.buf);
  assert.deepEqual([r.status, r.data.locked], [401, true], 'a locked backup asks for its passphrase');
  r = await ana.upload('/api/admin/restore', locked.buf, 'not the passphrase');
  assert.equal(r.status, 401); assert.match(r.data.error, /passphrase/);
  assert.ok((await ana.get('/api/state')).data.state.txns.some(x => x.m === 'Added Later'), 'a refused restore changes nothing');
  r = await ana.upload('/api/admin/restore', locked.buf, 'my long passphrase');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const now = (await ana.get('/api/state')).data.state.txns.map(x => x.m);
  assert.ok(now.includes('Kept Coffee') && !now.includes('Added Later'));
  assert.ok(fs.existsSync(path.join(DATA, 'receipts', receipt)), 'receipt photos come back too');
  assert.equal((await ben.get('/api/state')).status, 200, 'people stay signed in through a restore');
  assert.ok(fs.readdirSync(path.join(DATA, 'backups')).some(f => /^before-restore-.*db\.json$/.test(f)), 'what was there before is kept');

  assert.equal((await ana.upload('/api/admin/restore', Buffer.from('definitely not a backup'))).status, 400);
  assert.equal((await ana.upload('/api/admin/restore', plain.buf)).status, 200, 'a plain zip restores too');
});

test('a locked copy of the backup goes to the second place every day', async () => {
  const today = fs.readdirSync(COPIES).filter(f => /^budget-it-backup-\d{4}-\d\d-\d\d\.locked$/.test(f));
  assert.equal(today.length, 1, 'written when the app started: ' + fs.readdirSync(COPIES));
  const { unlock, isLocked, zipRead } = require('../server.js');
  const buf = fs.readFileSync(path.join(COPIES, today[0]));
  assert.ok(isLocked(buf));
  assert.throws(() => unlock(buf, 'wrong passphrase!'), /passphrase/);
  assert.ok(Object.keys(zipRead(unlock(buf, PASS))).includes('db.json'));
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(COPIES, today[0])).mode & 0o077, 0, 'only this user can read it');
  assert.equal((await ana.post('/api/admin/copy-now')).status, 200);
  const h = (await ana.get('/api/admin/overview')).data.health;
  assert.equal(h.copyDir, COPIES); assert.ok(h.copyAt > 0); assert.equal(h.copyError, null);
});

// ---------- laptop commands ----------
test('laptop commands reach the running app and take effect right away', async () => {
  assert.match(cli(['add-user', 'Fay'], 'fay-password\n'), /Added Fay/);
  const fay = await as('Fay');
  assert.match(cli(['sample', 'Fay']), /sample data/);
  assert.ok((await fay.get('/api/state')).data.state.txns.length > 20, 'the sample budget is there without a restart');
  assert.match(cli(['set-password', 'Fay'], 'fay-second-password\n'), /New password saved for Fay\. Signed out 1 session/);
  assert.equal((await fay.get('/api/state')).status, 401);
  const fay2 = await as('Fay', 'fay-second-password');
  assert.match(cli(['restore', 'whatever.zip']), /Usage/);
  fs.writeFileSync(path.join(DIR, 'x.zip'), 'x');
  assert.match(cli(['restore', path.join(DIR, 'x.zip')]), /app is running/, 'restore from the terminal waits until the app is stopped');
  assert.match(cli(['remove-user', 'Fay'], 'yes\n'), /Removed Fay/);
  assert.equal((await fay2.get('/api/state')).status, 401);
  assert.match(cli(['remove-user', 'Ana'], 'yes\n'), /is the owner/);
  const locked = path.join(DIR, 'cli.locked');
  assert.match(cli(['backup', locked]), /locked with your passphrase/);
  assert.equal(fs.readFileSync(locked).subarray(0, 5).toString(), 'BIBK1');
});

test('the door those commands use only opens from this computer with its secret', async () => {
  const lk = JSON.parse(fs.readFileSync(path.join(DATA, 'server.lock'), 'utf8'));
  const knock = headers => fetch(`http://127.0.0.1:${PORT}/api/local/cli`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ cmd: 'set-password', name: 'Ana', password: 'taken-over-123' }) });
  assert.equal((await knock({})).status, 404);
  assert.equal((await knock({ 'X-Local-Token': 'x'.repeat(lk.token.length) })).status, 404);
  assert.equal((await knock({ 'X-Local-Token': lk.token, 'X-Forwarded-For': '203.0.113.9' })).status, 404, 'never through a tunnel or proxy');
  assert.equal((await ana.get('/api/state')).status, 200);
});

// ---------- banks ----------
test('bank connections: the return address goes to Plaid, and used connections are counted', async () => {
  assert.equal((await ana.post('/api/plaid/link-token')).status, 200);
  const asked = plaidCalls.find(c => c.path === '/link/token/create').body;
  assert.equal(asked.redirect_uri, 'https://budget.example.test/plaid/return');
  const back = await fetch(`http://127.0.0.1:${PORT}/plaid/return?oauth_state_id=abc`, { redirect: 'manual', headers: { Cookie: ana.cookie() } });
  assert.deepEqual([back.status, back.headers.get('location')], [302, '/?bank=back&oauth_state_id=abc'], 'people come back into the app, which picks the connection up again');
  const out = await fetch(`http://127.0.0.1:${PORT}/plaid/return?oauth_state_id=abc`, { redirect: 'manual' });
  assert.deepEqual([out.status, out.headers.get('location')], [302, '/login'], 'only when signed in');
  let v = (await ana.get('/api/state')).data.plaid;
  assert.deepEqual([v.used, v.limit, v.back], [0, 10, true]);
  assert.equal((await ana.post('/api/plaid/exchange', { public_token: 'one', institution: 'Tangerine' })).status, 200);
  assert.equal((await ben.post('/api/plaid/exchange', { public_token: 'two', institution: 'RBC' })).status, 200);
  assert.equal((await ana.get('/api/state')).data.plaid.used, 2, 'everyone on this laptop shares the ten');
  const item = (await ana.get('/api/state')).data.items[0].id;
  assert.equal((await ana.post('/api/plaid/remove', { item })).status, 200);
  assert.equal((await ana.get('/api/state')).data.plaid.used, 2, 'disconnecting does not give one back, so it still counts');
  assert.equal((await ana.get('/api/admin/overview')).data.health.plaid.banks, 1);
});

// ---------- Split it ----------
test('a charge sent to Split it can count only your share in your budget', async () => {
  const url = `http://127.0.0.1:${fakeSplit.address().port}`;
  assert.equal((await ana.post('/api/splitit/connect', { url, key: SPLIT_KEY })).status, 200);
  const add = async (m, amount) => { const r = await ana.op('txn.add', { amount, m, c: 'groceries' }); return r.data.state.txns.find(x => x.m === m); };
  const month = async () => (await ana.get('/api/state')).data.state.txns;

  // an older Split it: three people, $90 -> $30 is mine
  let t = await add('Costco Run', 90);
  let r = await ana.post('/api/splitit/send', { id: t.id, group: 'House', mine: true });
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.match(r.data.msg, /Only your share \(\$30\.00\) counts/);
  let list = await month(), mine = list.find(x => x.id === t.id), owed = list.find(x => x.splitOf === t.id);
  assert.deepEqual([mine.a, mine.c, mine.sentTo], [-30, 'groceries', 'House']);
  assert.deepEqual([owed.a, owed.c], [-60, 'transfer']); assert.match(owed.note, /Owed back by housemates \(House\)/);
  // a newer Split it says "Your share" outright
  t = await add('Cabin Food', 80);
  r = await ana.post('/api/splitit/send', { id: t.id, group: 'Trip', mine: true });
  list = await month();
  assert.equal(list.find(x => x.id === t.id).a, -40); assert.equal(list.find(x => x.splitOf === t.id).a, -40);
  // not in the split at all: none of it is spending
  t = await add('Paid For Them', 50);
  r = await ana.post('/api/splitit/send', { id: t.id, group: 'Theirs', mine: true });
  assert.equal((await month()).find(x => x.id === t.id).c, 'transfer');
  // without the option nothing changes in the budget
  t = await add('Whole Thing', 20);
  r = await ana.post('/api/splitit/send', { id: t.id, group: 'House' });
  list = await month();
  assert.equal(list.find(x => x.id === t.id).a, -20); assert.equal(list.find(x => x.splitOf === t.id), undefined);
  assert.equal((await ana.op('txn.share', { id: t.id, amount: 5 })).status, 400, 'the page can’t ask for that change by itself');
  const { myShareFrom } = require('../server.js');
  assert.equal(myShareFrom('Added "X" $1,250.00 in House, paid by you, split by shares between you, Mika ($1,000.00 / $250.00). Your share: $1,000.00.'), 1000);
  assert.equal(myShareFrom('Something else entirely'), null);
});

// ---------- currencies ----------
test('today’s rates work for a home currency other than CAD', async () => {
  assert.match(cli(['add-user', 'Uma'], 'uma-password\n'), /Added/);
  const uma = await as('Uma');
  assert.equal((await uma.op('money.home', { home: 'USD' })).status, 200);
  await uma.op('account.add', { name: 'Maple savings', type: 'Savings', bal: 1000, cur: 'CAD' });
  const r = await uma.post('/api/rates/today');
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.match(r.data.msg, /Updated CAD \(2026-11-06\)/);
  assert.ok(Math.abs(r.data.state.rates.CAD - 1 / 1.4) < 1e-5, 'kept as "1 CAD is worth this many USD": ' + JSON.stringify(r.data.state.rates));
});

// ---------- one sign-in for both apps ----------
test('accounts.js and push.js are the same files Split it uses', { skip: !fs.existsSync(path.join(__dirname, '..', '..', 'split-it', 'accounts.js')) && 'no split-it folder next to this one' }, () => {
  for (const f of ['accounts.js', 'push.js'])
    assert.ok(fs.readFileSync(path.join(__dirname, '..', f)).equals(fs.readFileSync(path.join(__dirname, '..', '..', 'split-it', f))), f + ' has drifted from Split it’s copy: fix it in both');
});
