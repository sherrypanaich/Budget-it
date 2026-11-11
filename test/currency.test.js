// Accounts in other currencies: totals in your home currency, rates you keep. Run with: node --test
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const B = require('../budget');
const sample = require('../sample');
const makeOps = require('../ops');

const base = o => ({ accounts: [], txns: [], budgets: {}, rollover: {}, rules: [], goals: [], hiddenBills: [], ...o });
const ops = () => makeOps(B, { today: () => '2026-11-09', rid: p => p + Math.random().toString(16).slice(2, 8), sample }).OPS;

test.beforeEach(() => B.useCats({}));

test('net worth turns other currencies into home money', () => {
  const s = base({ rates: { USD: 1.4 }, accounts: [{ id: 'a', type: 'Chequing', bal: 1000 }, { id: 'b', type: 'Savings', bal: 500, cur: 'USD' }, { id: 'c', type: 'Savings', bal: 100, cur: 'EUR' }] });
  assert.equal(B.homeCur(s), 'CAD');
  assert.equal(B.inHome(s, s.accounts[1]), 700);
  assert.equal(B.inHome(s, s.accounts[2]), 100, 'no rate yet counts 1 to 1');
  assert.deepEqual(B.missingRates(s), ['EUR']);
  assert.equal(B.worth(s), 1800);
});

test('safe to spend counts a US chequing account in CAD', () => {
  const s = base({ rates: { USD: 1.5 }, accounts: [{ id: 'a', type: 'Chequing', bal: 100, cur: 'USD' }, { id: 'v', type: 'Credit card', bal: -50, cur: 'USD' }],
    txns: ['2026-09-15', '2026-10-15'].map((date, i) => ({ id: 'p' + i, date, acct: 'b', m: 'Payroll', a: 2000, c: 'income' })) });
  const r = B.safeToSpend(s, '2026-11-09');
  assert.equal(r.cash, 150);
  assert.equal(r.cards, -75);
});

test('a charge in another currency keeps what it was', () => {
  const s = base({ rates: { USD: 1.39 } });
  const t = B.convertTxn(s, { a: -20 }, 'USD');
  assert.deepEqual(t, { a: -27.8, orig: { a: -20, cur: 'USD' } });
  assert.deepEqual(B.convertTxn(s, { a: -20 }, 'CAD'), { a: -20 });
  assert.deepEqual(B.convertTxn(s, { a: -20 }, 'EUR'), { a: -20, orig: { a: -20, cur: 'EUR' }, norate: true }, 'no rate: 1 to 1 until there is one');
});

test('currency settings, rates and account currencies', () => {
  const O = ops(), s = base();
  O['account.add'](s, { name: 'US savings', type: 'Savings', bal: 200, cur: 'USD' });
  O['account.add'](s, { name: 'Wallet', type: 'Cash', bal: 20, cur: 'CAD' });
  assert.equal(s.accounts[0].cur, 'USD');
  assert.equal(s.accounts[1].cur, undefined, 'home currency is not stored');
  assert.throws(() => O['money.rate'](s, { cur: 'USD', rate: 0 }));
  assert.throws(() => O['money.rate'](s, { cur: 'CAD', rate: 1 }), 'no rate for your own currency');
  O['money.rate'](s, { cur: 'USD', rate: '1.3912' });
  assert.equal(s.rates.USD, 1.3912);
  assert.equal(B.worth(s), 298.24);
  O['account.currency'](s, { id: s.accounts[0].id, cur: 'CAD' });
  assert.equal(s.accounts[0].cur, undefined);
  s.accounts.push({ id: 'p_x', type: 'Savings', bal: 1, item: 'i' });
  assert.throws(() => O['account.currency'](s, { id: 'p_x', cur: 'USD' }), 'the bank says');
  O['money.home'](s, { home: 'USD' });
  assert.equal(B.homeCur(s), 'USD');
  assert.deepEqual(s.rates, {}, 'old rates were for the old home');
  assert.deepEqual(s.accounts.map(a => a.cur), ['CAD', 'CAD', 'CAD'], 'CAD accounts now say CAD');
  assert.throws(() => O['money.home'](s, { home: 'XYZ' }));
});

test('CSV import into a US account converts and still skips repeats', () => {
  const O = ops(), s = base({ rates: { USD: 1.25 } });
  s.accounts.push({ id: 'csv1', name: 'US card', type: 'Imported', bal: 0, csv: true, cur: 'USD' });
  const text = 'Date,Description,Amount\n2026-11-02,Target,-40.00\n';
  O['csv.import'](s, { acct: 'csv1', text });
  assert.equal(s.txns[0].a, -50);
  assert.deepEqual(s.txns[0].orig, { a: -40, cur: 'USD' });
  assert.match(O['csv.import'](s, { acct: 'csv1', text }), /already/);
  assert.equal(s.txns.length, 1);
});

test('sample data has a US dollar account with a rate, and clearing it removes the rate', () => {
  const O = ops(), s = base();
  O['sample.load'](s);
  assert.equal(s.accounts.find(a => a.id === 'usd').cur, 'USD');
  assert.equal(s.rates.USD, 1.39);
  O['sample.clear'](s);
  assert.equal(s.rates.USD, undefined);
});

test('charges from before a rate get it when you set one', () => {
  const O = ops(), s = base({ accounts: [{ id: 'u', type: 'Savings', bal: 10, cur: 'USD', manual: true }] });
  s.txns.push(B.convertTxn(s, { id: 'x', date: '2026-11-02', acct: 'u', m: 'Target', a: -20, c: 'shopping' }, 'USD'));
  assert.equal(s.txns[0].a, -20); assert.equal(s.txns[0].norate, true);
  O['money.rate'](s, { cur: 'USD', rate: 1.5 });
  assert.equal(s.txns[0].a, -30); assert.equal(s.txns[0].norate, undefined);
  O['money.rate'](s, { cur: 'USD', rate: 1.2 });
  assert.equal(s.txns[0].a, -30, 'once it has a rate it keeps it');
});

test('changing an account’s currency moves its charges too', () => {
  const O = ops(), s = base({ rates: { USD: 1.4, EUR: 1.5 }, accounts: [{ id: 'm', type: 'Imported', bal: 0, csv: true }] });
  s.txns.push({ id: 'a', date: '2026-11-02', acct: 'm', m: 'Shop', a: -10, c: 'shopping' }, { id: 'b', date: '2026-11-03', acct: 'm', m: 'Big shop', a: -100, c: 'shopping' });
  O['account.currency'](s, { id: 'm', cur: 'USD' });
  assert.equal(s.txns[0].a, -14); assert.deepEqual(s.txns[0].orig, { a: -10, cur: 'USD' });
  O['account.currency'](s, { id: 'm', cur: 'EUR' });
  assert.equal(s.txns[0].a, -15);
  O['txn.split'](s, { id: 'b', amount: 50, c: 'groceries' });
  assert.equal(s.txns.find(t => t.id === 'b').orig, undefined, 'split parts are home money');
  O['account.currency'](s, { id: 'm', cur: 'CAD' });
  assert.equal(s.txns[0].a, -10); assert.equal(s.txns[0].orig, undefined);
  assert.equal(s.txns.find(t => t.id === 'b').a, -100, 'split parts stay as they are');
});

test('update every price in an account at once', () => {
  const O = ops(), s = base();
  O['account.add'](s, { name: 'RRSP', type: 'Investment', bal: 0 });
  const id = s.accounts[0].id;
  O['holding.save'](s, { acct: id, sym: 'VFV', qty: 10, price: 100 });
  O['holding.save'](s, { acct: id, sym: 'XEQT', qty: 20, price: 30 });
  const [h1, h2] = s.accounts[0].holdings;
  assert.equal(O['holding.prices'](s, { acct: id, prices: { [h1.id]: '110.5', [h2.id]: 30 } }), 'Updated 1 price');
  assert.equal(s.accounts[0].bal, 1705);
  assert.ok(s.accounts[0].priced);
  assert.throws(() => O['holding.prices'](s, { acct: id, prices: { [h1.id]: 'abc' } }));
  s.accounts.push({ id: 'p_i', type: 'Investment', bal: 5, holdings: [] });
  assert.throws(() => O['holding.prices'](s, { acct: 'p_i', prices: {} }), 'bank holdings');
});
