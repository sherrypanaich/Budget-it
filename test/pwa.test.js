// The installed phone app: the service worker (updates, offline, the laptop asleep), the manifest and iPhone tags,
// changes sent again after a lost answer, and phone notifications end to end against a fake push service. Run with: node --test
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const vm = require('vm');

const PUB = f => path.join(__dirname, '..', 'public', f);
const read = f => fs.readFileSync(PUB(f), 'utf8');

// ---------- the service worker, run with stand-ins for the browser's caches and network ----------
function worker(net) {
  const stores = new Map(), on = {};
  const key = r => typeof r === 'string' ? new URL(r, 'http://app.test').pathname : new URL(r.url).pathname;
  const store = name => { if (!stores.has(name)) stores.set(name, new Map()); const m = stores.get(name);
    return { put: async (r, res) => { m.set(key(r), res); }, match: async r => m.get(key(r))?.clone(), keys: async () => [...m.keys()],
      add: async u => { const r = await net(u); if (!r.ok) throw new Error('bad'); m.set(key(u), r); } }; };
  const caches = { open: async n => store(n), keys: async () => [...stores.keys()], delete: async n => stores.delete(n),
    match: async r => { for (const n of stores.keys()) { const hit = await store(n).match(r); if (hit) return hit; } } };
  const self = { location: { origin: 'http://app.test' }, addEventListener: (t, f) => { on[t] = f; }, skipWaiting() {}, clients: { claim: async () => {} }, registration: {} };
  vm.runInNewContext(read('sw.js'), { self, caches, fetch: (r) => net(typeof r === 'string' ? r : r.url), Response, Headers, URL, Promise, console });
  const fire = async (type, e) => { let p = null; const waits = []; on[type]({ ...e, respondWith: x => { p = x; }, waitUntil: x => waits.push(x) }); await Promise.all(waits); return p && await p; };
  const get = (p, mode) => fire('fetch', { request: { url: 'http://app.test' + p, method: 'GET', mode: mode || 'cors' } });
  return { stores, caches, fire, get, on };
}
const answer = (body, status = 200, type = 'text/html') => { const r = new Response(body, { status, headers: { 'Content-Type': type } }); Object.defineProperty(r, 'type', { value: 'basic' }); return r; };

test('the phone app keeps its code for offline use, page first from the laptop so updates arrive on the next open', async () => {
  let mode = 'up', asked = [];
  const w = worker(async u => { asked.push(new URL(u, 'http://app.test').pathname);
    if (mode === 'off') throw new TypeError('Failed to fetch');
    if (mode === 'asleep') return answer('<h1>502 Bad Gateway</h1>', 502);   // the tunnel's page while the laptop is off
    return answer(mode === 'new' ? 'new page' : 'page ' + new URL(u, 'http://app.test').pathname, 200, /\.js$/.test(u) ? 'text/javascript' : /api/.test(u) ? 'application/json' : 'text/html'); });
  await w.fire('install', {});
  // everything a phone needs to make changes offline, ops.js too (it was missing: offline changes failed after a reload)
  const shell = [...w.stores.keys()].find(k => /shell/.test(k));
  for (const f of ['/budget.js', '/ops.js', '/sample.js', '/qr.js', '/manifest.webmanifest', '/']) assert.ok(w.stores.get(shell).has(f), f + ' kept');
  // an older version's copies are dropped once this one starts
  w.stores.set('budget-it-shell-v1', new Map([['/', 'old']]));
  await w.fire('activate', {});
  assert.ok(!w.stores.has('budget-it-shell-v1'), 'old copies dropped'); assert.ok(w.stores.has(shell));
  // online: the page comes from the laptop each time, so a new version shows on the next open
  assert.equal(await (await w.get('/', 'navigate')).text(), 'page /');
  mode = 'new'; assert.equal(await (await w.get('/', 'navigate')).text(), 'new page', 'never an old copy while the laptop answers');
  assert.equal(await (await w.get('/ops.js')).text(), 'new page');
  // offline: the last copy, marked as one
  mode = 'off';
  const off = await w.get('/', 'navigate'); assert.equal(await off.text(), 'new page'); assert.equal(off.headers.get('X-From-Cache'), '1');
  assert.equal(await (await w.get('/ops.js')).text(), 'new page', 'the code to make changes offline is there');
  // the laptop asleep behind the tunnel: the app, not a 502 page
  mode = 'asleep';
  const slept = await w.get('/', 'navigate'); assert.equal(await slept.text(), 'new page'); assert.equal(slept.headers.get('X-From-Cache'), '1');
  const login = await w.get('/login', 'navigate'); assert.equal(login.status, 503); assert.match(await login.text(), /Can’t reach Budget it/, 'a friendly page when nothing is kept');
  mode = 'up'; await w.get('/api/state'); mode = 'asleep';
  const st = await w.get('/api/state'); assert.equal(st.headers.get('X-From-Cache'), '1', 'the last budget, marked as a copy');
  // signing out drops the copy of the budget
  await w.fire('message', { data: 'clear-data' });
  assert.ok(![...w.stores.keys()].some(k => /data/.test(k)), 'no copy of the budget left');
  // a request to anywhere else, or a change, is never touched
  asked = []; assert.equal(await w.fire('fetch', { request: { url: 'http://app.test/api/op', method: 'POST', mode: 'cors' } }), null);
  assert.equal(await w.fire('fetch', { request: { url: 'https://fonts.googleapis.com/x', method: 'GET', mode: 'cors' } }), null);
  assert.deepEqual(asked, []);
});

test('the page offers a reload once the laptop runs a newer version, and prefers its own offline copy', () => {
  const page = read('index.html');
  const sv = page.slice(page.indexOf('let PAGE_VER'), page.indexOf('const store = {'));
  const body = { children: [], appendChild(d) { this.children.push(d); } }, els = {};
  const ctx = vm.createContext({ esc: x => String(x), location: { reload() { ctx.reloaded = true; } },
    document: { body, getElementById: id => body.children.find(d => d.id === id) || null,
      createElement: () => { const d = { setAttribute() {}, querySelector: () => d.btn }; d.btn = {}; return d; } } });
  vm.runInContext(sv + ';this.seeVersion = seeVersion;', ctx);
  ctx.seeVersion('1.1.0'); ctx.seeVersion('1.1.0');
  assert.equal(body.children.length, 0, 'same version, nothing to say');
  ctx.seeVersion('1.2.0'); ctx.seeVersion('1.2.0');
  assert.equal(body.children.length, 1, 'said once');
  assert.match(body.children[0].innerHTML, /A new version of Budget it is ready \(v1\.2\.0\)/);
  body.children[0].btn.onclick(); assert.ok(ctx.reloaded);
  assert.match(page, /function setView\(v\) \{[^\n]*if \(LAPTOP\) seeVersion\(v\.version\)/, 'every answer from the laptop is checked');
  // the worker's copy of the budget is older than the one kept on the phone with changes made offline
  assert.match(page, /if \(r\.headers\.get\('X-From-Cache'\)\) \{ swCopy = /);
  assert.match(page, /const cached = store\.get\('bi-view'\) \|\| swCopy;/);
  assert.match(page, /r\.ok && !r\.headers\.get\('X-From-Cache'\)/, 'a refresh never puts an older copy on screen');
  // back after a restart (an update) or a dropped connection: catch up
  assert.match(page, /es\.onopen = \(\) => \{ if \(lost\)/);
});

test('the manifest and iPhone tags make an installable app that matches light and dark', () => {
  const m = JSON.parse(read('manifest.webmanifest'));
  assert.equal(m.id, '/'); assert.equal(m.start_url, '/'); assert.equal(m.scope, '/'); assert.equal(m.display, 'standalone');
  assert.ok(m.name && m.short_name && m.short_name.length <= 12);
  assert.match(m.theme_color, /^#[0-9A-F]{6}$/i); assert.match(m.background_color, /^#[0-9A-F]{6}$/i);
  const sizes = m.icons.filter(i => i.type === 'image/png').map(i => i.sizes);
  assert.ok(sizes.includes('192x192') && sizes.includes('512x512'), 'the two sizes Android asks for');
  assert.ok(m.icons.some(i => /maskable/.test(i.purpose || '')), 'a maskable icon');
  for (const i of m.icons) assert.ok(fs.existsSync(PUB(i.src.replace(/^\//, ''))), i.src + ' is there');
  for (const s of m.shortcuts || []) assert.match(s.url, /^\/(\?|$)/, 'shortcuts stay inside the app');
  for (const f of ['index.html', 'login.html']) {
    const h = read(f);
    assert.match(h, /<meta name="theme-color" content="#[0-9A-F]{6}" media="\(prefers-color-scheme: light\)">/i, f + ' light');
    assert.match(h, /<meta name="theme-color" content="#[0-9A-F]{6}" media="\(prefers-color-scheme: dark\)">/i, f + ' dark');
    assert.match(h, /<meta name="apple-mobile-web-app-capable" content="yes">/, f);
    assert.match(h, /<meta name="apple-mobile-web-app-title" content="Budget it">/, f);
    assert.match(h, /<meta name="apple-mobile-web-app-status-bar-style" content="default">/, f);
    assert.match(h, /<link rel="apple-touch-icon"(?: sizes="180x180")? href="\/?apple-touch-icon\.png(?:\?v=\d+)?">/, f);
    assert.match(h, /<link rel="manifest" href="\/?manifest\.webmanifest">/, f);
  }
  assert.equal(m.background_color.toUpperCase(), read('index.html').match(/--bg:(#[0-9A-F]{6})/i)[1].toUpperCase(), 'the splash matches the page');
});

// ---------- the real server, with a stand-in for the browsers' push services ----------
// A preload replaces fetch for https://push.test/: it opens each message the way a phone would (RFC 8291) and
// writes it down. An endpoint named gone-... answers 410, like a subscription the phone dropped.
const SERVER = path.join(__dirname, '..', 'server.js');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-it-pwa-'));
const DATA = path.join(DIR, 'data'), LOG = path.join(DIR, 'pushes.log'), KEYS = path.join(DIR, 'phones.json'), PRE = path.join(DIR, 'fake-push.js');
fs.writeFileSync(PRE, `'use strict';
const crypto = require('crypto'), fs = require('fs'), real = globalThis.fetch;
const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
globalThis.fetch = async (url, o = {}) => {
  if (!String(url).startsWith('https://push.test/')) return real(url, o);
  const phone = JSON.parse(fs.readFileSync(${JSON.stringify(KEYS)}, 'utf8'))[url], b = Buffer.from(o.body);
  const salt = b.subarray(0, 16), n = b[20], as = b.subarray(21, 21 + n), ct = b.subarray(21 + n);
  const e = crypto.createECDH('prime256v1'); e.setPrivateKey(Buffer.from(phone.priv, 'base64url'));
  const ua = e.getPublicKey(), auth = Buffer.from(phone.auth, 'base64url');
  const ikm = hmac(hmac(auth, e.computeSecret(as)), Buffer.concat([Buffer.from('WebPush: info\\0'), ua, as, Buffer.from([1])])), prk = hmac(salt, ikm);
  const d = crypto.createDecipheriv('aes-128-gcm', hmac(prk, Buffer.from('Content-Encoding: aes128gcm\\0\\x01')).subarray(0, 16), hmac(prk, Buffer.from('Content-Encoding: nonce\\0\\x01')).subarray(0, 12));
  d.setAuthTag(ct.subarray(-16)); const pt = Buffer.concat([d.update(ct.subarray(0, -16)), d.final()]);
  fs.appendFileSync(${JSON.stringify(LOG)}, JSON.stringify({ to: url, msg: JSON.parse(pt.subarray(0, pt.lastIndexOf(2)).toString()), vapid: /^vapid t=/.test(o.headers.Authorization) }) + '\\n');
  return new Response(null, { status: /\\/gone-/.test(url) ? 410 : 201 });
};`);
const phones = {};
function phone(name) {   // a browser's subscription, with keys only it knows
  const e = crypto.createECDH('prime256v1'); e.generateKeys();
  const endpoint = 'https://push.test/' + name, auth = crypto.randomBytes(16).toString('base64url');
  phones[endpoint] = { priv: e.getPrivateKey().toString('base64url'), auth }; fs.writeFileSync(KEYS, JSON.stringify(phones));
  return { endpoint, keys: { p256dh: e.getPublicKey().toString('base64url'), auth } };
}
const pushes = () => { try { return fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
const subsOnDisk = () => JSON.parse(fs.readFileSync(path.join(DATA, 'push.json'), 'utf8')).subs;
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, what) { for (let i = 0; i < 100; i++) { const v = fn(); if (v) return v; await wait(50); } assert.fail('waited for ' + what); }
const freePort = () => new Promise(res => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
let PORT, proc, env, addr = 0;
async function as(name) {
  const from = `10.8.0.${++addr}`; let cookie = '';
  const call = async (method, url, body, headers = {}) => {
    const r = await fetch(`http://127.0.0.1:${PORT}${url}`, { method, redirect: 'manual', headers: { 'X-Forwarded-For': from, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = r.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    return { status: r.status, headers: r.headers, data: await r.json().catch(() => null) };
  };
  const me = { get: (u, h) => call('GET', u, undefined, h), post: (u, b = {}) => call('POST', u, b), op: (op, args, qid) => call('POST', '/api/op', { op, args, qid }) };
  assert.equal((await me.post('/api/login', { name, password: name.toLowerCase() + '-password' })).status, 200);
  me.uid = (await me.get('/api/state')).data.me.id;
  return me;
}
let ana, ben;
before(async () => {
  PORT = await freePort();
  env = { ...process.env, DATA_DIR: DATA, PORT: String(PORT), HOST: '127.0.0.1', UPDATE_CHECK: 'off', RESEND_API_KEY: '', GOOGLE_CLIENT_ID: '', PUBLIC_URL: '', BACKUP_COPY_DIR: '', BACKUP_PASSPHRASE: '', PLAID_CLIENT_ID: '', PLAID_SECRET: '' };
  for (const n of ['Ana', 'Ben']) spawnSync(process.execPath, [SERVER, 'add-user', n], { env, input: n.toLowerCase() + '-password\n', encoding: 'utf8' });
  fs.writeFileSync(KEYS, '{}');
  proc = spawn(process.execPath, ['--require', PRE, SERVER], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((res, rej) => { let out = ''; const t = setTimeout(() => rej(new Error('server did not start: ' + out)), 15000);
    const on = d => { out += d; if (/running at/.test(out)) { clearTimeout(t); res(); } }; proc.stdout.on('data', on); proc.stderr.on('data', on); proc.on('exit', c => rej(new Error('server stopped early (' + c + '): ' + out))); });
  ana = await as('Ana'); ben = await as('Ben');
});
after(async () => {
  if (proc) { const gone = new Promise(r => proc.on('exit', r)); proc.kill(); await gone; }
  fs.rmSync(DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test('notifications: several phones, one that expired is dropped, a shared phone changes hands, and nobody else’s amounts', async () => {
  const p1 = phone('ana-phone'), p2 = phone('ana-tablet'), dead = phone('gone-ana-old');
  for (const p of [p1, p2]) assert.equal((await ana.post('/api/push/subscribe', p)).status, 200);
  const hello = pushes().filter(x => x.msg.tag === 'test');
  assert.deepEqual(hello.map(x => x.to).sort(), [p1.endpoint, p2.endpoint], 'turning them on says so on that phone only');
  assert.ok(pushes().every(x => x.vapid));
  // the page checking on each open says nothing new
  const n0 = pushes().length;
  assert.equal((await ana.post('/api/push/subscribe', { ...p1, quiet: true })).data.mine, true);
  await wait(200); assert.equal(pushes().length, n0, 'no second hello');
  // a phone whose subscription ended: the push service says 410, and it's dropped
  await ana.post('/api/push/subscribe', dead);
  await until(() => !subsOnDisk()[ana.uid].some(s => s.endpoint === dead.endpoint), 'the expired one dropped');
  assert.deepEqual(subsOnDisk()[ana.uid].map(s => s.endpoint).sort(), [p1.endpoint, p2.endpoint], 'the others stay');
  // Ana's budget nears its limit: both of her phones hear, with her own numbers
  await ana.op('budget.set', { c: 'groceries', amount: 100 });
  const before = pushes().length;
  await ana.op('txn.add', { amount: 90, m: 'Loblaws', c: 'groceries' });
  const got = await until(() => pushes().slice(before).filter(x => x.msg.tag === 'budget-groceries').length === 2 && pushes().slice(before), 'Ana’s nudge');
  assert.ok(got.every(x => x.to.includes('ana-')), 'only to Ana’s phones');
  assert.match(got[0].msg.title, /Groceries is at 90%/); assert.match(got[0].msg.body, /\$10\.00 left/);
  // Ben sees the shared account, but his own budget is his: her charge never shows up in his notifications
  const bp = phone('ben-phone'); await ben.post('/api/push/subscribe', bp);
  await ben.op('budget.set', { c: 'groceries', amount: 100 });
  const day = (await ana.get('/api/state')).data.today;
  await ana.op('csv.import', { text: `Date,Description,Amount\n${day},Big shop,-777.77\n`, name: 'Joint' });
  const joint = (await ana.get('/api/state')).data.state.accounts.find(a => a.name === 'Joint');
  await ana.op('account.share', { id: joint.id, with: [ben.uid] });
  assert.ok((await ben.get('/api/state')).data.state.txns.some(t => t.m === 'Big shop' && t.other), 'Ben does see her shared charge');
  await ben.op('txn.add', { amount: 85, m: 'No Frills', c: 'groceries' });
  await until(() => pushes().some(x => x.to === bp.endpoint && x.msg.tag === 'budget-groceries'), 'Ben’s nudge');
  const bens = pushes().filter(x => x.to === bp.endpoint);
  assert.ok(bens.every(x => !/777|867|Big shop|Loblaws/.test(JSON.stringify(x.msg))), 'nothing of Ana’s in Ben’s');
  assert.match(bens.find(x => x.msg.tag === 'budget-groceries').msg.title, /at 85%/);
  // a shared phone: Ben turns notifications on on Ana's tablet, so it's his now. Ana's page checking quietly doesn't take it back.
  await ben.post('/api/push/subscribe', p2);
  assert.equal((await ana.post('/api/push/subscribe', { ...p2, quiet: true })).data.mine, false);
  assert.ok(subsOnDisk()[ben.uid].some(s => s.endpoint === p2.endpoint) && !subsOnDisk()[ana.uid].some(s => s.endpoint === p2.endpoint));
  // one the laptop lost (a restore): the quiet check puts it back, without a hello
  const n1 = pushes().length, lost = phone('ana-lost');
  assert.equal((await ana.post('/api/push/subscribe', { ...lost, quiet: true })).data.mine, true);
  assert.ok(subsOnDisk()[ana.uid].some(s => s.endpoint === lost.endpoint)); await wait(200); assert.equal(pushes().length, n1);
  // turned off on one phone
  await ana.post('/api/push/unsubscribe', { endpoint: lost.endpoint });
  assert.ok(!subsOnDisk()[ana.uid].some(s => s.endpoint === lost.endpoint));
  // the page signs this phone out of notifications when you sign out
  assert.match(read('index.html'), /async function signOut[\s\S]{0,900}post\('\/api\/push\/unsubscribe', \{ endpoint: sub\.endpoint \}, true\), sub\.unsubscribe\(\)/);
  // and the service worker passes on a renewed subscription quietly
  assert.match(read('sw.js'), /addEventListener\('pushsubscriptionchange'[\s\S]*quiet: true/);
});

test('a change sent again from the offline list after a lost answer is saved once', async () => {
  const count = async () => (await ana.get('/api/state')).data.state.txns.filter(t => t.m === 'Corner store').length;
  assert.equal((await ana.op('txn.add', { amount: 4.25, m: 'Corner store', c: 'dining' }, 'q-lost-1')).status, 200);
  const again = await ana.op('txn.add', { amount: 4.25, m: 'Corner store', c: 'dining' }, 'q-lost-1');
  assert.equal(again.status, 200); assert.ok(again.data.state, 'answers with the budget as usual');
  assert.equal(await count(), 1);
  await ana.op('txn.add', { amount: 4.25, m: 'Corner store', c: 'dining' }, 'q-lost-2');
  await ana.op('txn.add', { amount: 4.25, m: 'Corner store', c: 'dining' });   // without an id, every one counts
  assert.equal(await count(), 3);
  // ids are per person: Ben's own list can't block Ana's
  await ben.op('txn.add', { amount: 1, m: 'Corner store', c: 'dining' }, 'q-lost-3');
  await ana.op('txn.add', { amount: 4.25, m: 'Corner store', c: 'dining' }, 'q-lost-3');
  assert.equal(await count(), 4);
});

test('updates reach phones: the code and manifest are checked every time, and signing out clears the browser’s cache', async () => {
  for (const f of ['/sw.js', '/qr.js', '/manifest.webmanifest']) assert.equal((await ana.get(f)).headers.get('cache-control'), 'no-cache', f);
  for (const f of ['/budget.js', '/ops.js', '/sample.js']) assert.equal((await ana.get(f)).headers.get('cache-control'), 'no-cache', f);
  assert.equal((await ana.get('/')).headers.get('cache-control'), 'private, no-cache');
  assert.equal((await ana.get('/api/state')).headers.get('cache-control'), 'no-store', 'a budget is never kept by the browser’s own cache');
  const out = await (await as('Ben')).get('/api/logout');
  assert.equal(out.status, 302); assert.equal(out.headers.get('clear-site-data'), '"cache"');
});
