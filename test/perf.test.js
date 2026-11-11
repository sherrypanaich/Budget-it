// A big budget stays quick: five years, ~25,000 charges over 8 accounts, 200 rules, 50 bills and receipt photos.
// The time limits are generous (a slow laptop, a busy test run); they're there to catch work that grows with the
// square of the budget, which took seconds before (Home 2.8 s, a CSV of 5,000 rows 65 s). Run with: node --test
'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const B = require('../budget');
const makeOps = require('../ops');
const sample = require('../sample');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-it-perf-'));
after(() => fs.rmSync(DIR, { recursive: true, force: true }));
const TODAY = B.ymd(new Date());
let seed = 11; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const pick = a => a[Math.floor(rnd() * a.length)];
const CATS = ['groceries', 'dining', 'transport', 'shopping', 'fun', 'health', 'home'];
function big(uid = 'u_perf') {
  const accounts = ['chq', 'sav', 'visa', 'mc', 'amex', 'loc', 'tfsa', 'joint'].map((id, i) => ({ id, name: 'Account ' + id, inst: 'Bank', type: i === 0 ? 'Chequing' : i < 5 ? 'Credit card' : 'Savings', mask: String(1000 + i), bal: 1000, shared: [], manual: true }));
  const shops = Array.from({ length: 600 }, (_, i) => `Store ${crypto.createHash('md5').update(String(i)).digest('hex').slice(0, 6)} #${100 + i % 9}`);
  const txns = []; let n = 0;
  for (let d = 5 * 365; d >= 0; d--) {
    const date = B.ymd(new Date(Date.now() - d * 864e5));
    for (let j = 0; j < 13; j++) txns.push({ id: 't' + (n++).toString(36), date, acct: pick(accounts).id, m: pick(shops), a: -Math.round(rnd() * 15000 + 100) / 100, c: pick(CATS), note: '', ...(d < 3 ? { fresh: true } : {}) });
    if (date.endsWith('-01')) for (let k = 0; k < 4; k++) txns.push({ id: 't' + (n++).toString(36), date, acct: 'chq', m: 'Monthly ' + k, a: -50 - k, c: 'home', note: '' });   // bills it spots
    if (date.endsWith('-15')) txns.push({ id: 't' + (n++).toString(36), date, acct: 'chq', m: 'Payroll', a: 2850, c: 'income', note: '' });
  }
  for (let i = 0; i < 40; i++) txns[txns.length - 1 - i * 60].receipt = `${uid}_${crypto.randomBytes(9).toString('hex')}.jpg`;
  return { accounts, txns, budgets: Object.fromEntries(CATS.map(c => [c, 400])), rollover: { groceries: true }, carry: {}, expectIncome: 5700,
    rules: shops.slice(0, 200).map((m, i) => ({ match: m.split(' #')[0], cat: CATS[i % 7] })), goals: [], hiddenBills: [], cats: [], catNames: {}, dismissed: [], guide: 'luffy', seenNew: 0,
    myBills: Array.from({ length: 50 }, (_, i) => ({ id: 'b' + i, n: 'Bill ' + i, a: 10 + i, d: 1 + i % 28, every: i % 10 ? 'month' : 'year', month: i % 10 ? null : 1 + i % 12, c: 'home', sub: false })) };
}
const clock = fn => { const a = process.hrtime.bigint(); const r = fn(); return [Number(process.hrtime.bigint() - a) / 1e6, r]; };

test('Home, Plans and alerts on a five-year budget take milliseconds, and say the same as the slow way', () => {
  const st = big(); B.useCats(st);
  assert.ok(st.txns.length > 23000);
  const [tHome] = clock(() => { B.totals(st, B.ymOf(TODAY)); B.budgetStatus(st, B.ymOf(TODAY), TODAY); B.perDay(st, TODAY); B.safeToSpend && B.safeToSpend(st, TODAY); B.week(st, TODAY); });
  const [tUp, up] = clock(() => B.upcoming(st, TODAY));
  const [tAlerts, al] = clock(() => B.alerts(st, TODAY));
  assert.ok(tHome + tUp + tAlerts < 3000, `Home's numbers took ${Math.round(tHome + tUp + tAlerts)} ms`);
  // the quick way gives the same answers as checking each one over every charge
  assert.ok(up.length >= 50);
  for (const b of up) if (b.every !== 'year') assert.equal(b.paid, B.billPaid(st, b, B.ymOf(TODAY)), b.n);
  assert.ok(up.some(b => b.paid) && up.some(b => !b.paid));
  assert.ok(Array.isArray(al));
  const idx = B.lastCats(st);
  for (const t of st.txns.slice(-300)) assert.equal(B.lastCat(st, t.m, idx), B.lastCat(st, t.m), t.m);
  // Trends: every category and month in one pass
  const sp = B.spentBy(st);
  for (const ym of ['2026-01', B.ymOf(TODAY), B.prevYm(B.ymOf(TODAY))]) for (const c of [...CATS, 'income']) assert.equal(sp(c, ym), B.spent(st, c, ym), c + ' ' + ym);
});

test('importing a CSV of 5,000 rows into a big budget takes well under a few seconds, with the same categories as before', () => {
  const st = big(); B.useCats(st);
  const O = makeOps(B, { today: () => TODAY, rid: p => p + crypto.randomBytes(6).toString('hex'), sample }).OPS;
  const old = st.txns.slice(-50).map(t => t.m);
  const rows = ['Date,Description,Amount'];
  for (let i = 0; i < 5000; i++) rows.push(`${B.ymd(new Date(Date.now() - (i % 300) * 864e5))},${i % 3 ? 'Import shop ' + (i % 250) : old[i % 50]},${i % 40 ? '-' : ''}${(i % 97) + 0.5}`);
  const [t, msg] = clock(() => O['csv.import'](st, { text: rows.join('\n'), name: 'Old bank' }));
  assert.match(msg, /^Imported 5,?000 transactions|^Imported \d+ transactions/);
  assert.ok(t < 5000, `import took ${Math.round(t)} ms`);
  // each row got the category the slow way would give: a rule, income, the one used last time, a guess
  const acct = st.accounts.find(a => a.name === 'Old bank'), mine = st.txns.filter(x => x.acct === acct.id);
  const replay = { ...st, txns: st.txns.filter(x => x.acct !== acct.id) };
  for (const x of mine.slice(0, 400)) {
    assert.equal(x.c, B.pickCat(replay, x.m, x.a > 0 ? 'income' : null), x.m);
    replay.txns.push(x);
  }
});

test('a change to a big budget with receipt photos is quick, and keeps the photos its charges still have', () => {
  const data = path.join(DIR, 'data'); fs.mkdirSync(path.join(data, 'receipts'), { recursive: true });
  const uid = 'u_perf', st = big(uid);
  for (const t of st.txns) if (t.receipt) fs.writeFileSync(path.join(data, 'receipts', t.receipt), 'jpg');
  fs.writeFileSync(path.join(data, 'receipts', `${uid}_0000aaaa.jpg`), 'no charge has this one');
  fs.writeFileSync(path.join(data, 'db.json'), JSON.stringify({ items: {}, people: { [uid]: st } }));
  process.env.DATA_DIR = data; process.env.UPDATE_CHECK = 'off';
  const S = require('../server.js');
  const id = S._db().people[uid].txns.at(-1).id;
  const [t] = clock(() => { for (let i = 0; i < 5; i++) S.applyOp(uid, 'txn.update', { id, note: 'note ' + i }); S.applyOp(uid, 'txn.add', { amount: 3, m: 'Coffee', c: 'dining' }); });
  assert.ok(t < 4000, `6 changes took ${Math.round(t)} ms`);
  const left = fs.readdirSync(path.join(data, 'receipts'));
  assert.equal(left.length, 40, 'every photo a charge points to is kept');
  assert.ok(!left.includes(`${uid}_0000aaaa.jpg`), 'the one nothing points to went (Undo has no copy with it)');
  const [tv, v] = clock(() => JSON.stringify(S.viewFor(uid)));
  assert.ok(tv < 1500, `the page’s state took ${Math.round(tv)} ms`);
  assert.ok(v.length < 6e6, 'and is a few MB at most');
});
