// Installing and running it: the settings the code reads are the ones the docs list, budget-it.env is read the way
// the example promises, and the laptop commands still work after the app was killed (a stale data/server.lock).
// Run with: node --test test/*.test.js
'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-it-install-'));
after(() => fs.rmSync(DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

const CODE = ['server.js', 'accounts.js', 'plaid.js', 'mcp.js', 'push.js', 'budget.js', 'ops.js'].map(read).join('\n');
const used = new Set([...CODE.matchAll(/process\.env\.([A-Z][A-Z0-9_]+)|\benv\('([A-Z][A-Z0-9_]+)'\)/g)].map(m => m[1] || m[2]));
used.add('TZ');   // read by Node itself
const EXAMPLE = read('budget-it.env.example');
// a setting line, or a commented-out one (# NAME=value), or one of the names in the tests-only list
const exampleNames = new Set([...EXAMPLE.matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)].map(m => m[1]));
for (const m of EXAMPLE.split('Only for the tests')[1]?.matchAll(/\b([A-Z][A-Z0-9_]+_URL)\b/g) || []) exampleNames.add(m[1]);

test('every setting the code reads is in budget-it.env.example and README, and nothing documented is made up', () => {
  const readme = read('README.md');
  for (const n of used) {
    assert.ok(exampleNames.has(n), `${n} is read by the code but not in budget-it.env.example`);
    assert.match(readme, new RegExp('`' + n + '[`=]'), `${n} is read by the code but not in README.md`);
  }
  for (const n of exampleNames) assert.ok(used.has(n), `budget-it.env.example lists ${n}, which nothing reads`);
});

test('budget-it.env.example works as it is, for a laptop and for Docker', () => {
  // Docker passes an empty line on as an empty value, which would beat the image's own HOST and DATA_DIR
  for (const n of ['HOST', 'DATA_DIR', 'PORT', 'TZ']) assert.doesNotMatch(EXAMPLE, new RegExp('^' + n + '=', 'm'), `${n}= must stay commented out`);
  // a made-up address would send assistants and email links nowhere
  assert.match(EXAMPLE, /^PUBLIC_URL=$/m);
  assert.doesNotMatch(read('budget-it.service'), /^Environment=/m, 'a setting in the service would win over budget-it.env');
});

test('an empty line in budget-it.env counts as not set (TZ= must not mean UTC)', () => {
  const app = path.join(DIR, 'app');
  fs.mkdirSync(app);
  for (const f of ['server.js', 'accounts.js', 'plaid.js', 'mcp.js', 'push.js', 'budget.js', 'ops.js', 'sample.js']) fs.copyFileSync(path.join(ROOT, f), path.join(app, f));
  fs.writeFileSync(path.join(app, 'budget-it.env'), 'TZ=\nPUBLIC_URL=\nSYNC_HOURS=3\n');
  const env = { ...process.env, DATA_DIR: path.join(DIR, 'tz-data'), UPDATE_CHECK: 'off' };
  delete env.TZ; delete env.PUBLIC_URL; delete env.SYNC_HOURS;
  const r = spawnSync(process.execPath, ['-e', "require('./server.js'); console.log(JSON.stringify([process.env.TZ ?? 'unset', process.env.PUBLIC_URL ?? 'unset', process.env.SYNC_HOURS])); process.exit(0)"],
    { cwd: app, env, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(r.stdout.trim().split('\n').pop()), ['unset', 'unset', '3'], r.stderr);
});

test('every laptop command in server.js is in the README, and the app lists them all', () => {
  const header = read('server.js').split("'use strict'")[0];
  const cmds = [...new Set([...header.matchAll(/node server\.js ([a-z-]+)/g)].map(m => m[1]))];
  assert.ok(cmds.length >= 10, String(cmds));
  const readme = read('README.md');
  const env = { ...process.env, DATA_DIR: path.join(DIR, 'cmds'), UPDATE_CHECK: 'off', PLAID_CLIENT_ID: '', PLAID_SECRET: '' };
  const list = spawnSync(process.execPath, [path.join(ROOT, 'server.js'), 'nothing-like-this'], { env, encoding: 'utf8' }).stdout;
  for (const c of cmds) {
    assert.ok(readme.includes(c), `README.md never mentions ${c}`);
    assert.ok(list.includes(c), `the list of commands leaves out ${c}`);
  }
});

test('laptop commands still work after the app was killed and left its server.lock behind', async () => {
  const data = path.join(DIR, 'stale');
  const env = { ...process.env, DATA_DIR: data, UPDATE_CHECK: 'off', PLAID_CLIENT_ID: '', PLAID_SECRET: '', BACKUP_PASSPHRASE: '' };
  const cli = (args, input = '') => spawnSync(process.execPath, [path.join(ROOT, 'server.js'), ...args], { env, input, encoding: 'utf8', cwd: DIR }).stdout;
  assert.match(cli(['add-user', 'Ana'], 'ana-password\n'), /Added Ana/);
  assert.match(cli(['backup', path.join(DIR, 'stale.zip')], '\n'), /Wrote/);
  // a port nothing listens on, and a process that's alive (in Docker, number 1 is always alive)
  const port = await new Promise(res => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
  fs.writeFileSync(path.join(data, 'server.lock'), JSON.stringify({ pid: process.pid, port, token: 'x' }));
  const added = cli(['add-user', 'Ben'], 'ben-password\n');
  assert.match(added, /Added Ben/);
  assert.doesNotMatch(added, /didn’t answer/);
  assert.match(cli(['restore', path.join(DIR, 'stale.zip')]), /^Restored /);
});
