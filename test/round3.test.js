// Net worth over time, paying off a card, the year in review, and fixes to quick add, splits and renames. Run with: node --test
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const B = require('../budget');
const sample = require('../sample');
const makeOps = require('../ops');

const T = (date, m, a, c, o = {}) => ({ id: Math.random().toString(36).slice(2), date, acct: 'chk', m, a, c, note: '', ...o });
const base = o => ({ accounts: [], txns: [], budgets: {}, rollover: {}, rules: [], goals: [], hiddenBills: [], ...o });
const ops = () => makeOps(B, { today: () => '2026-11-09', rid: p => p + Math.random().toString(16).slice(2, 8), sample }).OPS;

test.beforeEach(() => B.useCats({}));

test('quick add understands thousands separators and decimal commas', () => {
  assert.equal(B.parseQuick('$1,200 rent').amount, 1200);
  assert.equal(B.parseQuick('tv 1,299.99').amount, 1299.99);
  assert.equal(B.parseQuick('lunch 14,20').amount, 14.2);
  assert.equal(B.parseQuick('coffee 4.50').amount, 4.5);
});

test('net worth is noted once a month and kept for 36 months', () => {
  const st = base({ accounts: [{ id: 'a', bal: 1000 }, { id: 'c', bal: -200 }, { id: 'x', bal: 99, other: true }] });
  assert.equal(B.noteWorth(st, '2026-11-09'), true);
  assert.deepEqual(st.worthHist, { '2026-11': 800 });
  assert.equal(B.noteWorth(st, '2026-11-10'), false);
  st.accounts[0].bal = 1500; B.noteWorth(st, '2026-11-20');
  assert.equal(st.worthHist['2026-11'], 1300);
  for (let i = 0; i < 40; i++) st.worthHist[`20${20 + Math.floor(i / 12)}-${String(i % 12 + 1).padStart(2, '0')}`] = i;
  B.noteWorth(st, '2026-12-01');
  assert.equal(Object.keys(st.worthHist).length, 36);
  assert.equal(B.worthSeries(st).at(-1).ym, '2026-12');
  assert.equal(B.noteWorth(base({}), '2026-11-09'), false);
});

test('payoff planner: months, interest, and payments too small to help', () => {
  const r = B.payoff(1000, 0, 100); assert.equal(r.months, 10); assert.equal(r.interest, 0);
  const s = B.payoff(642.38, 20.99, 100); assert.equal(s.months, 7); assert.ok(s.interest > 40 && s.interest < 50);
  assert.equal(B.payoff(5000, 20, 50).never, true);
  assert.equal(B.payFor(1200, 0, 12), 100);
  const p = B.payFor(642.38, 20.99, 6); assert.ok(B.payoff(642.38, 20.99, p).months <= 6);
});

test('year in review adds up the year and leaves out transfers', () => {
  const st = base({ txns: [T('2026-01-05', 'Payroll', 3000, 'income'), T('2026-01-06', 'Loblaws', -100, 'groceries'), T('2026-02-06', 'Loblaws', -150, 'groceries'),
    T('2026-02-07', 'Rent', -1500, 'home'), T('2026-02-08', 'To savings', -500, 'transfer'), T('2025-12-30', 'Old', -999, 'shopping'), T('2026-11-20', 'Future', -50, 'fun')] });
  const r = B.yearReview(st, 2026, '2026-11-09');
  assert.equal(r.spent, 1750); assert.equal(r.earned, 3000); assert.equal(r.kept, 1250); assert.equal(r.rate, 42);
  assert.equal(r.cats[0].cat, 'home'); assert.equal(r.big.ym, '2026-02'); assert.equal(r.small.ym, '2026-01');
  assert.equal(r.places[0].name, 'Loblaws'); assert.equal(r.places.some(p => p.name === 'Rent'), false);
});

test('splitting a charge does not copy its receipt or transfer match, and deleting the second part gives it back', () => {
  const O = ops(), st = base({ txns: [T('2026-11-02', 'Costco', -100, 'groceries', { id: 'p', manual: true, receipt: 'data:x', sentTo: 'House' })] });
  O['txn.split'](st, { id: 'p', amount: 30, c: 'shopping' });
  const kid = st.txns.find(t => t.id === 'p-2');
  assert.equal(kid.receipt, undefined); assert.equal(kid.sentTo, undefined); assert.equal(kid.a, -30);
  O['txn.delete'](st, { id: 'p-2' });
  assert.equal(st.txns.length, 1); assert.equal(st.txns[0].a, -100); assert.equal(st.txns[0].split, undefined);
  O['txn.split'](st, { id: 'p', amount: 30, c: 'shopping' }); O['txn.delete'](st, { id: 'p' });
  assert.equal(st.txns.length, 0);
});

test('changing a matched transfer in bulk or in review unpairs it', () => {
  const O = ops(), st = base({ txns: [T('2026-11-02', 'Pay card', -50, 'transfer', { id: 'a', pair: 'b' }), T('2026-11-02', 'Thanks', 50, 'transfer', { id: 'b', pair: 'a', acct: 'cc' })] });
  O['txn.bulk'](st, { ids: ['a'], c: 'shopping' });
  assert.equal(st.txns[0].pair, undefined); assert.equal(st.txns[1].pair, undefined); assert.equal(st.txns[0].set, true);
  const st2 = base({ txns: [T('2026-11-02', 'X', -5, 'dining', { id: 'z', fresh: true })] });
  O['review.done'](st2, { id: 'z', c: 'fun' }); assert.equal(st2.txns[0].set, true);
});

test('a renamed bank account keeps its name, and the payoff plan is saved on it', () => {
  const O = ops(), st = base({ accounts: [{ id: 'p_1', name: 'VISA', type: 'Credit card', bal: -400 }] });
  O['account.rename'](st, { id: 'p_1', name: 'Travel card' });
  assert.equal(st.accounts[0].renamed, true);
  O['account.debt'](st, { id: 'p_1', apr: 19.99, pay: 120 });
  assert.equal(st.accounts[0].apr, 19.99); assert.equal(st.accounts[0].pay, 120);
  assert.throws(() => O['account.debt'](st, { id: 'p_1', apr: 99 }), /0 to 60/);
});

test('sample data brings net worth history and takes it away again', () => {
  const O = ops(), st = base({ txns: [], accounts: [], myBills: [], cats: [] });
  O['sample.load'](st);
  assert.ok(Object.keys(st.worthHist).length >= 5);
  O['sample.clear'](st);
  assert.deepEqual(st.worthHist, {});
});


test('holdings: value, gain, and what Plaid sends', () => {
  const h = B.holdings({ holdings: [{ id: 'a', sym: 'VFV', name: 'VFV', qty: 10, price: 120, cost: 1000 }, { id: 'b', sym: 'X', name: 'X', qty: 2, price: 50 }] });
  assert.equal(h.value, 1300); assert.equal(h.cost, 1000); assert.equal(h.gain, 200); assert.equal(h.pct, 20);
  assert.equal(h.list[0].sym, 'VFV'); assert.equal(h.list[1].gain, null);
  assert.equal(B.holdings({}).gain, null);
  const p = B.plaidHoldings({ holdings: [{ account_id: 'z', security_id: 's', quantity: 4, institution_value: 100, cost_basis: 80 }, { account_id: 'other', security_id: 's', quantity: 1 }], securities: [{ security_id: 's', name: 'Thing', ticker_symbol: 'TH' }] }, 'z');
  assert.deepEqual(p.map(x => [x.sym, x.qty, x.price, x.cost]), [['TH', 4, 25, 80]]);
});

test('holdings you keep by hand set the account balance', () => {
  const O = ops(), st = base({ accounts: [] });
  O['account.add'](st, { name: 'RRSP', type: 'Investment', bal: 0 });
  const id = st.accounts[0].id;
  O['holding.save'](st, { acct: id, sym: 'xeqt', qty: '10', price: '30', cost: '250' });
  assert.equal(st.accounts[0].bal, 300); assert.equal(st.accounts[0].holdings[0].sym, 'XEQT');
  const hid = st.accounts[0].holdings[0].id;
  O['holding.save'](st, { acct: id, id: hid, sym: 'XEQT', qty: 20, price: 30 });
  assert.equal(st.accounts[0].bal, 600); assert.equal(st.accounts[0].holdings.length, 1); assert.equal(st.accounts[0].holdings[0].cost, undefined);
  assert.throws(() => O['account.balance'](st, { id, bal: 5 }), /total of its holdings/);
  assert.throws(() => O['holding.save'](st, { acct: id, sym: 'X', qty: 0, price: 1 }), /how many/);
  O['holding.delete'](st, { acct: id, id: hid });
  assert.equal(st.accounts[0].holdings, undefined);
});

test('a known subscription shows up as a bill from its first charge, a one-off shop does not', () => {
  const st = base({ txns: [T('2026-11-02', 'Crave', -22.99, 'fun', { acct: 'cc' }), T('2026-11-03', 'Apple Store', -649, 'shopping'), T('2026-09-15', 'Netflix', -16.99, 'fun')] });
  const bl = B.bills(st, '2026-11-09');
  assert.deepEqual(bl.map(b => b.n), ['Crave']);
  assert.equal(bl[0].early, true); assert.equal(bl[0].d, 2);
  st.hiddenBills = ['crave']; assert.equal(B.bills(st, '2026-11-09').length, 0);
});

test('bills from Plaid fill in what Budget it has not spotted, without doubling up', () => {
  const r = { outflow_streams: [
    { stream_id: 's1', account_id: 'chk', merchant_name: 'Enbridge Gas', frequency: 'MONTHLY', average_amount: { amount: 88.4 }, last_amount: { amount: 91.2 }, predicted_next_date: '2026-11-21', is_active: true, status: 'MATURE', personal_finance_category: { primary: 'RENT_AND_UTILITIES' } },
    { stream_id: 's2', account_id: 'cc', description: 'CAA MEMBERSHIP', frequency: 'ANNUALLY', last_amount: { amount: 120 }, last_date: '2026-03-04', is_active: true },
    { stream_id: 's3', merchant_name: 'Gym', frequency: 'WEEKLY', average_amount: { amount: 10 }, is_active: true },
    { stream_id: 's4', merchant_name: 'Old', frequency: 'MONTHLY', average_amount: { amount: 10 }, is_active: false },
    { stream_id: 's5', merchant_name: 'Rogers', frequency: 'MONTHLY', average_amount: { amount: 70 }, predicted_next_date: '2026-11-18', is_active: true }] };
  const pb = B.plaidBills(r);
  assert.deepEqual(pb.map(b => [b.n, b.every, b.d]), [['Enbridge Gas', 'month', 21], ['CAA MEMBERSHIP', 'year', 4], ['Rogers', 'month', 18]]);
  assert.equal(pb[0].c, 'home'); assert.equal(pb[0].varies, true); assert.equal(pb[1].month, 3);
  const st = base({ plaidBills: pb, txns: [T('2026-09-18', 'Rogers', -70, 'home'), T('2026-10-18', 'Rogers', -70, 'home')] });
  const bl = B.bills(st, '2026-11-09');
  assert.equal(bl.filter(b => b.n === 'Rogers').length, 1, 'found from charges and by the bank: shown once');
  assert.equal(bl.find(b => b.n === 'Enbridge Gas').bank, true);
  const caa = B.upcoming(st, '2026-11-09').find(b => b.n === 'CAA MEMBERSHIP');
  assert.equal(caa.due, '2027-03-04');
});
