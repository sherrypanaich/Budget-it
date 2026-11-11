// The changes a person can make to their own budget, from the page or an assistant.
// Shared by the server and the preview page (which runs them in the browser on sample data).
// Each one changes the state in place and returns a short message for the person.
(function (root) {
  'use strict';
  function makeOps(B, { today, rid, sample }) {
    // A billion or more is a typo (or "1e300"), not an amount: it would only turn totals into nonsense
    const num = v => { const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(/[$,\s]/g, '')); return isFinite(n) && Math.abs(n) < 1e9 ? B.round2(n) : NaN; };
    const text = (v, max = 80) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
      const okCat = c => B.CAT_IDS.includes(c);
    const bad = msg => { throw Object.assign(new Error(msg), { status: 400 }); };
    function addRule(s, match, cat, how) {
      match = text(match, 40); if (!match) return;
      how = how === 'contains' ? 'contains' : 'starts';
      s.rules = s.rules.filter(r => r.match.toLowerCase() !== match.toLowerCase());
      s.rules.push(how === 'contains' ? { match, cat, how } : { match, cat });
      const m = match.toLowerCase();
      for (const t of s.txns) if (!t.split && !t.other && t.c !== 'transfer' && (how === 'contains' ? t.m.toLowerCase().includes(m) : t.m.toLowerCase().startsWith(m))) t.c = cat;
    }
    const tagsOf = v => [...new Set((Array.isArray(v) ? v : String(v || '').split(/[\s,]+/)).map(x => String(x).trim().replace(/^#/, '').toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').slice(0, 24)).filter(Boolean))].slice(0, 8);
    const find = (s, id) => { const t = s.txns.find(x => x.id === id && !x.other) || bad('That transaction isn’t there any more.'); return t; };
    const day = v => { const d = Math.round(num(v)); return d >= 1 && d <= 31 ? d : bad('Pick a day from 1 to 31.'); };
    // A transfer pair stops being one when either side gets another category.
    const unpair = (s, t) => { if (!t.pair) return; const u = s.txns.find(x => x.id === t.pair); if (u) delete u.pair; delete t.pair; };
    const ICONS = ['star', 'paw', 'gift', 'kids', 'book', 'plane', 'briefcase', 'coffee', 'heart', 'tool'];
    const OPS = {
      'txn.update'(s, a) {
        const t = find(s, a.id);
        if (a.c !== undefined) { okCat(a.c) || bad('Pick a category.'); if (a.c !== t.c) { t.c = a.c; t.set = true; if (a.c !== 'transfer') unpair(s, t); } }
        if (a.m !== undefined) t.m = text(a.m) || t.m;
        if (a.note !== undefined) t.note = text(a.note, 140);
        if (a.tags !== undefined) { const tg = tagsOf(a.tags); if (tg.length) t.tags = tg; else delete t.tags; }
        if (a.hidden !== undefined) { if (a.hidden) t.hidden = true; else delete t.hidden; }
        t.fresh = false; delete t.changed;   // saving it is checking it, after the bank changed its amount
        if (a.rule) addRule(s, B.ruleName(t.m), t.c);
        return a.rule ? `Saved. ${B.ruleName(t.m)} goes in ${B.catName(t.c)} from now on.` : a.hidden ? 'Hidden. It won’t count in your totals.' : 'Saved';
      },
      'txn.bulk'(s, a) {
        const ids = new Set(Array.isArray(a.ids) ? a.ids.slice(0, 500) : []); if (!ids.size) bad('Pick some transactions first.');
        if (a.c !== undefined) okCat(a.c) || bad('Pick a category.');
        let n = 0;
        for (const t of s.txns) if (ids.has(t.id) && !t.other) {
          if (a.c !== undefined && a.c !== t.c) { t.c = a.c; t.set = true; if (a.c !== 'transfer') unpair(s, t); }
          if (a.hidden !== undefined) { if (a.hidden) t.hidden = true; else delete t.hidden; }
          if (a.tag) t.tags = tagsOf([...(t.tags || []), a.tag]);
          t.fresh = false; n++;
        }
        return `Changed ${n} transaction${n === 1 ? '' : 's'}`;
      },
      'txn.receipt'(s, a) { const t = find(s, a.id); if (a.receipt) t.receipt = text(a.receipt, 2e6); else delete t.receipt; return a.receipt ? 'Receipt added' : 'Receipt removed'; },
      'txn.sent'(s, a) { const t = find(s, a.id); t.sentTo = text(a.to, 60); return ''; },
      // Sent to Split it with "count only my share": the part housemates owe back becomes its own line that isn't spending.
      'txn.share'(s, a) {
        const t = find(s, a.id), amt = num(a.amount);
        if (t.a >= 0 || t.split || !(amt > 0 && amt < -t.a)) return '';
        t.a = B.round2(t.a + amt); t.split = true; t.fresh = false;
        delete t.orig; delete t.norate;
        const { receipt, pair, sentTo, plaidId, ...rest } = t;
        s.txns.push({ ...rest, id: t.id + '-2', a: -amt, c: 'transfer', splitOf: t.id, set: true, owed: text(a.to, 60) || true, note: 'Owed back by housemates' + (a.to ? ' (' + text(a.to, 60) + ')' : '') });
        return `Only your share ($${(-t.a).toFixed(2)}) counts in your budget`;
      },
      'txn.split'(s, a) {
        const t = find(s, a.id);
        const amt = num(a.amount);
        if (t.a >= 0 || t.split) bad('Only one-off spending can be split.');
        if (!(amt > 0 && amt < -t.a)) bad(`Enter an amount between $0 and $${(-t.a).toFixed(2)}.`);
        okCat(a.c) || bad('Pick the second category.');
        t.a = B.round2(t.a + amt); t.split = true; t.fresh = false;
        delete t.orig; delete t.norate;   // split parts are in home money from here on
        // The second part is its own line: it doesn't take the receipt, the transfer match or the Split it mark with it.
        const { receipt, pair, sentTo, plaidId, ...rest } = t;
        s.txns.push({ ...rest, id: t.id + '-2', a: -amt, c: a.c, splitOf: t.id, set: true });
        return `Moved $${amt.toFixed(2)} to ${B.catName(a.c)}`;
      },
      'txn.add'(s, a) {
        const amt = num(a.amount); if (!(amt > 0)) bad('Enter how much you paid.');
        const c = okCat(a.c) ? a.c : B.pickCat(s, a.m, null);
        const date = /^\d{4}-\d\d-\d\d$/.test(a.date || '') && B.toDate(a.date) === a.date ? a.date : today();   // never 2026-02-31
        const t = { id: rid('m'), date, acct: 'cash', m: text(a.m) || 'Cash purchase', a: -amt, c, note: text(a.note, 140), manual: true, at: Date.now(), via: a.via || 'app' };
        s.txns.push(t);
        return `Added $${amt.toFixed(2)} to ${B.catName(c)}`;
      },
      'txn.delete'(s, a) {
        const t = s.txns.find(x => x.id === a.id) || bad('That transaction isn’t there any more.');
        if (!t.manual) bad('Bank transactions can’t be deleted. Change the category to Transfer to leave it out of your budget.');
        // Deleting the second part of a split gives its amount back to the first. Deleting the first takes both.
        const parent = t.splitOf && s.txns.find(x => x.id === t.splitOf);
        if (parent) { parent.a = B.round2(parent.a + t.a); delete parent.split; }
        s.txns = s.txns.filter(x => x.id !== a.id && x.splitOf !== a.id);
        return 'Deleted';
      },
      'review.done'(s, a) {
        const t = s.txns.find(x => x.id === a.id) || bad('That transaction isn’t there any more.');
        if (a.c && okCat(a.c) && a.c !== t.c) { t.c = a.c; t.set = true; if (a.c !== 'transfer') unpair(s, t); }
        t.fresh = false;
        if (a.rule) addRule(s, B.ruleName(t.m), t.c);
        return 'Checked';
      },
      'review.seen'(s) { s.seenNew = Date.now(); return ''; },
      'budget.set'(s, a) {
        okCat(a.c) && !B.NOT_SPENDING.includes(a.c) || bad('Pick a spending category.');
        const v = num(a.amount); if (!(v >= 0)) bad('Enter an amount of $0 or more.');
        if (v === 0) delete s.budgets[a.c]; else s.budgets[a.c] = v;
        if (a.rollover !== undefined) s.rollover[a.c] = !!a.rollover;
        if (a.carry !== undefined) { s.carry = s.carry || {}; s.carry[a.c] = !!a.carry; }
        return v ? 'Budget saved' : 'Budget removed';
      },
      'rule.delete'(s, a) { s.rules = s.rules.filter(r => r.match !== a.match); return 'Rule removed'; },
      'rule.save'(s, a) {
        okCat(a.cat) || bad('Pick a category.'); text(a.match, 40) || bad('Type the name to match.');
        if (a.old && a.old !== a.match) s.rules = s.rules.filter(r => r.match !== a.old);
        addRule(s, a.match, a.cat, a.how); return 'Rule saved. Matching charges moved too.';
      },
      'cat.add'(s, a) {
        const name = text(a.name, 24); if (!name) bad('Give the category a name.');
        if (B.CATS.some(c => c.name.toLowerCase() === name.toLowerCase())) bad('There’s already a category with that name.');
        s.cats = s.cats || []; if (s.cats.length >= 20) bad('That’s the most categories you can add.');
        const id = 'x' + rid('').slice(-6).replace(/[^a-z0-9]/gi, '');
        s.cats.push({ id, name, icon: ICONS.includes(a.icon) ? a.icon : 'star', color: /^--c[1-8]$/.test(a.color || '') ? a.color : '--c5' });
        B.useCats(s); return `Added ${name}`;
      },
      'cat.update'(s, a) {
        const c = (s.cats || []).find(x => x.id === a.id), name = text(a.name, 24);
        if (c) { if (name) c.name = name; if (ICONS.includes(a.icon)) c.icon = a.icon; if (/^--c[1-8]$/.test(a.color || '')) c.color = a.color; }
        else { okCat(a.id) && !B.NOT_SPENDING.includes(a.id) || bad('That category can’t be renamed.'); s.catNames = s.catNames || {}; if (name) s.catNames[a.id] = name; else delete s.catNames[a.id]; }
        B.useCats(s); return 'Saved';
      },
      'cat.delete'(s, a) {
        const c = (s.cats || []).find(x => x.id === a.id) || bad('Only categories you added can be removed.');
        const to = a.to && a.to !== a.id && okCat(a.to) ? a.to : 'shopping';
        let n = 0; for (const t of s.txns) if (t.c === c.id && !t.other) { t.c = to; n++; }
        s.rules.forEach(r => { if (r.cat === c.id) r.cat = to; });
        (s.myBills || []).forEach(b => { if (b.c === c.id) b.c = to; });
        delete s.budgets[c.id]; if (s.rollover) delete s.rollover[c.id]; if (s.carry) delete s.carry[c.id];
        s.cats = s.cats.filter(x => x !== c); B.useCats(s);
        return `Removed ${c.name}.${n ? ` ${n} transaction${n === 1 ? '' : 's'} moved to ${B.catName(to)}.` : ''}`;
      },
      'bill.add'(s, a) {
        const n = text(a.n, 40), amt = num(a.amount); if (!n || !(amt > 0)) bad('Add a name and an amount.');
        const every = a.every === 'year' ? 'year' : 'month', month = every === 'year' ? Math.min(12, Math.max(1, Math.round(num(a.month)) || 1)) : null;
        s.myBills = s.myBills || [];
        const b = { id: rid('b'), n, a: amt, d: day(a.d), every, month, c: okCat(a.c) ? a.c : 'home', sub: !!a.sub };
        if (a.id) { const old = s.myBills.find(x => x.id === a.id) || bad('That bill isn’t there any more.'); Object.assign(old, { ...b, id: old.id }); return 'Bill saved'; }
        s.myBills.push(b); return `Added ${n}`;
      },
      'bill.delete'(s, a) { s.myBills = (s.myBills || []).filter(b => b.id !== a.id); return 'Bill removed'; },
      'goal.link'(s, a) {
        const g = s.goals.find(x => x.id === a.id) || bad('That goal isn’t there any more.');
        if (a.acct) { const ac = s.accounts.find(x => x.id === a.acct && !x.other) || bad('Pick one of your accounts.'); g.acct = ac.id; return `${g.n} now follows ${ac.name}`; }
        g.saved = B.goalSaved(s, g); delete g.acct; return 'Saved';
      },
      'alert.dismiss'(s, a) { s.dismissed = (s.dismissed || []).concat(text(a.key, 120)).slice(-300); return ''; },
      'goal.add'(s, a) {
        const n = text(a.n, 40), t = num(a.target); if (!n || !(t > 0)) bad('Add a name and an amount.');
        const by = /^\d{4}-\d\d$/.test(a.by || '') ? a.by : B.nextYm(B.nextYm(B.ymOf(today())));
        const ac = a.acct && s.accounts.find(x => x.id === a.acct && !x.other);
        s.goals.push({ id: rid('g'), n, target: t, saved: 0, by, ...(ac ? { acct: ac.id } : {}) });
        return `Goal created: ${n}`;
      },
      'goal.fund'(s, a) {
        const g = s.goals.find(x => x.id === a.id) || bad('That goal isn’t there any more.');
        if (g.acct) bad('This goal follows an account’s balance, so it updates by itself.');
        const v = num(a.amount); if (!v) bad('Enter an amount.');
        const was = g.saved < g.target;
        g.saved = B.round2(Math.max(0, g.saved + v));
        if (was && g.saved >= g.target) g.doneAt = Date.now();
        return `${v > 0 ? 'Added' : 'Took out'} $${Math.abs(v).toFixed(2)} ${v > 0 ? 'to' : 'from'} ${g.n}`;
      },
      'goal.delete'(s, a) { s.goals = s.goals.filter(g => g.id !== a.id); return 'Goal removed'; },
      'income.set'(s, a) { const v = num(a.amount); if (!(v >= 0)) bad('Enter an amount.'); s.expectIncome = v; return 'Saved'; },
      'account.share'(s, a) {
        const x = s.accounts.find(y => y.id === a.id) || bad('That account isn’t there any more.');
        // `with`: the people (their ids) who can see it. The server keeps only people who are really here and says who.
        // `shared: true/false` is the older all-or-nobody switch.
        x.shared = Array.isArray(a.with) ? [...new Set(a.with.map(v => text(v, 40)).filter(Boolean))].slice(0, 50) : !!a.shared;
        return x.shared === true || (x.shared && x.shared.length) ? 'Shared' : 'Only you can see it now';
      },
      // Accounts you keep by hand (no bank connection): cash, a credit union Plaid can't reach, a loan.
      'account.add'(s, a) {
        const name = text(a.name, 40); if (!name) bad('Give the account a name.');
        const types = ['Chequing', 'Savings', 'Credit card', 'Cash', 'Investment', 'Loan', 'Other'], type = types.includes(a.type) ? a.type : 'Other';
        let bal = num(a.bal); if (!Number.isFinite(bal)) bal = 0;
        if ((type === 'Credit card' || type === 'Loan') && bal > 0) bal = -bal;   // what you owe is negative
        const cur = B.CURRENCIES.includes(a.cur) && a.cur !== B.homeCur(s) ? a.cur : undefined;
        const acct = { id: rid('m'), name, inst: 'Added by you', type, mask: '', bal: Math.round(bal * 100) / 100, shared: false, manual: true, synced: Date.now(), ...(cur ? { cur } : {}) };
        s.accounts.push(acct); return `Added ${name}`;
      },
      'account.balance'(s, a) {
        const x = s.accounts.find(y => y.id === a.id && !y.other) || bad('That account isn’t there any more.');
        if (!x.manual && !x.csv) bad('This balance comes from your bank.');
        if (x.holdings && x.holdings.length) bad('This balance is the total of its holdings. Change a holding to update it.');
        let v = num(a.bal); if (!Number.isFinite(v)) bad('Enter the balance.');
        if ((x.type === 'Credit card' || x.type === 'Loan') && v > 0) v = -v;
        x.bal = Math.round(v * 100) / 100; x.synced = Date.now(); return 'Balance updated';
      },
      'account.delete'(s, a) {
        const x = s.accounts.find(y => y.id === a.id && !y.other) || bad('That account isn’t there any more.');
        // A bank account goes only once its bank is disconnected ("Delete this history")
        if (!x.manual && !x.csv && !x.disconnected) bad('Disconnect the bank to remove this account.');
        const n = s.txns.filter(t => t.acct === x.id).length;
        for (const t of s.txns) if (t.acct === x.id) unpair(s, t);
        // A goal that followed it keeps what it had saved, in home money like the goal (a US dollar account's balance isn't)
        s.goals.forEach(g => { if (g.acct === x.id) { g.saved = B.goalSaved(s, g); delete g.acct; } });
        s.accounts = s.accounts.filter(y => y !== x); s.txns = s.txns.filter(t => t.acct !== x.id);
        return `Removed ${x.name}${n ? ` and its ${n} transaction${n === 1 ? '' : 's'}` : ''}`;
      },
      'account.rename'(s, a) { const x = s.accounts.find(y => y.id === a.id) || bad('That account isn’t there any more.'); const n = text(a.name, 40); if (n && n !== x.name) { x.name = n; x.renamed = true; } return 'Saved'; },
      // Your home currency, and what one unit of another currency is worth in it
      'money.home'(s, a) {
        B.CURRENCIES.includes(a.home) || bad('Pick a currency.');
        const old = B.homeCur(s);
        if (a.home !== old) {   // accounts keep the money they're in: the old home's accounts now say so
          for (const x of s.accounts) if (!x.other) { const c = x.cur || old; if (c === a.home) delete x.cur; else x.cur = c; }
          s.home = a.home; s.rates = {};
          // So do their charges: back to the money they were in, then into the new home money (1 to 1 until there's a rate,
          // like a new account's). Cash you added and splits stay as they are, in the numbers you see.
          const accts = new Set(s.accounts.filter(x => !x.other).map(x => x.id));
          for (const t of s.txns) if (accts.has(t.acct) && !t.other && !t.split && !t.splitOf) B.reconvert(s, t, t.orig ? t.orig.cur : old);
        }
        return `Totals are in ${a.home} now.`;
      },
      'money.rate'(s, a) {
        B.CURRENCIES.includes(a.cur) && a.cur !== B.homeCur(s) || bad('Pick a currency.');
        const r = parseFloat(String(a.rate ?? '').replace(/[,\s]/g, '')); if (!(r > 0 && r < 100000)) bad('Enter how much one ' + a.cur + ' is in ' + B.homeCur(s) + '.');
        s.rates = s.rates || {}; s.rates[a.cur] = Math.round(r * 1e6) / 1e6; s.ratesAt = Date.now();
        // Charges that came in before there was a rate get it now
        for (const t of s.txns) if (t.norate && t.orig && t.orig.cur === a.cur && !t.other) B.reconvert(s, t, a.cur);
        return `1 ${a.cur} = ${s.rates[a.cur]} ${B.homeCur(s)}`;
      },
      'account.currency'(s, a) {
        const x = s.accounts.find(y => y.id === a.id && !y.other) || bad('That account isn’t there any more.');
        if (!x.manual && !x.csv) bad('Your bank says which currency this account is in.');
        B.CURRENCIES.includes(a.cur) || bad('Pick a currency.');
        if ((x.cur || B.homeCur(s)) === a.cur) return 'Saved';
        if (a.cur === B.homeCur(s)) delete x.cur; else x.cur = a.cur;
        // Its charges were in the old currency: put them in the new one (splits follow their parent's amounts)
        for (const t of s.txns) if (t.acct === x.id && !t.splitOf && !t.split) B.reconvert(s, t, x.cur);
        return 'Saved';
      },
      // New prices for every holding in an account at once
      'holding.prices'(s, a) {
        const x = s.accounts.find(y => y.id === a.acct && !y.other) || bad('That account isn’t there any more.');
        if (!x.manual) bad('This account’s holdings come from your bank.');
        const p = a.prices && typeof a.prices === 'object' ? a.prices : {};
        let n = 0;
        for (const h of x.holdings || []) {
          if (!Object.hasOwn(p, h.id)) continue;
          const v = num(p[h.id]); if (!(v >= 0)) bad(`Enter a price for ${h.sym || h.name}.`);
          const nv = Math.round(v * 1e4) / 1e4; if (nv !== h.price) { h.price = nv; n++; }
        }
        x.bal = B.holdings(x).value; x.synced = x.priced = Date.now();
        return n ? `Updated ${n} price${n === 1 ? '' : 's'}` : 'Prices saved';
      },
      // Holdings you keep by hand in an investment account you added yourself. Its balance becomes their total value.
      'holding.save'(s, a) {
        const x = s.accounts.find(y => y.id === a.acct && !y.other) || bad('That account isn’t there any more.');
        if (!x.manual) bad('This account’s holdings come from your bank.');
        const qty = num(a.qty), price = num(a.price), cost = a.cost === '' || a.cost === undefined ? NaN : num(a.cost);
        const sym = text(a.sym, 12).toUpperCase(), name = text(a.name, 60) || sym;
        if (!name) bad('Give it a name or a symbol, like VFV or Apple.');
        if (!(qty > 0)) bad('Enter how many units you own.');
        if (!(price >= 0)) bad('Enter the price of one unit.');
        x.holdings = x.holdings || [];
        const h = { id: a.id || rid('h'), sym, name, qty: Math.round(qty * 1e6) / 1e6, price: Math.round(price * 1e4) / 1e4, ...(cost > 0 ? { cost: B.round2(cost) } : {}) };
        const i = x.holdings.findIndex(y => y.id === a.id);
        if (a.id && i < 0) bad('That holding isn’t there any more.');
        if (i >= 0) x.holdings[i] = h; else { if (x.holdings.length >= 100) bad('That’s the most holdings one account can have.'); x.holdings.push(h); }
        x.bal = B.holdings(x).value; x.synced = Date.now();
        return i >= 0 ? 'Saved' : `Added ${name}`;
      },
      'holding.delete'(s, a) {
        const x = s.accounts.find(y => y.id === a.acct && !y.other) || bad('That account isn’t there any more.');
        if (!x.manual) bad('This account’s holdings come from your bank.');
        x.holdings = (x.holdings || []).filter(h => h.id !== a.id);
        if (x.holdings.length) x.bal = B.holdings(x).value; else delete x.holdings;
        return 'Removed';
      },
      // For the payoff planner on a card or loan: its yearly interest rate and what you plan to pay each month.
      'account.debt'(s, a) {
        const x = s.accounts.find(y => y.id === a.id && !y.other) || bad('That account isn’t there any more.');
        const apr = num(a.apr), pay = num(a.pay);
        if (a.apr !== undefined && a.apr !== '') { if (!(apr >= 0 && apr <= 60)) bad('Enter an interest rate from 0 to 60%.'); x.apr = apr; }
        if (a.pay !== undefined && a.pay !== '') { if (!(pay >= 0)) bad('Enter what you pay each month.'); if (pay) x.pay = pay; else delete x.pay; }
        return 'Saved'; },
      'bill.hide'(s, a) { const k = B.norm(a.m); if (k && !s.hiddenBills.includes(k)) s.hiddenBills.push(k); return 'Hidden. It won’t show as a bill any more.'; },
      'guide.set'(s, a) { if (!['luffy', 'hancock', 'none'].includes(a.guide)) bad('Pick a guide.'); s.guide = a.guide; return ''; },
      'csv.import'(s, a) {
        const rows = B.parseCsv(String(a.text || '').slice(0, 2e6));
        if (!rows.length) bad('No rows found. Each row needs a date, a description and an amount.');
        let acct = s.accounts.find(x => x.id === a.acct && x.csv);
        if (!acct) { acct = { id: rid('csv'), name: text(a.name, 40) || 'Imported account', inst: 'CSV', type: 'Imported', mask: '', bal: 0, shared: false, csv: true, synced: Date.now() }; s.accounts.push(acct); }
        // How many of each day, amount and name are here already. The same file again (or one that overlaps) adds nothing
        // twice, while two coffees for the same amount on the same day in one file both come in. The key is kept on each
        // charge, so renaming or splitting it later doesn't make it look new.
        const key = (d, a, m) => d + '|' + a + '|' + B.norm(m), have = new Map(), used = new Map();
        for (const t of s.txns) if (t.acct === acct.id && !t.splitOf) { const k = t.csvKey || key(t.date, t.orig ? t.orig.a : t.a, t.m); have.set(k, (have.get(k) || 0) + 1); }
        let n = 0;
        for (const r of rows) {
          const k = key(r.date, r.a, r.m), u = (used.get(k) || 0) + 1; used.set(k, u); if (u <= (have.get(k) || 0)) continue;
          s.txns.push(B.convertTxn(s, { id: rid('c'), date: r.date, acct: acct.id, m: r.m, a: r.a, c: B.pickCat(s, r.m, r.a > 0 ? 'income' : null), note: '', fresh: true, csv: true, csvKey: k }, acct.cur));
          n++;
        }
        s.seenNew = 0;
        B.matchTransfers(s);
        return n ? `Imported ${n} transaction${n === 1 ? '' : 's'}${rows.length > n ? ` (${rows.length - n} already there)` : ''}` : 'Those were all imported already.';
      },
      // Budgets from what you spent last month, rounded up to the next $10. Keeps any you already set.
      'budget.suggest'(s) {
        const last = B.prevYm(B.ymOf(today()));
        let n = 0;
        for (const c of B.CAT_IDS) {
          if (B.NOT_SPENDING.includes(c) || s.budgets[c]) continue;
          const v = B.spent(s, c, last);
          if (v > 0) { s.budgets[c] = Math.ceil(v / 10) * 10; n++; }
        }
        return n ? `Suggested ${n} budget${n === 1 ? '' : 's'} from last month. Tap one to change it.` : 'Nothing to suggest yet. Budgets come from last month’s spending.';
      },
      'sample.load'(s) {
        if (s.txns.length || s.accounts.length) bad('Sample data only goes into an empty budget.');
        Object.assign(s, sample(today()));
        return 'Sample data added. Remove it any time in Settings.';
      },
      'sample.clear'(s) {
        s.accounts = s.accounts.filter(a => !a.sample);
        const keep = new Set(s.accounts.map(a => a.id).concat('cash'));
        s.txns = s.txns.filter(t => keep.has(t.acct) && !/^s\d/.test(t.id));
        s.goals = s.goals.filter(g => !/^g\d$/.test(g.id));
        // Budgets, rules and pay that came with the sample go too, unless you changed them.
        const ex = sample(today());
        for (const [c, v] of Object.entries(ex.budgets)) if (s.budgets[c] === v) { delete s.budgets[c]; if (s.rollover[c] === ex.rollover[c]) delete s.rollover[c]; }
        s.rules = s.rules.filter(r => !ex.rules.some(x => x.match === r.match && x.cat === r.cat));
        if (s.rates && s.rates.USD === ex.rates.USD && !s.accounts.some(a => a.cur === 'USD')) delete s.rates.USD;
        if (s.expectIncome === ex.expectIncome) s.expectIncome = 0;
        if (s.worthHist) for (const k of Object.keys(ex.worthHist)) if (s.worthHist[k] === ex.worthHist[k]) delete s.worthHist[k];
        if (!s.accounts.length) s.worthHist = {};
        delete s.sample;
        return 'Sample data removed';
      }
    };
    return { OPS, num, text, bad };
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = makeOps; else root.makeBudgetOps = makeOps;
})(typeof window !== 'undefined' ? window : this);
