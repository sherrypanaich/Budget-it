// An attacker's view of the newer parts: addresses behind a proxy, the assistant sign-in, backups copied off the
// laptop, and what one person can reach of another's. Against the real server on a spare port.
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const SERVER = path.join(__dirname, '..', 'server.js');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-it-security-'));
const DATA = path.join(DIR, 'data'), COPIES = path.join(DIR, 'copies'), OAUTH = path.join(DATA, 'oauth.json');
let PORT, base, proc, env, ana = '', ben = '', addr = 0;
const freePort = () => new Promise(ok => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const cli = (args, input = '', e = env) => { const r = spawnSync(process.execPath, [SERVER, ...args], { env: e, input, encoding: 'utf8' }); return (r.stdout || '') + (r.stderr || ''); };
const ip = () => `10.8.${++addr >> 8}.${addr & 255}`;   // behind the (trusted) proxy, each caller its own address
async function call(method, p, body, cookie = '', headers = {}) {
  const form = body instanceof URLSearchParams;
  const r = await fetch(base + p, { method, redirect: 'manual', headers: { 'X-Forwarded-For': headers.ip || ip(), ...(body !== undefined ? { 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: body === undefined ? undefined : form ? body : JSON.stringify(body) });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  return { status: r.status, body: j, headers: r.headers };
}
const login = async (name, password, from) => { const r = await call('POST', '/api/login', { name, password }, '', from ? { ip: from } : {}); return r.status === 200 ? r.headers.get('set-cookie').split(';')[0] : r; };
const pkce = () => { const verifier = crypto.randomBytes(32).toString('base64url'); return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') }; };
const register = (uris, from = ip()) => call('POST', '/oauth/register', { client_name: 'Test', redirect_uris: uris }, '', { ip: from });
const rpc = async (key, body) => (await call('POST', '/mcp', body, '', { Authorization: 'Bearer ' + key })).body;
const tool = async (key, name, args = {}) => (await rpc(key, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })).result;
const keyFor = (name, extra) => /(bik_[A-Za-z0-9_-]+)/.exec(cli(['mcp-key', name, ...(extra ? [extra] : [])]))[1];
const waitFor = (p, re) => new Promise((ok, no) => { let out = ''; const t = setTimeout(() => no(new Error('no start: ' + out)), 15000);
  const on = d => { out += d; if (re.test(out)) { clearTimeout(t); ok(out); } }; p.stdout.on('data', on); p.stderr.on('data', on); p.on('exit', c => { clearTimeout(t); no(new Error('exited ' + c + ': ' + out)); }); });

before(async () => {
  PORT = await freePort(); base = `http://127.0.0.1:${PORT}`;
  env = { ...process.env, DATA_DIR: DATA, PORT: String(PORT), HOST: '127.0.0.1', UPDATE_CHECK: 'off', RESEND_API_KEY: '', GOOGLE_CLIENT_ID: '', PUBLIC_URL: '',
    PLAID_CLIENT_ID: '', PLAID_SECRET: '', SPLIT_IT_URL: '', TRUSTED_PROXY: '', BACKUP_COPY_DIR: COPIES, BACKUP_PASSPHRASE: '' };
  cli(['add-user', 'Ana'], 'ana-password\n'); cli(['add-user', 'Ben'], 'ben-password\n');
  // A key made earlier (a Split it link that was tried and dropped), with nothing sealed by it right now
  fs.writeFileSync(path.join(DATA, 'secret.key'), crypto.randomBytes(32).toString('base64'), { mode: 0o600 });
  proc = spawn(process.execPath, [SERVER], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  await waitFor(proc, /running at/);
  ana = await login('Ana', 'ana-password'); ben = await login('Ben', 'ben-password');
  assert.equal(typeof ana, 'string'); assert.equal(typeof ben, 'string');
});
after(async () => { if (!proc) return; const gone = new Promise(r => proc.on('exit', r)); proc.kill(); await gone; fs.rmSync(DIR, { recursive: true, force: true }); });

test('an unlocked copy off the laptop never holds secret.key, even before anything is sealed with it', async () => {
  const { zipRead } = require('../server.js');
  const copies = fs.readdirSync(COPIES).filter(f => f.endsWith('.zip'));
  assert.equal(copies.length, 1, String(copies));
  const files = zipRead(fs.readFileSync(path.join(COPIES, copies[0])));
  assert.ok(files['db.json']);
  assert.ok(!files['secret.key'], 'the key seals every bank connected later, so a copy anyone can open must not carry it');
  // The owner’s own download is still the whole thing
  const r = await fetch(base + '/api/admin/backup', { headers: { Cookie: ana } });
  assert.ok('secret.key' in zipRead(Buffer.from(await r.arrayBuffer())));
});

test('a TRUSTED_PROXY entry with an impossible prefix is skipped, not a crash at start', async () => {
  const port = await freePort(), data = path.join(DIR, 'proxy-start');
  const p = spawn(process.execPath, [SERVER], { env: { ...env, DATA_DIR: data, PORT: String(port), BACKUP_COPY_DIR: '', TRUSTED_PROXY: '10.0.0.0/99, 203.0.113.7, ::/200' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = await waitFor(p, /running at/);
  assert.match(out, /10\.0\.0\.0\/99 isn’t an address/);
  const gone = new Promise(r => p.on('exit', r)); p.kill(); await gone;
});

test('wrong passwords from one IPv6 network count together, so hopping addresses inside it doesn’t help', async () => {
  for (let i = 1; i <= 5; i++) assert.equal((await call('POST', '/api/login', { name: 'Nobody', password: 'x' }, '', { ip: `2001:db8:5:7::${i}` })).status, 401);
  const r = await login('Ana', 'ana-password', '2001:db8:5:7:ffff::99');
  assert.equal(r.status, 429, 'the same /64 is the same visitor');
  assert.equal(typeof await login('Ana', 'ana-password', '2001:db8:5:8::1'), 'string', 'the next network over is someone else');
});

test('apps registered from one IPv6 network count together', async () => {
  for (let i = 1; i <= 20; i++) assert.equal((await register(['https://claude.ai/cb'], `2001:db8:9:9::${i.toString(16)}`)).status, 201);
  assert.equal((await register(['https://claude.ai/cb'], '2001:db8:9:9:1:2:3:4')).status, 429);
});

test('the assistant sign-in page never sends someone straight on to an address it hasn’t shown them', async () => {
  const c = (await register(['https://evil.example/landing'])).body.client_id, { challenge } = pkce();
  const q = (o = {}) => '/oauth/authorize?' + new URLSearchParams({ response_type: 'code', client_id: c, redirect_uri: 'https://evil.example/landing', state: 's', code_challenge: challenge, code_challenge_method: 'S256', ...o });
  for (const bad of [q({ response_type: 'token' }), q({ code_challenge: '' }), q({ code_challenge_method: 'plain' })]) {
    const r = await call('GET', bad);
    assert.equal(r.status, 400, bad); assert.equal(r.headers.get('location'), null, 'an open redirect on this site’s own address');
  }
  // the same from a form on another site
  const r = await call('POST', '/oauth/authorize', new URLSearchParams({ client_id: c, redirect_uri: 'https://evil.example/landing', response_type: 'code' }), '', { Origin: 'https://evil.example' });
  assert.equal(r.headers.get('location'), null);
  // a normal start still shows the page
  assert.equal((await call('GET', q())).status, 200);
});

test('registering an app: return addresses are limited in length, and unsafe kinds are refused', async () => {
  assert.equal((await register(['https://claude.ai/' + 'a'.repeat(5000)])).status, 400);
  for (const u of ['javascript:alert(1)', ' JavaScript:alert(1)', 'data:text/html,x', 'http://evil.example/cb', 'http://localhost.evil.example/cb', 'file:///etc/passwd'])
    assert.equal((await register([u])).status, 400, u);
  assert.equal((await register(['http://127.0.0.1:3000/cb', 'myapp://callback'])).status, 201);
});

test('a broken Basic sign-in on the token endpoint is a refusal, not a crash', async () => {
  const r = await call('POST', '/oauth/token', new URLSearchParams({ grant_type: 'refresh_token', refresh_token: 'x' }), '', { Authorization: 'Basic ' + Buffer.from('%zz:%zz').toString('base64') });
  assert.equal(r.status, 401);
  for (const id of ['__proto__', 'constructor', 'toString']) {
    assert.equal((await call('POST', '/oauth/token', new URLSearchParams({ grant_type: 'authorization_code', code: 'x', client_id: id }))).status, 401, id);
    assert.equal((await call('GET', '/oauth/authorize?client_id=' + id)).status, 400, id);
  }
});

test('data/oauth.json is readable only by the laptop’s user', () => {
  assert.equal(fs.statSync(OAUTH).mode & 0o077, 0);
});

test('opening the Allow page again and again doesn’t pile up one-tap tokens', async () => {
  const c = (await register(['https://claude.ai/cb'])).body.client_id, { challenge } = pkce();
  const q = '/oauth/authorize?' + new URLSearchParams({ response_type: 'code', client_id: c, redirect_uri: 'https://claude.ai/cb', state: 's', code_challenge: challenge, code_challenge_method: 'S256' });
  for (let i = 0; i < 40; i++) assert.equal((await call('GET', q, undefined, ben)).status, 200);
  const benId = JSON.parse(fs.readFileSync(path.join(DATA, 'users.json'), 'utf8'));
  const uid = Object.entries(benId.users).find(([, u]) => u.name === 'Ben')[0];
  const forms = Object.values(JSON.parse(fs.readFileSync(OAUTH, 'utf8')).forms).filter(f => f.uid === uid);
  assert.ok(forms.length <= 20, String(forms.length));
  // and the newest one still works
  const page = (await call('GET', q, undefined, ben)).body, form = /name="form" value="([^"]+)"/.exec(page)[1];
  const r = await call('POST', '/oauth/authorize', new URLSearchParams({ response_type: 'code', client_id: c, redirect_uri: 'https://claude.ai/cb', state: 's', code_challenge: challenge, code_challenge_method: 'S256', form, allow: '1' }), ben);
  assert.equal(r.status, 302); assert.match(r.headers.get('location'), /^https:\/\/claude\.ai\/cb\?code=/);
});

test('a read-only key refuses every tool that changes something, including ones added later', async () => {
  const full = keyFor('Ana'), ro = keyFor('Ana', '--read-only');
  const all = (await rpc(full, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).result.tools;
  const writes = all.filter(t => !t.annotations?.readOnlyHint);
  assert.ok(writes.length >= 8);
  const shown = (await rpc(ro, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).result.tools.map(t => t.name);
  const before = (await call('GET', '/api/state', undefined, ana)).body.state;
  for (const t of writes) {
    assert.ok(!shown.includes(t.name), t.name);
    const r = await tool(ro, t.name, { id: 'x', category: 'dining', amount: 5, what: 'Coffee', goal: 'x', name: 'x', target: 5, symbol: 'x', price: 1 });
    assert.equal(r.isError, true, t.name); assert.match(r.content[0].text, /read only/, t.name);
  }
  const after = (await call('GET', '/api/state', undefined, ana)).body.state;
  assert.deepEqual(after.txns, before.txns); assert.deepEqual(after.goals, before.goals); assert.deepEqual(after.budgets, before.budgets);
});

test('a batch of assistant calls is capped', async () => {
  const key = keyFor('Ben');
  const big = Array.from({ length: 51 }, (_, i) => ({ jsonrpc: '2.0', id: i, method: 'ping' }));
  const r = await rpc(key, big);
  assert.ok(!Array.isArray(r) || r.length === 1, 'a huge batch is refused as a whole');
  assert.match(JSON.stringify(r), /Too many/);
  const ok = await rpc(key, big.slice(0, 5));
  assert.equal(ok.length, 5);
});

test('the same cash purchase twice in a row is taken as a retry, unless the assistant says it really is a second one', async () => {
  const key = keyFor('Ben'), args = { amount: 4.25, what: 'Bus fare', category: 'transport' };
  assert.doesNotMatch((await tool(key, 'add_cash_purchase', args)).content[0].text, /Already/);
  const again = (await tool(key, 'add_cash_purchase', args)).content[0].text;
  assert.match(again, /Already added/); assert.match(again, /again/);
  assert.doesNotMatch((await tool(key, 'add_cash_purchase', { ...args, again: true })).content[0].text, /Already/);
  const fares = (await call('GET', '/api/state', undefined, ben)).body.state.txns.filter(t => t.m === 'Bus fare');
  assert.equal(fares.length, 2);
});

test('someone who can see a shared account can’t change it or its charges', async () => {
  const day = (await call('GET', '/api/state', undefined, ana)).body.today;
  const add = await call('POST', '/api/op', { op: 'csv.import', args: { name: 'Joint cash', text: `Date,Description,Amount\n${day},Snacks,-9.00\n` } }, ana);
  assert.equal(add.status, 200, JSON.stringify(add.body));
  const acct = add.body.state.accounts.find(a => a.name === 'Joint cash');
  const benId = add.body.people.find(p => p.name === 'Ben').id;
  assert.equal((await call('POST', '/api/op', { op: 'account.share', args: { id: acct.id, with: [benId, '__proto__', 'constructor'] } }, ana)).status, 200);
  const anaState = (await call('GET', '/api/state', undefined, ana)).body.state;
  assert.deepEqual(anaState.accounts.find(a => a.id === acct.id).shared, [benId], 'only real people are kept');
  const seen = (await call('GET', '/api/state', undefined, ben)).body.state;
  const theirs = seen.accounts.find(a => a.other && a.name === 'Joint cash'), tx = seen.txns.find(t => t.other && t.m === 'Snacks');
  assert.ok(theirs && tx);
  for (const [op, args] of [['account.rename', { id: theirs.id, name: 'Mine now' }], ['account.share', { id: theirs.id, with: [] }], ['account.delete', { id: theirs.id }],
    ['txn.update', { id: tx.id, c: 'fun' }], ['txn.delete', { id: tx.id }], ['account.balance', { id: theirs.id, bal: 0 }]]) {
    assert.notEqual((await call('POST', '/api/op', { op, args }, ben)).status, 200, op);
  }
  const still = (await call('GET', '/api/state', undefined, ana)).body.state;
  assert.equal(still.accounts.find(a => a.id === acct.id).name, 'Joint cash');
  assert.ok(still.txns.find(t => t.m === 'Snacks' && t.c !== 'fun'));
});

test('owner tools refuse ids that aren’t people', async () => {
  for (const id of ['__proto__', 'constructor', 'hasOwnProperty'])
    assert.equal((await call('POST', '/api/admin/rename', { id, name: 'Polluted' }, ana)).status, 404, id);
  const st = (await call('GET', '/api/state', undefined, ana)).body;
  assert.ok(!st.people.some(p => p.name === 'Polluted'));
});

test('a damaged or oversized zip is refused in plain words, not unpacked without limit', () => {
  const { zipRead, zipWrite } = require('../server.js');
  const good = zipWrite([{ name: 'db.json', data: Buffer.from('{}') }]);
  assert.throws(() => zipRead(good.subarray(0, good.length - 30)), /isn’t a zip|damaged/);
  // a deflated entry that grows past the limit
  const big = zlib.deflateRawSync(Buffer.alloc(3e6));
  const z = Buffer.from(zipWrite([{ name: 'db.json', data: big }]));
  const cd = z.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); z.writeUInt16LE(8, cd + 10); z.writeUInt16LE(8, 8);
  assert.equal(zipRead(z)['db.json'].length, 3e6);
  assert.throws(() => zipRead(z, 1e6), /too big/);
});

// Last: it deletes Ben
test('deleting your data also ends the invite links you sent', async () => {
  const inv = await call('POST', '/api/invite', {}, ben);
  assert.equal(inv.status, 200);
  assert.equal((await call('POST', '/api/me/delete', { name: 'Ben' }, ben)).status, 200);
  const r = await call('POST', '/api/join', { token: inv.body.token });
  assert.equal(r.status, 410, 'someone gone can’t keep bringing people in');
});
