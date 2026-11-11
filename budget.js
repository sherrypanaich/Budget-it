// Budget it's money rules, shared by the server, the assistant connector (mcp.js), the tests and the page.
// Plain functions over one person's state, no dependencies. Works in Node (require) and in the browser (window.Budget).
//
// Money is stored as dollars with cents (numbers like -12.5). Spending is negative, money coming in is positive.
// Dates are 'YYYY-MM-DD' strings in the laptop's local time. A month is 'YYYY-MM'.
(function (root) {
  'use strict';
  const BASE = [
    { id: 'groceries', name: 'Groceries' }, { id: 'dining', name: 'Dining out' }, { id: 'transport', name: 'Transport' },
    { id: 'home', name: 'Home & bills' }, { id: 'shopping', name: 'Shopping' }, { id: 'fun', name: 'Fun' },
    { id: 'health', name: 'Health' }, { id: 'income', name: 'Income' }, { id: 'transfer', name: 'Transfer' }
  ];
  const CATS = BASE.map(c => ({ ...c })), CAT_IDS = CATS.map(c => c.id);
  // Each person can rename categories and add their own (st.catNames, st.cats). Call this with their state before
  // anything else: it fills CATS and CAT_IDS in place, so code holding those arrays sees the person's list.
  function useCats(st) {
    const names = (st && st.catNames) || {}, extra = ((st && st.cats) || []).filter(c => c && c.id && !BASE.some(b => b.id === c.id));
    const out = BASE.filter(c => !NOT_SPENDING.includes(c.id)).map(c => ({ ...c, name: names[c.id] || c.name }))
      .concat(extra.map(c => ({ id: c.id, name: c.name, icon: c.icon || 'star', color: c.color || '--c5', custom: true })))
      .concat(BASE.filter(c => NOT_SPENDING.includes(c.id)).map(c => ({ ...c })));
    CATS.length = 0; CATS.push(...out); CAT_IDS.length = 0; CAT_IDS.push(...out.map(c => c.id));
    return CATS;
  }
  // Not everyday spending: kept out of budgets' "left to spend", the per-day amount and the chart.
  const NOT_SPENDING = ['income', 'transfer'];
  const catName = id => (CATS.find(c => c.id === id) || { name: 'Other' }).name;
  // A charge counts unless it's someone else's (shared with you) or you hid it.
  const round2 = n => Math.round(n * 100) / 100;
  const pad = n => String(n).padStart(2, '0');

  // ---------- dates ----------
  const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const ymOf = s => String(s).slice(0, 7);
  const ymNow = d => ymOf(ymd(d));
  const prevYm = ym => { let [y, m] = ym.split('-').map(Number); m--; if (!m) { m = 12; y--; } return `${y}-${pad(m)}`; };
  const nextYm = ym => { let [y, m] = ym.split('-').map(Number); m++; if (m > 12) { m = 1; y++; } return `${y}-${pad(m)}`; };
  const daysIn = ym => { const [y, m] = ym.split('-').map(Number); return new Date(y, m, 0).getDate(); };
  const dayOf = s => +String(s).slice(8, 10);
  const monthsBetween = (fromYm, toYm) => { const [a, b] = fromYm.split('-').map(Number), [c, d] = toYm.split('-').map(Number); return (c - a) * 12 + (d - b); };

  // ---------- currencies ----------
  // Everything adds up in your home currency (CAD unless you change it). An account can be in another one (a US dollar
  // account): its balance stays in that currency, and is turned into home money with the rate you keep in st.rates.
  const CURRENCIES = ['CAD', 'USD', 'EUR', 'GBP', 'AUD', 'NZD', 'JPY', 'CHF', 'MXN', 'INR', 'CNY', 'HKD', 'SGD', 'PHP', 'KRW', 'BRL'];
  const homeCur = st => (st && st.home) || 'CAD';
  // How much one unit of cur is in home money, or null when no rate is set yet
  const rate = (st, cur) => !cur || cur === homeCur(st) ? 1 : (+((st.rates || {})[cur]) > 0 ? +st.rates[cur] : null);
  const inHome = (st, a) => round2((a.bal || 0) * (rate(st, a.cur) || 1));
  // Currencies your accounts use that have no rate yet
  const missingRates = st => [...new Set((st.accounts || []).filter(a => !a.other && a.cur && rate(st, a.cur) === null).map(a => a.cur))];

  // ---------- spending ----------
  // Only your own transactions count toward your budgets. Accounts someone shared with you are view only.
  const mine = st => (st.txns || []).filter(t => !t.other && !t.hidden);
  function spent(st, cat, ym) {
    let s = 0;
    for (const t of mine(st)) if (t.c === cat && ymOf(t.date) === ym) s -= t.a;
    return round2(s);
  }
  // A budget's limit this month: the monthly amount, plus last month's leftover when rollover is on.
  function limit(st, cat, ym) {
    const b = (st.budgets || {})[cat] || 0;
    if (!b) return 0;
    const roll = (st.rollover || {})[cat], carry = (st.carry || {})[cat];
    if (!roll && !carry) return b;
    // Rollover adds last month's leftover. "Carry overspending" also takes last month's overspend off this month.
    const left = b - spent(st, cat, prevYm(ym));
    return round2(Math.max(0, b + (left > 0 ? (roll ? left : 0) : (carry ? left : 0))));
  }
  const budgeted = st => Object.keys(st.budgets || {}).filter(c => (st.budgets[c] || 0) > 0);
  function totals(st, ym) {
    const ids = budgeted(st);
    const lim = round2(ids.reduce((s, c) => s + limit(st, c, ym), 0)), sp = round2(ids.reduce((s, c) => s + spent(st, c, ym), 0));
    return { limit: lim, spent: sp, left: round2(lim - sp) };
  }
  // Per day for the rest of the month, leaving out home & bills (fixed costs that are already planned).
  function perDay(st, today) {
    const ym = ymOf(today), left = daysIn(ym) - dayOf(today) + 1;
    const ids = budgeted(st).filter(c => c !== 'home');
    const free = ids.reduce((s, c) => s + Math.max(0, limit(st, c, ym) - spent(st, c, ym)), 0);
    // Bills still to come this month in those budgets (Netflix in Fun) are set aside first.
    const later = upcoming(st, today).filter(b => !b.paid && !b.late && ids.includes(b.c) && ymOf(b.due) === ym).reduce((s, b) => s + b.a, 0);
    return round2(Math.max(0, free - later) / left);
  }
  const moneyOut = (st, ym) => round2(-mine(st).filter(t => ymOf(t.date) === ym && t.a < 0 && t.c !== 'transfer').reduce((s, t) => s + t.a, 0));
  const moneyIn = (st, ym) => round2(mine(st).filter(t => ymOf(t.date) === ym && t.c === 'income').reduce((s, t) => s + t.a, 0));
  // 'ok' | 'near' (80% or more) | 'over'
  function budgetState(st, cat, ym) {
    const l = limit(st, cat, ym); if (!l) return null;
    const s = spent(st, cat, ym);
    return s > l ? 'over' : s >= l * 0.8 ? 'near' : 'ok';
  }
  function budgetStatus(st, ym, today) {
    const left = ymOf(today) === ym ? daysIn(ym) - dayOf(today) + 1 : 0;
    return budgeted(st).map(c => {
      const l = limit(st, c, ym), s = spent(st, c, ym);
      return { cat: c, name: catName(c), limit: l, spent: s, left: round2(l - s), perDay: left && c !== 'home' ? round2(Math.max(0, l - s) / left) : null, state: budgetState(st, c, ym), rollover: !!(st.rollover || {})[c] };
    });
  }

  // ---------- categories ----------
  const baseName = m => String(m || '').split(' · ')[0].trim();
  const norm = m => baseName(m).toLowerCase().replace(/[#*]\s*\d+.*$/, '').replace(/\s+\d{3,}.*$/, '').replace(/[^a-z0-9&' ]+/g, ' ').replace(/\s+/g, ' ').trim();
  // The part of a name a rule should match: "COSTCO WHOLESALE #551" -> "COSTCO WHOLESALE"
  const ruleName = m => baseName(m).replace(/\s*[#*]\s*\d.*$/, '').replace(/\s+\d{3,}.*$/, '').trim() || baseName(m);
  function ruleCat(rules, name) {
    const n = String(name || '').toLowerCase();
    const r = (rules || []).find(x => { const m = String(x.match).toLowerCase(); return x.how === 'contains' ? n.includes(m) : n.startsWith(m); });
    return r ? r.cat : null;
  }
  const GUESS = [
    [/\b(coffee|starbucks|tim hortons|tims|latte|cafe|café|second cup)\b/i, 'dining'],
    [/\b(lunch|dinner|breakfast|pizza|sushi|burger|restaurant|uber eats|doordash|skip ?the ?dishes|takeout|mcdonald'?s|subway|a&w|izakaya)\b/i, 'dining'],
    [/\b(grocer(y|ies)?|loblaws|costco|no frills|metro|sobeys|freshco|food basics|farm boy|walmart supercentre|market|safeway|whole foods|t&t)\b/i, 'groceries'],
    [/\b(gas|shell|esso|petro|presto|uber|lyft|taxi|bus|transit|parking|go transit|ttc)\b/i, 'transport'],
    [/\b(movie|cineplex|concert|ticketmaster|steam|game|bar|pub|drinks|netflix|spotify|disney|crave)\b/i, 'fun'],
    [/\b(pharmacy|shoppers drug|rexall|drug mart|doctor|dentist|clinic|gym|goodlife|fitness|physio)\b/i, 'health'],
    [/\b(rent|hydro|internet|rogers|bell|telus|fido|koodo|freedom mobile|insurance|enbridge|utilities|property)\b/i, 'home'],
    [/\b(amazon|winners|indigo|best buy|ikea|canadian tire|hm|h&m|uniqlo|shop|store)\b/i, 'shopping'],
    [/\b(payroll|salary|deposit from|e-?transfer received|refund)\b/i, 'income'],
    [/\b(transfer|e-?transfer|payment - thank you|credit card payment)\b/i, 'transfer']
  ];
  const guessCat = name => { const g = GUESS.find(([r]) => r.test(name || '')); return g ? g[1] : null; };
  // Plaid's personal_finance_category { primary, detailed } -> one of our categories.
  function plaidCat(pfc, name, amount) {
    const p = (pfc && pfc.primary) || '', d = (pfc && pfc.detailed) || '';
    if (/GROCERIES/.test(d)) return 'groceries';
    if (p === 'FOOD_AND_DRINK') return 'dining';
    if (p === 'TRANSPORTATION' || p === 'TRAVEL') return 'transport';
    if (p === 'RENT_AND_UTILITIES' || p === 'HOME_IMPROVEMENT' || p === 'LOAN_PAYMENTS' && !/CREDIT_CARD/.test(d)) return 'home';
    if (p === 'GENERAL_MERCHANDISE') return 'shopping';
    if (p === 'ENTERTAINMENT') return 'fun';
    if (p === 'MEDICAL' || p === 'PERSONAL_CARE') return 'health';
    if (p === 'INCOME') return 'income';
    if (p === 'TRANSFER_IN' || p === 'TRANSFER_OUT' || /CREDIT_CARD/.test(d)) return 'transfer';
    return guessCat(name) || (amount > 0 ? 'income' : 'shopping');
  }
  // The category you used last time for this name, so quick add and CSV imports remember.
  function lastCat(st, name) {
    const k = norm(name); if (!k) return null;
    let best = null;
    for (const t of mine(st)) if (norm(t.m) === k && t.c !== 'transfer' && (!best || t.date > best.date)) best = t;
    return best && CAT_IDS.includes(best.c) ? best.c : null;
  }
  const pickCat = (st, name, fallback) => ruleCat(st.rules, name) || fallback || lastCat(st, name) || guessCat(name) || 'shopping';

  // ---------- transfers ----------
  // Money leaving one of your accounts and the same amount arriving in another within 4 days is a transfer
  // (paying your card, moving money to savings), so neither side counts as spending or income.
  // Charges you put in a category yourself are left alone. Returns how many pairs it found.
  function matchTransfers(st) {
    const own = new Set((st.accounts || []).filter(a => !a.other).map(a => a.id));
    const since = ymd(new Date(Date.now() - 150 * 864e5));
    const pool = mine(st).filter(t => own.has(t.acct) && !t.pair && !t.set && !t.split && !t.splitOf && t.date >= since && t.a !== 0);
    const ins = pool.filter(t => t.a > 0);
    let n = 0;
    for (const t of pool) {
      if (t.a >= 0 || t.pair) continue;
      const days = d => Math.abs(new Date(d + 'T12:00:00') - new Date(t.date + 'T12:00:00')) / 864e5;
      const u = ins.find(x => !x.pair && x.acct !== t.acct && Math.abs(x.a + t.a) < 0.005 && days(x.date) <= 4);
      if (!u) continue;
      t.pair = u.id; u.pair = t.id; t.c = 'transfer'; u.c = 'transfer'; n++;
    }
    return n;
  }

  // ---------- paydays and safe to spend ----------
  // Finds your pay from income that repeats, and when the next one should land.
  function payday(st, today) {
    const since = ymd(new Date(new Date(today + 'T12:00:00').getTime() - 100 * 864e5)), by = new Map();
    for (const t of mine(st)) if (t.c === 'income' && t.a >= 100 && t.date >= since && t.date <= today) { const k = norm(t.m); if (!by.has(k)) by.set(k, []); by.get(k).push(t); }
    let list = null; for (const l of by.values()) if (l.length >= 2 && (!list || l.reduce((s, t) => s + t.a, 0) > list.reduce((s, t) => s + t.a, 0))) list = l;
    if (!list) return null;
    list.sort((a, b) => a.date.localeCompare(b.date));
    const dates = [...new Set(list.map(t => t.date))], amount = round2(list.reduce((s, t) => s + t.a, 0) / list.length);
    const doms = [...new Set(dates.map(dayOf))].sort((a, b) => a - b), clusters = [];
    // Pay on the 30th one month and the 1st the next (weekends, short months) is the same payday.
    const near = (x, d) => Math.min(Math.abs(x - d), 31 - Math.abs(x - d)) <= 3;
    for (const d of doms) { const c = clusters.find(x => near(x, d)); if (!c) clusters.push(d); }
    const add = (d, n) => ymd(new Date(new Date(d + 'T12:00:00').getTime() + n * 864e5));
    // Every 1 or 2 weeks can look like twice a month over a few months, so check the gaps first.
    const gaps0 = []; for (let i = 1; i < dates.length; i++) gaps0.push(Math.round((new Date(dates[i]) - new Date(dates[i - 1])) / 864e5));
    const weekly = dates.length >= 3 && gaps0.every(g => g === gaps0[0] && (g === 7 || g === 14));
    let next, every;
    if (!weekly && clusters.length <= 2 && dates.length >= 2 && (clusters.length === 1 ? monthsBetween(ymOf(dates[0]), ymOf(dates[dates.length - 1])) >= 1 : true)) {
      every = clusters.length === 2 ? 'twice a month' : 'monthly';
      for (let i = 1; i <= 62 && !next; i++) { const d = add(today, i); if (clusters.some(c => Math.min(c, daysIn(ymOf(d))) === dayOf(d))) next = d; }
    } else {
      const gaps = []; for (let i = 1; i < dates.length; i++) gaps.push(Math.round((new Date(dates[i]) - new Date(dates[i - 1])) / 864e5));
      gaps.sort((a, b) => a - b); const g = Math.max(7, gaps[Math.floor(gaps.length / 2)]);
      every = g === 14 ? 'every 2 weeks' : g === 7 ? 'every week' : `every ${g} days`;
      next = dates[dates.length - 1]; while (next <= today) next = add(next, g);
    }
    return { name: baseName(list[list.length - 1].m), amount, every, next, days: Math.round((new Date(next + 'T12:00:00') - new Date(today + 'T12:00:00')) / 864e5) };
  }
  // What's free until the next payday: money in chequing, minus what you owe on cards, minus bills due before then.
  function safeToSpend(st, today) {
    const p = payday(st, today); if (!p) return null;
    const own = (st.accounts || []).filter(a => !a.other && !a.csv);
    const cash = round2(own.filter(a => a.type === 'Chequing').reduce((s, a) => s + inHome(st, a), 0));
    const cards = round2(own.filter(a => a.type === 'Credit card').reduce((s, a) => s + Math.min(0, inHome(st, a)), 0));
    const due = upcoming(st, today).filter(b => !b.late && b.due >= today && b.due < p.next && !(b.paid && ymOf(b.due) === ymOf(today)));
    const billsTotal = round2(due.reduce((s, b) => s + b.a, 0));
    return { amount: round2(cash + cards - billsTotal), cash, cards, bills: due, billsTotal, payday: p, perDay: round2(Math.max(0, cash + cards - billsTotal) / Math.max(1, p.days)) };
  }

  // "coffee 4.50", "$32 farmers market", "lunch 14,20" -> { amount, name, cat }
  function parseQuick(text) {
    text = String(text || '').trim();
    // "1,200" and "1,200.50" are thousands; "14,20" is a decimal comma.
    const m = text.match(/\$?\s?(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d{1,6}(?:[.,]\d{1,2})?)(?![\d,.]*\d)/);
    if (!m) return { amount: null, name: text, cat: guessCat(text) };
    const amount = round2(parseFloat(/,\d{3}/.test(m[1]) ? m[1].replace(/,/g, '') : m[1].replace(',', '.')));
    let name = (text.slice(0, m.index) + ' ' + text.slice(m.index + m[0].length)).replace(/\s+/g, ' ').trim();
    name = name ? name[0].toUpperCase() + name.slice(1) : 'Cash purchase';
    return { amount, name, cat: guessCat(name) };
  }

  // ---------- CSV import ----------
  function csvRows(text) {
    const rows = []; let row = [], cell = '', q = false;
    text = String(text || '').replace(/^﻿/, '');
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) { if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch; continue; }
      if (ch === '"') q = true;
      else if (ch === ',') { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
      else cell += ch;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows.map(r => r.map(c => c.trim())).filter(r => r.some(Boolean));
  }
  function toDate(s) {
    s = String(s || '').trim();
    let m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/); if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); if (m) return `${m[3]}-${pad(m[1])}-${pad(m[2])}`;   // MM/DD/YYYY, as most Canadian bank exports use
    const d = new Date(s); return isNaN(d) ? null : ymd(d);
  }
  const toNum = s => { s = String(s || '').replace(/[$\s]/g, ''); if (!s) return null; const neg = /^\(.*\)$/.test(s) || /-$/.test(s); s = s.replace(/[()]/g, '').replace(/-$/, '').replace(/,/g, ''); const n = parseFloat(s); return isNaN(n) ? null : (neg ? -n : n); };
  // Understands: date,description,amount   or   a header row with Date / Description / Amount, or Debit + Credit columns.
  function parseCsv(text) {
    const rows = csvRows(text); if (!rows.length) return [];
    const head = rows[0].map(h => h.toLowerCase());
    let iDate = head.findIndex(h => /date/.test(h)), iDesc = head.findIndex(h => /desc|payee|merchant|name|details|memo/.test(h)),
      iAmt = head.findIndex(h => /^amount|amount$|^cad/.test(h)), iDeb = head.findIndex(h => /debit|withdraw/.test(h)), iCred = head.findIndex(h => /credit|deposit/.test(h));
    let body = rows;
    if (iDate >= 0 && (iAmt >= 0 || iDeb >= 0)) body = rows.slice(1);
    else { iDate = 0; iDesc = 1; iAmt = -1; iDeb = -1; iCred = -1; }
    const out = [];
    for (const r of body) {
      const date = toDate(r[iDate]); if (!date) continue;
      let a;
      if (iAmt >= 0) a = toNum(r[iAmt]);
      else if (iDeb >= 0) { const d = toNum(r[iDeb]), c = toNum(r[iCred]); a = c ? Math.abs(c) : d ? -Math.abs(d) : null; }
      else a = toNum(r[r.length - 1]);
      if (a === null) continue;
      const m = (iDesc >= 0 ? r[iDesc] : r.slice(1, -1).join(', ')) || 'Imported';
      out.push({ date, m: m.slice(0, 80), a: round2(a) });
    }
    return out;
  }

  // ---------- bills and subscriptions ----------
  // A bill is a charge from the same place, in at least two different months out of the last four,
  // on about the same day (within 5 days) and for about the same amount (within 25%).
  const SUBS = /\b(netflix|spotify|disney|crave|prime|apple|google|youtube|icloud|xbox|playstation|patreon|audible|gym|goodlife|fitness|adobe|dropbox|chatgpt|claude)\b/i;
  // Names that are a subscription from the very first charge (not "Apple Store" or a gym's one-off fee)
  const EARLY = /\b(netflix|spotify|disney\+?|disney plus|crave|youtube premium|youtube tv|icloud|apple\.com\/bill|patreon|audible|adobe|dropbox|chatgpt|openai|claude\.ai|anthropic|prime video|amazon prime|paramount|xbox game pass|playstation plus|nintendo online)\b/i;
  function bills(st, today) {
    const since = ymd(new Date(new Date(today + 'T12:00:00').getTime() - 125 * 864e5));
    const by = new Map();
    for (const t of mine(st)) {
      if (t.a >= 0 || t.date < since || NOT_SPENDING.includes(t.c) || t.manual) continue;
      const k = norm(t.m); if (!k) continue;
      if (!by.has(k)) by.set(k, []);
      by.get(k).push(t);
    }
    const out = [], hide = new Set((st.hiddenBills || []).map(x => String(x).toLowerCase()));
    for (const [k, list] of by) {
      if (hide.has(k)) continue;
      const months = new Map();
      for (const t of list) { const ym = ymOf(t.date); if (!months.has(ym)) months.set(ym, t); }
      if (months.size < 2) continue;
      const ts = [...months.values()].sort((a, b) => a.date.localeCompare(b.date));
      const last = ts[ts.length - 1], amts = ts.map(t => -t.a), days = ts.map(t => dayOf(t.date));
      const avg = amts.reduce((s, a) => s + a, 0) / amts.length;
      if (amts.some(a => Math.abs(a - avg) > avg * 0.25)) continue;
      if (Math.max(...days) - Math.min(...days) > 5) continue;
      if (monthsBetween(ymOf(last.date), ymOf(today)) > 1) continue;   // stopped
      const varies = amts.some(a => Math.abs(a - amts[0]) > 0.009);
      out.push({ m: baseName(last.m), key: k, n: baseName(last.m), a: round2(varies ? avg : -last.a), d: Math.round(days.reduce((s, x) => s + x, 0) / days.length), acct: last.acct, c: last.c, varies, sub: SUBS.test(last.m) });
    }
    // A known subscription (Netflix, Spotify...) shows up from its first charge in the last 35 days.
    const have = new Set(out.map(b => b.key)), soon = ymd(new Date(new Date(today + 'T12:00:00').getTime() - 35 * 864e5));
    for (const [k, list] of by) {
      if (have.has(k) || hide.has(k)) continue;
      const t = list.filter(x => x.date >= soon && EARLY.test(x.m) && -x.a < 100).sort((a, b) => b.date.localeCompare(a.date))[0];
      if (!t || list.some(x => x !== t && ymOf(x.date) === ymOf(t.date))) continue;   // twice in one month isn't a monthly subscription
      out.push({ m: baseName(t.m), key: k, n: baseName(t.m), a: round2(-t.a), d: dayOf(t.date), acct: t.acct, c: t.c, varies: false, sub: true, early: true }); have.add(k);
    }
    // Bills your bank (Plaid) found that Budget it hasn't spotted yet
    for (const p of st.plaidBills || []) {
      const k = norm(p.n); if (!k || have.has(k) || hide.has(k) || (st.myBills || []).some(b => norm(b.n) === k)) continue;
      out.push({ m: p.n, key: k, n: p.n, a: round2(p.a), d: p.d, acct: p.acct || null, c: p.c || 'home', varies: !!p.varies, sub: SUBS.test(p.n), bank: true, every: p.every === 'year' ? 'year' : 'month', month: p.month || null }); have.add(k);
    }
    for (const b of st.myBills || []) out.push({ m: b.n, key: 'my:' + b.id, id: b.id, n: b.n, a: b.a, d: b.d, acct: b.acct || null, c: b.c || 'home', varies: false, sub: !!b.sub, mine: true, every: b.every || 'month', month: b.month || null });
    return out.sort((a, b) => a.d - b.d);
  }
  // Has this bill been charged in month ym?
  const billPaid = (st, b, ym) => mine(st).some(t => norm(t.m) === (b.mine ? norm(b.n) : b.key) && ymOf(t.date) === ym && t.a < 0);
  function upcoming(st, today) {
    const ym = ymOf(today), d = dayOf(today), dim = daysIn(ym);
    const T = new Date(today + 'T12:00:00');
    return bills(st, today).map(b => {
      if (b.every === 'year') {   // a yearly bill you added: due once a year, in its month
        const mo = +b.month || 1;
        let y = T.getFullYear(), due = `${y}-${pad(mo)}-${pad(Math.min(b.d, daysIn(`${y}-${pad(mo)}`)))}`;
        const paid = ymOf(due) === ym && billPaid(st, b, ym);
        if (due < today || paid) { y++; due = `${y}-${pad(mo)}-${pad(Math.min(b.d, daysIn(`${y}-${pad(mo)}`)))}`; }
        return { ...b, paid, days: Math.round((new Date(due + 'T12:00:00') - T) / 864e5), late: false, due };
      }
      const paid = billPaid(st, b, ym), day = Math.min(b.d, dim);
      const days = paid ? dim - d + Math.min(b.d, daysIn(nextYm(ym))) : day - d;
      return { ...b, paid, days, late: !paid && days < 0, due: paid ? `${nextYm(ym)}-${pad(Math.min(b.d, daysIn(nextYm(ym))))}` : `${ym}-${pad(day)}` };
    }).sort((a, b) => a.days - b.days);
  }

  // ---------- goals ----------
  // How much to put away each month to finish by the goal's month (at least one month away).
  // A goal can follow a savings account: then what's saved is that account's balance.
  function goalSaved(st, g) {
    const a = g.acct && (st.accounts || []).find(x => x.id === g.acct);
    return a ? round2(Math.max(0, inHome(st, a))) : g.saved;
  }
  function goalMonthly(g, today, st) {
    const saved = st ? goalSaved(st, g) : g.saved;
    if (saved >= g.target) return 0;
    const months = Math.max(1, monthsBetween(ymOf(today), g.by || nextYm(ymOf(today))));
    return round2((g.target - saved) / months);
  }

  // ---------- tags ----------
  // "#japan" style tags across categories, with their totals. Newest first.
  function tagTotals(st) {
    const m = new Map();
    for (const t of mine(st)) for (const tag of t.tags || []) {
      const x = m.get(tag) || { tag, spent: 0, count: 0, from: t.date, to: t.date };
      if (t.a < 0 && t.c !== 'transfer') x.spent = round2(x.spent - t.a);
      x.count++; if (t.date < x.from) x.from = t.date; if (t.date > x.to) x.to = t.date; m.set(tag, x);
    }
    return [...m.values()].sort((a, b) => b.to.localeCompare(a.to));
  }

  // ---------- this week ----------
  // Everyday spending in the last 7 days, and in a usual week (the 8 weeks before).
  function week(st, today) {
    const T = new Date(today + 'T12:00:00').getTime(), back = n => ymd(new Date(T - n * 864e5));
    const every = (from, to) => round2(mine(st).filter(t => t.date > from && t.date <= to && t.a < 0 && !['home', 'transfer', 'income'].includes(t.c)).reduce((s, t) => s - t.a, 0));
    const spentNow = every(back(7), today), first = mine(st).reduce((m, t) => t.date < m ? t.date : m, today);
    const weeks = Math.min(8, Math.floor((T - new Date(first + 'T12:00:00').getTime()) / (7 * 864e5)) - 1);
    const usual = weeks > 0 ? round2(every(back(7 * (weeks + 1)), back(7)) / weeks) : null;
    return { spent: spentNow, usual };
  }

  // ---------- things worth a heads-up ----------
  // Big or unusual charges, new subscriptions, price increases and a low chequing balance before bills.
  // Each has a key, so it's only shown (and sent to the phone) once, and can be dismissed.
  function alerts(st, today) {
    const out = [], T = new Date(today + 'T12:00:00').getTime(), back = n => ymd(new Date(T - n * 864e5)), list = mine(st), seen = new Set(st.dismissed || []);
    const fmt = v => '$' + Math.abs(v).toFixed(2);
    for (const t of list) {
      if (t.a >= 0 || t.date < back(3) || ['home', 'transfer', 'income'].includes(t.c) || t.manual) continue;
      const k = norm(t.m), before = list.filter(x => x !== t && x.a < 0 && norm(x.m) === k && x.date < t.date).map(x => -x.a).sort((a, b) => a - b);
      const usual = before.length >= 2 ? before[Math.floor(before.length / 2)] : null;
      if (-t.a >= 150 && (usual ? -t.a > usual * 3 : -t.a >= 400)) out.push({ key: 'big:' + t.id, kind: 'big', id: t.id, title: `${fmt(t.a)} at ${baseName(t.m)}`, body: usual ? `About ${Math.round(-t.a / usual)} times what it usually is. Was this you?` : 'A bigger charge than usual. Was this you?' });
    }
    for (const b of bills(st, today)) {
      if (b.mine) continue;
      const ts = list.filter(t => norm(t.m) === b.key && t.a < 0).sort((x, y) => x.date.localeCompare(y.date));
      if (b.sub && ts.length && ts[0].date >= back(45)) out.push({ key: 'newsub:' + b.key, kind: 'newsub', title: `New subscription: ${b.n}`, body: `${fmt(b.a)} a month, about ${fmt(b.a * 12)} a year.` });
      if (b.sub && ts.length >= 2) { const a = -ts[ts.length - 1].a, p = -ts[ts.length - 2].a;
        if (a - p >= 0.5 && a > p * 1.03 && ts[ts.length - 1].date >= back(35)) out.push({ key: `up:${b.key}:${ts[ts.length - 1].date}`, kind: 'priceup', title: `${b.n} went up ${fmt(a - p)}`, body: `It's ${fmt(a)} now, was ${fmt(p)}. That's ${fmt((a - p) * 12)} more a year.` }); }
    }
    const chq = (st.accounts || []).filter(a => !a.other && a.type === 'Chequing' && !a.csv);
    if (chq.length) {
      const bal = chq.reduce((s, a) => s + inHome(st, a), 0), ids = new Set(chq.map(a => a.id));
      const soon = upcoming(st, today).filter(b => !b.paid && !b.late && b.days <= 7 && (!b.acct || ids.has(b.acct))).reduce((s, b) => s + b.a, 0);
      if (bal - soon < 100) out.push({ key: 'low:' + ymOf(today) + ':' + Math.floor(dayOf(today) / 7), kind: 'low', title: 'Chequing is running low', body: `${fmt(bal)} in chequing and ${fmt(soon)} of bills due this week.` });
    }
    return out.filter(a => !seen.has(a.key));
  }

  // ---------- export ----------
  function toCsv(st) {
    const q = v => { v = String(v ?? ''); return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    // Text that starts like a formula (= + - @, a tab or a return) gets a ' in front, so a spreadsheet shows it
    // instead of running it. Amounts are numbers and stay as they are.
    const w = v => { v = String(v ?? ''); return /^[=+\-@\t\r]/.test(v) ? "'" + v : v; };
    const acc = id => ((st.accounts || []).find(a => a.id === id) || { name: id === 'cash' ? 'Cash' : id }).name;
    const rows = mine(st).concat((st.txns || []).filter(t => t.hidden && !t.other)).sort((a, b) => a.date.localeCompare(b.date));
    return ['Date,Description,Amount,Category,Account,Note,Tags,Counted'].concat(rows.map(t => [t.date, w(t.m), t.a.toFixed(2), w(catName(t.c)), w(acc(t.acct)), w(t.note || ''), w((t.tags || []).join(' ')), t.hidden ? 'no' : 'yes'].map(q).join(','))).join('\n') + '\n';
  }

  // Top places money went this month, leaving out home & bills and transfers.
  function topMerchants(st, ym, n = 3) {
    const m = new Map();
    for (const t of mine(st)) {
      if (ymOf(t.date) !== ym || t.a >= 0 || ['home', 'transfer', 'income'].includes(t.c)) continue;
      const k = baseName(t.m), x = m.get(k) || { name: k, total: 0, count: 0, cat: t.c };
      x.total = round2(x.total - t.a); x.count++; m.set(k, x);
    }
    return [...m.values()].sort((a, b) => b.total - a.total).slice(0, n);
  }

  // ---------- net worth over time ----------
  // Your own accounts only (not ones shared with you). Loans and cards count as negative.
  const worth = st => round2((st.accounts || []).filter(a => !a.other).reduce((s, a) => s + inHome(st, a), 0));
  // Keeps one number per month (the latest seen that month), for the last 36 months. Returns true if it changed.
  function noteWorth(st, today) {
    if (!(st.accounts || []).some(a => !a.other)) return false;
    const ym = ymOf(today), v = worth(st), h = st.worthHist = st.worthHist || {};
    if (h[ym] === v) return false;
    h[ym] = v;
    for (const k of Object.keys(h).sort().slice(0, -36)) delete h[k];
    return true;
  }
  // Oldest first: [{ ym, v }]
  const worthSeries = st => Object.entries(st.worthHist || {}).sort((a, b) => a[0].localeCompare(b[0])).map(([ym, v]) => ({ ym, v }));

  // ---------- investments ----------
  // An investment account's holdings: [{ id, sym, name, qty, price, cost }] where cost is what you paid in total (if known).
  // Returns each with its value and gain, plus totals. Gain is only counted for holdings that have a cost.
  function holdings(acct) {
    const list = ((acct && acct.holdings) || []).map(h => {
      const value = round2((+h.qty || 0) * (+h.price || 0)), cost = h.cost > 0 ? round2(h.cost) : null;
      return { ...h, value, cost, gain: cost === null ? null : round2(value - cost), pct: cost ? Math.round((value - cost) / cost * 1000) / 10 : null };
    }).sort((a, b) => b.value - a.value);
    const value = round2(list.reduce((s, h) => s + h.value, 0)), withCost = list.filter(h => h.cost !== null);
    const cost = round2(withCost.reduce((s, h) => s + h.cost, 0)), gain = withCost.length ? round2(withCost.reduce((s, h) => s + h.gain, 0)) : null;
    return { list, value, cost: withCost.length ? cost : null, gain, pct: withCost.length && cost ? Math.round(gain / cost * 1000) / 10 : null };
  }
  // Plaid's /transactions/recurring/get -> bills: active money going out, monthly or yearly.
  function plaidBills(r) {
    const every = { MONTHLY: 'month', ANNUALLY: 'year' };
    return (r.outflow_streams || []).filter(x => x.is_active !== false && every[x.frequency] && x.status !== 'TOMBSTONED').map(x => {
      const when = x.predicted_next_date || x.last_date || '', amt = Math.abs((x.average_amount && x.average_amount.amount) ?? (x.last_amount && x.last_amount.amount) ?? 0);
      const n = String(x.merchant_name || x.description || 'Bill').slice(0, 60);
      return { id: x.stream_id, n, a: round2(amt), d: dayOf(when) || 1, every: every[x.frequency], month: every[x.frequency] === 'year' ? +when.slice(5, 7) || 1 : null,
        acct: x.account_id ? 'p_' + x.account_id : null, c: plaidCat(x.personal_finance_category, n, -amt), varies: !!(x.last_amount && x.average_amount && Math.abs(x.last_amount.amount - x.average_amount.amount) > 0.01) };
    }).filter(b => b.a > 0);
  }
  // Plaid's /investments/holdings/get for one account -> our holdings
  function plaidHoldings(r, accountId) {
    const sec = new Map((r.securities || []).map(s => [s.security_id, s]));
    return (r.holdings || []).filter(h => h.account_id === accountId && (+h.quantity || 0) !== 0).map(h => {
      const s = sec.get(h.security_id) || {}, qty = +h.quantity || 0;
      const price = h.institution_price != null ? +h.institution_price : qty ? (+h.institution_value || 0) / qty : 0;
      return { id: 'p_' + h.security_id, sym: String(s.ticker_symbol || '').slice(0, 12), name: String(s.name || s.ticker_symbol || 'Holding').slice(0, 60),
        qty: Math.round(qty * 1e6) / 1e6, price: Math.round(price * 1e4) / 1e4, cost: h.cost_basis > 0 ? round2(h.cost_basis) : undefined, kind: s.type || '' };
    });
  }

  // ---------- paying off a card or loan ----------
  // owe: what you owe (positive), apr: yearly interest in %, pay: what you pay each month.
  // Returns { months, interest, total } or { never: true } when the payment doesn't cover the interest.
  function payoff(owe, apr, pay) {
    owe = Math.abs(+owe || 0); apr = Math.max(0, +apr || 0); pay = +pay || 0;
    if (!owe) return { months: 0, interest: 0, total: 0 };
    const r = apr / 100 / 12;
    if (pay <= owe * r + 0.005) return { never: true, minimum: round2(owe * r + 1) };
    let b = owe, months = 0, interest = 0;
    while (b > 0.005 && months < 600) { const i = b * r; interest += i; b = b + i - pay; months++; }
    return { months, interest: round2(interest), total: round2(owe + interest) };
  }
  // The monthly payment that clears it in n months.
  function payFor(owe, apr, n) {
    owe = Math.abs(+owe || 0); const r = Math.max(0, +apr || 0) / 100 / 12; n = Math.max(1, Math.round(n));
    // Rounded up to the cent, so the last payment doesn't leave a few cents for one more month.
    return Math.ceil((r ? owe * r / (1 - Math.pow(1 + r, -n)) : owe / n) * 100 - 1e-6) / 100;
  }

  // ---------- year in review ----------
  // One year (or the year so far): money in and out, by category, the top places, the biggest month and subscriptions.
  function yearReview(st, year, today) {
    year = String(year); const list = mine(st).filter(t => t.date.slice(0, 4) === year && t.date <= today);
    const out = list.filter(t => t.a < 0 && t.c !== 'transfer'), byCat = {}, byMonth = {}, byPlace = new Map();
    let spentAll = 0, earned = 0;
    for (const t of list) if (t.c === 'income') earned += t.a;
    for (const t of out) {
      spentAll -= t.a; byCat[t.c] = (byCat[t.c] || 0) - t.a; byMonth[ymOf(t.date)] = (byMonth[ymOf(t.date)] || 0) - t.a;
      if (!['home', 'income'].includes(t.c)) { const k = baseName(t.m), x = byPlace.get(k) || { name: k, total: 0, count: 0, cat: t.c }; x.total -= t.a; x.count++; byPlace.set(k, x); }
    }
    const cats = Object.entries(byCat).map(([c, v]) => ({ cat: c, name: catName(c), spent: round2(v) })).sort((a, b) => b.spent - a.spent);
    const months = Object.entries(byMonth).map(([ym, v]) => ({ ym, spent: round2(v) })).sort((a, b) => a.ym.localeCompare(b.ym));
    const big = months.reduce((m, x) => !m || x.spent > m.spent ? x : m, null), small = months.reduce((m, x) => !m || x.spent < m.spent ? x : m, null);
    const places = [...byPlace.values()].map(x => ({ ...x, total: round2(x.total) })).sort((a, b) => b.total - a.total).slice(0, 5);
    const subs = bills(st, today).filter(b => b.sub), subsYear = round2(subs.reduce((s, b) => s + b.a * (b.every === 'year' ? 1 : 12), 0));
    const busiest = [...byPlace.values()].sort((a, b) => b.count - a.count)[0] || null;
    earned = round2(earned); spentAll = round2(spentAll);
    return { year, earned, spent: spentAll, kept: round2(earned - spentAll), rate: earned > 0 ? Math.round((earned - spentAll) / earned * 100) : null,
      cats, months, big, small: months.length > 1 ? small : null, places, busiest: busiest && busiest.count >= 3 ? { name: busiest.name, count: busiest.count } : null,
      subs: subs.length, subsYear, count: out.length };
  }

  // A transaction in another currency, turned into home money at today's rate. Keeps what it really was in orig.
  // With no rate yet it counts 1 to 1 and is marked norate, so setting the rate later fixes it.
  function convertTxn(st, t, cur) {
    if (!cur || cur === homeCur(st)) return t;
    const r = rate(st, cur);
    t.orig = { a: t.a, cur }; t.a = round2(t.a * (r || 1));
    if (r === null) t.norate = true; else delete t.norate;
    return t;
  }
  // Put a transaction back in the money it was in, then into home money for its account's currency
  function reconvert(st, t, cur) {
    if (t.orig) { t.a = t.orig.a; delete t.orig; delete t.norate; }
    return convertTxn(st, t, cur);
  }
  const api = { CURRENCIES, homeCur, rate, inHome, missingRates, convertTxn, reconvert, plaidBills, holdings, plaidHoldings, worth, noteWorth, worthSeries, payoff, payFor, yearReview, useCats, lastCat, matchTransfers, payday, safeToSpend, goalSaved, tagTotals, week, alerts, toCsv, ruleName, CATS, CAT_IDS, NOT_SPENDING, catName, round2, ymd, ymOf, ymNow, prevYm, nextYm, daysIn, dayOf, monthsBetween,
    mine, spent, limit, budgeted, totals, perDay, moneyOut, moneyIn, budgetState, budgetStatus,
    baseName, norm, ruleCat, guessCat, plaidCat, pickCat, parseQuick, csvRows, parseCsv, toDate, bills, billPaid, upcoming, goalMonthly, topMerchants };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Budget = api;
})(typeof window !== 'undefined' ? window : this);
