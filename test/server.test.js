// The whole server, end to end, against a fake Plaid. Run with: node --test
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const B = require('../budget');

const SERVER = path.join(__dirname, '..', 'server.js');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-it-test-'));
const COPIES = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-it-copies-'));
const today = (() => { const d = new Date(), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; })();

// ---------- a fake Plaid ----------
const calls = [];
let syncs = 0, loginBroken = false;
const ACCESS = 'access-sandbox-very-secret-123';
const fake = http.createServer((req, res) => {
  let body = ''; req.on('data', c => body += c); req.on('end', () => {
    const j = JSON.parse(body || '{}'); calls.push({ path: req.url, body: j });
    const send = (code, x) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(x)); };
    if (j.client_id !== 'test-client' || j.secret !== 'test-secret') return send(400, { error_code: 'INVALID_API_KEYS' });
    if (loginBroken && j.access_token) return send(400, { error_code: 'ITEM_LOGIN_REQUIRED', error_message: 'login required' });
    switch (req.url) {
      case '/link/token/create': return send(200, { link_token: 'link-sandbox-abc' });
      case '/item/public_token/exchange': return send(200, { access_token: ACCESS, item_id: 'item1' });
      case '/accounts/get': return send(200, { accounts: [
        { account_id: 'chk', name: 'Plaid Checking', mask: '0000', type: 'depository', subtype: 'checking', balances: { current: 110, available: 100 } },
        { account_id: 'cc', name: 'Plaid Credit Card', mask: '3333', type: 'credit', subtype: 'credit card', balances: { current: 410, limit: 2000 } },
        { account_id: 'inv', name: 'Plaid TFSA', mask: '5555', type: 'investment', subtype: 'tfsa', balances: { current: 1530 } },
        { account_id: 'usd', name: 'Plaid USD', mask: '7777', type: 'depository', subtype: 'savings', balances: { current: 100, iso_currency_code: 'USD' } }] });
      case '/transactions/recurring/get': return send(200, { outflow_streams: [{ stream_id: 'r1', account_id: 'chk', merchant_name: 'Enbridge Gas', frequency: 'MONTHLY', average_amount: { amount: 88.4 }, last_amount: { amount: 88.4 }, predicted_next_date: today, is_active: true, status: 'MATURE', personal_finance_category: { primary: 'RENT_AND_UTILITIES' } }], inflow_streams: [] });
      case '/investments/holdings/get': return send(200, {
        holdings: [{ account_id: 'inv', security_id: 'sec1', quantity: 10, institution_price: 123, institution_value: 1230, cost_basis: 1000 },
          { account_id: 'inv', security_id: 'sec2', quantity: 3, institution_price: 100, institution_value: 300, cost_basis: null },
          { account_id: 'inv', security_id: 'sec3', quantity: 0, institution_price: 5, institution_value: 0 }],
        securities: [{ security_id: 'sec1', name: 'Vanguard S&P 500 Index ETF', ticker_symbol: 'VFV', type: 'etf' }, { security_id: 'sec2', name: 'Shopify Inc.', ticker_symbol: 'SHOP', type: 'equity' }] });
      case '/transactions/sync': {
        syncs++;
        const tx = (id, acct, amount, name, pfc, o = {}) => ({ transaction_id: id, account_id: acct, amount, name, merchant_name: name, date: today, pending: false, personal_finance_category: pfc, ...o });
        if (!j.cursor) return send(200, { added: [
          tx('t1', 'cc', 54.20, 'Loblaws', { primary: 'FOOD_AND_DRINK', detailed: 'FOOD_AND_DRINK_GROCERIES' }),
          tx('t2', 'chk', -2000, 'Payroll', { primary: 'INCOME', detailed: 'INCOME_WAGES' }),
          tx('p3', 'cc', 12.00, 'Uber', { primary: 'TRANSPORTATION', detailed: 'TRANSPORTATION_TAXIS' }, { pending: true }),
          tx('t4', 'usd', 10, 'Amazon.com', { primary: 'GENERAL_MERCHANDISE', detailed: 'GENERAL_MERCHANDISE_ONLINE_MARKETPLACES' }, { iso_currency_code: 'USD' })],
          modified: [], removed: [], next_cursor: 'c1', has_more: false });
        // The pending Uber ride posts with a new id and a tip
        return send(200, { added: [tx('t3', 'cc', 14.50, 'Uber', { primary: 'TRANSPORTATION', detailed: 'TRANSPORTATION_TAXIS' }, { pending_transaction_id: 'p3' })],
          modified: [], removed: [{ transaction_id: 'p3' }], next_cursor: 'c2', has_more: false });
      }
      case '/item/remove': return send(200, { removed: true });
    }
    send(404, { error_code: 'NOT_FOUND' });
  });
});

// The Bank of Canada's rates, for "Get today's rates"
const boc = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(req.url.includes('FXUSDCAD') ? { observations: [{ d: '2026-11-06', FXUSDCAD: { v: '1.3950' } }] } : { observations: [] }));
});
// The European Central Bank's rates (frankfurter.app), for homes that aren't in CAD: "1 USD = 1.40 CAD, 0.92 EUR"
const fx = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'); res.writeHead(200, { 'Content-Type': 'application/json' });
  const all = { CAD: 1.4, EUR: 0.92 }, want = (u.searchParams.get('to') || '').split(',');
  res.end(JSON.stringify({ base: u.searchParams.get('from'), date: '2026-11-06', rates: Object.fromEntries(want.filter(c => all[c]).map(c => [c, all[c]])) }));
});
// GitHub's "latest release" answer
const gh = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ tag_name: 'v9.0.0', name: 'Later', html_url: 'https://github.com/sherrypanaich/budget-it/releases/tag/v9.0.0' })); });
let srv, base, cookie = '', other = '';
const env = { ...process.env, DATA_DIR: DATA, PLAID_CLIENT_ID: 'test-client', PLAID_SECRET: 'test-secret', PLAID_ENV: 'sandbox', HOST: '127.0.0.1',
  BACKUP_COPY_DIR: COPIES, BACKUP_PASSPHRASE: 'copy-passphrase-1', PLAID_REDIRECT_URI: 'https://budget.example.test/plaid/return', UPDATE_CHECK: '', RESEND_API_KEY: '', GOOGLE_CLIENT_ID: '', PUBLIC_URL: '' };
const cli = (args, input, extra) => execFileSync(process.execPath, [SERVER, ...args], { env: { ...env, ...extra }, input, encoding: 'utf8' });
async function req(method, p, body, c = cookie, headers = {}) {
  const r = await fetch(base + p, { method, redirect: 'manual', headers: { 'Content-Type': 'application/json', ...(c ? { Cookie: c } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  return { status: r.status, body: j, headers: r.headers };
}
const op = (o, args, c) => req('POST', '/api/op', { op: o, args }, c);
async function login(name, pw) {
  const r = await req('POST', '/api/login', { name, password: pw }, '');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.headers.get('set-cookie').split(';')[0];
}

test.before(async () => {
  await new Promise(ok => fake.listen(0, '127.0.0.1', ok));
  env.PLAID_URL = `http://127.0.0.1:${fake.address().port}`;
  await new Promise(ok => boc.listen(0, '127.0.0.1', ok));
  env.BOC_URL = `http://127.0.0.1:${boc.address().port}`;
  await new Promise(ok => fx.listen(0, '127.0.0.1', ok));
  env.FX_URL = `http://127.0.0.1:${fx.address().port}`;
  await new Promise(ok => gh.listen(0, '127.0.0.1', ok)); gh.unref();
  env.RELEASES_URL = `http://127.0.0.1:${gh.address().port}/latest`;
  await new Promise(ok => fakeSplit.listen(0, '127.0.0.1', ok));
  env.SPLIT_IT_URL = `http://127.0.0.1:${fakeSplit.address().port}`;   // a Split it on this laptop has to be named
  cli(['add-user', 'Sherry'], 'password123\n');
  cli(['add-user', 'Mika'], 'password456\n');
  // A port the system says is free right now (a random guess sometimes hit one in use, the server stopped, and the
  // clean-up then waited forever for it). Something else can still take it in the moment before the server does: then another one.
  for (let tries = 1; ; tries++) {
    const port = await new Promise(ok => { const s = net.createServer().listen(0, '127.0.0.1', () => { const n = s.address().port; s.close(() => ok(n)); }); });
    env.PORT = String(port); base = `http://127.0.0.1:${port}`;
    srv = spawn(process.execPath, [SERVER], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const up = await new Promise((ok, no) => { let out = '';
      srv.stdout.on('data', d => { out += d; if (/running at/.test(out)) ok(true); }); srv.stderr.on('data', d => { out += d; if (!/already in use/.test(d)) process.stderr.write(d); });
      srv.once('close', c => /already in use/.test(out) && tries < 5 ? ok(false) : no(new Error('server exited ' + c))); });
    if (up) break;
  }
  cookie = await login('Sherry', 'password123');
  other = await login('mika', 'password456');
});
test.after(async () => {
  // the server writes its files once more as it stops, so wait for it before deleting the folder
  // when it already stopped (it failed to start), its 'exit' came and went: waiting for another one hung the run forever
  if (srv && srv.exitCode === null && srv.signalCode === null) { const gone = new Promise(ok => srv.once('exit', ok)); srv.kill(); await gone; }
  fake.close(); boc.close(); fx.close();
  fs.rmSync(DATA, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.rmSync(COPIES, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test('pages and the API need a sign-in', async () => {
  assert.equal((await req('GET', '/', undefined, '')).status, 302);
  assert.equal((await req('GET', '/api/state', undefined, '')).status, 401);
  assert.equal((await req('POST', '/api/login', { name: 'Sherry', password: 'wrong-one' }, '')).status, 401);
  const r = await req('GET', '/');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy'), /cdn\.plaid\.com/);
});

test('changes, and undo', async () => {
  let r = await op('txn.add', { amount: 4.5, m: 'Coffee', c: 'dining', date: today });
  assert.equal(r.status, 200);
  assert.equal(r.body.state.txns.filter(t => t.m === 'Coffee').length, 1);
  r = await op('budget.set', { c: 'dining', amount: 250 });
  assert.equal(r.body.state.budgets.dining, 250);
  r = await op('undo');
  assert.equal(r.body.state.budgets.dining, undefined);
  r = await op('txn.add', { amount: 'lots' });
  assert.equal(r.status, 400);
  assert.ok(r.body.error);
  r = await op('no.such.thing', {});
  assert.equal(r.status, 400);
});

test('connecting a bank through Plaid brings in accounts and charges', async () => {
  let r = await req('POST', '/api/plaid/link-token', {});
  assert.equal(r.body.link_token, 'link-sandbox-abc');
  r = await req('POST', '/api/plaid/exchange', { public_token: 'public-sandbox-1', institution: 'Platypus Bank' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const s = r.body.state;
  const cc = s.accounts.find(a => a.id === 'p_cc');
  assert.equal(cc.bal, -410);                     // what you owe on a card is negative
  assert.equal(s.accounts.find(a => a.id === 'p_chk').bal, 110);
  const inv = s.accounts.find(a => a.id === 'p_inv');
  assert.equal(inv.type, 'Investment');
  assert.deepEqual(inv.holdings.map(h => [h.sym, h.qty, h.price, h.cost]), [['VFV', 10, 123, 1000], ['SHOP', 3, 100, undefined]]);   // nothing left of sec3
  assert.equal((await op('holding.save', { acct: 'p_inv', sym: 'X', qty: 1, price: 1 })).status, 400, 'bank holdings can’t be edited');
  assert.deepEqual(s.plaidBills.map(b => [b.n, b.a, b.c]), [['Enbridge Gas', 88.4, 'home']], 'bills Plaid found come in');
  const groceries = s.txns.find(t => t.plaidId === 't1');
  assert.equal(groceries.a, -54.2);               // Plaid's positive amounts are money out
  assert.equal(groceries.c, 'groceries');
  assert.equal(groceries.fresh, true);
  assert.equal(s.txns.find(t => t.plaidId === 't2').c, 'income');
  assert.equal(s.txns.find(t => t.plaidId === 'p3').pending, true);
  assert.equal(r.body.items[0].inst, 'Platypus Bank');
  assert.equal(JSON.stringify(r.body).includes(ACCESS), false, 'the access token never goes to the browser');
  // A US dollar account keeps its currency; its charges count in CAD once there is a rate
  assert.equal(s.accounts.find(a => a.id === 'p_usd').cur, 'USD');
  assert.equal(s.accounts.find(a => a.id === 'p_chk').cur, undefined);
  assert.equal(s.txns.find(t => t.plaidId === 't4').a, -10, 'no rate yet, so it counts 1 to 1');
  r = await req('POST', '/api/rates/today', {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.msg, /USD/);
  assert.equal(r.body.state.rates.USD, 1.395);
  assert.equal(B.inHome(r.body.state, r.body.state.accounts.find(a => a.id === 'p_usd')), 139.5);
});

test('the bank connection is encrypted on disk', async () => {
  await new Promise(ok => setTimeout(ok, 1500));   // the db is written shortly after a change
  const raw = fs.readFileSync(path.join(DATA, 'db.json'), 'utf8');
  assert.equal(raw.includes(ACCESS), false);
  assert.match(raw, /"token":\s*"v1:/);
  const key = fs.statSync(path.join(DATA, 'secret.key'));
  assert.equal(key.mode & 0o077, 0, 'secret.key is readable only by its owner');
});

test('a pending charge that posts keeps your changes', async () => {
  let s = (await req('GET', '/api/state')).body.state;
  const uber = s.txns.find(t => t.plaidId === 'p3');
  await op('txn.update', { id: uber.id, c: 'fun', note: 'Night out' });
  const r = await req('POST', '/api/plaid/sync', {});
  s = r.body.state;
  const ubers = s.txns.filter(t => t.m === 'Uber');
  assert.equal(ubers.length, 1);
  assert.equal(ubers[0].a, -14.5);
  assert.equal(ubers[0].pending, false);
  assert.equal(ubers[0].c, 'fun');
  assert.equal(ubers[0].note, 'Night out');
});

test('an account is shared with the people you pick, read only; everyone else sees nothing', async () => {
  cli(['add-user', 'Jo'], 'password789\n');
  const jo = await login('jo', 'password789');
  let m = (await req('GET', '/api/state', undefined, other)).body.state;
  assert.equal(m.accounts.length, 0);
  assert.equal(m.txns.length, 0);
  const people = (await req('GET', '/api/state')).body.people;
  assert.deepEqual(people.map(p => p.name).sort(), ['Jo', 'Mika']);
  const mika = people.find(p => p.name === 'Mika').id, joId = people.find(p => p.name === 'Jo').id;
  const sh = await op('account.share', { id: 'p_cc', with: [mika, 'u_nobody', (await req('GET', '/api/state')).body.me.id] });
  assert.equal(sh.body.msg, 'Shared with Mika');
  assert.deepEqual(sh.body.state.accounts.find(a => a.id === 'p_cc').shared, [mika], 'only real people, never yourself');
  const joSees = (await req('GET', '/api/state', undefined, jo)).body.state;
  assert.equal(joSees.accounts.length, 0, 'Jo has a login but the card is shared only with Mika');
  assert.equal(joSees.txns.length, 0);
  m = (await req('GET', '/api/state', undefined, other)).body.state;
  assert.equal(m.accounts[0].shared, undefined, 'Mika doesn’t see who else it is shared with');
  assert.equal(m.accounts.length, 1);
  assert.equal(m.accounts[0].other, true);
  assert.equal(m.accounts[0].owner, 'Sherry');
  assert.ok(m.txns.length >= 2 && m.txns.every(t => t.other));
  const theirs = m.txns[0];
  const r = await op('txn.update', { id: theirs.id, c: 'fun' }, other);
  assert.equal(r.status, 400);
  // the older all-or-nobody switch still works: on means everyone here, by name
  const all = await op('account.share', { id: 'p_cc', shared: true });
  assert.deepEqual([...all.body.state.accounts.find(a => a.id === 'p_cc').shared].sort(), [mika, joId].sort());
  assert.equal((await req('GET', '/api/state', undefined, jo)).body.state.accounts.length, 1);
  await op('account.share', { id: 'p_cc', with: [mika] });
  assert.equal((await req('GET', '/api/state', undefined, jo)).body.state.accounts.length, 0);
});

test('a bank that wants you to sign in again shows Reconnect', async () => {
  loginBroken = true;
  const r = await req('POST', '/api/plaid/sync', {});
  assert.match(r.body.msg, /sign in again/i);
  assert.equal(r.body.items[0].error, 'login');
  loginBroken = false;
  const lt = await req('POST', '/api/plaid/link-token', { item: r.body.items[0].id });
  assert.equal(lt.status, 200);
  assert.equal(calls.filter(c => c.path === '/link/token/create').at(-1).body.access_token, ACCESS, 'update mode sends the access token');
  const f = await req('POST', '/api/plaid/fixed', { item: r.body.items[0].id });
  assert.equal(f.body.items[0].error, null);
});

test('the AI assistant (MCP) can read and change the budget with a key', async () => {
  const out = cli(['mcp-key', 'Sherry']);
  const key = out.match(/bik_[A-Za-z0-9_-]+/)[0];
  const rpc = async (method, params) => (await req('POST', '/mcp', { jsonrpc: '2.0', id: 1, method, params }, '', { Authorization: 'Bearer ' + key, Accept: 'application/json, text/event-stream' })).body;
  assert.equal((await req('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, '')).status, 401);
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.equal(init.result.serverInfo.name, 'budget-it');
  const names = (await rpc('tools/list')).result.tools.map(t => t.name);
  for (const n of ['get_balances', 'list_transactions', 'spending_summary', 'budget_status', 'list_goals', 'set_category', 'add_cash_purchase', 'add_to_goal', 'refresh_banks', 'undo_last_change']) assert.ok(names.includes(n), n);
  const bal = await rpc('tools/call', { name: 'get_balances', arguments: {} });
  assert.match(bal.result.content[0].text, /Plaid Checking/);
  assert.match(bal.result.content[0].text, /VFV 10 x \$123\.00 = \$1,230\.00 \(\+23%\)/);
  const add = await rpc('tools/call', { name: 'add_cash_purchase', arguments: { amount: 12, what: 'Farmers market', category: 'groceries' } });
  assert.ok(!add.result.isError, add.result.content[0].text);
  let s = (await req('GET', '/api/state')).body.state;
  assert.ok(s.txns.some(t => t.m === 'Farmers market' && t.a === -12));
  await rpc('tools/call', { name: 'undo_last_change', arguments: {} });
  s = (await req('GET', '/api/state')).body.state;
  assert.ok(!s.txns.some(t => t.m === 'Farmers market'));
  const sum = await rpc('tools/call', { name: 'spending_summary', arguments: {} });
  assert.match(sum.result.content[0].text, /Groceries/);
});

test('disconnecting a bank removes it at Plaid and keeps its history here', async () => {
  const items = (await req('GET', '/api/state')).body.items;
  const r = await req('POST', '/api/plaid/remove', { item: items[0].id });
  assert.equal(r.status, 200);
  assert.equal(r.body.items.length, 0);
  const kept = r.body.state.accounts.filter(a => a.id.startsWith('p_'));
  assert.ok(kept.length >= 4 && kept.every(a => a.disconnected && a.disconnectedOn === today));
  assert.ok(r.body.state.txns.some(t => t.plaidId === 't1'), 'its transactions stay');
  assert.ok(calls.some(c => c.path === '/item/remove'));
  await new Promise(ok => setTimeout(ok, 1500));
  assert.equal(JSON.parse(fs.readFileSync(path.join(DATA, 'db.json'), 'utf8')).items[items[0].id], undefined, 'the sealed access token is gone');
  // "Delete this history" removes one for good
  const del = await op('account.delete', { id: 'p_chk' });
  assert.equal(del.status, 200, JSON.stringify(del.body));
  assert.ok(!del.body.state.accounts.some(a => a.id === 'p_chk'));
  assert.ok(!del.body.state.txns.some(t => t.acct === 'p_chk'));
});

test('invite links work once', async () => {
  const r = await req('POST', '/api/invite', {});
  assert.equal(r.status, 200);
  assert.ok(r.body.token);
});

// ---------- a fake Split it, for "Send to Split it" ----------
const SPLIT_KEY = 'hsk_test_key_abcdefghijklmnop';
const splitCalls = [];
const fakeSplit = http.createServer((req, res) => {
  let body = ''; req.on('data', c => body += c); req.on('end', () => {
    const send = (code, x) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(x)); };
    if (req.url !== '/mcp') return send(404, {});
    if (req.headers.authorization !== 'Bearer ' + SPLIT_KEY) return send(401, { error: 'unauthorized' });
    const j = JSON.parse(body); splitCalls.push(j.params);
    const text = j.params.name === 'list_groups' ? 'House: Sherry, Mika. You’re all square in this group.\nCottage trip: Sherry, Jo. You owe $12.00 in this group.'
      : (() => { const a = j.params.arguments, half = (a.amount / 2).toFixed(2);   // an older Split it lists the shares; a newer one also says "Your share"
          return `Added "${a.title}" $${a.amount.toFixed(2)} in ${a.group}, paid by you, split equally between you, Mika ($${half} / $${half}).` + (a.group === 'Cottage trip' ? ` Your share: $${half}.` : ''); })();
    send(200, { jsonrpc: '2.0', id: j.id, result: { content: [{ type: 'text', text }] } });
  });
});

test('export, receipts and Send to Split it', async () => {
  try {
    let r = await op('txn.add', { amount: 54.2, m: 'Loblaws', c: 'groceries', date: today });
    const t = r.body.state.txns.find(x => x.m === 'Loblaws' && x.manual);
    // Export
    const csv = await fetch(base + '/api/export.csv', { headers: { Cookie: cookie } });
    assert.equal(csv.status, 200); assert.match(csv.headers.get('content-type'), /text\/csv/);
    assert.match(await csv.text(), /^Date,Description,Amount/);
    assert.equal((await fetch(base + '/api/export.csv')).status, 401);
    // Receipts: only the owner can see them, and removing one deletes the file
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    r = await req('POST', '/api/receipt', { id: t.id, data: png });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const name = r.body.state.txns.find(x => x.id === t.id).receipt;
    assert.match(name, /^u_[a-f0-9]+_[a-f0-9]+\.png$/);
    assert.equal((await fetch(base + '/api/receipt/' + name, { headers: { Cookie: cookie } })).status, 200);
    assert.equal((await fetch(base + '/api/receipt/' + name, { headers: { Cookie: other } })).status, 404);
    const zipFile = path.join(DATA, 'test-backup.zip'); cli(['backup', zipFile], '\n', { BACKUP_PASSPHRASE: '' });
    assert.ok(fs.readFileSync(zipFile).includes('receipts/' + name), 'the backup zip has the receipt photo');
    assert.equal((await op('constructor', {})).status, 400, 'only real changes can be asked for');
    assert.equal((await req('POST', '/api/receipt', { id: t.id, data: 'data:text/html;base64,PGI+' })).status, 400);
    assert.equal((await op('txn.receipt', { id: t.id, receipt: '../../etc/passwd' })).status, 400, 'the browser can’t set a receipt path');
    r = await req('POST', '/api/receipt', { id: t.id, data: '' });
    assert.equal(r.body.state.txns.find(x => x.id === t.id).receipt, undefined);
    assert.equal(fs.existsSync(path.join(DATA, 'receipts', name)), false);
    // Split it
    const url = `http://127.0.0.1:${fakeSplit.address().port}`;
    assert.equal((await req('POST', '/api/splitit/send', { id: t.id, group: 'House' })).status, 400, 'needs connecting first');
    assert.equal((await req('POST', '/api/splitit/connect', { url, key: 'hsk_wrong_key_abcdefghijklmnop' })).status, 400);
    r = await req('POST', '/api/splitit/connect', { url, key: SPLIT_KEY });
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.splitit, true);
    assert.equal(JSON.stringify(r.body).includes(SPLIT_KEY), false, 'the key never goes back to the browser');
    await new Promise(ok => setTimeout(ok, 1500));
    assert.equal(fs.readFileSync(path.join(DATA, 'db.json'), 'utf8').includes(SPLIT_KEY), false, 'the key is encrypted on disk');
    r = await req('GET', '/api/splitit/groups');
    assert.deepEqual(r.body.groups, ['House', 'Cottage trip']);
    r = await req('POST', '/api/splitit/send', { id: t.id, group: 'House' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.match(r.body.msg, /Added "Loblaws" \$54\.20 in House/);
    assert.equal(r.body.state.txns.find(x => x.id === t.id).sentTo, 'House');
    const sent = splitCalls.at(-1);
    assert.equal(sent.name, 'add_expense'); assert.equal(sent.arguments.category, 'groceries'); assert.equal(sent.arguments.amount, 54.2);
    r = await req('POST', '/api/splitit/connect', {});
    assert.equal(r.body.splitit, false);
  } finally { fakeSplit.close(); }
});

test('the assistant’s newer tools: bills, safe to spend, month report, budgets and goals', async () => {
  const key = cli(['mcp-key', 'Sherry']).match(/bik_[A-Za-z0-9_-]+/)[0];
  const call = async (name, args = {}) => (await req('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, '', { Authorization: 'Bearer ' + key, Accept: 'application/json, text/event-stream' })).body.result;
  for (const n of ['safe_to_spend', 'list_bills', 'month_report', 'year_review', 'payoff_plan']) { const x = await call(n); assert.ok(!x.isError, n + ': ' + x.content[0].text); }
  let x = await call('set_budget', { category: 'groceries', amount: 400 });
  assert.ok(!x.isError, x.content[0].text);
  assert.equal((await req('GET', '/api/state')).body.state.budgets.groceries, 400);
  x = await call('create_goal', { name: 'Japan', target: 3000, by: '2027-06' });
  assert.match(x.content[0].text, /a month to finish by 2027-06/);
  x = await call('set_budget', { category: 'nonsense', amount: 5 });
  assert.equal(x.isError, true);
  // A holding added by hand gets a new price from the assistant
  await op('account.add', { name: 'RRSP', type: 'Investment', bal: 0 });
  const rr = (await req('GET', '/api/state')).body.state.accounts.find(a => a.name === 'RRSP');
  await op('holding.save', { acct: rr.id, sym: 'XEQT', qty: 10, price: 30 });
  x = await call('update_price', { symbol: 'xeqt', price: 33.5 });
  assert.match(x.content[0].text, /XEQT now 33\.50 CAD in "RRSP", which is worth 335\.00 CAD/, 'it says the currency');
  assert.match((await call('update_price', { symbol: 'nope', price: 1 })).content[0].text, /You have: XEQT/);
});

test('odd requests get a clear answer, never a crash', async () => {
  const routes = ['/api/receipt', '/api/splitit/connect', '/api/splitit/send', '/api/op', '/api/plaid/link-token', '/api/plaid/exchange', '/api/plaid/fixed', '/api/plaid/remove', '/api/push/subscribe', '/api/push/unsubscribe'];
  const bodies = [null, [], 'x', 5, {}, { op: 'txn.update', args: null }, { op: 'txn.update', args: [1] }, { op: '__proto__' }, { id: {}, item: [], group: {}, amount: 'lots', url: 5, key: {}, public_token: 5, sub: 'x', endpoint: {} }];
  for (const p of routes) for (const b of bodies) {
    const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(b) });
    assert.ok(r.status < 500, `${p} ${JSON.stringify(b)} -> ${r.status} ${await r.text()}`);
  }
  const r = await fetch(base + '/api/op', { method: 'POST', headers: { Cookie: cookie }, body: '{not json' });
  assert.equal(r.status, 400);
});

test('the assistant’s tools answer plainly even with odd arguments', async () => {
  const key = cli(['mcp-key', 'Sherry']).match(/bik_[A-Za-z0-9_-]+/)[0];
  const rpc = async body => { const r = await fetch(base + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: 'Bearer ' + key }, body: JSON.stringify(body) }); assert.ok(r.status < 500, JSON.stringify(body) + ' -> ' + r.status); const t = await r.text(); return t ? JSON.parse(t) : null; };
  assert.ok((await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: null })).error);
  const tools = (await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).result.tools;
  const odd = [{}, { month: 'soon', category: 5, search: {}, limit: -3, amount: 'lots', name: '', target: -1, by: 'never', id: [], account: 7, apr: 'x', payment: -5, months: 0, symbol: {}, price: 'free', year: 'abc', note: 9 }];
  for (const t of tools) if (!['refresh_banks', 'undo_last_change'].includes(t.name)) for (const args of odd) {
    const x = (await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: t.name, arguments: args } })).result;
    const text = x.content[0].text;
    assert.doesNotMatch(text, /Cannot read|is not a function|undefined|NaN|\[object Object\]/, `${t.name} ${JSON.stringify(args)}: ${text}`);
  }
});

test('each person links their own assistants from the app, and only they can disconnect them', async () => {
  const tools = key => req('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, '', { Authorization: 'Bearer ' + key, Accept: 'application/json, text/event-stream' });
  assert.equal((await req('GET', '/api/assistants', undefined, '')).status, 401, 'needs a sign-in');
  let r = await req('GET', '/api/assistants');
  assert.equal(r.status, 200);
  assert.match(r.body.url, /\/mcp$/);
  const before = r.body.list.length;

  // a key made in the app works on /mcp and acts as its person
  r = await req('POST', '/api/assistants/key', { name: '  Muse   on my phone ' });
  assert.equal(r.status, 200);
  const key = r.body.key;
  assert.match(key, /^bik_/);
  assert.equal((await tools(key)).status, 200);
  const list = (await req('GET', '/api/assistants')).body.list;
  assert.equal(list.length, before + 1);
  const row = list.find(x => x.name === 'Muse on my phone');
  assert.equal(row.kind, 'key');
  assert.ok(row.used > 0, 'it shows when it was last used');
  assert.ok(!JSON.stringify(list).includes(key.slice(4)), 'the list never shows the key itself');

  // an assistant connected by signing in (what Claude does) shows up under its own name
  const crypto = require('crypto');
  const reg = await req('POST', '/oauth/register', { client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] }, '');
  const verifier = crypto.randomBytes(32).toString('base64url'), challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const q = { response_type: 'code', client_id: reg.body.client_id, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', state: 's', code_challenge: challenge, code_challenge_method: 'S256' };
  const back = await fetch(base + '/oauth/authorize', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...q, name: 'Mika', password: 'password456' }) });
  const code = new URL(back.headers.get('location')).searchParams.get('code');
  const tok = await (await fetch(base + '/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: reg.body.client_id, redirect_uri: q.redirect_uri }) })).json();
  assert.equal((await tools(tok.access_token)).status, 200);
  const mika = (await req('GET', '/api/assistants', undefined, other)).body.list;
  const claude = mika.find(x => x.name === 'Claude');
  assert.equal(claude.kind, 'app');
  assert.ok(!mika.some(x => x.name === 'Muse on my phone'), 'Mika sees only her own');

  // someone else can't disconnect yours
  r = await req('POST', '/api/assistants/remove', { id: row.id }, other);
  assert.equal(r.body.removed, 0);
  assert.equal((await tools(key)).status, 200);
  // you can
  r = await req('POST', '/api/assistants/remove', { id: row.id });
  assert.equal(r.body.removed, 1);
  assert.equal((await tools(key)).status, 401);
  // disconnecting Claude ends both its access and its refresh
  r = await req('POST', '/api/assistants/remove', { id: claude.id }, other);
  assert.equal(r.body.removed, 2);
  assert.equal((await tools(tok.access_token)).status, 401);
  const again = await fetch(base + '/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: reg.body.client_id }) });
  assert.equal(again.status, 400);
  assert.equal((await req('POST', '/api/assistants/remove', {})).status, 400);
});
