// The money rules. Run with: node --test
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const B = require('../budget');
const sample = require('../sample');
const makeOps = require('../ops');

const T = (date, m, a, c, o = {}) => ({ id: Math.random().toString(36).slice(2), date, acct: 'x', m, a, c, note: '', ...o });
const base = o => ({ accounts: [], txns: [], budgets: {}, rollover: {}, rules: [], goals: [], hiddenBills: [], ...o });

test('spent, limit and rollover', () => {
  const st = base({ budgets: { groceries: 500 }, rollover: { groceries: true },
    txns: [T('2026-10-03', 'Loblaws', -300, 'groceries'), T('2026-11-02', 'Loblaws', -120.25, 'groceries'), T('2026-11-03', 'Refund', 20.25, 'groceries')] });
  assert.equal(B.spent(st, 'groceries', '2026-11'), 100);
  assert.equal(B.limit(st, 'groceries', '2026-11'), 700);   // 500 plus 200 left in October
  st.rollover.groceries = false;
  assert.equal(B.limit(st, 'groceries', '2026-11'), 500);
  assert.deepEqual(B.totals(st, '2026-11'), { limit: 500, spent: 100, left: 400 });
});

test('budget states: ok, near at 80%, over', () => {
  const st = base({ budgets: { dining: 100 }, txns: [T('2026-11-02', 'A', -79, 'dining')] });
  assert.equal(B.budgetState(st, 'dining', '2026-11'), 'ok');
  st.txns.push(T('2026-11-03', 'B', -1, 'dining'));
  assert.equal(B.budgetState(st, 'dining', '2026-11'), 'near');
  st.txns.push(T('2026-11-04', 'C', -20.01, 'dining'));
  assert.equal(B.budgetState(st, 'dining', '2026-11'), 'over');
  assert.equal(B.budgetState(st, 'fun', '2026-11'), null);
});

test('other people’s shared charges never count toward your budget', () => {
  const st = base({ budgets: { dining: 100 }, txns: [T('2026-11-02', 'Mine', -10, 'dining'), T('2026-11-02', 'Theirs', -90, 'dining', { other: true })] });
  assert.equal(B.spent(st, 'dining', '2026-11'), 10);
  assert.equal(B.moneyOut(st, '2026-11'), 10);
});

test('per day leaves out home & bills and counts today', () => {
  const st = base({ budgets: { groceries: 300, home: 2000 }, txns: [T('2026-11-01', 'Loblaws', -100, 'groceries')] });
  assert.equal(B.perDay(st, '2026-11-21'), 20);   // $200 left over 10 days (21st to 30th)
});

test('money in and out skip transfers', () => {
  const st = base({ txns: [T('2026-11-01', 'Pay', 2000, 'income'), T('2026-11-02', 'To savings', -500, 'transfer'), T('2026-11-03', 'Shell', -60, 'transport')] });
  assert.equal(B.moneyIn(st, '2026-11'), 2000);
  assert.equal(B.moneyOut(st, '2026-11'), 60);
});

test('Plaid categories map to ours', () => {
  assert.equal(B.plaidCat({ primary: 'FOOD_AND_DRINK', detailed: 'FOOD_AND_DRINK_GROCERIES' }, 'Loblaws', -50), 'groceries');
  assert.equal(B.plaidCat({ primary: 'FOOD_AND_DRINK', detailed: 'FOOD_AND_DRINK_COFFEE' }, 'Tims', -3), 'dining');
  assert.equal(B.plaidCat({ primary: 'RENT_AND_UTILITIES', detailed: 'RENT_AND_UTILITIES_RENT' }, 'Landlord', -1500), 'home');
  assert.equal(B.plaidCat({ primary: 'LOAN_PAYMENTS', detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' }, 'TD Visa', -300), 'transfer');
  assert.equal(B.plaidCat({ primary: 'INCOME', detailed: 'INCOME_WAGES' }, 'Payroll', 2000), 'income');
  assert.equal(B.plaidCat(null, 'Mystery', 25), 'income');
  assert.equal(B.plaidCat(null, 'Mystery', -25), 'shopping');
});

test('rules beat guesses, and match store numbers', () => {
  const st = base({ rules: [{ match: 'Costco', cat: 'shopping' }] });
  assert.equal(B.pickCat(st, 'COSTCO WHOLESALE #551', 'groceries'), 'shopping');
  assert.equal(B.pickCat(st, 'Uber', null), 'transport');
});

test('quick add understands "coffee 4.50" and "$32 farmers market"', () => {
  assert.deepEqual(B.parseQuick('coffee 4.50'), { amount: 4.5, name: 'Coffee', cat: B.guessCat('Coffee') });
  assert.equal(B.parseQuick('$32 farmers market').amount, 32);
  assert.equal(B.parseQuick('$32 farmers market').name, 'Farmers market');
  assert.equal(B.parseQuick('lunch 14,20').amount, 14.2);
  assert.equal(B.parseQuick('nothing here').amount, null);
});

test('CSV: plain rows, headers, debit and credit columns, quotes', () => {
  assert.deepEqual(B.parseCsv('2026-11-07,FARM BOY #12,-18.40\n2026-11-08,"Pay, Inc",1200'),
    [{ date: '2026-11-07', m: 'FARM BOY #12', a: -18.4 }, { date: '2026-11-08', m: 'Pay, Inc', a: 1200 }]);
  assert.deepEqual(B.parseCsv('Date,Description,Debit,Credit\n11/05/2026,Shell,"1,061.10",\n11/06/2026,Refund,,5.00'),
    [{ date: '2026-11-05', m: 'Shell', a: -1061.1 }, { date: '2026-11-06', m: 'Refund', a: 5 }]);
  assert.deepEqual(B.parseCsv('Transaction Date,Payee,Amount\n2026-11-01,Netflix,($16.99)'), [{ date: '2026-11-01', m: 'Netflix', a: -16.99 }]);
  assert.deepEqual(B.parseCsv('junk\nnot,a,date'), []);
});

test('bills: repeats on about the same day and amount; one-offs and hidden ones are not', () => {
  const st = base({ txns: [
    T('2026-09-12', 'Netflix', -16.99, 'fun'), T('2026-10-12', 'Netflix', -16.99, 'fun'),
    T('2026-09-15', 'Toronto Hydro', -92.10, 'home'), T('2026-10-16', 'Toronto Hydro', -86.40, 'home'),
    T('2026-09-03', 'Loblaws', -40, 'groceries'), T('2026-10-25', 'Loblaws', -140, 'groceries'),
    T('2026-10-02', 'One-off', -50, 'shopping')] });
  const names = B.bills(st, '2026-11-05').map(b => b.n);
  assert.deepEqual(names.sort(), ['Netflix', 'Toronto Hydro']);
  const up = B.upcoming(st, '2026-11-05');
  const nf = up.find(b => b.n === 'Netflix');
  assert.equal(nf.days, 7); assert.equal(nf.paid, false); assert.equal(nf.sub, true);
  assert.equal(up.find(b => b.n === 'Toronto Hydro').varies, true);
  st.hiddenBills = ['netflix'];
  assert.deepEqual(B.bills(st, '2026-11-05').map(b => b.n), ['Toronto Hydro']);
});

test('goals: monthly amount to finish on time', () => {
  assert.equal(B.goalMonthly({ target: 1200, saved: 200, by: '2027-03' }, '2026-11-09'), 250);
  assert.equal(B.goalMonthly({ target: 100, saved: 100, by: '2027-03' }, '2026-11-09'), 0);
  assert.equal(B.goalMonthly({ target: 100, saved: 0, by: '2026-11' }, '2026-11-09'), 100);
});

test('sample data always looks current and never has future charges', () => {
  for (const today of ['2026-11-09', '2026-03-01', '2027-01-31']) {
    const s = sample(today);
    assert.ok(s.txns.every(t => t.date <= today), today);
    assert.ok(s.txns.some(t => B.ymOf(t.date) === B.prevYm(B.ymOf(today))));
    assert.equal(new Set(s.txns.map(t => t.id)).size, s.txns.length);
  }
});

test('changes: categorise with a rule, split, cash, undo-safe errors', () => {
  const { OPS } = makeOps(B, { today: () => '2026-11-09', rid: p => p + Math.random().toString(16).slice(2, 8), sample });
  const st = base({ txns: [T('2026-11-02', 'COSTCO #1', -100, 'shopping', { id: 'a' }), T('2026-11-05', 'COSTCO #9', -50, 'shopping', { id: 'b' })] });
  OPS['txn.update'](st, { id: 'a', c: 'groceries', rule: true });
  assert.equal(st.txns.find(t => t.id === 'b').c, 'groceries');
  assert.equal(st.rules.length, 1);
  OPS['txn.split'](st, { id: 'a', amount: 30, c: 'shopping' });
  assert.equal(st.txns.find(t => t.id === 'a').a, -70);
  assert.equal(st.txns.find(t => t.id === 'a-2').a, -30);
  OPS['txn.add'](st, { amount: 4.5, m: 'Coffee', c: 'dining', date: '2026-11-09' });
  assert.equal(st.txns.at(-1).a, -4.5);
  assert.throws(() => OPS['txn.delete'](st, { id: 'b' }), /bank/i);
  assert.throws(() => OPS['txn.add'](st, { amount: -5 }));
  OPS['budget.set'](st, { c: 'dining', amount: 200 });
  assert.equal(st.budgets.dining, 200);
  OPS['budget.set'](st, { c: 'dining', amount: 0 });
  assert.equal(st.budgets.dining, undefined);
});

test('CSV import skips rows it already has', () => {
  const { OPS } = makeOps(B, { today: () => '2026-11-09', rid: p => p + Math.random().toString(16).slice(2, 8), sample });
  const st = base({});
  const csv = '2026-11-07,FARM BOY #12,-18.40\n2026-11-08,Shell,-40';
  OPS['csv.import'](st, { text: csv, name: 'Credit union' });
  const acct = st.accounts[0].id;
  OPS['csv.import'](st, { text: csv + '\n2026-11-09,Uber,-12', acct });
  assert.equal(st.txns.length, 3);
  assert.equal(st.accounts.length, 1);
});

test('sample data comes out cleanly, keeping what you added', () => {
  const { OPS } = makeOps(B, { today: () => '2026-11-09', rid: p => p + Math.random().toString(16).slice(2, 8), sample });
  const st = base({ expectIncome: 0 });
  OPS['sample.load'](st, {});
  OPS['budget.set'](st, { c: 'dining', amount: 300 });
  OPS['txn.add'](st, { amount: 4.5, m: 'Coffee', c: 'dining', date: '2026-11-09' });
  OPS['sample.clear'](st, {});
  assert.equal(st.accounts.length, 0);
  assert.deepEqual(st.txns.map(t => t.m), ['Coffee']);
  assert.deepEqual(st.budgets, { dining: 300 });
  assert.equal(st.goals.length, 0);
  assert.equal(st.rules.length, 0);
  assert.ok(!st.expectIncome);
});
