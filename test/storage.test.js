// Keeping data safe on the laptop: the bank key, damaged files, safety copies, a full disk, restore checks,
// copies off the laptop without a passphrase, and each person's own "download / delete my data".
// Each part runs its own server in a folder of its own. Run with: node --test test/*.test.js
'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

const SERVER = path.join(__dirname, '..', 'server.js');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-it-storage-'));
process.env.DATA_DIR = path.join(ROOT, 'here');   // for require('../server.js') in this process
const { zipWrite, zipRead } = require('../server.js');
const running = new Set();
after(async () => {
  for (const s of running) await s.stop();
  fakePlaid.close();
  fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const plaidCalls = [];
const fakePlaid = http.createServer((req, res) => {
  let body = ''; req.on('data', c => body += c); req.on('end', () => {
    const j = JSON.parse(body || '{}'); plaidCalls.push({ path: req.url, body: j });
    const send = x => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(x)); };
    if (req.url === '/item/public_token/exchange') return send({ access_token: 'access-' + j.public_token, item_id: 'item-' + j.public_token });
    if (req.url === '/accounts/get') return send({ accounts: [{ account_id: 'chk-' + j.access_token, name: 'Chequing', mask: '0001', type: 'depository', subtype: 'checking', balances: { current: 500 } }] });
    if (req.url === '/transactions/sync') return send({ added: [], modified: [], removed: [], next_cursor: 'c1', has_more: false });
    if (req.url === '/transactions/recurring/get') return send({ outflow_streams: [], inflow_streams: [] });
    send({ removed: true });
  });
});
const plaidUrl = new Promise(ok => fakePlaid.listen(0, '127.0.0.1', () => ok(`http://127.0.0.1:${fakePlaid.address().port}`)));
const freePort = () => new Promise(ok => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const baseEnv = async (data, extra = {}) => ({ ...process.env, DATA_DIR: data, HOST: '127.0.0.1', UPDATE_CHECK: 'off', RESEND_API_KEY: '', GOOGLE_CLIENT_ID: '', PUBLIC_URL: '', BUDGET_IT_KEY: '',
  BACKUP_COPY_DIR: '', BACKUP_PASSPHRASE: '', PLAID_CLIENT_ID: 'id', PLAID_SECRET: 'secret', PLAID_ENV: 'sandbox', PLAID_URL: await plaidUrl, PLAID_REDIRECT_URI: '', ...extra });
const cli = async (data, args, input = '', extra = {}) => { const r = spawnSync(process.execPath, [SERVER, ...args], { env: await baseEnv(data, extra), input, encoding: 'utf8' }); return (r.stdout || '') + (r.stderr || ''); };

// Start a server and wait until it listens, or until it stops (then `code` says how).
async function start(data, extra = {}, tries = 1) {
  const port = await freePort(), env = { ...await baseEnv(data, extra), PORT: String(port) };
  const proc = spawn(process.execPath, [SERVER], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const s = { proc, port, out: '', code: null };
  s.stop = async () => { running.delete(s); if (proc.exitCode === null && proc.signalCode === null) { const gone = new Promise(r => proc.once('exit', r)); proc.kill(); await gone; } };
  running.add(s);
  await new Promise((ok, no) => { const t = setTimeout(() => no(new Error('server did not start: ' + s.out)), 15000);
    const on = d => { s.out += d; if (/running at/.test(s.out)) { clearTimeout(t); ok(); } };
    proc.stdout.on('data', on); proc.stderr.on('data', on); proc.once('close', c => { clearTimeout(t); s.code = c; running.delete(s); ok(); }); });
  // another program took the free port in the moment before the server did: another port
  if (s.code !== null && /already in use/.test(s.out) && tries < 5) return start(data, extra, tries + 1);
  return s;
}
function browser(s) {
  let cookie = '';
  const call = async (method, url, body, raw, headers = {}) => {
    const r = await fetch(`http://127.0.0.1:${s.port}${url}`, { method, redirect: 'manual', headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body !== undefined && !raw ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body) });
    const set = r.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    const buf = Buffer.from(await r.arrayBuffer()); let data = null; try { data = JSON.parse(buf.toString('utf8')); } catch {}
    return { status: r.status, data, buf, headers: r.headers };
  };
  return { get: u => call('GET', u), post: (u, b) => call('POST', u, b === undefined ? {} : b), upload: (u, buf) => call('POST', u, buf, true), op: (op, args) => call('POST', '/api/op', { op, args }) };
}
async function as(s, name) { const b = browser(s); const r = await b.post('/api/login', { name, password: name.toLowerCase() + '-password' }); assert.equal(r.status, 200, JSON.stringify(r.data)); return b; }
const sealWith = (key, text) => { const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key, iv); const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]); return 'v1:' + Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64'); };
const folder = name => { const d = path.join(ROOT, name); fs.mkdirSync(d, { recursive: true }); return d; };
const uidOf = (data, name) => Object.entries(JSON.parse(fs.readFileSync(path.join(data, 'users.json'), 'utf8')).users).find(([, u]) => u.name === name)[0];

// ---------- the key to the bank connections ----------
test('a damaged or unreadable secret.key stops the app when banks depend on it, and is never replaced', async () => {
  const linked = { people: {}, items: { i1: { uid: 'u_1', token: 'v1:' + crypto.randomBytes(40).toString('base64'), inst: 'Bank' } } };
  // damaged
  let data = folder('key-damaged'); fs.writeFileSync(path.join(data, 'db.json'), JSON.stringify(linked)); fs.writeFileSync(path.join(data, 'secret.key'), 'not a key at all');
  let s = await start(data);
  assert.equal(s.code, 1, 'it refuses to start'); assert.match(s.out, /secret\.key is damaged.*won’t start/s);
  assert.equal(fs.readFileSync(path.join(data, 'secret.key'), 'utf8'), 'not a key at all', 'the key file is left exactly as it was');
  // unreadable (a folder where the file should be: even root can't read that as a file)
  data = folder('key-unreadable'); fs.writeFileSync(path.join(data, 'db.json'), JSON.stringify({ people: {}, splitit: { u_1: { url: 'http://x', key: 'v1:abc' } } })); fs.mkdirSync(path.join(data, 'secret.key'));
  s = await start(data);
  assert.equal(s.code, 1); assert.match(s.out, /Can’t read .*secret\.key.*Split it/s);
  assert.ok(fs.statSync(path.join(data, 'secret.key')).isDirectory());
  // with no bank links yet it starts, keeps the bad file aside, and makes a new key only when one is needed
  data = folder('key-unused'); fs.writeFileSync(path.join(data, 'secret.key'), 'garbage');
  s = await start(data);
  assert.equal(s.code, null, 'it starts: ' + s.out);
  assert.ok(fs.readdirSync(data).some(f => /^secret\.key\.damaged-\d+$/.test(f)), 'the damaged key is kept');
  assert.ok(!fs.existsSync(path.join(data, 'secret.key')));
  await s.stop();
});

// ---------- damaged db.json, and the safety copies ----------
test('a damaged db.json comes back from the newest copy, and the owner is told which', async () => {
  const data = folder('recover'), bk = path.join(data, 'backups'); fs.mkdirSync(bk, { recursive: true });
  assert.match(await cli(data, ['add-user', 'Ana'], 'ana-password\n'), /Added/);
  assert.match(await cli(data, ['add-user', 'Ben'], 'ben-password\n'), /Added/);
  const good = n => JSON.stringify({ people: {}, items: {}, marker: n });
  fs.writeFileSync(path.join(bk, 'db-2026-01-01.json'), good('daily'));
  fs.writeFileSync(path.join(bk, 'db-weekly-2025-12-28.json'), good('weekly'));
  for (let i = 1; i <= 7; i++) fs.writeFileSync(path.join(bk, `db-start-2026-01-0${i}T0900.json`), good('start' + i));
  fs.writeFileSync(path.join(bk, 'db-6h-2026-01-07T1200.json'), good('6h'));
  fs.writeFileSync(path.join(bk, 'db-start-notes.json'), 'not one of ours');
  fs.writeFileSync(path.join(data, 'db.json'), '{"people": {broken');
  const s = await start(data);
  assert.equal(s.code, null, s.out);
  assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'db.json'), 'utf8')).marker, '6h', 'the newest copy of any kind is used');
  assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'last-recovery.json'), 'utf8')).from, 'db-6h-2026-01-07T1200.json');
  const names = fs.readdirSync(bk);
  const starts = names.filter(f => /^db-start-\d{4}-\d\d-\d\dT\d{4}\.json$/.test(f)).sort();
  assert.equal(starts.length, 5, 'five start copies are kept: ' + starts);
  assert.ok(!starts.includes('db-start-2026-01-03T0900.json') && starts.includes('db-start-2026-01-07T0900.json'), 'the oldest ones go');
  for (const f of ['db-2026-01-01.json', 'db-weekly-2025-12-28.json', 'db-6h-2026-01-07T1200.json', 'db-start-notes.json']) assert.ok(names.includes(f), f + ' is left alone');

  const ana = await as(s, 'Ana'), ben = await as(s, 'Ben');
  let st = (await ana.get('/api/state')).data;
  assert.equal(st.ownerNotes.recovered.from, 'db-6h-2026-01-07T1200.json');
  assert.ok(st.ownerNotes.recovered.copyAt > 0);
  assert.equal((await ben.get('/api/state')).data.ownerNotes, undefined, 'only the owner sees it');
  const o = (await ana.get('/api/admin/overview')).data;
  assert.equal(o.health.recovered.from, 'db-6h-2026-01-07T1200.json');
  assert.ok(o.backups.some(b => b.file.startsWith('db-start-')), 'the start copies are listed');
  assert.equal((await ben.post('/api/admin/recovery-seen')).status, 403);
  assert.equal((await ana.post('/api/admin/recovery-seen')).status, 200);
  st = (await ana.get('/api/state')).data; assert.equal(st.ownerNotes.recovered, null, 'dismissed');
  assert.ok(JSON.parse(fs.readFileSync(path.join(data, 'last-recovery.json'), 'utf8')).dismissed, 'kept in the file, so a restart doesn’t bring it back');
  await s.stop();
});

// ---------- the main laptop: a bank linked, a copy off the laptop with no passphrase ----------
let main, data, copies, ana, ben, anaUid, key;
test('setting up: a bank link already there, BACKUP_COPY_DIR set, no BACKUP_PASSPHRASE', async () => {
  data = folder('main'); copies = folder('main-copies');
  for (const n of ['Ana', 'Ben']) assert.match(await cli(data, ['add-user', n], n.toLowerCase() + '-password\n'), /Added/);
  anaUid = uidOf(data, 'Ana'); key = crypto.randomBytes(32);
  fs.writeFileSync(path.join(data, 'secret.key'), key.toString('base64'), { mode: 0o600 });
  fs.writeFileSync(path.join(data, 'db.json'), JSON.stringify({ people: { [anaUid]: { accounts: [], txns: [{ id: 't1', date: '2026-01-05', m: 'Ana Lunch', a: -12, c: 'dining', acct: 'cash' }] } },
    items: { 'item-pre': { uid: anaUid, token: sealWith(key, 'access-pre'), inst: 'Pre Bank', cursor: null } } }));
  main = await start(data, { BACKUP_COPY_DIR: copies });
  assert.equal(main.code, null, main.out);
  ana = await as(main, 'Ana'); ben = await as(main, 'Ben');
  assert.ok(fs.readdirSync(path.join(data, 'backups')).some(f => /^db-start-\d{4}-\d\d-\d\dT\d{4}\.json$/.test(f)), 'a copy was taken at start');
});

test('an unlocked copy off the laptop leaves out the bank key, and says so', async () => {
  const f = fs.readdirSync(copies).find(x => /^budget-it-backup-\d{4}-\d\d-\d\d\.zip$/.test(x)); assert.ok(f, String(fs.readdirSync(copies)));
  const files = zipRead(fs.readFileSync(path.join(copies, f)));
  assert.ok(files['db.json'] && !files['secret.key'], 'no secret.key in it: ' + Object.keys(files));
  assert.match(files['README.txt'].toString(), /leaves out secret\.key/);
  const h = (await ana.get('/api/admin/overview')).data.health;
  assert.match(h.copyNote, /Copies leave out the bank key until you set BACKUP_PASSPHRASE/);
  // the owner's own download still has it (the page warns before an unlocked one)
  assert.ok('secret.key' in zipRead((await ana.get('/api/admin/backup')).buf));
  // it restores here, where the key is
  const r = await ana.upload('/api/admin/restore', fs.readFileSync(path.join(copies, f)));
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.banks, 1);
  assert.equal(fs.readFileSync(path.join(data, 'secret.key'), 'utf8'), key.toString('base64'), 'the key is untouched');
  // somewhere without that key it is refused, clearly, and nothing changes
  for (const [name, otherKey] of [['nokey', null], ['wrongkey', crypto.randomBytes(32)]]) {
    const d = folder('restore-' + name); if (otherKey) fs.writeFileSync(path.join(d, 'secret.key'), otherKey.toString('base64'));
    const out = await cli(d, ['restore', path.join(copies, f)]);
    assert.match(out, otherKey ? /doesn’t unlock them/ : /not the key that unlocks them/);
    assert.ok(!fs.existsSync(path.join(d, 'db.json')), 'nothing restored');
  }
});

test('a restore checks the shape of every file before replacing anything', async () => {
  const before = fs.readFileSync(path.join(data, 'db.json'), 'utf8');
  const zip = files => zipWrite(Object.entries(files).map(([name, x]) => ({ name, data: Buffer.from(typeof x === 'string' ? x : JSON.stringify(x)) })));
  const tries = [
    [zip({ 'db.json': { people: null } }), /db\.json .*doesn’t look like Budget it data \(no people/],
    [zip({ 'db.json': { docs: null } }), /no people in it/],
    [zip({ 'db.json': { people: { u_1: 'x' } } }), /a budget that isn’t one/],
    [zip({ 'db.json': { people: {} }, 'users.json': { users: null } }), /users\.json .*no users/],
    [zip({ 'db.json': { people: {} }, 'users.json': { users: {}, sessions: [] } }), /sign-ins/],
    [zip({ 'db.json': '{"people": ' }), /damaged/],
    [Buffer.from('{"people":null}'), /no people in it/],   // a plain db.json, like one from data/backups
    [Buffer.from('{"docs":null}'), /no people in it/]];
  for (const [buf, re] of tries) {
    const r = await ana.upload('/api/admin/restore', buf);
    assert.equal(r.status, 400); assert.match(r.data.error, re); assert.match(r.data.error, /nothing was changed|no people/);
  }
  assert.equal(fs.readFileSync(path.join(data, 'db.json'), 'utf8'), before, 'nothing was replaced');
  // a good plain db.json restores the budgets alone
  const good = JSON.parse(before); good.people[anaUid].txns.push({ id: 't2', date: '2026-01-06', m: 'From A Copy', a: -3, c: 'dining', acct: 'cash' });
  const r = await ana.upload('/api/admin/restore', Buffer.from(JSON.stringify(good)));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok((await ana.get('/api/state')).data.state.txns.some(t => t.m === 'From A Copy'));
});

test('a full disk: the change is refused with a clear message, the app keeps going, and it saves once there’s room', { skip: !fs.existsSync('/dev/full') && 'needs /dev/full' }, async () => {
  const tmp = path.join(data, 'db.json.tmp');
  fs.symlinkSync('/dev/full', tmp);   // every write of db.json now fails as on a full disk
  try {
    const r = await ana.op('txn.add', { amount: 4.5, m: 'Disk Full Coffee', c: 'dining' });
    assert.equal(r.status, 507); assert.equal(r.data.error, 'The laptop’s disk is full, so this wasn’t saved.');
    assert.equal((await ana.get('/api/state')).status, 200, 'still serving');
    assert.equal((await ben.op('txn.add', { amount: 1, m: 'Ben Gum', c: 'dining' })).status, 507);
    const h = (await ana.get('/api/admin/overview')).data.health;
    assert.match(h.diskWarning, /disk is full.*Saving has failed/);
    assert.match((await ana.get('/api/state')).data.ownerNotes.disk, /disk is full/);
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const t = (await ana.get('/api/state')).data.state.txns.find(x => x.id === 't1');
    assert.equal((await ana.post('/api/receipt', { id: t.id, data: png })).status, 507);
  } finally { fs.unlinkSync(tmp); }
  const r = await ana.op('txn.add', { amount: 2, m: 'Room Again', c: 'dining' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const saved = JSON.parse(fs.readFileSync(path.join(data, 'db.json'), 'utf8')).people[anaUid].txns.map(x => x.m);
  assert.ok(saved.includes('Room Again') && saved.includes('Disk Full Coffee'), 'what waited in memory is saved too');
  assert.equal((await ana.get('/api/admin/overview')).data.health.diskWarning, null);
  // a receipt folder that can't be written to answers clearly too
  fs.rmSync(path.join(data, 'receipts'), { recursive: true, force: true }); fs.writeFileSync(path.join(data, 'receipts'), 'in the way');
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const rr = await ana.post('/api/receipt', { id: 't1', data: png });
  assert.equal(rr.status, 507); assert.match(rr.data.error, /wasn’t saved/);
  fs.rmSync(path.join(data, 'receipts'));
  assert.equal((await ana.op('txn.add', { amount: 1, m: 'Still Fine', c: 'dining' })).status, 200);
});

test('everyone can download their own data, and only their own', async () => {
  await ben.op('txn.add', { amount: 7, m: 'Ben Snack', c: 'dining' });
  const r = await ben.get('/api/me/export');
  assert.equal(r.status, 200); assert.match(r.headers.get('content-disposition'), /attachment; filename="budget-it-my-data-/);
  const j = JSON.parse(r.buf.toString());
  assert.equal(j.you.name, 'Ben'); assert.ok(j.budget.txns.some(t => t.m === 'Ben Snack'));
  assert.ok(!r.buf.includes('Ana Lunch') && !r.buf.includes('Pre Bank') && !r.buf.includes('v1:'), 'nothing of Ana’s, and no bank tokens');
  const a = JSON.parse((await ana.get('/api/me/export')).buf.toString());
  assert.deepEqual(a.banks.map(b => b.inst), ['Pre Bank']); assert.ok(!JSON.stringify(a).includes('access-pre'));
  assert.equal((await browser(main).get('/api/me/export')).status, 401);
});

test('deleting my data removes my budget, banks and account, after typing my name', async () => {
  assert.equal((await ben.post('/api/plaid/exchange', { public_token: 'ben1', institution: 'Ben Bank' })).status, 200);
  const benUid = (await ben.get('/api/state')).data.me.id;
  assert.equal((await ben.post('/api/me/delete', { name: 'Benjamin' })).status, 400, 'the wrong name changes nothing');
  assert.equal((await ana.post('/api/me/delete', { name: 'Ana' })).status, 400, 'the only owner can’t delete themselves');
  plaidCalls.length = 0;
  const r = await ben.post('/api/me/delete', { name: ' ben ' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(plaidCalls.some(c => c.path === '/item/remove' && c.body.access_token === 'access-ben1'), 'his bank is disconnected at Plaid');
  assert.equal((await ben.get('/api/state')).status, 401, 'signed out');
  await new Promise(ok => setTimeout(ok, 600));
  const saved = JSON.parse(fs.readFileSync(path.join(data, 'db.json'), 'utf8'));
  assert.ok(!saved.people[benUid] && !Object.values(saved.items).some(i => i.uid === benUid));
  assert.ok(!JSON.parse(fs.readFileSync(path.join(data, 'users.json'), 'utf8')).users[benUid]);
  assert.equal((await ana.get('/api/state')).status, 200, 'everyone else carries on');
  assert.ok(saved.items['item-pre'], 'other people’s banks stay');
  await main.stop();
});

// ---------- changes made offline (the page's own code, run here with a pretend laptop) ----------
test('a change made offline that the laptop refuses is shown, and one that keeps failing is set aside', async () => {
  const vm = require('vm');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const code = html.slice(html.indexOf('const OP_NOUN'), html.indexOf('// Signing out leaves nothing'));
  assert.ok(code.includes('async function flushQueue'), 'found the code that sends them');
  const mem = {}, shown = [], toasts = [], sent = [];
  let answer = () => ({ status: 200, body: { ok: true } });
  const ctx = vm.createContext({
    store: { get: k => mem[k] === undefined ? null : JSON.parse(mem[k]), set: (k, v) => { mem[k] = JSON.stringify(v); } },
    navigator: { onLine: true }, LAPTOP: true, VIEW: { me: { id: 'u_me' } }, location: {},
    fetch: async (url, o) => { const b = JSON.parse(o.body); sent.push(b.op + ':' + (b.args && b.args.n)); const a = answer(b); if (a.offline) throw new Error('offline'); return { ok: a.status < 300, status: a.status, json: async () => a.body }; },
    refresh: async () => {}, toast: m => toasts.push(m), sheet: h => shown.push(h), close: () => {}, esc: x => String(x),
    document: { getElementById: () => ({ innerHTML: '' }) } });
  vm.runInContext(code + '\n;this.flushQueue = flushQueue;', ctx);
  const q = list => { mem['bi-queue'] = JSON.stringify(list); };
  // one refused (that charge is gone), the others still go
  q([{ op: 'txn.update', args: { n: 1 }, uid: 'u_me', what: 'Changed Coffee', tries: 0 }, { op: 'txn.add', args: { n: 2 }, uid: 'u_me', what: 'Added Lunch', tries: 0 },
    { op: 'txn.add', args: { n: 3 }, uid: 'u_someone_else', tries: 0 }]);
  answer = b => b.args.n === 1 ? { status: 400, body: { error: 'That transaction isn’t there any more.' } } : { status: 200, body: { ok: true } };
  await ctx.flushQueue();
  assert.deepEqual(sent, ['txn.update:1', 'txn.add:2'], 'someone else’s change is never sent as you');
  assert.deepEqual(JSON.parse(mem['bi-queue']).map(x => x.uid), ['u_someone_else'], 'and it’s kept for them');
  assert.match(shown.join(''), /This change you made offline couldn’t be saved: Changed Coffee \(That transaction isn’t there any more\.\)/);
  assert.match(shown.join(''), /1 other change you made offline went through/);
  // a change the laptop keeps failing on waits, then after 3 tries is set aside and the rest carry on
  sent.length = 0; shown.length = 0;
  q([{ op: 'budget.set', args: { n: 4 }, uid: 'u_me', tries: 0 }, { op: 'goal.add', args: { n: 5 }, uid: 'u_me', what: 'Added a goal', tries: 0 }]);
  answer = b => b.args.n === 4 ? { status: 507, body: { error: 'The laptop’s disk is full, so this wasn’t saved.' } } : { status: 200, body: { ok: true } };
  await ctx.flushQueue(); await ctx.flushQueue();
  assert.deepEqual(sent, ['budget.set:4', 'budget.set:4'], 'the order is kept while it might still go through');
  assert.equal(JSON.parse(mem['bi-queue']).length, 2);
  await ctx.flushQueue();
  assert.deepEqual(sent.slice(2), ['budget.set:4', 'goal.add:5']);
  assert.equal(JSON.parse(mem['bi-queue']).length, 0);
  assert.equal(JSON.parse(mem['bi-aside']).length, 1, 'kept aside, not lost');
  assert.match(shown.join(''), /couldn’t be saved: A change to a budget \(The laptop’s disk is full, so this wasn’t saved\.\)\. It’s set aside after 3 tries/);
  // no connection: nothing is lost or counted as a try
  sent.length = 0; q([{ op: 'txn.add', args: { n: 6 }, uid: 'u_me', tries: 0 }]); answer = () => ({ offline: true });
  await ctx.flushQueue();
  assert.equal(JSON.parse(mem['bi-queue'])[0].tries, 0);
});
