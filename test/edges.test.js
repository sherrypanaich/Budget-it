// Edges found in a last read-through before 1.1.0: dates and amounts in CSV files, bills around the end of a month,
// disconnected banks, charges the bank takes back, Undo after a bank update, receipt photos, odd ids, and the update check.
// Run with: node --test
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const B = require('../budget');
const makeOps = require('../ops');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-it-edges-'));
const DATA = path.join(DIR, 'data');
const T = '2026-11-11';
let n = 0;
const ops = (today = T) => makeOps(B, { today: () => today, rid: p => p + 'id' + (++n), sample: () => ({}) }).OPS;
const blank = () => ({ accounts: [], txns: [], budgets: {}, rollover: {}, carry: {}, rules: [], goals: [], hiddenBills: [], myBills: [], cats: [], catNames: {} });
after(() => fs.rmSync(DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

// ---------- money rules ----------
test('CSV dates: real days only, and DD/MM when the first number can’t be a month', () => {
  assert.equal(B.toDate('25/12/2026'), '2026-12-25');
  assert.equal(B.toDate('11/05/2026'), '2026-11-05', 'MM/DD stays the default');
  assert.equal(B.toDate('2028-02-29'), '2028-02-29');
  assert.equal(B.toDate('2027-02-29'), null);
  assert.equal(B.toDate('2026-02-30'), null);
  assert.equal(B.toDate('13/13/2026'), null);
  assert.equal(B.toDate('5'), null, 'a lone number isn’t a date');
  assert.equal(B.toDate('45231'), null, 'nor a spreadsheet’s day number');
  assert.equal(B.toDate('Nov 5, 2026'), '2026-11-05');
  const rows = B.parseCsv('Date,Description,Amount\n2026-11-02,Way too much,1e999\n2026-02-31,Nope,-5\n2026-11-03,Coffee,-4.50\n');
  assert.deepEqual(rows, [{ date: '2026-11-03', m: 'Coffee', a: -4.5 }], 'an amount of Infinity or a day that isn’t one is left out');
});

test('CSV import: two of the same coffee in one file both come in, the same file again adds nothing', () => {
  const s = blank(), O = ops();
  const file = 'Date,Description,Amount\n2026-11-02,Tim Hortons,-4.50\n2026-11-02,Tim Hortons,-4.50\n2026-11-03,Loblaws,-50\n';
  O['csv.import'](s, { text: file, name: 'Card' });
  assert.equal(s.txns.length, 3);
  const acct = s.accounts[0].id;
  assert.match(O['csv.import'](s, { text: file, acct }), /all imported already/);
  O['txn.update'](s, { id: s.txns[2].id, m: 'Groceries run' });   // renamed: still the same charge
  O['txn.split'](s, { id: s.txns[0].id, amount: 2, c: 'fun' });   // split: still the same charge
  assert.equal(s.txns.length, 4);
  O['csv.import'](s, { text: file + '2026-11-02,Tim Hortons,-4.50\n', acct });
  assert.equal(s.txns.filter(t => !t.splitOf).length, 4, 'only the third coffee is new');
});

test('a disconnected bank’s old balance isn’t money to spend, and doesn’t hide a low chequing balance', () => {
  const s = blank();
  s.accounts = [{ id: 'a', type: 'Chequing', bal: 50 }, { id: 'b', type: 'Chequing', bal: 9000, disconnected: true }];
  s.txns = ['2026-09-01', '2026-10-01', '2026-11-01'].map((date, i) => ({ id: 'p' + i, date, acct: 'a', m: 'Payroll', a: 2000, c: 'income' }));
  assert.equal(B.safeToSpend(s, T).cash, 50);
  assert.ok(B.alerts(s, T).some(a => a.kind === 'low'));
  assert.equal(B.worth(s), 9050, 'it still counts in net worth (the page says it’s the last known balance)');
});

test('a bill charged on the 31st one month and the 1st the next is still a bill, and the reminder comes the day before', () => {
  const s = blank();
  s.txns = [['2026-07-31', -1650], ['2026-09-01', -1650], ['2026-09-30', -1650], ['2026-11-02', -1650]].map(([date, a], i) => ({ id: 'r' + i, date, acct: 'a', m: 'Maple Rent', a, c: 'home' }));
  const b = B.bills(s, T).find(x => x.n === 'Maple Rent');
  assert.ok(b, 'found');
  assert.equal(b.d, 1);
  // Rent on the 1st, already paid this month: on the 31st, it's due tomorrow
  const r = blank(); r.txns = ['2026-09-01', '2026-10-01'].map((date, i) => ({ id: 'q' + i, date, acct: 'a', m: 'Rent', a: -1650, c: 'home' }));
  assert.deepEqual(B.dueOn(r, '2026-10-31', '2026-11-01').map(x => x.n), ['Rent']);
  assert.deepEqual(B.dueOn(r, '2026-10-30', '2026-10-31'), []);
});

test('ops: amounts that aren’t money and days that don’t exist', () => {
  const s = blank(), O = ops();
  assert.throws(() => O['txn.add'](s, { amount: '1e300', m: 'x' }), /how much/);
  assert.throws(() => O['budget.set'](s, { c: 'fun', amount: 1e12 }), /\$0 or more/);
  O['txn.add'](s, { amount: 5, m: 'Coffee', date: '2026-02-31' });
  assert.equal(s.txns[0].date, T);
});

test('ops: removing a category moves your own bills too, and a goal keeps its account’s balance in home money', () => {
  const s = blank(), O = ops();
  O['cat.add'](s, { name: 'Pets' }); const id = s.cats[0].id;
  O['bill.add'](s, { n: 'Vet plan', amount: 30, d: 5, c: id });
  O['cat.delete'](s, { id, to: 'health' });
  assert.equal(s.myBills[0].c, 'health');
  s.rates = { USD: 1.4 };
  O['account.add'](s, { name: 'US savings', type: 'Savings', bal: 100, cur: 'USD' });
  O['goal.add'](s, { n: 'Trip', target: 1000, acct: s.accounts[0].id });
  O['account.delete'](s, { id: s.accounts[0].id });
  assert.equal(s.goals[0].saved, 140);
  B.useCats(blank());
});

test('ops: a new home currency puts each account’s charges in it', () => {
  const s = blank(), O = ops();
  s.rates = { USD: 1.4 };
  s.accounts = [{ id: 'us', name: 'US', type: 'Chequing', bal: 10, cur: 'USD', manual: true }, { id: 'ca', name: 'CA', type: 'Chequing', bal: 20, manual: true }];
  s.txns = [{ id: 'u', date: T, acct: 'us', m: 'Diner', a: -14, orig: { a: -10, cur: 'USD' }, c: 'dining' }, { id: 'c', date: T, acct: 'ca', m: 'Cafe', a: -20, c: 'dining' }];
  O['money.home'](s, { home: 'USD' });
  assert.equal(s.txns[0].a, -10); assert.equal(s.txns[0].orig, undefined);
  assert.equal(s.txns[1].a, -20); assert.deepEqual(s.txns[1].orig, { a: -20, cur: 'CAD' }); assert.equal(s.txns[1].norate, true);
  O['money.rate'](s, { cur: 'CAD', rate: 0.7 });
  assert.equal(s.txns[1].a, -14);
});

// ---------- the server, in this process, against a fake Plaid and a fake GitHub ----------
let srv, base, ana, ben, S, plaidDelay = 0;
const plan = { syncs: [] };   // what each /transactions/sync answers, in turn
const tx = (id, acct, amount, name, o = {}) => ({ transaction_id: id, account_id: acct, amount, name, merchant_name: name, date: B.ymd(new Date()), pending: false, ...o });
const fake = http.createServer((req, res) => {
  let body = ''; req.on('data', c => body += c); req.on('end', async () => {
    const send = x => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(x)); };
    if (req.url === '/release') return send({ tag_name: 'v9.9.9', name: 'Budget it 9.9.9', body: '## Security\n- A fix', html_url: 'https://github.com/x/y' });
    if (req.url === '/item/public_token/exchange') return send({ access_token: 'acc-1', item_id: 'item-1' });
    if (req.url === '/accounts/get') return send({ accounts: [['chk', '1111', 'depository', 'checking'], ['sav', '2222', 'depository', 'savings'], ['cc', '3333', 'credit', 'credit card']]
      .map(([account_id, mask, type, subtype]) => ({ account_id, mask, type, subtype, name: account_id, balances: { current: 100, iso_currency_code: 'CAD' } })) });
    if (req.url === '/transactions/sync') {
      if (plaidDelay) await new Promise(r => setTimeout(r, plaidDelay));
      const x = plan.syncs.shift() || {};
      return send({ added: x.added || [], modified: [], removed: (x.removed || []).map(id => ({ transaction_id: id })), next_cursor: 'c' + Date.now(), has_more: false });
    }
    if (req.url === '/transactions/recurring/get') return send({ outflow_streams: [] });
    send({});
  });
});
function call(who, method, url, body) {
  return new Promise((ok, no) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const r = http.request(base + url, { method, headers: { 'Content-Type': 'application/json', ...(who ? { Cookie: who.cookie } : {}) } }, res => {
      let t = ''; res.on('data', c => t += c); res.on('end', () => { let j = null; try { j = JSON.parse(t); } catch {} ok({ status: res.statusCode, data: j, headers: res.headers }); });
    });
    r.on('error', no); if (data) r.write(data); r.end();
  });
}
const signIn = async name => {
  const r = await call(null, 'POST', '/api/login', { name, password: name.toLowerCase() + '-password' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const cookie = [].concat(r.headers['set-cookie']).find(c => c.startsWith('bi=')).split(';')[0];
  const who = { cookie }; who.uid = (await call(who, 'GET', '/api/state')).data.me.id; return who;
};

before(async () => {
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  const fakeUrl = `http://127.0.0.1:${fake.address().port}`;
  Object.assign(process.env, { DATA_DIR: DATA, PLAID_CLIENT_ID: 'id', PLAID_SECRET: 'secret', PLAID_ENV: 'sandbox', PLAID_URL: fakeUrl, PLAID_REDIRECT_URI: '',
    RELEASES_URL: fakeUrl + '/release', UPDATE_CHECK: '', BUDGET_IT_KEY: 'edges-test-key', BACKUP_COPY_DIR: '', BACKUP_PASSPHRASE: '', RESEND_API_KEY: '', GOOGLE_CLIENT_ID: '', PUBLIC_URL: '', SPLIT_IT_URL: '' });
  fs.mkdirSync(DATA, { recursive: true });
  for (const name of ['Ana', 'Ben']) spawnSync(process.execPath, [path.join(__dirname, '..', 'server.js'), 'add-user', name], { env: process.env, input: name.toLowerCase() + '-password\n' });
  S = require('../server.js');
  srv = http.createServer((q, r) => S.handle(q, r).catch(e => { r.writeHead(e.status || 500); r.end(JSON.stringify({ error: e.message })); }));
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.address().port}`;
  ana = await signIn('Ana'); ben = await signIn('Ben');
});
after(async () => { if (srv) { srv.closeAllConnections?.(); srv.close(); } fake.close(); });

test('sample data isn’t shared with everyone here', () => {
  S.applyOp(ben.uid, 'sample.load');
  assert.equal(S.viewFor(ana.uid).state.accounts.filter(a => a.other).length, 0);
  S.applyOp(ben.uid, 'sample.clear');
});

test('odd ids: "constructor" and "__proto__" are nobody', async () => {
  S.applyOp(ana.uid, 'account.add', { name: 'Joint', type: 'Chequing', bal: 10 });
  const id = S.viewFor(ana.uid).state.accounts[0].id;
  assert.equal(S.applyOp(ana.uid, 'account.share', { id, with: ['constructor', '__proto__', 'toString', ben.uid] }).msg, 'Shared with Ben');
  for (const [p, body] of [['owner', { id: '__proto__', owner: true }], ['rename', { id: 'constructor', name: 'X' }], ['remove', { id: 'hasOwnProperty' }]])
    assert.equal((await call(ana, 'POST', '/api/admin/' + p, body)).status, 404, p);
  assert.equal({}.owner, undefined, 'nothing was set on every object');
  S.applyOp(ana.uid, 'account.delete', { id });
});

test('the owner’s update check says when a release is a security update', async () => {
  const r = await call(ana, 'GET', '/api/admin/update');
  assert.equal(r.data.newer, true); assert.equal(r.data.security, true);
});

let item;
test('a charge the bank takes back goes with its split part, its transfer match ends, and Undo can’t bring back what the bank changed', async () => {
  plan.syncs.push({ added: [tx('p1', 'cc', 30, 'Bar Raval', { pending: true }), tx('m1', 'chk', 100, 'Moved money'), tx('m2', 'sav', -100, 'Moved money')] });
  await S.connectItem(ana.uid, 'pub', 'Maple Bank', '');
  item = Object.keys(S._db().items)[0];
  let s = S._db().people[ana.uid];
  const bar = s.txns.find(t => t.plaidId === 'p1'), sav = s.txns.find(t => t.plaidId === 'm2');
  assert.ok(sav.pair, 'the two sides were matched as a transfer');
  S.applyOp(ana.uid, 'txn.split', { id: bar.id, amount: 10, c: 'fun' });
  plan.syncs.push({ removed: ['p1', 'm1'] });
  await S.syncAll(ana.uid);
  s = S._db().people[ana.uid];
  assert.equal(s.txns.filter(t => t.splitOf === bar.id).length, 0, 'the split part went too');
  const left = s.txns.find(t => t.plaidId === 'm2');
  assert.equal(left.pair, undefined); assert.notEqual(left.c, 'transfer');
  assert.throws(() => S.applyOp(ana.uid, 'undo'), /Nothing to undo/);
});

test('disconnecting while the bank is answering: the accounts stay disconnected and nothing new comes in', async () => {
  plan.syncs.push({ added: [tx('late', 'chk', 7, 'Late coffee')] });
  plaidDelay = 300;
  const going = S.syncAll(ana.uid);
  await new Promise(r => setTimeout(r, 100));
  await S.removeItem(ana.uid, item);
  await going; plaidDelay = 0;
  const s = S._db().people[ana.uid];
  assert.ok(s.accounts.filter(a => a.item === item).every(a => a.disconnected));
  assert.ok(!s.txns.some(t => t.plaidId === 'late'));
});

test('receipt photos: removing one can be undone, and "Delete this history" takes them once Undo can’t bring them back', async () => {
  const s = S._db().people[ana.uid], t = s.txns.find(x => x.plaidId === 'm2');
  const png = 'data:image/png;base64,' + Buffer.from('not really a png').toString('base64');
  let r = await call(ana, 'POST', '/api/receipt', { id: t.id, data: png });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const name = S._db().people[ana.uid].txns.find(x => x.id === t.id).receipt, file = path.join(DATA, 'receipts', name);
  r = await call(ana, 'POST', '/api/receipt', { id: t.id, data: '' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.state.txns.find(x => x.id === t.id).receipt, undefined);
  assert.ok(fs.existsSync(file), 'kept while Undo can bring it back');
  await call(ana, 'POST', '/api/op', { op: 'undo' });
  assert.equal(S._db().people[ana.uid].txns.find(x => x.id === t.id).receipt, name);
  S.receiptsBackup();
  assert.ok(fs.existsSync(file), 'a backup run keeps it too');
  S.applyOp(ana.uid, 'account.delete', { id: t.acct });
  assert.ok(fs.existsSync(file));
  for (let i = 1; i <= 21; i++) S.applyOp(ana.uid, 'income.set', { amount: i });   // Undo only goes back 20 steps
  assert.ok(!fs.existsSync(file), 'gone with the history');
});

test('restoring a backup from before 1.1 turns "shared with everyone" into the people here', () => {
  const old = { people: { [ana.uid]: { accounts: [{ id: 'mj', name: 'Joint', type: 'Chequing', bal: 1, manual: true, shared: true }], txns: [] } }, items: {} };
  S.restoreBackup(Buffer.from(JSON.stringify(old)));
  assert.deepEqual(S._db().people[ana.uid].accounts[0].shared, [ben.uid]);
});
