// Talking to Plaid, with no extra packages.
// Plaid brings in balances and transactions, read only. Budget it never sees bank passwords:
// people sign in to their bank inside Plaid Link, and we get an access token for that bank.
//
// Settings (budget-it.env):
//   PLAID_CLIENT_ID, PLAID_SECRET   from dashboard.plaid.com > Developers > Keys
//   PLAID_ENV                       sandbox (the fake test bank, the default) or production
//   PLAID_COUNTRIES                 default CA,US
//   PLAID_REDIRECT_URI              optional. Some banks approve the connection in their own app or site and then need an
//                                   address to send people back to: your PUBLIC_URL followed by /plaid/return. It must be
//                                   https and listed under Allowed redirect URIs in the Plaid dashboard, or Plaid refuses it.
//   PLAID_URL                       only for tests: a fake Plaid to talk to
//
// Access tokens are encrypted (AES-256-GCM) before they're saved. The key is BUDGET_IT_KEY if set,
// otherwise data/secret.key, created on first run and readable only by you.
'use strict';
const fs = require('fs');
const crypto = require('crypto');

module.exports = function makePlaid({ keyFile }) {
  const env = k => (process.env[k] || '').trim();
  const ID = env('PLAID_CLIENT_ID'), SECRET = env('PLAID_SECRET');
  const ENV = (env('PLAID_ENV') || 'sandbox').toLowerCase();
  const URL = env('PLAID_URL') || `https://${ENV === 'production' ? 'production' : 'sandbox'}.plaid.com`;
  const COUNTRIES = (env('PLAID_COUNTRIES') || 'CA,US').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  const configured = !!(ID && SECRET);
  // Only an https address is ever sent to Plaid; anything else is ignored with a note in the log.
  const rawBack = env('PLAID_REDIRECT_URI');
  const redirect = /^https:\/\/[^\s/]+\/plaid\/return$/.test(rawBack) ? rawBack : '';
  if (rawBack && !redirect) console.error('PLAID_REDIRECT_URI is ignored: it has to look like https://your-address/plaid/return');

  // ---------- encryption for access tokens ----------
  let key;
  // The key file, or null when there is none yet. A file that is there but can't be read or is damaged throws:
  // making a new key in its place would lock every bank connection away for good.
  function readKeyFile() {
    let raw; try { raw = fs.readFileSync(keyFile, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw Object.assign(new Error(`Can’t read ${keyFile} (${e.code || e.message})`), { code: 'BAD_KEY' }); }
    const k = Buffer.from(raw.trim(), 'base64');
    if (k.length !== 32 || !/^[A-Za-z0-9+/]+=*$/.test(raw.trim())) throw Object.assign(new Error(`${keyFile} is damaged`), { code: 'BAD_KEY' });
    return k;
  }
  function getKey() {
    if (key) return key;
    const fromEnv = env('BUDGET_IT_KEY');
    if (fromEnv) { key = crypto.createHash('sha256').update(fromEnv).digest(); return key; }
    const found = readKeyFile(); if (found) return (key = found);
    // Only when there is no file at all: 'wx' never writes over one that appeared in the meantime.
    const fresh = crypto.randomBytes(32);
    try { fs.writeFileSync(keyFile, fresh.toString('base64'), { mode: 0o600, flag: 'wx' }); }
    catch (e) { if (e.code === 'EEXIST') return getKey(); try { if (!fs.readFileSync(keyFile, 'utf8').trim()) fs.unlinkSync(keyFile); } catch {} throw e; }
    return (key = fresh);
  }
  // Why the key can't be used (a message), or null when it's fine or not made yet.
  const keyProblem = () => { if (env('BUDGET_IT_KEY')) return null; try { readKeyFile(); return null; } catch (e) { return e.message; } };
  const forgetKey = () => { key = null; };   // after a restore put a different secret.key in place
  function seal(text) {
    const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
    const enc = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
    return 'v1:' + Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
  }
  function open(box) {
    const b = Buffer.from(String(box).replace(/^v1:/, ''), 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', getKey(), b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
  }

  // ---------- API calls ----------
  // Errors that mean the bank needs the person to sign in again in Plaid Link (update mode). Nothing else fixes them.
  const LOGIN = new Set(['ITEM_LOGIN_REQUIRED', 'PENDING_EXPIRATION', 'PENDING_DISCONNECT', 'ITEM_LOCKED', 'USER_SETUP_REQUIRED', 'INVALID_CREDENTIALS', 'INVALID_MFA', 'INVALID_UPDATED_USERNAME']);
  const needsLogin = code => LOGIN.has(code);
  async function call(endpoint, body) {
    if (!configured) throw Object.assign(new Error('Plaid isn’t set up yet. Add PLAID_CLIENT_ID and PLAID_SECRET to budget-it.env, then restart.'), { code: 'NOT_CONFIGURED' });
    let r;
    try {
      r = await fetch(URL + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_id: ID, secret: SECRET, ...body }), signal: AbortSignal.timeout(30000) });
    } catch (e) { throw Object.assign(new Error('Couldn’t reach Plaid. Check the laptop’s internet connection.'), { code: 'NETWORK' }); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const code = j.error_code || 'PLAID_ERROR';
      const msg = LOGIN.has(code) ? 'Your bank wants you to sign in again. Tap Reconnect.'
        : j.display_message || j.error_message || `Plaid said no (${code}).`;
      throw Object.assign(new Error(msg), { code, status: r.status });
    }
    return j;
  }
  // A new connection asks for up to two years of history (730 days is Plaid's most); banks send what they have.
  const linkToken = (uid, accessToken) => call('/link/token/create', {
    client_name: 'Budget it', language: 'en', country_codes: COUNTRIES, user: { client_user_id: uid }, ...(redirect ? { redirect_uri: redirect } : {}),
    ...(accessToken ? { access_token: accessToken } : { products: ['transactions'], optional_products: ['investments'], transactions: { days_requested: 730 } })
  }).then(j => j.link_token);
  const exchange = publicToken => call('/item/public_token/exchange', { public_token: publicToken });
  const accounts = accessToken => call('/accounts/get', { access_token: accessToken });
  const remove = accessToken => call('/item/remove', { access_token: accessToken });
  // What an investment account holds. Banks without investments (or before you allow it) answer with an error, which is fine.
  // Bills and subscriptions Plaid found. Needs the Recurring Transactions product; without it Plaid says no, which is fine.
  const recurring = accessToken => call('/transactions/recurring/get', { access_token: accessToken, options: { include_personal_finance_category: true } });
  const holdings = accessToken => call('/investments/holdings/get', { access_token: accessToken });
  // All changes since the cursor: { added, modified, removed, cursor }. Follows has_more for you.
  async function sync(accessToken, cursor, retried) {
    const added = [], modified = [], removed = [];
    let next = cursor || undefined, guard = 0;
    for (;;) {
      let j;
      try { j = await call('/transactions/sync', { access_token: accessToken, cursor: next, count: 500, options: { include_personal_finance_category: true } }); }
      catch (e) { if (e.code === 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION' && !retried) return sync(accessToken, cursor, true); throw e; }
      added.push(...(j.added || [])); modified.push(...(j.modified || [])); removed.push(...(j.removed || []));
      next = j.next_cursor;
      if (!j.has_more || ++guard > 50) break;
    }
    return { added, modified, removed, cursor: next };
  }
  return { configured, env: ENV, redirect, needsLogin, forgetKey, keyProblem, seal, open, linkToken, exchange, accounts, remove, holdings, recurring, sync };
};
