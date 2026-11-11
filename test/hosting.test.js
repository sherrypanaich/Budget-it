// Running behind a proxy (Traefik, Coolify, a Cloudflare tunnel), requests from other websites, the Split it
// address, text that looks like HTML or a spreadsheet formula. Against the real server on a spare port.
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('child_process');
const dns = require('dns');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const vm = require('vm');
const B = require('../budget');

const SERVER = path.join(__dirname, '..', 'server.js');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-it-hosting-'));
const KEY = 'hsk_test_key_abcdefghijklmnop';
const splitCalls = [];
const fakeSplit = http.createServer((req, res) => {
  let body = ''; req.on('data', c => body += c); req.on('end', () => {
    const j = JSON.parse(body || '{}'); splitCalls.push(j.params);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id, result: { content: [{ type: 'text', text: 'House: you, Mika.' }] } }));
  });
});
const freePort = () => new Promise(ok => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });

// Two apps: A as it ships (proxies on private addresses trusted, no SPLIT_IT_URL),
// B with TRUSTED_PROXY=none, a PUBLIC_URL and a Split it named in SPLIT_IT_URL.
const apps = {};
async function start(name, extra) {
  const data = path.join(DIR, name), port = await freePort();
  const env = { ...process.env, DATA_DIR: data, PORT: String(port), HOST: '127.0.0.1', UPDATE_CHECK: 'off', RESEND_API_KEY: '', GOOGLE_CLIENT_ID: '', PUBLIC_URL: '',
    PLAID_CLIENT_ID: '', PLAID_SECRET: '', BACKUP_COPY_DIR: '', TRUSTED_PROXY: '', SPLIT_IT_URL: '', ...extra };
  for (const n of ['Ana', 'Ben']) spawnSync(process.execPath, [SERVER, 'add-user', n], { env, input: n.toLowerCase() + '-password\n', encoding: 'utf8' });
  const proc = spawn(process.execPath, [SERVER], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((ok, no) => { let out = ''; const t = setTimeout(() => no(new Error('server did not start: ' + out)), 15000);
    const on = d => { out += d; if (/running at/.test(out)) { clearTimeout(t); ok(); } }; proc.stdout.on('data', on); proc.stderr.on('data', on); proc.on('exit', c => no(new Error('server stopped (' + c + '): ' + out))); });
  apps[name] = { proc, port, base: `http://127.0.0.1:${port}` };
}
const call = async (app, method, url, { body, headers = {}, cookie } = {}) => {
  const r = await fetch(apps[app].base + url, { method, redirect: 'manual',
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  let data = null; const raw = await r.text(); try { data = JSON.parse(raw); } catch {}
  return { status: r.status, data, raw, headers: r.headers, cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
};
const signIn = (app, name, headers = {}) => call(app, 'POST', '/api/login', { body: { name, password: name.toLowerCase() + '-password' }, headers });
let anaA, anaB;

before(async () => {
  await new Promise(ok => fakeSplit.listen(0, '127.0.0.1', ok));
  await start('a', {});
  await start('b', { TRUSTED_PROXY: 'none', PUBLIC_URL: 'https://budget.example.test', SPLIT_IT_URL: `http://127.0.0.1:${fakeSplit.address().port}` });
  anaA = (await signIn('a', 'Ana', { 'X-Forwarded-For': '198.51.100.1' })).cookie; assert.ok(anaA);
  anaB = (await signIn('b', 'Ana')).cookie; assert.ok(anaB);
});
after(async () => {
  for (const { proc } of Object.values(apps)) { const gone = new Promise(r => proc.on('exit', r)); proc.kill(); await gone; }
  fakeSplit.close();
  fs.rmSync(DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// ---------- behind a proxy ----------
test('behind a proxy, each visitor has their own wrong-password limit', async () => {
  // Every request comes from 127.0.0.1, like Traefik at 10.0.2.6: the proxy says who the visitor is.
  const miss = headers => call('a', 'POST', '/api/login', { body: { name: 'Nobody', password: 'nope' }, headers });
  for (let i = 0; i < 5; i++) assert.equal((await miss({ 'X-Forwarded-For': '203.0.113.1' })).status, 401);
  assert.equal((await signIn('a', 'Ben', { 'X-Forwarded-For': '203.0.113.1' })).status, 429, 'that visitor waits');
  assert.equal((await signIn('a', 'Ben', { 'X-Forwarded-For': '203.0.113.2' })).status, 200, 'another visitor isn’t blocked by them');
  assert.equal((await signIn('a', 'Ben')).status, 200, 'nor is the laptop itself');
  // Only the hops the proxies added count: what the visitor wrote further left can't dodge the limit
  assert.equal((await signIn('a', 'Ben', { 'X-Forwarded-For': '192.0.2.77, 203.0.113.1' })).status, 429);
  assert.equal((await signIn('a', 'Ben', { 'X-Forwarded-For': '203.0.113.1, 10.0.2.6, 172.18.0.3' })).status, 429, 'Traefik and cloudflared’s own hops are skipped');
  assert.equal((await signIn('a', 'Ben', { 'X-Forwarded-For': '10.0.2.6' })).status, 200);
  // Cloudflare's header wins over X-Forwarded-For
  assert.equal((await signIn('a', 'Ben', { 'CF-Connecting-IP': '203.0.113.1', 'X-Forwarded-For': '203.0.113.9' })).status, 429);
  assert.equal((await signIn('a', 'Ben', { 'CF-Connecting-IP': '2001:db8::5', 'X-Forwarded-For': '203.0.113.1' })).status, 200);
  assert.equal((await signIn('a', 'Ben', { 'X-Forwarded-For': '[::ffff:203.0.113.1]:4433' })).status, 429, 'the same address written another way');
});

test('with TRUSTED_PROXY=none the proxy’s headers are ignored', async () => {
  const miss = ip => call('b', 'POST', '/api/login', { body: { name: 'Nobody', password: 'nope' }, headers: { 'X-Forwarded-For': ip } });
  for (let i = 0; i < 5; i++) assert.equal((await miss('203.0.113.' + (i + 10))).status, 401);
  assert.equal((await signIn('b', 'Ben', { 'X-Forwarded-For': '203.0.113.99', 'CF-Connecting-IP': '203.0.113.98' })).status, 429, 'all of it counts as the one address it came from');
});

test('laptop commands still refuse anything that came through a proxy', async () => {
  for (const h of [{ 'X-Forwarded-For': '127.0.0.1' }, { 'X-Forwarded-Host': 'localhost' }])
    assert.equal((await call('a', 'POST', '/api/local/cli', { body: { cmd: 'ping' }, headers: { 'X-Local-Token': 'x', ...h } })).status, 404);
});

// ---------- requests from other websites ----------
test('changes only come from Budget it’s own page; tools with no Origin still work', async () => {
  const add = (headers, cookie = anaA, app = 'a') => call(app, 'POST', '/api/op', { body: { op: 'txn.add', args: { amount: 1, m: 'Origin test' } }, headers, cookie });
  const before = (await call('a', 'GET', '/api/state', { cookie: anaA })).data.state.txns.length;
  for (const h of [{ Origin: 'https://evil.example' }, { Origin: 'null' }, { Referer: 'https://evil.example/page' }, { Origin: `http://127.0.0.1:${apps.a.port}.evil.example` }]) {
    const r = await add(h); assert.equal(r.status, 403, JSON.stringify(h)); assert.match(r.data.error, /another website/);
  }
  assert.equal((await call('a', 'GET', '/api/state', { cookie: anaA })).data.state.txns.length, before, 'nothing was added');
  assert.equal((await add({})).status, 200, 'no Origin or Referer: curl, scripts');
  assert.equal((await add({ Origin: apps.a.base })).status, 200, 'its own page');
  assert.equal((await add({ Referer: apps.a.base + '/' })).status, 200);
  assert.equal((await add({ Origin: 'https://budget.example.com', 'X-Forwarded-Host': 'budget.example.com', 'X-Forwarded-Proto': 'https' })).status, 200, 'its own page behind a proxy');
  assert.equal((await add({ Origin: 'https://budget.example.test' }, anaB, 'b')).status, 200, 'its PUBLIC_URL');
  assert.equal((await add({ Origin: 'https://evil.example' }, anaB, 'b')).status, 403);
  assert.equal((await call('a', 'GET', '/api/state', { cookie: anaA, headers: { Origin: 'https://evil.example' } })).status, 200, 'reading is left alone');
  assert.equal((await call('a', 'POST', '/api/login', { body: { name: 'Ben', password: 'ben-password' }, headers: { Origin: 'https://evil.example' } })).status, 403, 'no signing in from another site either');
  // AI assistants call these from their own sites
  const reg = await call('a', 'POST', '/oauth/register', { body: { redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], client_name: 'Test' }, headers: { Origin: 'https://claude.ai' } });
  assert.notEqual(reg.status, 403); assert.ok(reg.status < 300, 'an assistant can register: ' + reg.raw);
  assert.equal((await call('a', 'POST', '/mcp', { body: { jsonrpc: '2.0', id: 1, method: 'tools/list' }, headers: { Origin: 'https://claude.ai' } })).status, 401, 'asks for a key, not refused as another site');
});

// ---------- the Split it address ----------
test('Split it can’t be pointed at the laptop’s own network unless SPLIT_IT_URL names it', async () => {
  const connect = (url, app = 'a', cookie = anaA) => call(app, 'POST', '/api/splitit/connect', { body: { url, key: KEY }, cookie });
  const n = splitCalls.length;
  for (const url of [`http://127.0.0.1:${fakeSplit.address().port}`, 'http://example.com', 'https://localhost:8080', 'https://app.localhost', 'https://127.0.0.1', 'https://2130706433',
    'https://10.0.2.6', 'https://192.168.1.1', 'https://172.17.0.1', 'https://169.254.169.254', 'https://100.100.100.100', 'https://0.0.0.0', 'https://[::1]', 'https://[::ffff:127.0.0.1]', 'https://[fd00::1]', 'https://[fe80::1]']) {
    const r = await connect(url); assert.equal(r.status, 400, url); assert.match(r.data.error, /SPLIT_IT_URL|https/, url);
  }
  // a name that leads to a private address: this computer's own name usually does
  const host = os.hostname(); let mine = [];
  try { mine = await dns.promises.lookup(host, { all: true }); } catch {}
  if (mine.length && mine.every(a => /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|f[cd]|fe[89ab])/i.test(a.address))) {
    const r = await connect(`https://${host}`); assert.equal(r.status, 400); assert.match(r.data.error, /home network/);
  }
  assert.equal(splitCalls.length, n, 'none of those were called');
  // With SPLIT_IT_URL, that Split it works (also when the page leaves the address empty), and nothing else does
  const named = `http://127.0.0.1:${fakeSplit.address().port}`;
  let r = await connect(named + '/', 'b', anaB); assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.splititUrl, named, 'the page fills the address in');
  r = await connect('', 'b', anaB); assert.equal(r.status, 200, JSON.stringify(r.data));
  r = await connect('https://split.example.com', 'b', anaB); assert.equal(r.status, 400); assert.match(r.data.error, /only connects to the Split it at/);
  assert.equal(splitCalls.length, n + 2);
});

// ---------- text that looks like HTML ----------
const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const esc = vm.runInNewContext(/\nconst esc = (s => [^\n]+);\n/.exec(PAGE)[1]);
const NASTY = ['<img src=x onerror=alert(1)>', '"><script>alert(1)</script>', "'><svg onload=alert(1)>"];

test('the page’s esc() turns HTML into plain text', () => {
  for (const s of NASTY) { const e = esc(s); assert.doesNotMatch(e, /[<>"']/); assert.equal(e.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&'), s); }
  assert.equal(esc(null), ''); assert.equal(esc(0), '0');
});

test('every name and note people type is put on the page through esc()', () => {
  // A plain ${x.name} (or .m, .note...) in the page's HTML would show someone's text as HTML. (md.m is the guide's mood.)
  const fields = /^[\w$.[\]?]*\.(m|n|name|note|match|sym|inst|owner|sentTo|tag|title|email|pendingEmail|googleEmail|to|owed|line)$/;
  const lines = PAGE.split('\n'), bad = [];
  lines.forEach((l, i) => { for (const [, e] of l.matchAll(/\$\{([^{}]*)\}/g)) if (fields.test(e.trim()) && e.trim() !== 'md.m' && !/\b(toast|confirmTap)\(/.test(l)) bad.push(`line ${i + 1}: \${${e}}`); });
  assert.deepEqual(bad, [], 'put these through esc()');
});

test('names and notes with HTML in them come back as plain text the page escapes', async () => {
  const op = (o, args) => call('a', 'POST', '/api/op', { body: { op: o, args }, cookie: anaA });
  const [a, b, c] = NASTY;
  let r = await op('txn.add', { amount: 3, m: a, note: b, c: 'groceries' }); assert.equal(r.status, 200);
  const t = r.data.state.txns.find(x => x.m === a);
  assert.equal((await op('txn.update', { id: t.id, tags: c })).status, 200);
  for (const [o, args] of [['cat.add', { name: a.slice(0, 24) }], ['goal.add', { n: b, target: 100 }], ['bill.add', { n: c, amount: 20, d: 3 }],
    ['account.add', { name: a, type: 'Investment' }], ['rule.save', { match: b, cat: 'fun' }], ['csv.import', { text: `2026-01-02,"${b.replace(/"/g, '""')}",-4.00`, name: c }]]) {
    r = await op(o, args); assert.equal(r.status, 200, o + ': ' + JSON.stringify(r.data));
  }
  const acct = r.data.state.accounts.find(x => x.name === a);
  r = await op('holding.save', { acct: acct.id, sym: 'X', name: b, qty: 1, price: 2 }); assert.equal(r.status, 200, JSON.stringify(r.data));
  const st = await call('a', 'GET', '/api/state', { cookie: anaA });
  assert.match(st.headers.get('content-type'), /^application\/json/); assert.equal(st.headers.get('x-content-type-options'), 'nosniff');
  // The JSON keeps the text as it was typed (so it reads right everywhere); it's the page's job to escape it.
  const s = st.data.state, texts = [
    ...s.txns.flatMap(x => [x.m, x.note, ...(x.tags || [])]), ...s.cats.map(x => x.name), ...s.goals.map(x => x.n), ...s.myBills.map(x => x.n),
    ...s.accounts.flatMap(x => [x.name, ...(x.holdings || []).flatMap(h => [h.sym, h.name])]), ...s.rules.map(x => x.match)].filter(Boolean);
  for (const want of [a, b, c, a.slice(0, 24)]) assert.ok(texts.includes(want), 'kept as typed: ' + want);
  assert.ok(texts.some(x => x.includes('<')), 'the test really did store HTML-looking text');
  for (const x of texts) assert.doesNotMatch(esc(x), /[<>"']/, x);
});

// ---------- spreadsheet formulas in the export ----------
test('the CSV export never starts a text cell with a formula', async () => {
  const st = { accounts: [{ id: 'k', name: '=HYPERLINK("http://evil")' }], cats: [], catNames: {}, rules: [], txns: [
    { id: '1', date: '2026-01-02', acct: 'k', m: '=1+2', a: -12.5, c: 'fun', note: '+cmd', tags: ['x'] },
    { id: '2', date: '2026-01-03', acct: 'cash', m: '@SUM(A1)', a: 40, c: 'income', note: '-oops' },
    { id: '3', date: '2026-01-04', acct: 'cash', m: '\tTab', a: -1, c: 'fun', note: '\rCR' },
    { id: '4', date: '2026-01-05', acct: 'cash', m: 'Coffee - large', a: -3, c: 'dining', note: '' }] };
  B.useCats(st);
  const rows = B.toCsv(st).trim().split('\n').slice(1);
  assert.equal(rows[0], `2026-01-02,'=1+2,-12.50,Fun,"'=HYPERLINK(""http://evil"")",'+cmd,x,yes`);
  assert.equal(rows[1], `2026-01-03,'@SUM(A1),40.00,Income,Cash,'-oops,,yes`);
  assert.ok(rows[2].startsWith("2026-01-04,'\tTab,-1.00,"), 'negative amounts stay numbers');
  assert.match(rows[2], /,"'\rCR",/);
  assert.equal(rows[3], '2026-01-05,Coffee - large,-3.00,Dining out,Cash,,,yes');
  // and through the server
  await call('a', 'POST', '/api/op', { body: { op: 'txn.add', args: { amount: 2, m: '=cmd|"/c calc"!A1' } }, cookie: anaA });
  const csv = await call('a', 'GET', '/api/export.csv', { cookie: anaA });
  assert.match(csv.raw, /,"'=cmd\|""\/c calc""!A1",-2\.00,/);
  assert.doesNotMatch(csv.raw, /(^|,)"?[=+@]/m);
});
