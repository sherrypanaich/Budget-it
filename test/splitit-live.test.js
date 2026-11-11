// Budget it and the real Split it, side by side: "count only my share" takes Split it's own numbers (odd cents,
// a trip group in euros, a Budget it kept in US dollars), a second send isn't counted twice, and a stopped
// Split it or a removed key say so. Runs only when Split it 2.2 or newer is next to this folder (../split-it) or
// named in SPLIT_IT_DIR; skipped otherwise. Split it's folder is only read: its data goes in a temporary folder.
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const SPLIT = path.resolve(process.env.SPLIT_IT_DIR || path.join(__dirname, '..', '..', 'split-it'));
const splitVersion = (() => { try {
  const v = /const VERSION = '(\d+)\.(\d+)\.(\d+)'/.exec(fs.readFileSync(path.join(SPLIT, 'server.js'), 'utf8'));
  return v && /yourShareCents/.test(fs.readFileSync(path.join(SPLIT, 'mcp.js'), 'utf8')) ? v.slice(1).map(Number) : null;
} catch { return null; } })();
const skip = !(splitVersion && (splitVersion[0] > 2 || (splitVersion[0] === 2 && splitVersion[1] >= 2))) && 'no Split it 2.2 folder next to this one (or in SPLIT_IT_DIR)';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-it-splitlive-'));
const freePort = () => new Promise(res => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const procs = [];
function start(file, env) {
  const proc = spawn(process.execPath, [file], { env, cwd: DIR, stdio: ['ignore', 'pipe', 'pipe'] }); procs.push(proc);
  return new Promise((res, rej) => { let out = ''; const t = setTimeout(() => rej(new Error(file + ' did not start: ' + out)), 15000);
    const on = d => { out += d; if (/running at/.test(out)) { clearTimeout(t); res(proc); } }; proc.stdout.on('data', on); proc.stderr.on('data', on); proc.on('exit', c => rej(new Error(file + ' stopped early (' + c + '): ' + out))); });
}
const stop = async proc => { if (proc.exitCode === null) { const gone = new Promise(r => proc.on('exit', r)); proc.kill(); await gone; } };
const jar = r => r.headers.getSetCookie().map(x => x.split(';')[0]).join('; ');

let sEnv, sPort, sProc, bEnv, bPort, key, me, uma, alexUid;
const splitCli = (args, input = '') => spawnSync(process.execPath, [path.join(SPLIT, 'server.js'), ...args], { env: sEnv, cwd: DIR, input, encoding: 'utf8' }).stdout;
// Split it as the person signed in, through its own page API (groups, members) and its assistant connection (the numbers)
async function splitLogin(name) {
  const r = await fetch(`http://127.0.0.1:${sPort}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.7.0.' + name.length }, body: JSON.stringify({ name, password: 'pw-12345678' }) });
  assert.equal(r.status, 200, name + ' signs in to Split it');
  const c = jar(r), uid = (await (await fetch(`http://127.0.0.1:${sPort}/api/me`, { headers: { cookie: c } })).json()).uid;
  const batch = async ops => { const x = await fetch(`http://127.0.0.1:${sPort}/api/batch`, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie: c }, body: JSON.stringify({ ops }) }); assert.equal(x.status, 200, await x.text()); };
  return { uid, batch };
}
async function group(who, id, name, guests, extra = {}, others = []) {
  const now = Date.now(), member = (uid, data) => ({ op: 'set', path: `groups/${id}/members/${uid}`, data: { active: true, joinedAt: now, addedBy: who.uid, ...data } });
  await who.batch([{ op: 'set', path: 'groups/' + id, data: { name, emoji: 'house', createdBy: who.uid, createdAt: now, lastAt: now, simplify: true, archived: false, ...extra } }]);
  await who.batch([member(who.uid, { kind: 'account' }), ...others.map(o => member(o, { kind: 'account' })), ...guests.map((n, i) => member(`g_${id}${i}`, { kind: 'guest', name: n, color: i }))]);
}
async function splitTool(name, args) {
  const r = await fetch(`http://127.0.0.1:${sPort}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: 'Bearer ' + key }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
  return (await r.json()).result;
}
// Split it's own record of an expense: what it says my share is, in cents
const splitShare = async title => { const t = (await splitTool('recent_expenses', { limit: 50 })).content[0].text.split('\n').find(l => l.includes(`"${title}"`));
  assert.ok(t, title + ' is in Split it'); return Math.round(+/your share \$([\d.]+)/.exec(t)[1] * 100); };

async function budgetAs(name, n) {
  const from = '10.6.0.' + n; let cookie = '';
  const call = async (method, url, body) => {
    const r = await fetch(`http://127.0.0.1:${bPort}${url}`, { method, headers: { 'X-Forwarded-For': from, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = r.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    return { status: r.status, data: await r.json().catch(() => null) };
  };
  const who = { get: url => call('GET', url), post: (url, body = {}) => call('POST', url, body), op: (op, args) => call('POST', '/api/op', { op, args }) };
  assert.equal((await who.post('/api/login', { name, password: 'pw-12345678' })).status, 200);
  who.add = async (m, amount) => (await who.op('txn.add', { amount, m, c: 'groceries' })).data.state.txns.findLast(x => x.m === m && !x.splitOf);
  who.txns = async id => (await who.get('/api/state')).data.state.txns.filter(x => x.id === id || x.splitOf === id);
  return who;
}

before(async () => {
  if (skip) return;
  [sPort, bPort] = [await freePort(), await freePort()];
  const sData = path.join(DIR, 'split'), bData = path.join(DIR, 'budget');
  fs.mkdirSync(sData, { recursive: true });
  // Today's rates, so no test reaches the internet: 1 EUR = 1.5 CAD, 1 USD = 1.5 / 1.1 CAD
  fs.writeFileSync(path.join(sData, 'rates.json'), JSON.stringify({ base: 'EUR', date: new Date().toISOString().slice(0, 10), rates: { EUR: 1, CAD: 1.5, USD: 1.1 }, fetchedAt: Date.now(), triedAt: Date.now(), error: null }));
  const quiet = { UPDATE_CHECK: 'off', RESEND_API_KEY: '', GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', PUBLIC_URL: '', BACKUP_COPY_DIR: '', BACKUP_PASSPHRASE: '', HOST: '127.0.0.1' };
  sEnv = { ...process.env, ...quiet, DATA_DIR: sData, PORT: String(sPort), RATES_URL: 'off', HOME_CURRENCY: 'CAD' };
  for (const n of ['Sherry', 'Alex']) splitCli(['add-user', n], 'pw-12345678\npw-12345678\n');
  sProc = await start(path.join(SPLIT, 'server.js'), sEnv);
  const sherry = await splitLogin('Sherry'), alex = await splitLogin('Alex'); alexUid = alex.uid;
  await group(sherry, 'ghouse', 'House', ['Mo', 'Jo']);
  await group(sherry, 'gtrip', 'Lisbon trip', ['Mo'], { cur: 'EUR', cardFee: 2.5 });
  await group(sherry, 'gpair', 'Us two', [], {}, [alex.uid]);
  await group(alex, 'galex', 'Alex flat', ['Kim']);
  key = (/\n\s*(\S{20,})\s*\n/.exec(splitCli(['mcp-key', 'Sherry'])) || [])[1];
  assert.ok(key, 'Split it made a key');

  bEnv = { ...process.env, ...quiet, DATA_DIR: bData, PORT: String(bPort), PLAID_CLIENT_ID: '', PLAID_SECRET: '', SPLIT_IT_URL: `http://127.0.0.1:${sPort}` };
  for (const n of ['Sherry', 'Uma']) spawnSync(process.execPath, [path.join(__dirname, '..', 'server.js'), 'add-user', n], { env: bEnv, cwd: DIR, input: 'pw-12345678\npw-12345678\n' });
  await start(path.join(__dirname, '..', 'server.js'), bEnv);
  me = await budgetAs('Sherry', 1); uma = await budgetAs('Uma', 2);
});
after(async () => {
  for (const p of procs) await stop(p);
  fs.rmSync(DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test('connecting lists only my Split it groups, by their real names', { skip }, async () => {
  const r = await me.post('/api/splitit/connect', { url: `http://127.0.0.1:${sPort}`, key });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual((await me.get('/api/splitit/groups')).data.groups, ['House', 'Lisbon trip', 'Us two']);
});

test('my share is the one Split it keeps, odd cents too', { skip }, async () => {
  for (const [m, amount, group] of [['Costco run', 100, 'House'], ['Hardware store', 10.01, 'House'], ['One cent', 0.01, 'Us two'], ['Pizza night', 47.03, 'Us two']]) {
    const t = await me.add(m, amount + 5);   // a bit of it was only mine, so only the amount sent is split
    const r = await me.post('/api/splitit/send', { id: t.id, group, amount, title: m, mine: true });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const share = await splitShare(m), [mine, owed] = await me.txns(t.id);
    assert.equal(Math.round(-mine.a * 100), share + 500, `${m}: my part of the charge is Split it’s share plus the $5 that wasn’t sent`);
    assert.equal(owed ? Math.round(-owed.a * 100) : 0, Math.round(amount * 100) - share, `${m}: the rest is owed back`);
    assert.equal(mine.sentTo, group);
  }
});

test('a trip group in euros takes the amount as Canadian dollars, without a card fee', { skip }, async () => {
  const t = await me.add('Lisbon hostel', 81);
  const r = await me.post('/api/splitit/send', { id: t.id, group: 'Lisbon trip', mine: true });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(await splitShare('Lisbon hostel'), 4050);
  assert.deepEqual((await me.txns(t.id)).map(x => x.a), [-40.5, -40.5]);
});

test('a Budget it kept in US dollars counts its share in US dollars', { skip }, async () => {
  assert.equal((await uma.op('money.home', { home: 'USD' })).status, 200);
  assert.equal((await uma.post('/api/splitit/connect', { url: `http://127.0.0.1:${sPort}`, key })).status, 200);
  const t = await uma.add('Duty free', 30);
  const r = await uma.post('/api/splitit/send', { id: t.id, group: 'House', mine: true });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const e = (await splitTool('recent_expenses', { limit: 50 })).content[0].text.split('\n').find(l => l.includes('"Duty free"'));
  assert.match(e, /\$40\.91 \(US\$30\.00\)|\$40\.91 \(USD 30\.00\)|\$40\.91 \(30\.00 USD\)/, 'Split it turned it into CAD: ' + e);
  assert.deepEqual((await uma.txns(t.id)).map(x => x.a), [-10, -20], 'a third of the US dollars, not a third of the Canadian ones');
});

test('sending the same charge again doesn’t count the share twice', { skip }, async () => {
  const t = await me.add('Grocery haul', 60);
  assert.equal((await me.post('/api/splitit/send', { id: t.id, group: 'House', mine: true })).status, 200);
  const r = await me.post('/api/splitit/send', { id: t.id, group: 'House', mine: true });
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.match(r.data.msg, /already in Split it \(House\), so it wasn’t added twice/);
  assert.deepEqual((await me.txns(t.id)).map(x => x.a), [-20, -40]);
  assert.equal((await splitTool('recent_expenses', { limit: 50 })).content[0].text.split('\n').filter(l => l.includes('"Grocery haul"')).length, 1);
  // another charge just like it, a moment later: Split it says it already has it, so this one isn't marked or split
  const u = await me.add('Grocery haul', 60);
  const r2 = await me.post('/api/splitit/send', { id: u.id, group: 'House', mine: true });
  assert.equal(r2.status, 409); assert.match(r2.data.error, /already has this from “Grocery haul”/);
  const [same] = await me.txns(u.id); assert.deepEqual([same.a, same.sentTo, (await me.txns(u.id)).length], [-60, undefined, 1]);
});

test('a group I’m not in, a removed key and a stopped Split it each say what’s wrong', { skip }, async () => {
  const t = await me.add('Not mine', 20);
  let r = await me.post('/api/splitit/send', { id: t.id, group: 'Alex flat', mine: true });
  assert.equal(r.status, 400); assert.match(r.data.error, /not in a group called "Alex flat"/);
  splitCli(['mcp-revoke', 'Sherry']);
  r = await me.post('/api/splitit/send', { id: t.id, group: 'House', mine: true });
  assert.equal(r.status, 400); assert.match(r.data.error, /didn’t accept the key/);
  await stop(sProc);
  r = await me.post('/api/splitit/send', { id: t.id, group: 'House', mine: true });
  assert.equal(r.status, 400); assert.match(r.data.error, /Couldn’t reach Split it/);
  const [still] = await me.txns(t.id); assert.deepEqual([still.a, still.sentTo, still.c], [-20, undefined, 'groceries'], 'nothing changed in the budget');
  assert.ok(alexUid);
});
