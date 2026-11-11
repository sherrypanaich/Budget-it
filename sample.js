// Made-up sample data, for trying Budget it before connecting a bank:
//   node server.js sample NAME    fills NAME's budget with it (only if they have nothing yet)
// The preview page uses it too. Dates are worked out from "today", so it always looks current.
(function (root) {
  'use strict';
  const pad = n => String(n).padStart(2, '0');
  function sample(today) {
    const d = new Date(today + 'T12:00:00'), y = d.getFullYear(), m = d.getMonth(), day = d.getDate();
    const ym = (yy, mm) => { const x = new Date(yy, mm, 1); return `${x.getFullYear()}-${pad(x.getMonth() + 1)}`; };
    const last = ym(y, m - 1), cur = ym(y, m), later = (n) => ym(y, m + n);
    const T = []; let n = 1;
    const t = (month, dd, acct, name, a, c, o = {}) => { if (month === cur && dd > day) return; T.push({ id: 's' + pad(n++) + pad(dd), date: `${month}-${pad(dd)}`, acct, m: name, a, c, note: '', ...o }); };
    // Six months of history: five full months before this one, plus this month so far.
    const past = [5, 4, 3, 2, 1].map(k => ym(y, m - k));
    const both = (dd, acct, name, a, c) => { for (const mo of past) t(mo, dd, acct, name, a, c); t(cur, dd, acct, name, a, c); };
    both(1, 'chq', 'Payroll · Northwind Co.', 2850, 'income'); both(1, 'chq', 'Maple Property Mgmt', -1650, 'home');
    for (const mo of past) t(mo, 3, 'visa', 'GoodLife Fitness', -39.99, 'health'); t(cur, 3, 'visa', 'GoodLife Fitness', -44.99, 'health');   // a price increase to spot both(3, 'chq', 'Presto card', -40, 'transport');
    both(12, 'visa', 'Netflix', -16.99, 'fun'); both(15, 'chq', 'Payroll · Northwind Co.', 2850, 'income');
    past.forEach((mo, k) => t(mo, 15, 'chq', 'Toronto Hydro', -[118.40, 104.75, 88.20, 79.60, 92.10][k], 'home')); t(cur, 15, 'chq', 'Toronto Hydro', -86.40, 'home');
    both(18, 'chq', 'Rogers Internet', -70, 'home'); both(20, 'visa', 'Spotify', -11.99, 'fun'); both(22, 'visa', 'Fido Mobile', -55, 'home');
    // last month, everyday spending
    [[4, 'Loblaws', -96.44, 'groceries'], [5, 'Tim Hortons', -5.85, 'dining'], [6, 'Uber Eats', -41.20, 'dining'], [7, 'Amazon.ca', -88.10, 'shopping'],
      [8, 'Costco', -171.25, 'groceries'], [9, 'Pizzeria Libretto', -58.30, 'dining'], [14, 'Shell', -61.10, 'transport'], [17, 'No Frills', -63.75, 'groceries'],
      [19, 'Cineplex', -32.50, 'fun'], [24, 'Winners', -49.99, 'shopping'], [25, 'Loblaws', -118.02, 'groceries'], [27, 'Shoppers Drug Mart', -24.60, 'health'],
      [28, 'Kinka Izakaya', -74.80, 'dining']].forEach(([dd, nm, a, c], i) => past.forEach((mo, k) => {
        // Older months: the same kind of spending, a bit more or less each time, so the trends have something to show
        const f = k === 4 ? 1 : [1.12, 0.86, 1.05, 0.93][k] * (1 + ((i * 7 + k * 3) % 5 - 2) * 0.06);
        if (k < 4 && (i + k) % 6 === 0) return;
        t(mo, k === 4 ? dd : (dd - 1 + (k + 1) * 9 + i * 2) % 27 + 1, 'visa', nm, Math.round(a * f * 100) / 100, c);
      }));
    // A December splurge or a summer trip shows up in the trends
    t(past[1], 21, 'visa', 'Air Canada', -486.00, 'transport'); t(past[2], 11, 'visa', 'IKEA', -312.45, 'home');
    past.slice(0, 4).forEach((mo, k) => t(mo, 9, 'chq', 'Transfer to Savings', -200, 'transfer'));
    // this month, so far
    const fresh = dd => dd >= day - 1;
    [[2, 'visa', 'Loblaws', -84.32, 'groceries'], [2, 'visa', 'Tim Hortons', -6.45, 'dining'], [4, 'visa', 'Amazon.ca', -64.20, 'shopping'],
      [5, 'visa', 'No Frills', -52.18, 'groceries'], [5, 'visa', 'Uber Eats', -34.80, 'dining'], [6, 'visa', 'Shell', -58.40, 'transport'],
      [6, 'visa', 'Winners', -71.30, 'shopping'], [7, 'visa', 'Cineplex', -28.50, 'fun'], [7, 'visa', 'Kinka Izakaya', -62.40, 'dining', "Mika's birthday"],
      [8, 'visa', 'Costco', -146.77, 'groceries'], [8, 'visa', 'Indigo', -50.49, 'shopping'], [9, 'visa', 'Starbucks', -7.85, 'dining'],
      [9, 'chq', 'Transfer to Savings', -200, 'transfer'], [11, 'visa', 'Farm Boy', -38.60, 'groceries'], [13, 'visa', 'Uber', -16.25, 'transport'],
      [14, 'visa', 'Loblaws', -77.90, 'groceries'], [16, 'visa', 'Burrito Boyz', -18.40, 'dining'], [19, 'visa', 'Best Buy', -129.99, 'shopping'],
      [21, 'visa', 'Costco', -132.10, 'groceries'], [23, 'visa', 'Shell', -55.00, 'transport'], [25, 'visa', 'Cineplex', -24.00, 'fun']]
      .forEach(([dd, acct, nm, a, c, note]) => t(cur, dd, acct, nm, a, c, { note: note || '', fresh: fresh(dd) && dd <= day, pending: dd === day }));
    // A streaming service you just signed up for: shows as a bill (and a new subscription) from this first charge
    t(cur, 2, 'visa', 'Crave', -22.99, 'fun');
    // A big one-off yesterday, for the "was this you?" heads-up
    t(cur, Math.max(1, day - 1), 'visa', 'Apple Store', -649.00, 'shopping', { fresh: true });
    return {
      accounts: [
        { id: 'chq', name: 'Everyday Chequing', inst: 'TD', type: 'Chequing', mask: '4821', bal: 2384.17, shared: true, synced: Date.now() - 12 * 60e3, sample: true },
        { id: 'sav', name: 'High-Interest Savings', inst: 'EQ Bank', type: 'Savings', mask: '0093', bal: 5790.00, shared: false, synced: Date.now() - 12 * 60e3, sample: true },
        { id: 'tfsa', name: 'TFSA', inst: 'Wealthsimple', type: 'Investment', mask: '2209', bal: 7481.40, shared: false, synced: Date.now() - 12 * 60e3, sample: true,
          holdings: [{ id: 'h1', sym: 'VFV', name: 'Vanguard S&P 500 Index ETF', qty: 42, price: 131.2, cost: 4410 }, { id: 'h2', sym: 'XEQT', name: 'iShares Core Equity ETF Portfolio', qty: 60, price: 32.85, cost: 1806 }] },
        { id: 'usd', name: 'US Dollar Account', inst: 'TD', type: 'Savings', mask: '5512', bal: 640.00, cur: 'USD', shared: false, synced: Date.now() - 12 * 60e3, sample: true },
        { id: 'visa', name: 'Cash Back Visa', inst: 'TD', type: 'Credit card', mask: '7710', bal: -642.38, limit: 5000, apr: 20.99, shared: false, synced: Date.now() - 12 * 60e3, sample: true }],
      txns: T,
      budgets: { groceries: 600, dining: 250, transport: 180, home: 1900, shopping: 200, fun: 120, health: 80 }, rollover: { groceries: true },
      expectIncome: 5700, rules: [{ match: 'Costco', cat: 'groceries' }],
      goals: [{ id: 'g1', n: 'Emergency fund', target: 5000, saved: 3200, by: later(7) }, { id: 'g2', n: 'Japan trip', target: 3000, saved: 1150, by: later(5) },
        { id: 'g3', n: 'New laptop', target: 1500, saved: 1440, by: later(1) }],
      // Net worth at the end of each past month, so the chart on Accounts has a story
      rates: { USD: 1.39 },
      worthHist: Object.fromEntries(past.map((mo, k) => [mo, [11702.52, 12395.80, 12020.15, 13238.60, 14190.44][k]])),
      guide: 'luffy', sample: true
    };
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = sample; else root.budgetSample = sample;
})(typeof window !== 'undefined' ? window : this);
