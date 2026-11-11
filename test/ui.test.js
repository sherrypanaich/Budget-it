// The page itself: fits a phone, works with a keyboard, and reads like the rest of the app. Run with: node --test
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const read = f => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
const PAGE = read('index.html');
const css = PAGE.slice(PAGE.indexOf('<style>'), PAGE.indexOf('</style>'));
const between = (a, b) => { const i = PAGE.indexOf(a); assert.ok(i >= 0, 'found ' + a); return PAGE.slice(i, PAGE.indexOf(b, i)); };

test('the Activity search box can shrink, so Select never pushes the page sideways on a phone', () => {
  assert.match(css, /\.search\{[^}]*min-width:0/);
  assert.match(PAGE, /<label class="search" style="flex:1">/);
});

test('boxes that hide their own outline show one around them when the keyboard is in them', () => {
  for (const box of ['quick', 'search', 'amtin']) {
    assert.match(css, new RegExp(`\\.${box} input\\{[^}]*outline:none`), box + ' input hides its outline');
    assert.match(css, new RegExp(`\\.${box}:has\\(input:focus-visible\\)[^{]*\\{[^}]*outline:3px`), box + ' shows one instead');
  }
  for (const f of ['login.html', 'join.html']) assert.match(read(f), /button:focus-visible,a:focus-visible\{outline:3px/, f);
});

test('a keyboard reaches the receipt photo button, and Tab inside a sheet counts toggles and text boxes', () => {
  const sheet = between('function editTxn(', '\n}\n');
  assert.match(sheet, /<button class="btn sm" type="button" id="rpBtn">/);
  assert.doesNotMatch(sheet, /<label class="btn/, 'a label is not a button for a keyboard');
  assert.match(sheet, /#rpBtn'\)\.onclick = \(\) => root\.querySelector\('#rp'\)\.click\(\)/);
  assert.match(sheet, /confirmTap\(rr, /, 'removing a receipt photo takes a second tap');
  const trap = between("if (e.key === 'Tab')", '\n  }\n');
  for (const k of ['summary', 'textarea', 'select', 'a[href]']) assert.ok(trap.includes('.sheet ' + k), k);
});

test('a row without an icon gives its text the room, not the 42px icon column', () => {
  assert.match(css, /\.row\.noic\{grid-template-columns:minmax\(0,1fr\) auto\}/);
  assert.match(between('function trendSheet(', '\n}\n'), /class="row noic"/);
});

test('when the laptop can’t be reached, sheets say so in plain words, not “Failed to fetch”', async () => {
  const code = between('async function call(', '\n}\n') + '\n}';
  const ctx = vm.createContext({ fetch: async () => { throw new TypeError('Failed to fetch'); } });
  vm.runInContext(code + '\n;this.call = call;', ctx);
  await assert.rejects(ctx.call('/api/account'), { message: 'Couldn’t reach the laptop. Check your connection and try again.' });
  ctx.fetch = async () => ({ ok: false, json: async () => ({ error: 'That tag is taken.' }) });
  await assert.rejects(ctx.call('/api/account/tag', { tag: 'x' }), { message: 'That tag is taken.' }, 'the laptop’s own words still come through');
});

test('signing someone out from the owner page takes a second tap, like signing out everywhere', () => {
  assert.match(between('function personSheet(', '\n}\n'), /ppOut\.onclick = \(\) => \{ if \(!confirmTap\(ppOut\.querySelector\('b'\)/);
});

test('the guides and the everyday words use curly apostrophes and quotes', () => {
  const words = [between('const LINES = {', '} };'), between('<p class="qhint">', '</p>'), between('function addSheet(', '\n}\n'), between('function editTxn(', '\n}\n'),
    between('function csv(', '\n}\n'), between('function billForm(', '\n}\n'), between('function plaid(', '\n}\n'), between('function settings(', '\n}\n')];
  for (const w of words) assert.doesNotMatch(w.replace(/\/\/[^\n]*/g, ''), /[A-Za-z]'[A-Za-z]/, w.slice(0, 40));
  assert.doesNotMatch(between('<p class="qhint">', '</p>').slice(17), /"/);
});

test('the Accounts page names the same assistants as Settings and links to setting one up', () => {
  const side = between('const side = `${worthChart(nw)}', '</div>\n');
  assert.match(side, /Ask Claude, Muse or ChatGPT/);
  assert.match(side, /data-act="assistants">Set up</);
  assert.match(PAGE, /Connect Claude, Muse or ChatGPT to your budget/);
});

test('a bank that needs you says so in full on the Accounts page', () => {
  assert.match(between('function accounts(', '\n}\n'), /<small\$\{it\.error \? ' style="white-space:normal"' : ''\}>/);
});

test('picked charges are named in the sheet titles', () => {
  assert.match(PAGE, /<h3>Move \$\{picked\.size\} charge\$\{picked\.size === 1 \? '' : 's'\} to<\/h3>/);
  assert.match(PAGE, /<h3>Tag \$\{picked\.size\} charge\$\{picked\.size === 1 \? '' : 's'\}<\/h3>/);
});
