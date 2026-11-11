// The assistant tools (mcp.js) as an assistant uses them, on the sample budget: the numbers match the app's,
// answers say the currency, words like "yesterday" and "last month" work, odd input gets a clear error instead of
// a quiet guess, and nobody else's data comes back. Run with: node --test test/*.test.js
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const B = require('../budget');

const SERVER = path.join(__dirname, '..', 'server.js');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-it-assistant-'));
let PORT, proc, env, key, mikaKey, sherry, mika;
const freePort = () => new Promise(res => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const cli = (args, input = '') => spawnSync(process.execPath, [SERVER, ...args], { env, input, encoding: 'utf8' }).stdout;
let n = 0;
async function as(name, password) {
  const from = '10.5.0.' + ++n; let cookie = '';
  const call = async (method, url, body) => {
    const r = await fetch(`http://127.0.0.1:${PORT}${url}`, { method, headers: { 'X-Forwarded-For': from, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = r.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    return { status: r.status, data: await r.json().catch(() => null) };
  };
  assert.equal((await call('POST', '/api/login', { name, password })).status, 200);
  return { state: async () => (await call('GET', '/api/state')).data.state, op: (op, args) => call('POST', '/api/op', { op, args }) };
}
const rpc = async (k, method, params) => { const j = await (await fetch(`http://127.0.0.1:${PORT}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + k, 'X-Forwarded-For': '10.5.1.1' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json(); assert.ok(j.result, JSON.stringify(j)); return j.result; };
const tool = async (name, args = {}, k = key) => { const r = await rpc(k, 'tools/call', { name, arguments: args }); return { text: r.content[0].text, error: !!r.isError }; };
const ok = async (name, args, k) => { const r = await tool(name, args, k); assert.ok(!r.error, `${name} ${JSON.stringify(args)}: ${r.text}`); return r.text; };
const fails = async (name, args, re) => { const r = await tool(name, args); assert.ok(r.error, `${name} ${JSON.stringify(args)} should fail: ${r.text}`); assert.match(r.text, re); return r.text; };
const $ = v => (v < 0 ? '-' : '') + '$' + Math.abs(v).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const day = (n = 0) => { const d = new Date(Date.now() + n * 864e5), p = x => String(x).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };

before(async () => {
  PORT = await freePort();
  env = { ...process.env, DATA_DIR: path.join(DIR, 'data'), PORT: String(PORT), HOST: '127.0.0.1', PLAID_CLIENT_ID: '', PLAID_SECRET: '', UPDATE_CHECK: 'off', RESEND_API_KEY: '', GOOGLE_CLIENT_ID: '', PUBLIC_URL: '', BACKUP_COPY_DIR: '', BACKUP_PASSPHRASE: '' };
  cli(['add-user', 'Sherry'], 'password123\n'); cli(['add-user', 'Mika'], 'password456\n');
  cli(['sample', 'Sherry']);
  proc = spawn(process.execPath, [SERVER], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((res, rej) => { proc.stdout.on('data', d => /running at/.test(d) && res()); proc.on('exit', c => rej(new Error('server exited ' + c))); });
  key = /(bik_[A-Za-z0-9_-]+)/.exec(cli(['mcp-key', 'Sherry']))[1]; mikaKey = /(bik_[A-Za-z0-9_-]+)/.exec(cli(['mcp-key', 'Mika']))[1];
  sherry = await as('Sherry', 'password123'); mika = await as('Mika', 'password456');
});
after(async () => {
  if (proc) { const gone = new Promise(r => proc.on('exit', r)); proc.kill(); await gone; }
  fs.rmSync(DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test('the numbers are the app’s own, and the answer says they’re Canadian dollars', async () => {
  const s = await sherry.state(); B.useCats(s);
  const ym = B.ymOf(day()), last = B.prevYm(ym);
  const has = (x, part) => assert.ok(x.includes(part), `${part} in:\n${x}`);
  let x = await ok('spending_summary', {});
  has(x, `Money out: ${$(B.moneyOut(s, ym))}`); assert.match(x, /\(Amounts are in CAD\.\)$/);
  has(await ok('spending_summary', { month: 'last month' }), `${last}\nMoney in: ${$(B.moneyIn(s, last))}`);
  x = await ok('budget_status', {});
  has(x, `${ym}: ${$(B.totals(s, ym).left)} left of ${$(B.totals(s, ym).limit)}`);
  assert.ok(!/OVER \(\$0\.00\/day\)/.test(x), 'no “per day” on a budget that’s already over');
  has(await ok('safe_to_spend', {}), `: ${$(B.safeToSpend(s, day()).amount)}, about`);
  assert.match(await ok('get_balances', {}), /"US Dollar Account" .*: 640\.00 USD \(about \$[\d,.]+ CAD\)[\s\S]*Net worth: \$[\d,.]+ CAD/);
  assert.match(await ok('spending_summary', {}), /\(\d+ charges?\)/, 'the top places say how many charges');
});

test('dates, months and amounts the way people say them', async () => {
  let x = await ok('add_cash_purchase', { amount: '12.50', what: 'Farmers market', category: 'Groceries', date: 'yesterday' });
  assert.match(x, new RegExp(`Added "Farmers market": 12\\.50 CAD on ${day(-1)}, in Groceries`));
  x = await ok('add_cash_purchase', { amount: '$1,200', what: 'Couch', category: 'shop' });
  assert.match(x, /1,200\.00 CAD on .*, in Shopping/);
  await fails('add_cash_purchase', { amount: '12,50', what: 'Bake sale' }, /dot for cents: 12\.50, not 12,50/);
  await fails('add_cash_purchase', { amount: 'twelve', what: 'Bake sale' }, /amount has to be a number/);
  await fails('add_cash_purchase', { amount: -5, what: 'Refund' }, /more than 0/);
  await fails('add_cash_purchase', { amount: 3, what: 'Coffee', date: '2026-02-31' }, /date has to be a day like/);
  await fails('add_cash_purchase', { amount: 3, what: 'Coffee', date: 'last tuesday' }, /“today” or “yesterday”/);
  await fails('add_cash_purchase', { amount: 3, what: 'Coffee', date: day(3) }, /can’t be after today/);
  assert.ok(!(await sherry.state()).txns.some(t => ['Bake sale', 'Refund', 'Coffee'].includes(t.m)), 'none of those were added');
  // months
  const oct = (+day().slice(5, 7) >= 10 ? day().slice(0, 4) : +day().slice(0, 4) - 1) + '-10';
  assert.match(await ok('spending_summary', { month: 'October' }), new RegExp('^' + oct));
  assert.match(await ok('list_transactions', { month: 'this month', search: 'farmers' }), /"Farmers market"/);
  await fails('list_transactions', { month: 'yesterday' }, /month has to be a month like/);
  await fails('budget_status', { month: '2026-13' }, /month has to be a month like/);
  assert.match(await ok('year_review', { year: 'last year' }), /No spending in \d{4}/);
  await fails('year_review', { year: 'twenty' }, /year has to be like/);
  assert.match(await ok('month_report', { month: '2020-01' }), /No transactions in 2020-01 in Budget it/);
  // goals and budgets
  await fails('create_goal', { name: 'Car', target: 8000, by: 'next summer' }, /by has to be a month/);
  await fails('create_goal', { name: 'Car', target: 8000, by: '2020-05' }, /this month .* or later/);
  const june = (+day().slice(5, 7) <= 6 ? day().slice(0, 4) : +day().slice(0, 4) + 1) + '-06';
  assert.match(await ok('create_goal', { name: 'Car', target: '8000', by: 'June' }), new RegExp(`8,000\\.00 CAD\\. .* finish by ${june}`));
  await fails('add_to_goal', { goal: '', amount: 5 }, /No goal called that/);
  await fails('add_to_goal', { goal: 'car', amount: 0 }, /can’t be 0/);
  assert.match(await ok('add_to_goal', { goal: 'car', amount: '250' }), /Added 250\.00 CAD to "Car"/);
  await fails('set_budget', { category: 'income', amount: 10 }, /Budgets are for spending categories\. One of: .*health \(Health\)\.$/);
  assert.match(await ok('set_budget', { category: 'Fun', amount: '150' }), /150\.00 CAD a month/);
  await fails('set_category', { id: 'nope', category: 'fun' }, /No transaction has the id "nope"/);
  await fails('payoff_plan', { months: 0, apr: 20 }, /months has to be a whole number/);
  assert.match(await ok('payoff_plan', { payment: '100', apr: '19.99' }), /^"Cash Back Visa": paying \$100\.00 a month clears/);
  assert.match(await ok('refresh_banks', {}), /No banks are connected/);
});

test('another home currency never shows as dollars', async () => {
  await mika.op('money.home', { home: 'EUR' });
  await ok('add_cash_purchase', { amount: 4, what: 'Croissant', category: 'dining' }, mikaKey);
  await ok('set_budget', { category: 'dining', amount: 100 }, mikaKey);
  for (const name of ['spending_summary', 'budget_status', 'list_transactions']) {
    const x = await ok(name, {}, mikaKey);
    assert.ok(!/\$/.test(x) && /4\.00 EUR/.test(x), `${name}: ${x}`);
  }
});

test('the category lists are the person’s own, and nobody else’s data comes back', async () => {
  await sherry.op('cat.add', { name: 'Pets' });
  const list = (await rpc(key, 'tools/list')).tools;
  assert.match(list.find(t => t.name === 'set_category').inputSchema.properties.category.description, /\(Pets\)/);
  assert.ok(!/income|transfer/.test(list.find(t => t.name === 'set_budget').inputSchema.properties.category.description), 'budgets only take spending categories');
  assert.ok(!/Pets/.test((await rpc(mikaKey, 'tools/list')).tools.find(t => t.name === 'set_category').inputSchema.properties.category.description));
  assert.match(await ok('add_cash_purchase', { amount: 9, what: 'Vet', category: 'pets' }), /in Pets/);
  // Mika's own spending and accounts stay hers, shared with Sherry or not
  await mika.op('account.add', { name: 'Mika joint', type: 'Chequing', bal: 999 });
  const acct = (await mika.state()).accounts.find(a => a.name === 'Mika joint');
  await mika.op('account.share', { id: acct.id, with: [Object.keys(JSON.parse(fs.readFileSync(path.join(DIR, 'data', 'users.json'), 'utf8')).users).find(id => (JSON.parse(fs.readFileSync(path.join(DIR, 'data', 'users.json'), 'utf8')).users[id].name === 'Sherry'))] });
  for (const [name, args] of [['list_transactions', { search: 'croissant' }], ['get_balances', {}], ['year_review', {}], ['spending_summary', {}]]) {
    const x = await ok(name, args);
    assert.ok(!/Croissant|Mika joint|EUR/.test(x), `${name} shows only Sherry’s: ${x}`);
  }
});

test('every tool’s schema lists what it takes, and a read-only key gets only the looking ones', async () => {
  const list = (await rpc(key, 'tools/list')).tools;
  for (const t of list) {
    assert.equal(t.inputSchema.type, 'object', t.name);
    for (const r of t.inputSchema.required || []) assert.ok(t.inputSchema.properties[r], `${t.name} requires ${r}, which it describes`);
  }
  assert.ok(list.find(t => t.name === 'year_review').inputSchema.properties.year.type.includes('string'), 'year takes “last year” too');
  const ro = /(bik_[A-Za-z0-9_-]+)/.exec(cli(['mcp-key', 'Sherry', '--read-only']))[1];
  const names = (await rpc(ro, 'tools/list')).tools.map(t => t.name);
  assert.deepEqual(names.sort(), list.filter(t => t.annotations.readOnlyHint).map(t => t.name).sort());
  const r = await tool('set_budget', { category: 'fun', amount: 1 }, ro);
  assert.ok(r.error && /read only/.test(r.text));
});
