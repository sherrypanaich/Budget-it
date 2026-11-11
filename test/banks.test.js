// Bank connections over time, end to end against a fake Plaid: disconnecting keeps the history, reconnecting carries
// it on without doubles, a pending charge that changes after you split it gets flagged, banks that need a sign-in,
// and sharing an account with named people (including the old "everyone" switch). Run with: node --test
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const B = require('../budget');

const SERVER = path.join(__dirname, '..', 'server.js');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-it-banks-'));
const DATA = path.join(DIR, 'data');
const day = n => B.ymd(new Date(Date.now() - n * 864e5));
const calls = [];
let loginBroken = false;

// ---------- a fake Plaid with two connections to the same bank: the first one, and the one after a reconnect ----------
const tx = (id, acct, amount, name, date, o = {}) => ({ transaction_id: id, account_id: acct, amount, name, merchant_name: name, date, pending: false, personal_finance_category: { primary: 'GENERAL_MERCHANDISE', detailed: 'GENERAL_MERCHANDISE_OTHER' }, ...o });
const ACCOUNTS = {
  'acc-one': [['chk', '1111', 'depository', 'checking', 'Every Day Chequing'], ['cc', '2222', 'credit', 'credit card', 'Maple Visa'], ['sav', '', 'depository', 'savings', 'Rainy Day']],
  'acc-two': [['chk2', '1111', 'depository', 'checking', 'Every Day Chequing'], ['cc2', '2222', 'credit', 'credit card', 'Maple Visa'], ['sav2', '', 'depository', 'savings', 'Rainy Day'], ['new2', '9999', 'depository', 'savings', 'Brand New Savings']]
};
const SYNC = {
  'acc-one': {
    '': [tx('a1', 'chk', 54.2, 'Loblaws', day(3)), tx('a3', 'cc', 60, 'Pho Hoa', day(2)), tx('a4', 'sav', -1.5, 'Interest', day(1)),
      tx('p-uber', 'cc', 20, 'Uber', day(0), { pending: true }), tx('p-bar', 'cc', 30, 'Bar Raval', day(0), { pending: true })],
    // both pending charges post with a tip added; a new pending coffee nobody touches
    c1: [tx('t-uber', 'cc', 25, 'Uber', day(0), { pending_transaction_id: 'p-uber' }), tx('t-bar', 'cc', 35, 'Bar Raval', day(0), { pending_transaction_id: 'p-bar' }),
      tx('p-coffee', 'chk', 4.5, 'Tim Hortons', day(0), { pending: true })],
    removed: { c1: ['p-uber', 'p-bar'] }
  },
  'acc-two': {   // a new connection sends everything again, with new ids, plus older history
    '': [tx('n1', 'chk2', 54.2, 'Loblaws', day(3)), tx('n3', 'cc2', 60, 'Pho Hoa', day(2)), tx('n4', 'sav2', -1.5, 'Interest', day(1)),
      tx('n-uber', 'cc2', 25, 'Uber', day(0)), tx('n-bar', 'cc2', 35, 'Bar Raval', day(0)), tx('n-coffee', 'chk2', 4.5, 'Tim Hortons', day(0)),
      tx('n-old', 'chk2', 12, 'Old Bookshop', day(400)), tx('n-new', 'new2', -100, 'Opening deposit', day(1))]
  }
};
const fakePlaid = http.createServer((req, res) => {
  let body = ''; req.on('data', c => body += c); req.on('end', () => {
    const j = JSON.parse(body || '{}'); calls.push({ path: req.url, body: j });
    const send = (code, x) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(x)); };
    if (loginBroken && j.access_token) return send(400, { error_code: 'ITEM_LOGIN_REQUIRED', error_message: 'login required' });
    if (req.url === '/link/token/create') return send(200, { link_token: 'link-abc' });
    if (req.url === '/item/public_token/exchange') return send(200, { access_token: 'acc-' + j.public_token, item_id: 'item-' + j.public_token });
    if (req.url === '/accounts/get') return send(200, { accounts: ACCOUNTS[j.access_token].map(([account_id, mask, type, subtype, name]) => ({ account_id, mask, type, subtype, name, balances: { current: 100 } })) });
    if (req.url === '/transactions/sync') {
      const s = SYNC[j.access_token], cur = j.cursor || '';
      const next = cur === '' ? 'c1' : cur === 'c1' ? 'c2' : cur;
      return send(200, { added: s[cur] || [], modified: [], removed: (s.removed?.[cur] || []).map(id => ({ transaction_id: id })), next_cursor: next, has_more: false });
    }
    if (req.url === '/transactions/recurring/get') return send(200, { outflow_streams: [], inflow_streams: [] });
    send(200, { removed: true });
  });
});
// A newer Split it that sends the share as numbers too (and leaves "Your share" out of the sentence)
const SPLIT_KEY = 'hsk_test_key_abcdefghijklmnop';
const fakeSplit = http.createServer((req, res) => {
  let body = ''; req.on('data', c => body += c); req.on('end', () => {
    const j = JSON.parse(body), a = j.params.arguments || {};
    const result = j.params.name === 'list_groups' ? { content: [{ type: 'text', text: 'House: you, Mika. You’re all square in this group.' }] }
      : { content: [{ type: 'text', text: `Added "${a.title}" $${a.amount.toFixed(2)} in House, paid by you.` }], structuredContent: { yourShareCents: 1000 } };
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id, result }));
  });
});

const freePort = () => new Promise(res => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const listen = srv => new Promise(ok => srv.listen(0, '127.0.0.1', () => ok(srv.address().port)));
let PORT, proc, env, addr = 0;
const cli = (args, input = '') => spawnSync(process.execPath, [SERVER, ...args], { env, input, encoding: 'utf8' }).stdout;
async function as(name) {
  const from = `10.9.0.${++addr}`; let cookie = '';
  const call = async (method, url, body) => {
    const r = await fetch(`http://127.0.0.1:${PORT}${url}`, { method, headers: { 'X-Forwarded-For': from, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = r.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    return { status: r.status, data: await r.json().catch(() => null) };
  };
  const me = { get: url => call('GET', url), post: (url, body = {}) => call('POST', url, body), op: (op, args) => call('POST', '/api/op', { op, args }) };
  assert.equal((await me.post('/api/login', { name, password: name.toLowerCase() + '-password' })).status, 200);
  me.uid = (await me.get('/api/state')).data.me.id;
  return me;
}
const wait = ms => new Promise(ok => setTimeout(ok, ms));
const disk = async () => { await wait(1000); return JSON.parse(fs.readFileSync(path.join(DATA, 'db.json'), 'utf8')); };
const ids = () => JSON.parse(fs.readFileSync(path.join(DATA, 'users.json'), 'utf8')).users;

let ana, ben;
before(async () => {
  PORT = await freePort();
  env = { ...process.env, DATA_DIR: DATA, PORT: String(PORT), HOST: '127.0.0.1', UPDATE_CHECK: 'off', RESEND_API_KEY: '', GOOGLE_CLIENT_ID: '', PUBLIC_URL: '', BACKUP_COPY_DIR: '', BACKUP_PASSPHRASE: '',
    PLAID_CLIENT_ID: 'id', PLAID_SECRET: 'secret', PLAID_ENV: 'sandbox', PLAID_URL: `http://127.0.0.1:${await listen(fakePlaid)}`, PLAID_REDIRECT_URI: '' };
  env.SPLIT_IT_URL = `http://127.0.0.1:${await listen(fakeSplit)}`;   // a Split it on this computer has to be named
  for (const n of ['Ana', 'Ben']) cli(['add-user', n], n.toLowerCase() + '-password\n');
  // A budget from before 1.1, when a shared account was shared with everyone here
  const [anaId] = Object.entries(ids()).find(([, u]) => u.name === 'Ana');
  fs.writeFileSync(path.join(DATA, 'db.json'), JSON.stringify({ items: {}, people: { [anaId]: { accounts: [{ id: 'mjoint', name: 'Joint', inst: 'Added by you', type: 'Chequing', mask: '', bal: 500, shared: true, manual: true }], txns: [] } } }));
  proc = spawn(process.execPath, [SERVER], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((res, rej) => { let out = ''; const t = setTimeout(() => rej(new Error('server did not start: ' + out)), 15000);
    const on = d => { out += d; if (/running at/.test(out)) { clearTimeout(t); res(); } }; proc.stdout.on('data', on); proc.stderr.on('data', on); proc.on('exit', c => rej(new Error('server stopped early (' + c + '): ' + out))); });
  ana = await as('Ana'); ben = await as('Ben');
});
after(async () => {
  if (proc) { const gone = new Promise(r => proc.on('exit', r)); proc.kill(); await gone; }
  fakePlaid.close(); fakeSplit.close();
  fs.rmSync(DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test('an account shared with "everyone" before 1.1 becomes the people who were here, once', async () => {
  assert.deepEqual((await ana.get('/api/state')).data.state.accounts.find(a => a.id === 'mjoint').shared, [ben.uid]);
  assert.equal((await ben.get('/api/state')).data.state.accounts.find(a => a.id.endsWith(':mjoint')).owner, 'Ana');
  cli(['add-user', 'Cy'], 'cy-password\n');
  const cy = await as('Cy');
  assert.equal((await cy.get('/api/state')).data.state.accounts.length, 0, 'someone who joins later doesn’t see it');
  assert.deepEqual((await disk()).people[ana.uid].accounts[0].shared, [ben.uid]);
});

test('a new bank asks Plaid for two years', async () => {
  assert.equal((await ana.post('/api/plaid/link-token')).status, 200);
  assert.equal(calls.filter(c => c.path === '/link/token/create').at(-1).body.transactions.days_requested, 730);
});

let s;
test('connect, change things, and a pending charge that changes after you split it gets flagged', async () => {
  let r = await ana.post('/api/plaid/exchange', { public_token: 'one', institution: 'Maple Bank', institution_id: 'ins_9' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  s = r.data.state;
  const find = m => s.txns.find(t => t.m === m && !t.splitOf);
  // the person's changes
  await ana.op('txn.update', { id: find('Loblaws').id, c: 'fun', note: 'Party food', tags: '#party' });
  await ana.op('txn.update', { id: find('Interest').id, hidden: true });
  await ana.op('txn.split', { id: find('Pho Hoa').id, amount: 20, c: 'fun' });
  await ana.op('txn.split', { id: find('Uber').id, amount: 5, c: 'fun' });
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  assert.equal((await ana.post('/api/receipt', { id: find('Loblaws').id, data: png })).status, 200);
  await ana.op('account.rename', { id: 'p_cc', name: 'Our Visa' });
  await ana.op('account.share', { id: 'p_cc', with: [ben.uid] });
  // Send the bar tab to Split it, counting only my share: the share comes from Split it's numbers, not its sentence
  assert.equal((await ana.post('/api/splitit/connect', { url: `http://127.0.0.1:${fakeSplit.address().port}`, key: SPLIT_KEY })).status, 200);
  r = await ana.post('/api/splitit/send', { id: find('Bar Raval').id, group: 'House', mine: true });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  s = r.data.state;
  assert.equal(find('Bar Raval').a, -10, 'my share was $10.00');
  assert.equal(s.txns.find(t => t.splitOf === find('Bar Raval').id).a, -20);

  // They post with tips
  r = await ana.post('/api/plaid/sync'); s = r.data.state;
  const uber = s.txns.filter(t => t.m === 'Uber');
  assert.equal(uber.length, 2, 'the posted charge replaced the pending one: the two parts of the split, no more');
  const up = uber.find(t => !t.splitOf), part = uber.find(t => t.splitOf);
  assert.deepEqual([up.plaidId, up.pending, up.a, part.a], ['t-uber', false, -20, -5], 'the parts stay; the first one took the tip');
  assert.deepEqual(up.changed, { was: -20, now: -25 });
  const bar = find('Bar Raval');
  assert.equal(bar.sentTo, 'House');
  assert.deepEqual(bar.changed, { was: -30, now: -35 });
  assert.equal(bar.a, -15, 'my share took the tip; what housemates owe stays what Split it has');
  // Saving it marks it checked
  r = await ana.op('txn.update', { id: up.id, note: 'Tipped' });
  assert.equal(r.data.state.txns.find(t => t.id === up.id).changed, undefined);
  assert.ok(s.txns.some(t => t.plaidId === 'p-coffee' && t.pending));
});

test('disconnecting keeps the history; reconnecting carries it on with your changes and no doubles', async () => {
  const before = (await ana.get('/api/state')).data.state;
  const item = (await ana.get('/api/state')).data.items[0].id;
  let r = await ana.post('/api/plaid/remove', { item });
  assert.equal(r.status, 200);
  s = r.data.state;
  assert.deepEqual(s.accounts.filter(a => a.disconnected).map(a => a.id).sort(), ['p_cc', 'p_chk', 'p_sav']);
  assert.ok(!s.txns.some(t => t.plaidId === 'p-coffee'), 'a pending charge nobody touched goes; it would never post now');
  assert.equal(s.txns.length, before.txns.length - 1);
  assert.equal(r.data.items.length, 0);
  assert.equal((await disk()).items[item], undefined);
  assert.equal((await ben.get('/api/state')).data.state.accounts.filter(a => a.name === 'Our Visa').length, 1, 'still shared while disconnected');

  r = await ana.post('/api/plaid/exchange', { public_token: 'two', institution: 'Maple Bank', institution_id: 'ins_9' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  s = r.data.state;
  const own = s.accounts.filter(a => !a.other);
  assert.deepEqual(own.filter(a => a.id.startsWith('p_')).map(a => a.id).sort(), ['p_cc2', 'p_chk2', 'p_new2', 'p_sav2'], 'the old accounts carried on under the new connection');
  assert.ok(own.every(a => !a.disconnected && !a.carry));
  const visa = own.find(a => a.id === 'p_cc2');
  assert.deepEqual([visa.name, visa.shared], ['Our Visa', [ben.uid]]);
  assert.equal(s.txns.filter(t => t.acct.startsWith('p_cc') && t.acct !== 'p_cc2').length, 0);
  // nothing doubled, edits kept
  const count = m => s.txns.filter(t => t.m === m).length;
  assert.deepEqual(['Loblaws', 'Pho Hoa', 'Interest', 'Uber', 'Bar Raval', 'Tim Hortons', 'Old Bookshop'].map(count), [1, 2, 1, 2, 2, 1, 1]);
  const lob = s.txns.find(t => t.m === 'Loblaws');
  assert.deepEqual([lob.plaidId, lob.acct, lob.c, lob.note, lob.tags], ['n1', 'p_chk2', 'fun', 'Party food', ['party']]);
  assert.match(lob.receipt, /^u_/);
  assert.equal(s.txns.find(t => t.m === 'Interest').hidden, true);
  const pho = s.txns.filter(t => t.m === 'Pho Hoa');
  assert.deepEqual(pho.map(t => [t.acct, t.a]).sort(), [['p_cc2', -20], ['p_cc2', -40]]);
  const up = s.txns.find(t => t.m === 'Uber' && !t.splitOf);
  assert.deepEqual([up.plaidId, up.a, up.note, up.changed], ['n-uber', -20, 'Tipped', undefined], 'same amount as before, so nothing to check');
  assert.equal(s.txns.find(t => t.m === 'Bar Raval' && !t.splitOf).sentTo, 'House');
  // older history that wasn't here before comes in, without crowding "New from your bank"
  const old = s.txns.find(t => t.m === 'Old Bookshop');
  assert.deepEqual([old.acct, old.fresh], ['p_chk2', false]);
  assert.equal(s.txns.find(t => t.m === 'Tim Hortons').fresh, true);
  assert.equal(r.data.msg.match(/(\d+) transaction/)[1], '3', 'only the bookshop, the coffee and the opening deposit are new');
});

test('a bank that needs a sign-in is flagged once, and clears after an update', async () => {
  loginBroken = true;
  let r = await ana.post('/api/plaid/sync');
  assert.match(r.data.msg, /sign in again/i);
  const item = r.data.items[0];
  assert.equal(item.error, 'login');
  assert.ok(item.syncedAt > 0, 'when it last updated still shows');
  const told = (await disk()).items[item.id].loginTold;
  assert.ok(told > 0);
  await ana.post('/api/plaid/sync');
  assert.equal((await disk()).items[item.id].loginTold, told, 'told once, not on every try');
  loginBroken = false;
  assert.equal((await ana.post('/api/plaid/link-token', { item: item.id })).status, 200);
  assert.equal(calls.filter(c => c.path === '/link/token/create').at(-1).body.access_token, 'acc-two', 'Reconnect uses update mode');
  r = await ana.post('/api/plaid/fixed', { item: item.id });
  assert.equal(r.data.items[0].error, null);
  assert.equal((await disk()).items[item.id].loginTold, undefined);
});

test('the share from Split it: numbers first, then the sentence', () => {
  process.env.DATA_DIR = path.join(DIR, 'unit');   // loading the server makes its data folder: not in the repo
  const { myShareFrom } = require('../server.js');
  assert.equal(myShareFrom('Added it. Your share: $30.00.', { structuredContent: { yourShareCents: 1250 } }), 12.5);
  assert.equal(myShareFrom('Added it.', { structuredContent: { yourShare: '7.25' } }), 7.25);
  assert.equal(myShareFrom('Added it. Your share: $30.00.', { structuredContent: { yourShare: 'lots' } }), 30);
  assert.equal(myShareFrom('Added it. Your share: $30.00.', { content: [] }), 30);
  assert.equal(myShareFrom('Something else'), null);
  // Split it's numbers are in its home money: sent in US dollars, my part is the same fraction of what was sent
  const usd = { amount: 30, cur: 'USD' };
  assert.equal(myShareFrom('', { structuredContent: { yourShareCents: 1364, totalCents: 4091, currency: 'CAD' } }, usd), 10);
  assert.equal(myShareFrom('', { structuredContent: { yourShareCents: 1364, totalCents: 4091, currency: 'CAD' } }, { amount: 40.91, cur: 'CAD' }), 13.64);
  assert.equal(myShareFrom('Your share: $13.64.', { structuredContent: { yourShareCents: 1364, currency: 'CAD' } }, usd), null, 'no total: no fair way back, so the whole amount counts');
  assert.equal(myShareFrom('', { structuredContent: { yourShareCents: 0, totalCents: 4091, currency: 'CAD' } }, usd), 0);
});

test('Split it’s group names, quoted (2.2) or not (older)', () => {
  const { splitGroupsFrom } = require('../server.js');
  assert.deepEqual(splitGroupsFrom('"House": you, Mo, Jo. You’re all square in this group.\n"Trip: \\"Lisbon\\"": you, Mo. You owe $4.00 in this group. A trip group paying in EUR (card fee 2.5%): give a currency when adding expenses.'), ['House', 'Trip: "Lisbon"']);
  assert.deepEqual(splitGroupsFrom('House: you, Mika.\nTrip: you, Jo.'), ['House', 'Trip']);
  assert.deepEqual(splitGroupsFrom('You’re not in any groups yet.'), []);
});
