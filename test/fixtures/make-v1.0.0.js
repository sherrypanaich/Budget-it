// Makes test/fixtures/v1.0.0: a data folder written by Budget it 1.0.0 itself, for test/upgrade.test.js.
// Everything in it is made up: two people (Ana, Ben), sample data, an AI assistant key and an OAuth sign-in.
//   git archive 7867305 | tar -x -C /some/empty/folder
//   node test/fixtures/make-v1.0.0.js /some/empty/folder
'use strict';
const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OLD = path.resolve(process.argv[2] || '');
if (!fs.existsSync(path.join(OLD, 'server.js')) || !/VERSION = '1\.0\.0'/.test(fs.readFileSync(path.join(OLD, 'server.js'), 'utf8'))) {
  console.error('Usage: node test/fixtures/make-v1.0.0.js FOLDER-WITH-BUDGET-IT-1.0.0'); process.exit(1);
}
const OUT = path.join(__dirname, 'v1.0.0');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-it-v100-'));
const PORT = 20000 + Math.floor(Math.random() * 20000);
const env = { ...process.env, DATA_DIR: DATA, PORT: String(PORT), HOST: '127.0.0.1', UPDATE_CHECK: 'off', PUBLIC_URL: '', RESEND_API_KEY: '', GOOGLE_CLIENT_ID: '',
  PLAID_CLIENT_ID: '', PLAID_SECRET: '', SPLIT_IT_URL: '', BACKUP_COPY_DIR: '', BACKUP_PASSPHRASE: '' };
const cli = (args, input = '') => spawnSync(process.execPath, [path.join(OLD, 'server.js'), ...args], { env, input, encoding: 'utf8', cwd: DATA });
const base = `http://127.0.0.1:${PORT}`;

async function signIn(name, password) {
  const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, password }) });
  if (!r.ok) throw new Error('sign-in failed for ' + name);
  return r.headers.get('set-cookie').split(';')[0];
}
const op = async (cookie, o, args) => {
  const r = await fetch(base + '/api/op', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ op: o, args }) });
  const j = await r.json(); if (!r.ok) throw new Error(o + ': ' + j.error); return j;
};

(async () => {
  for (const n of ['Ana', 'Ben']) cli(['add-user', n], `${n.toLowerCase()}-password\n${n.toLowerCase()}-password\n`);
  cli(['sample', 'Ana']);
  const app = spawn(process.execPath, [path.join(OLD, 'server.js')], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise(ok => app.stdout.on('data', d => /running at/.test(d) && ok()));
  try {
    const ana = await signIn('Ana', 'ana-password'), ben = await signIn('Ben', 'ben-password');
    // 1.0 shared with everyone or nobody: Ana's sample chequing account is shared, and so is a cash box she adds
    const s = await op(ana, 'account.add', { name: 'Cash box', type: 'Cash', bal: 120 });
    await op(ana, 'account.share', { id: s.state.accounts.find(a => a.name === 'Cash box').id, shared: true });
    await op(ben, 'txn.add', { amount: 12.5, m: 'Coffee beans', date: '2026-11-01' });
    const invite = await (await fetch(base + '/api/invite', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ana }, body: '{}' })).json();
    // an AI assistant key for Ana (handed to the running app), and an assistant signed in over OAuth as Ben
    const key = /\b(bik_\S+)/.exec(cli(['mcp-key', 'Ana']).stdout)[1];
    const reg = await (await fetch(base + '/oauth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'Test assistant', redirect_uris: ['https://assistant.example/callback'] }) })).json();
    const verifier = crypto.randomBytes(32).toString('base64url'), challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const auth = await fetch(base + '/oauth/authorize', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: reg.client_id, redirect_uri: 'https://assistant.example/callback', response_type: 'code', code_challenge: challenge,
        code_challenge_method: 'S256', state: 's', name: 'Ben', password: 'ben-password' }) });
    const code = new URL(auth.headers.get('location')).searchParams.get('code');
    const tok = await (await fetch(base + '/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: reg.client_id, redirect_uri: 'https://assistant.example/callback' }) })).json();
    // a full backup, written by 1.0 while it runs (1.0 backs up what's on disk: give it a moment to write the last changes)
    await new Promise(ok => setTimeout(ok, 1500));
    const b = cli(['backup', path.join(DATA, 'backup.zip')], '\n'); if (!fs.existsSync(path.join(DATA, 'backup.zip'))) throw new Error('backup: ' + b.stdout + b.stderr);
    fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(path.join(OUT, 'data'), { recursive: true });
    await new Promise(ok => { app.on('exit', ok); app.kill(); });
    for (const f of ['db.json', 'users.json', 'oauth.json', 'push-keys.json']) if (fs.existsSync(path.join(DATA, f))) fs.copyFileSync(path.join(DATA, f), path.join(OUT, 'data', f));
    fs.copyFileSync(path.join(DATA, 'backup.zip'), path.join(OUT, 'backup.zip'));
    fs.writeFileSync(path.join(OUT, 'made-up-sign-ins.json'), JSON.stringify({ note: 'Fake test sign-ins made by Budget it 1.0.0 for test/upgrade.test.js',
      passwords: { Ana: 'ana-password', Ben: 'ben-password' }, cookies: { Ana: ana, Ben: ben }, invite: invite.token, mcpKey: key,
      oauth: { client_id: reg.client_id, access_token: tok.access_token, refresh_token: tok.refresh_token } }, null, 2) + '\n');
    console.log('Wrote', OUT);
  } finally { if (app.exitCode === null) app.kill(); fs.rmSync(DATA, { recursive: true, force: true }); }
})().catch(e => { console.error(e); process.exit(1); });
