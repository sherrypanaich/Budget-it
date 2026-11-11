// Transfers, paydays, safe to spend, alerts, bills you add, categories and export. Run with: node --test
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const B = require('../budget');
const sample = require('../sample');
const makeOps = require('../ops');

const T = (date, m, a, c, o = {}) => ({ id: Math.random().toString(36).slice(2), date, acct: 'chk', m, a, c, note: '', ...o });
const base = o => ({ accounts: [], txns: [], budgets: {}, rollover: {}, rules: [], goals: [], hiddenBills: [], ...o });
const ops = () => makeOps(B, { today: () => '2026-11-09', rid: p => p + Math.random().toString(16).slice(2, 8), sample }).OPS;
const daysAgo = n => { const d = new Date(Date.now() - n * 864e5), p = x => String(x).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
const ACCTS = [{ id: 'chk', name: 'Chequing', type: 'Chequing', bal: 1000 }, { id: 'cc', name: 'Visa', type: 'Credit card', bal: -300 }, { id: 'sav', name: 'Savings', type: 'Savings', bal: 2500 }];

test.beforeEach(() => B.useCats({}));

test('a card payment is matched as a transfer, not spending', () => {
  const st = base({ accounts: ACCTS, txns: [
    T(daysAgo(3), 'Payment to Visa', -300, 'shopping', { id: 'out' }),
    T(daysAgo(1), 'Payment thank you', 300, 'income', { id: 'in', acct: 'cc' }),
    T(daysAgo(2), 'Refund', 300, 'shopping', { id: 'same', acct: 'chk' }),          // same account: not a transfer
    T(daysAgo(2), 'Loblaws', -45, 'groceries', { id: 'set', acct: 'cc', set: true })] });
  assert.equal(B.matchTransfers(st), 1);
  const by = id => st.txns.find(t => t.id === id);
  assert.equal(by('out').c, 'transfer'); assert.equal(by('in').c, 'transfer');
  assert.equal(by('out').pair, 'in'); assert.equal(by('same').c, 'shopping');
  assert.equal(B.matchTransfers(st), 0);   // running again changes nothing
});

test('payday twice a month and safe to spend', () => {
  const st = base({ accounts: ACCTS, txns: [
    T('2026-09-15', 'PAYROLL ACME 123', 2000, 'income'), T('2026-09-30', 'PAYROLL ACME 456', 2000, 'income'),
    T('2026-10-15', 'PAYROLL ACME 789', 2000, 'income'), T('2026-10-30', 'PAYROLL ACME 111', 2000, 'income'),
    T('2026-11-01', 'Payroll Acme 222', 2000, 'income'),
    T('2026-09-12', 'Netflix', -16.99, 'fun', { acct: 'cc' }), T('2026-10-12', 'Netflix', -16.99, 'fun', { acct: 'cc' })] });
  const p = B.payday(st, '2026-11-09');
  assert.equal(p.every, 'twice a month'); assert.equal(p.next, '2026-11-15'); assert.equal(p.days, 6); assert.equal(p.amount, 2000);
  const s = B.safeToSpend(st, '2026-11-09');
  assert.equal(s.cash, 1000); assert.equal(s.cards, -300); assert.equal(s.billsTotal, 16.99);
  assert.equal(s.amount, 683.01);
  assert.equal(B.safeToSpend(base({ accounts: ACCTS }), '2026-11-09'), null);   // no pay found yet
});

test('payday every two weeks', () => {
  const st = base({ txns: ['2026-09-18', '2026-10-02', '2026-10-16', '2026-10-30'].map(d => T(d, 'Payroll', 1500, 'income')) });
  const p = B.payday(st, '2026-11-09');
  assert.equal(p.every, 'every 2 weeks'); assert.equal(p.next, '2026-11-13');
});

test('alerts: big charge, price increase, low chequing, and dismissing', () => {
  const st = base({ accounts: [{ id: 'chk', name: 'Chequing', type: 'Chequing', bal: 60 }], txns: [
    T('2026-09-03', 'GoodLife Fitness', -39.99, 'health'), T('2026-10-03', 'GoodLife Fitness', -39.99, 'health'), T('2026-11-03', 'GoodLife Fitness', -44.99, 'health'),
    T('2026-11-08', 'Apple Store', -649, 'shopping', { id: 'big' })] });
  const kinds = B.alerts(st, '2026-11-09').map(a => a.kind).sort();
  assert.deepEqual(kinds, ['big', 'low', 'priceup']);
  const up = B.alerts(st, '2026-11-09').find(a => a.kind === 'priceup');
  assert.match(up.title, /went up \$5\.00/);
  ops()['alert.dismiss'](st, { key: up.key });
  assert.ok(!B.alerts(st, '2026-11-09').some(a => a.kind === 'priceup'));
});

test('bills you add, monthly and yearly', () => {
  const st = base();
  const O = ops();
  O['bill.add'](st, { n: 'Car insurance', amount: 1240, d: 15, every: 'year', month: 3 });
  O['bill.add'](st, { n: 'Rent', amount: 1650, d: 1 });
  const up = B.upcoming(st, '2026-11-09');
  const car = up.find(b => b.n === 'Car insurance'), rent = up.find(b => b.n === 'Rent');
  assert.equal(car.due, '2027-03-15'); assert.equal(car.every, 'year');
  assert.equal(rent.due, '2026-11-01'); assert.equal(rent.late, true);
  st.txns.push(T('2026-11-01', 'Rent', -1650, 'home'));
  assert.equal(B.upcoming(st, '2026-11-09').find(b => b.n === 'Rent').paid, true);
  O['bill.delete'](st, { id: car.id });
  assert.equal(B.upcoming(st, '2026-11-09').length, 1);
  assert.throws(() => O['bill.add'](st, { n: '', amount: 5 }));
});

test('custom categories: add, rename, use, delete', () => {
  const st = base({ txns: [T('2026-11-02', 'Pet Valu', -45, 'shopping', { id: 'p' })] });
  const O = ops(); B.useCats(st);
  O['cat.add'](st, { name: 'Pets', icon: 'paw' });
  const pets = st.cats[0];
  assert.ok(B.CAT_IDS.includes(pets.id)); assert.equal(B.catName(pets.id), 'Pets');
  assert.throws(() => O['cat.add'](st, { name: 'pets' }), /already/);
  O['cat.update'](st, { id: 'fun', name: 'Going out' });
  assert.equal(B.catName('fun'), 'Going out');
  O['txn.update'](st, { id: 'p', c: pets.id });
  O['budget.set'](st, { c: pets.id, amount: 100 });
  assert.equal(B.spent(st, pets.id, '2026-11'), 45);
  O['cat.delete'](st, { id: pets.id, to: 'shopping' });
  assert.equal(st.txns[0].c, 'shopping'); assert.ok(!B.CAT_IDS.includes(pets.id));
  assert.throws(() => O['cat.delete'](st, { id: 'groceries' }));
});

test('carry overspending takes last month’s overspend off this month', () => {
  const st = base({ budgets: { dining: 200 }, carry: { dining: true }, txns: [T('2026-10-05', 'A', -250, 'dining')] });
  assert.equal(B.limit(st, 'dining', '2026-11'), 150);
  st.carry.dining = false;
  assert.equal(B.limit(st, 'dining', '2026-11'), 200);
});

test('rules that contain a word, and remembering the last category', () => {
  const st = base({ rules: [{ match: 'uber eats', cat: 'dining', how: 'contains' }], txns: [T('2026-10-01', 'Kinka Izakaya', -40, 'fun')] });
  assert.equal(B.pickCat(st, 'DD *UBER EATS TORONTO'), 'dining');
  assert.equal(B.pickCat(st, 'Kinka Izakaya'), 'fun');
});

test('bulk changes, tags, hiding and export', () => {
  const st = base({ accounts: ACCTS, txns: [T('2026-11-02', 'Ramen, "Ichiran"', -30, 'shopping', { id: 'a' }), T('2026-11-03', 'JR Pass', -400, 'shopping', { id: 'b' }), T('2026-11-04', 'Sushi', -60, 'dining', { id: 'c', other: true })] });
  const O = ops();
  assert.match(O['txn.bulk'](st, { ids: ['a', 'b', 'c'], c: 'fun', tag: '#Japan Trip' }), /Changed 2/);   // someone else's stays as is
  assert.equal(st.txns[0].c, 'fun'); assert.equal(st.txns[2].c, 'dining');
  assert.deepEqual(st.txns[0].tags, ['japan-trip']);
  const tags = B.tagTotals(st);
  assert.equal(tags[0].tag, 'japan-trip'); assert.equal(tags[0].spent, 430); assert.equal(tags[0].count, 2);
  O['txn.bulk'](st, { ids: ['b'], hidden: true });
  assert.equal(B.spent(st, 'fun', '2026-11'), 30);
  const csv = B.toCsv(st).trim().split('\n');
  assert.equal(csv[0], 'Date,Description,Amount,Category,Account,Note,Tags,Counted');
  assert.equal(csv.length, 3);   // two of yours, the shared one left out
  assert.equal(csv[1], '2026-11-02,"Ramen, ""Ichiran""",-30.00,Fun,Chequing,,japan-trip,yes');
  assert.match(csv[2], /,no$/);
  assert.throws(() => O['txn.bulk'](st, { ids: [] }));
});

test('goals can follow a savings account', () => {
  const st = base({ accounts: ACCTS });
  const O = ops();
  O['goal.add'](st, { n: 'Rainy day', target: 5000, by: '2027-11' });
  const g = st.goals[0];
  O['goal.link'](st, { id: g.id, acct: 'sav' });
  assert.equal(B.goalSaved(st, g), 2500);
  assert.equal(B.goalMonthly(g, '2026-11-09', st), 208.33);
  assert.throws(() => O['goal.fund'](st, { id: g.id, amount: 50 }), /follows/);
  O['goal.link'](st, { id: g.id });
  assert.equal(g.saved, 2500); assert.equal(g.acct, undefined);
});

test('the sample data shows every new feature', () => {
  const st = sample('2026-11-09'); B.useCats(st);
  const kinds = B.alerts(st, '2026-11-09').map(a => a.kind);
  assert.ok(kinds.includes('big') && kinds.includes('priceup'), kinds.join());
  assert.ok(B.safeToSpend(st, '2026-11-09'));
  assert.ok(B.upcoming(st, '2026-11-09').length >= 5);
});

test('accounts you keep by hand: add, update the balance, remove', () => {
  const st = base({ goals: [] }); const O = ops();
  O['account.add'](st, { name: 'Credit union', type: 'Chequing', bal: '1,250.40' });
  O['account.add'](st, { name: 'Line of credit', type: 'Loan', bal: 500 });
  const [cu, loc] = st.accounts;
  assert.equal(cu.bal, 1250.4); assert.equal(loc.bal, -500); assert.equal(cu.manual, true);
  O['account.balance'](st, { id: loc.id, bal: 450 });
  assert.equal(loc.bal, -450);
  st.txns.push(T('2026-11-02', 'Cash', -5, 'dining', { acct: cu.id }));
  O['goal.add'](st, { n: 'Rainy day', target: 2000 }); O['goal.link'](st, { id: st.goals[0].id, acct: cu.id });
  assert.match(O['account.delete'](st, { id: cu.id }), /and its 1 transaction/);
  assert.equal(st.txns.length, 0); assert.equal(st.goals[0].saved, 1250.4); assert.equal(st.goals[0].acct, undefined);
  st.accounts.push({ id: 'p_chk', name: 'Bank', type: 'Chequing', bal: 10 });
  assert.throws(() => O['account.balance'](st, { id: 'p_chk', bal: 5 }), /from your bank/);
  assert.throws(() => O['account.delete'](st, { id: 'p_chk' }));
  assert.throws(() => O['account.add'](st, { name: '' }));
});
