#!/usr/bin/env node
// Budget it server. No dependencies, needs Node 22 or newer.
//
//   node server.js                    start the app (PORT, HOST, DATA_DIR env vars are optional)
//   node server.js add-user NAME      add someone (asks for a password); or send an invite link from the app
//   node server.js set-password NAME  also signs them out everywhere, assistants included
//   node server.js list-users
//   node server.js remove-user NAME   signs them out everywhere and deletes their budget and bank connections
//   node server.js code-off NAME      turn off their sign-in code (they lost the phone with their authenticator app)
//   node server.js sample NAME        fill NAME's budget with made-up sample data to try things out
//   node server.js backup FILE        write a full backup (data and sign-ins); asks for a passphrase to lock it
//   node server.js restore FILE       put a backup back (the app must be stopped); also takes a db-....json copy
// These work while the app is running: the command hands the job to the running app, so it takes effect right away.
//   node server.js mcp-key NAME       a key for an AI assistant (see mcp.js)
//   node server.js mcp-revoke NAME
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const dns = require('dns');
const readline = require('readline');
const zlib = require('zlib');

const VERSION = '1.1.0';
const STARTED = Date.now();

// Optional settings file next to this one: KEY=value per line (see budget-it.env.example).
try {
  for (const line of fs.readFileSync(path.join(__dirname, 'budget-it.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} catch (e) { if (e.code !== 'ENOENT') console.error('Couldn’t read budget-it.env:', e.message); }

const B = require('./budget');
const sample = require('./sample');
const push = require('./push');
const { sessionKey, sessionGet, sessionDrop, migrateSessions, slideSession } = require('./accounts');   // sign-in tokens are kept hashed
const PORT = +process.env.PORT || 8090;
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const PUBLIC = path.join(__dirname, 'public');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const PUSH_FILE = path.join(DATA_DIR, 'push.json');
const PUSH_KEYS_FILE = path.join(DATA_DIR, 'push-keys.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const RECEIPT_DIR = path.join(DATA_DIR, 'receipts');
const PUSH_CONTACT = process.env.PUSH_CONTACT || 'mailto:budget-it@example.com';
const SYNC_HOURS = Math.max(1, +process.env.SYNC_HOURS || 6);
const KEEP_BACKUPS = 30, KEEP_WEEKLY = 52, SESSION_DAYS = 90, UNDO_STEPS = 20;
// A second place for backups that isn't this laptop's data folder: a USB drive, or a folder a sync app
// (Dropbox, Syncthing, Nextcloud...) sends elsewhere. One full backup a day goes there, 14 kept.
// With BACKUP_PASSPHRASE set, those copies are locked with it (they hold the key to the bank connections).
const BACKUP_COPY_DIR = (process.env.BACKUP_COPY_DIR || '').trim() ? path.resolve(process.env.BACKUP_COPY_DIR.trim()) : null;
const BACKUP_PASSPHRASE = process.env.BACKUP_PASSPHRASE || '';
const KEEP_COPIES = 14;
// Plaid's free plan for new accounts lets a client connect 10 banks in production, and removing one doesn't give it back.
const PLAID_LIMIT = Math.max(0, +(process.env.PLAID_ITEM_LIMIT ?? 10) || 0);
// The one Split it this laptop may call when it runs here or on the home network (see splitItOk). Empty: public https only.
const SPLIT_IT_URL = (() => { const v = (process.env.SPLIT_IT_URL || '').trim(); if (!v) return '';
  try { return new URL(v).origin; } catch { console.error('SPLIT_IT_URL isn’t a web address, so it’s ignored.'); return ''; } })();
fs.mkdirSync(BACKUP_DIR, { recursive: true });
const plaid = require('./plaid')({ keyFile: path.join(DATA_DIR, 'secret.key') });

// ---------- storage: plain JSON files, written atomically ----------
// A missing file means a fresh start. A damaged one never does: we fall back to the newest good copy,
// and refuse to start if there is none, so a bad file can't quietly be replaced by an empty budget.
// When a copy was used, data/last-recovery.json says which, so the owner sees it in the app (not just in a log).
const RECOVERY_FILE = path.join(DATA_DIR, 'last-recovery.json');
let recovered = null;
function load(file, empty, fallbacks = []) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return empty; throw e; }
  try { return JSON.parse(text); } catch (e) {
    console.error(`${path.basename(file)} is damaged (${e.message}).`);
    for (const fb of fallbacks) {
      try {
        const data = JSON.parse(fs.readFileSync(fb, 'utf8'));
        const keep = file + '.damaged-' + Date.now();
        fs.renameSync(file, keep); fs.copyFileSync(fb, file);
        console.error(`Restored it from ${path.basename(fb)}. The damaged file was kept as ${path.basename(keep)}.`);
        if (file === DB_FILE) {
          recovered = { file: path.basename(file), from: path.basename(fb), copyAt: fs.statSync(fb).mtimeMs, at: Date.now(), damaged: path.basename(keep) };
          try { fs.writeFileSync(RECOVERY_FILE, JSON.stringify(recovered), { mode: 0o600 }); } catch {}
        }
        return data;
      } catch {}
    }
    console.error(`No good copy found. Budget it won't start, so nothing gets overwritten. Fix or replace ${file}, then start it again.`);
    process.exit(1);
  }
}
// The safety copies of db.json, newest first: daily and weekly ones, one from every start, and one every 6 hours.
const COPY_RE = /^db-(weekly-|start-|6h-)?\d{4}-\d\d-\d\d(T\d{4})?\.json$/;
const copyWhen = f => f.replace(/^db-(weekly-|start-|6h-)?/, '');
const newestBackups = () => { try { return fs.readdirSync(BACKUP_DIR).filter(f => COPY_RE.test(f))
  .sort((a, b) => copyWhen(b).localeCompare(copyWhen(a))).map(f => path.join(BACKUP_DIR, f)); } catch { return []; } };
// A full or failing disk must never take the app down: the write fails, what's in memory stays, it's tried again,
// and the person whose change it was gets told (see durable()). The owner's page shows it too.
const DISK_CODES = new Set(['ENOSPC', 'EDQUOT', 'EIO', 'EROFS', 'EFBIG']);
const diskState = { error: null, since: null, code: null };
const diskMsg = e => e && (e.code === 'ENOSPC' || e.code === 'EDQUOT') ? 'The laptop’s disk is full, so this wasn’t saved.' : `The laptop couldn’t save this (${(e && e.code) || 'write error'}), so it wasn’t saved.`;
const noteDisk = (e, where) => { if (!diskState.error) diskState.since = Date.now(); diskState.error = diskMsg(e); diskState.code = e.code || null; console.error(`Couldn’t write ${where}: ${e.message}`); };
const diskOk = () => { diskState.error = null; diskState.since = null; };
const save = (file, obj) => {
  const tmp = file + '.tmp';
  try {
    const fd = fs.openSync(tmp, 'w', 0o600);
    try { fs.writeSync(fd, JSON.stringify(obj)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
  } catch (e) { try { if (fs.statSync(tmp).isFile()) fs.rmSync(tmp, { force: true }); } catch {} throw e; }   // a half-written .tmp only takes space
};
// db: { people: { uid: state }, items: { itemId: { uid, token (encrypted), cursor, inst, error } } }
let db = load(DB_FILE, { people: {}, items: {} }, newestBackups());
db.people = db.people || {}; db.items = db.items || {};
if (!recovered) try { recovered = JSON.parse(fs.readFileSync(RECOVERY_FILE, 'utf8')); } catch {}
let users = load(USERS_FILE, { users: {}, sessions: {} }, [USERS_FILE + '.bak']);
let pushes = load(PUSH_FILE, { subs: {} }, [PUSH_FILE + '.bak']);
let dbTimer = null, dbDirty = false;
// Never throws: a failed write keeps the change in memory and tries again in 30 seconds.
const flushDb = () => {
  if (dbTimer) { clearTimeout(dbTimer); dbTimer = null; } if (!dbDirty) return;
  try { save(DB_FILE, db); dbDirty = false; diskOk(); }
  catch (e) { noteDisk(e, 'db.json'); dbTimer = setTimeout(flushDb, 30e3); dbTimer.unref?.(); }
};
const saveDb = () => { dbDirty = true; if (!dbTimer) dbTimer = setTimeout(flushDb, 400); };
// For a change someone is waiting on: write it now, and tell them when that didn't work.
const durable = () => { if (dbDirty) flushDb(); if (dbDirty && diskState.error) throw Object.assign(new Error(diskState.error), { status: 507 }); };
const saveLater = (file, get) => { let t = null; const go = () => { t = null; try { save(file, get()); } catch (e) { noteDisk(e, path.basename(file)); t = setTimeout(go, 30e3); t.unref?.(); } }; return () => { if (t) { clearTimeout(t); } go(); }; };
const saveUsers = saveLater(USERS_FILE, () => users);
const savePushes = saveLater(PUSH_FILE, () => pushes);
if (migrateSessions(users)) saveUsers();   // sign-in tokens are kept hashed now; older files are converted once, nobody is signed out
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { flushDb(); process.exit(0); });
process.on('beforeExit', flushDb);

// ---------- one person's budget ----------
const today = () => B.ymd(new Date());
const blank = () => ({ accounts: [], txns: [], budgets: {}, rollover: {}, carry: {}, expectIncome: 0, rules: [], goals: [], hiddenBills: [], myBills: [], cats: [], catNames: {}, dismissed: [], guide: 'luffy', seenNew: 0 });
// Also switches the shared category list to this person's (their own categories and names).
const stateOf = uid => { if (!db.people[uid]) { db.people[uid] = blank(); saveDb(); } const s = db.people[uid]; for (const [k, v] of Object.entries(blank())) if (s[k] === undefined) s[k] = v; B.useCats(s); return s; };
const nameFor = id => users.users[id]?.name || 'Someone';
const rid = (p = '') => p + crypto.randomBytes(8).toString('hex');
const undo = new Map();   // uid -> [snapshots], in memory: undo is for the last few taps, not history

// Who besides its owner can see an account: a list of people. Before 1.1 `shared: true` meant everyone on this
// Budget it; that still reads as everyone until migrateShares turns it into the list of people who were here.
const sharedWith = (a, owner) => Array.isArray(a.shared) ? a.shared.filter(id => id !== owner && users.users[id])
  : a.shared === true ? Object.keys(users.users).filter(id => id !== owner) : [];
function migrateShares() {
  let n = 0;
  for (const [uid, s] of Object.entries(db.people)) for (const a of s.accounts || []) if (a.shared === true) { a.shared = sharedWith(a, uid); n++; }
  if (n) saveDb();
}

// What the page gets: your own budget, plus the accounts other people shared with you by name (view only).
function viewFor(uid) {
  const s = stateOf(uid), t = today();
  const others = [];
  const otherTx = [];
  for (const [id, o] of Object.entries(db.people)) {
    if (id === uid || !users.users[id]) continue;
    for (const a of o.accounts || []) if (sharedWith(a, id).includes(uid)) {
      others.push({ ...a, id: id + ':' + a.id, owner: nameFor(id), other: true, shared: undefined });
      for (const x of o.txns || []) if (x.acct === a.id && !x.hidden && x.date >= B.ymd(new Date(Date.now() - 70 * 864e5))) { const { receipt, tags, ...rest } = x; otherTx.push({ ...rest, id: id + ':' + x.id, acct: id + ':' + a.id, other: true, fresh: false }); }
    }
  }
  const items = Object.entries(db.items).filter(([, i]) => i.uid === uid).map(([id, i]) => ({ id, inst: i.inst, error: i.error || null, syncedAt: i.syncedAt || null }));
  // The other people here, so an account can be shared with some of them by name
  // (everyone on this install, your friends first)
  const fr = friendsOf(uid);
  const people = Object.entries(users.users).filter(([id]) => id !== uid).map(([id, u]) => ({ id, name: u.name, tag: u.tag || null, friend: fr.has(id) }))
    .sort((a, b) => b.friend - a.friend);
  B.useCats(s);
  if (B.noteWorth(s, t)) saveDb();   // one net worth number a month, for the chart on Accounts
  const ownerNotes = users.users[uid]?.owner ? { recovered: recoveryNote(), disk: diskWarning() } : undefined;
  return { me: { id: uid, name: nameFor(uid), owner: !!users.users[uid]?.owner }, today: t, version: VERSION, ownerNotes,
    plaid: { configured: plaid.configured, env: plaid.env, used: plaid.env === 'production' ? (db.plaidUsed || 0) : null, limit: plaid.env === 'production' && PLAID_LIMIT ? PLAID_LIMIT : null, back: !!plaid.redirect }, items, people, splitit: !!db.splitit?.[uid], splititUrl: SPLIT_IT_URL || undefined,
    state: { ...s, accounts: [...s.accounts, ...others], txns: [...s.txns, ...otherTx] } };
}

// ---------- changes the page (and the assistant) can make ----------
const { OPS, num, text, bad } = require('./ops')(B, { today: () => today(), rid, sample });
function applyOp(uid, op, args = {}, inside) {
  if ((op === 'txn.receipt' || op === 'txn.sent' || op === 'txn.share') && !inside) bad('Unknown change: ' + op);
  if (op === 'undo') {
    const st = undo.get(uid) || []; const prev = st.pop();
    if (!prev) bad('Nothing to undo.');
    db.people[uid] = JSON.parse(prev); saveDb(); return { msg: 'Undone' };
  }
  const fn = Object.hasOwn(OPS, op) && OPS[op]; if (!fn) bad('Unknown change: ' + op);
  const s = stateOf(uid);
  const before = JSON.stringify(s), status = B.budgetStatus(s, B.ymOf(today()), today());
  let msg = fn(s, args);
  if (op === 'account.share') {   // only people who are really here, never yourself; and say who can see it now
    const x = s.accounts.find(y => y.id === args.id); x.shared = sharedWith(x, uid);
    msg = x.shared.length ? 'Shared with ' + x.shared.map(nameFor).join(', ') : 'Only you can see it now';
  }
  if (JSON.stringify(s) !== before) {
    const u = undo.get(uid) || []; u.push(before); if (u.length > UNDO_STEPS) u.shift(); undo.set(uid, u);
    saveDb();
    nudge(uid, status).catch(() => {});
  }
  return { msg };
}

// ---------- Plaid ----------
const plaidAcctType = a => a.type === 'credit' ? 'Credit card' : a.type === 'loan' ? 'Loan' : a.type === 'investment' ? 'Investment' : a.subtype === 'savings' ? 'Savings' : 'Chequing';
async function connectItem(uid, publicToken, inst, instId) {
  const ex = await plaid.exchange(publicToken);
  if (!db.items[ex.item_id]) db.plaidUsed = (db.plaidUsed || 0) + 1;   // counted even if it is disconnected later: Plaid counts it that way too
  db.items[ex.item_id] = { uid, token: plaid.seal(ex.access_token), cursor: null, inst: text(inst || 'Bank', 40), ...(instId ? { instId: text(instId, 40) } : {}), at: Date.now() };
  saveDb();
  // The bank is connected even if the first update fails; the error shows on the Accounts page.
  return syncItem(ex.item_id).catch(() => ({ added: 0 }));
}
// A bank connected again after a disconnect: each of its accounts carries on from the old one, keeping its history,
// name, sharing and goals. Matched on the bank, the kind of account and the last 4 digits, or the name when there are none.
const lower = v => String(v || '').trim().toLowerCase();
function carryOn(s, it, a, id, type) {
  const olds = s.accounts.filter(x => x.disconnected && x.type === type && (it.instId && x.instId ? x.instId === it.instId : lower(x.inst) === lower(it.inst)));
  const name = lower(a.name || a.official_name);
  const x = (a.persistent_account_id && olds.find(y => y.pid === a.persistent_account_id))
    || (a.mask && olds.find(y => y.mask === a.mask))
    || olds.find(y => !(a.mask && y.mask) && name && lower(y.bankName || y.name) === name);
  if (!x) return null;
  for (const t of s.txns) if (t.acct === x.id) t.acct = id;
  for (const g of s.goals) if (g.acct === x.id) g.acct = id;
  x.id = id;
  return x;
}
// What a bank charge was for in full, in the money it was in: a split one adds its parts back.
const fullAmount = (s, t) => t.orig ? t.orig.a : B.round2(t.a + s.txns.reduce((n, u) => u.splitOf === t.id ? n + u.a : n, 0));
const edited = t => !!(t.set || t.note || t.tags || t.split || t.sentTo || t.hidden || t.receipt);
async function syncItem(itemId) {
  const it = db.items[itemId]; if (!it) return { added: 0 };
  const s = stateOf(it.uid), token = plaid.open(it.token);
  try {
    const ac = await plaid.accounts(token);
    for (const a of ac.accounts || []) {
      const id = 'p_' + a.account_id, type = plaidAcctType(a);
      let x = s.accounts.find(y => y.id === id) || carryOn(s, it, a, id, type);
      if (!x) { x = { id, item: itemId, shared: false }; s.accounts.push(x); }
      // Back from a disconnect: its old charges come again with new ids, and are matched up on the next update (x.carry)
      if (x.disconnected) { delete x.disconnected; delete x.disconnectedOn; x.carry = true; }
      // Plaid gives what you owe on a card as a positive balance; we show it as money owed (negative).
      const cur = a.balances.current ?? a.balances.available ?? 0;
      Object.assign(x, { item: itemId, name: x.renamed ? x.name : (a.name || a.official_name || 'Account'), bankName: a.name || a.official_name || undefined, inst: it.inst, type, mask: a.mask || '',
        bal: B.round2(['credit', 'loan'].includes(a.type) ? -cur : cur), limit: a.balances.limit || undefined, synced: Date.now() });
      if (it.instId) x.instId = it.instId;
      if (a.persistent_account_id) x.pid = a.persistent_account_id;
      // An account in another currency (a US dollar account) keeps its own money; totals turn it into home money
      const c = /^[A-Z]{3}$/.test(a.balances.iso_currency_code || '') ? a.balances.iso_currency_code : null;
      if (c && c !== B.homeCur(s)) x.cur = c; else delete x.cur;
    }
    // Investment accounts: what they hold. Not every bank shares this, so a "no" from Plaid just means no holdings.
    if ((ac.accounts || []).some(a => a.type === 'investment')) {
      try {
        const hr = await plaid.holdings(token);
        for (const a of ac.accounts) if (a.type === 'investment') { const x = s.accounts.find(y => y.id === 'p_' + a.account_id); if (x) x.holdings = B.plaidHoldings(hr, a.account_id); }
      } catch (e) { if (e.code === 'NETWORK' || plaid.needsLogin(e.code)) throw e; }
    }
    const before = B.budgetStatus(s, B.ymOf(today()), today());
    const r = await plaid.sync(token, it.cursor);
    const byPlaid = new Map(s.txns.filter(t => t.plaidId).map(t => [t.plaidId, t]));
    // The charges a carried-on account already had. The bank sends them again with new ids: match on the day, the
    // amount and the name (or the only one with that day and amount), so the person's changes stay and nothing doubles.
    const carried = new Set(s.accounts.filter(x => x.carry && x.item === itemId).map(x => x.id)), had = new Map();
    for (const t of s.txns) if (carried.has(t.acct) && t.plaidId && !t.splitOf) { const k = t.acct + '|' + t.date; had.set(k, [...(had.get(k) || []), t]); }
    const sameAs = (fields, raw, m) => {
      const list = had.get(fields.acct + '|' + fields.date); if (!list) return null;
      const same = list.filter(t => fullAmount(s, t) === (t.orig ? raw : fields.a));
      const hit = same.find(t => B.norm(t.m) === B.norm(m)) || (same.length === 1 ? same[0] : null);
      if (hit) list.splice(list.indexOf(hit), 1);
      return hit;
    };
    // A new bank brings up to two years at once: only the last two weeks wait in "New from your bank"
    const freshFrom = it.cursor ? '' : B.ymd(new Date(Date.now() - 14 * 864e5));
    let added = 0;
    for (const p of [...r.added, ...r.modified]) {
      let old = byPlaid.get(p.transaction_id) || (p.pending_transaction_id && byPlaid.get(p.pending_transaction_id));
      const a = B.round2(-p.amount), m = text(p.merchant_name || p.name || 'Bank transaction');
      const fields = { plaidId: p.transaction_id, date: p.authorized_date && p.pending ? p.authorized_date : p.date, acct: 'p_' + p.account_id, a, pending: !!p.pending };
      const tc = /^[A-Z]{3}$/.test(p.iso_currency_code || '') ? p.iso_currency_code : null;
      if (tc && tc !== B.homeCur(s)) B.convertTxn(s, fields, tc); else fields.orig = undefined;
      fields.norate = fields.norate || undefined;   // clears an old mark when the update has a rate
      if (!old && carried.has(fields.acct)) old = sameAs(fields, a, m);
      if (old) {   // a pending charge that posted, or Plaid corrected it: keep the person's category, name, note, tags, receipt and split
        if (old.plaidId !== p.transaction_id) byPlaid.delete(old.plaidId);
        const was = fullAmount(s, old), now = old.orig ? a : fields.a;
        if (!old.split) Object.assign(old, fields);
        else {   // the parts stay as the person made them; the first part takes any difference
          Object.assign(old, { plaidId: fields.plaidId, pending: fields.pending, date: fields.date, acct: fields.acct });
          if (now !== was) old.a = B.round2(old.a + now - was);
        }
        // It changed after the person split it or sent it to Split it (a tip added when it posted): ask them to check
        if ((old.split || old.sentTo) && Math.abs(now - was) >= 0.005) old.changed = { was: old.changed ? old.changed.was : was, now, ...(old.orig ? { cur: old.orig.cur } : {}) };
        byPlaid.set(p.transaction_id, old);
      } else {
        const t = { id: rid('t'), ...fields, m, c: B.pickCat(s, m, B.plaidCat(p.personal_finance_category, m, a)), note: '', fresh: fields.date >= freshFrom };
        s.txns.push(t); byPlaid.set(p.transaction_id, t); added++;
      }
    }
    const gone = new Set(r.removed.map(x => x.transaction_id));
    if (gone.size) s.txns = s.txns.filter(t => !t.plaidId || !gone.has(t.plaidId) || t.splitOf);
    // Bills Plaid found, kept per bank and put together for the person
    try { it.bills = B.plaidBills(await plaid.recurring(token)); } catch (e) { if (e.code === 'NETWORK') throw e; }
    s.plaidBills = Object.values(db.items).filter(x => x.uid === it.uid).flatMap(x => x.bills || []);
    it.cursor = r.cursor; it.error = null; it.syncedAt = Date.now(); delete it.loginTold;
    for (const x of s.accounts) if (carried.has(x.id)) delete x.carry;
    if (added) s.seenNew = 0;
    saveDb();
    if (added) B.matchTransfers(s);
    saveDb();
    await nudge(it.uid, before);
    await headsUp(it.uid);
    return { added };
  } catch (e) {
    it.error = plaid.needsLogin(e.code) ? 'login' : e.message;
    // Once per sign-in problem, not every few hours: a phone notification that this bank needs them
    if (it.error === 'login' && !it.loginTold) { it.loginTold = Date.now(); notify(it.uid, { title: `${it.inst} needs you to sign in again`, body: 'Open Budget it and tap Reconnect to keep it updating.', tag: 'bank-' + itemId }).catch(() => {}); }
    saveDb();
    throw e;
  }
}
async function syncAll(uid) {
  let added = 0; const errors = [];
  for (const [id, it] of Object.entries(db.items)) {
    if (uid && it.uid !== uid) continue;
    try { added += (await syncItem(id)).added; } catch (e) { errors.push(`${it.inst}: ${e.message}`); }
  }
  return { added, errors };
}
async function removeItem(uid, itemId) {
  const it = db.items[itemId]; if (!it || it.uid !== uid) bad('That bank isn’t connected.');
  try { await plaid.remove(plaid.open(it.token)); } catch (e) { if (e.code !== 'ITEM_NOT_FOUND' && e.code !== 'INVALID_ACCESS_TOKEN') throw e; }
  // The connection goes, here (with its sealed access token) and at Plaid. The history stays: its accounts are marked
  // disconnected, a reconnect carries on from them, and "Delete this history" on an account removes it for good.
  const s = stateOf(uid), ids = new Set(s.accounts.filter(a => a.item === itemId).map(a => a.id));
  for (const a of s.accounts) if (ids.has(a.id)) { a.disconnected = true; a.disconnectedOn = today(); delete a.carry; }
  // A pending charge would never post now. The ones nobody touched go, so a reconnect can't double them.
  s.txns = s.txns.filter(t => !(ids.has(t.acct) && t.pending && !edited(t)));
  delete db.items[itemId];
  s.plaidBills = Object.values(db.items).filter(x => x.uid === uid).flatMap(x => x.bills || []);
  saveDb();
}

// ---------- Split it ----------
const splitIt = (uid, tool, args) => splitItCall(uid, tool, args).then(r => r.text);
// -> { text, result }: what Split it said, and its whole answer (newer ones add structuredContent)
async function splitItCall(uid, tool, args) {
  const c = db.splitit?.[uid]; if (!c) bad('Connect Split it first, in Settings.');
  const why = await splitItOk(c.url); if (why) bad(why);
  let r;
  try {
    r = await fetch(c.url + '/mcp', { redirect: 'error', method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: 'Bearer ' + plaid.open(c.key) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } }), signal: AbortSignal.timeout(15000) });
  } catch { bad('Couldn’t reach Split it at ' + c.url + '. Is it running?'); }
  if (r.status === 401) bad('Split it didn’t accept the key. Make a new one with: node server.js mcp-key YOURNAME');
  const j = await r.json().catch(() => ({}));
  const textOut = j.result?.content?.[0]?.text || j.error?.message || 'Split it didn’t answer.';
  if (!r.ok || j.error || j.result?.isError) bad(textOut);
  return { text: textOut, result: j.result };
}
// Budget it calls Split it from the laptop, so an address someone types must not reach the laptop's own
// network (the router, other apps, a cloud's metadata service). SPLIT_IT_URL names the one Split it it may
// call, private or not. Without it only a public https address works. Checked again before every call,
// so a name that later points somewhere private stops working. -> null when it's fine, or the reason.
const NEED_SETTING = 'add SPLIT_IT_URL to budget-it.env (for example SPLIT_IT_URL=http://localhost:8080) and restart';
async function splitItOk(u) {
  let x; try { x = new URL(String(u)); } catch { return 'That address doesn’t look right.'; }
  if (SPLIT_IT_URL) return x.origin === SPLIT_IT_URL ? null : `This Budget it only connects to the Split it at ${SPLIT_IT_URL}.`;
  if (x.protocol !== 'https:') return `Use Split it’s https address. For a Split it on this laptop or your home network, ${NEED_SETTING}.`;
  const host = x.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase(), local = `That address is on this laptop or your home network. To use a Split it there, ${NEED_SETTING}.`;
  if (host === 'localhost' || host.endsWith('.localhost') || (net.isIP(host) && internalIp(host))) return local;
  if (net.isIP(host)) return null;
  let found; try { found = await dns.promises.lookup(host, { all: true }); } catch { return `Couldn’t find ${host}. Check the address.`; }
  return found.some(f => internalIp(f.address)) ? local : null;
}
// What Split it said my part of a new expense is, in dollars, or null when it didn't say.
// Best is the numbers in its answer (structuredContent.yourShareCents, or yourShare in dollars), when it sends them.
// Otherwise the sentence: newer Split it ends with "Your share: $30.00."; older ones list names and amounts in the same order.
function myShareFrom(msg, result) {
  const sc = result && typeof result === 'object' ? (result.structuredContent && typeof result.structuredContent === 'object' ? result.structuredContent : result) : {};
  const cents = sc.yourShareCents ?? sc.share?.yourShareCents, dollars = sc.yourShare ?? sc.share?.yourShare ?? (typeof sc.share === 'number' ? sc.share : undefined);
  if (Number.isInteger(cents) && cents >= 0) return B.round2(cents / 100);
  if (dollars !== undefined && dollars !== null && num(dollars) >= 0) return num(dollars);
  msg = String(msg || '');
  const m = /Your share: \$([\d,]+\.\d\d)/.exec(msg);
  if (m) return num(m[1].replace(/,/g, ''));
  if (/You’re not in this split/.test(msg)) return 0;
  const l = /between (.+?) \(([^)]+)\)\.?\s*$/.exec(msg); if (!l) return null;
  const names = l[1].split(',').map(x => x.trim().toLowerCase()), amounts = l[2].split('/').map(x => num(x.replace(/[^\d.]/g, '')));
  const i = names.indexOf('you');
  return names.length === amounts.length ? (i < 0 ? 0 : amounts[i]) : null;
}

// ---------- phone notifications ----------
let pushKeys = push.loadKeys(PUSH_KEYS_FILE);
async function notify(uid, message) {
  let sent = 0, changed = false;
  for (const sub of [...(pushes.subs[uid] || [])]) {
    const r = await push.sendOne(pushKeys, sub, { url: '/', ...message }, PUSH_CONTACT);
    if (r === 'ok') sent++;
    if (r === 'gone') { pushes.subs[uid] = pushes.subs[uid].filter(s => s !== sub); changed = true; }
  }
  if (changed) savePushes();
  return sent;
}
// Tell people when a budget crosses 80% or runs out. Once per budget per month for each level.
async function nudge(uid, before) {
  const s = stateOf(uid), ym = B.ymOf(today()), after = B.budgetStatus(s, ym, today());
  s.nudged = s.nudged || {};
  for (const b of after) {
    if (b.cat === 'home') continue;
    const was = before.find(x => x.cat === b.cat)?.state || 'ok';
    const lvl = b.state === 'over' && was !== 'over' ? 'over' : b.state === 'near' && was === 'ok' ? 'near' : null;
    const key = `${ym}:${b.cat}:${lvl}`;
    if (!lvl || s.nudged[key]) continue;
    s.nudged[key] = Date.now(); saveDb();
    await notify(uid, { title: lvl === 'over' ? `${b.name} is over budget` : `${b.name} is at ${Math.round(b.spent / b.limit * 100)}%`,
      body: lvl === 'over' ? `$${(-b.left).toFixed(2)} over this month.` : `$${b.left.toFixed(2)} left for the rest of the month.`, tag: 'budget-' + b.cat });
  }
  for (const k of Object.keys(s.nudged)) if (!k.startsWith(ym)) delete s.nudged[k];
}
// Big or unusual charges, new subscriptions, price increases, low chequing. Each one goes to the phone once.
async function headsUp(uid) {
  const s = stateOf(uid), sent = new Set(s.alerted || []), fresh = B.alerts(s, today()).filter(a => !sent.has(a.key));
  if (!fresh.length) return;
  s.alerted = [...sent, ...fresh.map(a => a.key)].slice(-300); saveDb();
  for (const a of fresh) await notify(uid, { title: a.title, body: a.body, tag: 'alert-' + a.kind, url: a.id ? '/?do=review' : '/' });
}
// Sunday evening: how the week went.
async function weeklyCheckIn() {
  const now = new Date(); if (now.getDay() !== 0 || now.getHours() < 18) return;
  const t = today();
  for (const [uid, s] of Object.entries(db.people)) {
    if (!pushes.subs[uid]?.length || s.weeklyOn === t || !s.txns.length) continue;
    s.weeklyOn = t; saveDb(); B.useCats(s);
    const w = B.week(s, t); if (!w.spent && !w.usual) continue;
    const diff = w.usual == null ? null : w.spent - w.usual;
    await notify(uid, { title: `You spent $${w.spent.toFixed(0)} this week`, tag: 'weekly',
      body: diff == null ? 'Everyday spending, leaving out home & bills.' : Math.abs(diff) < 10 ? 'About the same as a usual week.' : `$${Math.abs(diff).toFixed(0)} ${diff < 0 ? 'less' : 'more'} than a usual week.` });
  }
}
// The evening before a bill is due.
async function billReminders() {
  const t = today(), tomorrow = B.ymd(new Date(Date.now() + 864e5)), h = new Date().getHours();
  if (h < 18) return;
  for (const [uid, s] of Object.entries(db.people)) {
    if (!pushes.subs[uid]?.length || s.remindedOn === t) continue;
    const due = B.upcoming(s, t).filter(b => !b.paid && b.due === tomorrow);
    s.remindedOn = t; saveDb();
    if (due.length) await notify(uid, { title: due.length === 1 ? `${due[0].n} is due tomorrow` : `${due.length} bills due tomorrow`, body: due.map(b => `${b.n} $${b.a.toFixed(2)}`).join(', '), tag: 'bills' });
  }
}

// ---------- backups: one a day (30 kept) and one a week (a year kept) ----------
// Plus a copy at every start (that covers each update), 5 kept, and one every 6 hours, 8 kept (two days).
let lastBackupAt = null;
const KEEP_START = 5, KEEP_6H = 8;
const stampOf = d => `${B.ymd(d)}T${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
// Each step on its own: a full disk or one bad file skips that step, never the rest, and never stops the app.
const step = (what, fn) => { try { return fn(); } catch (e) { if (DISK_CODES.has(e.code)) noteDisk(e, what); else console.error(`Backup (${what}):`, e.message); } };
function trimCopies(re, keep) {   // only names this exact pattern matches, oldest first by name (the date is in the name)
  const old = fs.readdirSync(BACKUP_DIR).filter(f => re.test(f)).sort();
  for (const f of old.slice(0, Math.max(0, old.length - keep))) fs.unlinkSync(path.join(BACKUP_DIR, f));
}
function safetyCopy(kind) {   // 'start' or '6h': a copy of db.json as it is right now
  flushDb(); if (!fs.existsSync(DB_FILE)) return;
  step(kind + ' copy', () => {
    fs.copyFileSync(DB_FILE, path.join(BACKUP_DIR, `db-${kind}-${stampOf(new Date())}.json`));
    trimCopies(new RegExp(`^db-${kind}-\\d{4}-\\d\\d-\\d\\dT\\d{4}\\.json$`), kind === 'start' ? KEEP_START : KEEP_6H);
  });
}
function backup() {
  flushDb();
  const now = new Date(), day = B.ymd(now);
  const file = path.join(BACKUP_DIR, `db-${day}.json`);
  step('daily copy', () => {
    if (!fs.existsSync(file) && fs.existsSync(DB_FILE)) { fs.copyFileSync(DB_FILE, file); lastBackupAt = Date.now(); }
    else if (!lastBackupAt && fs.existsSync(file)) lastBackupAt = fs.statSync(file).mtimeMs;
  });
  const weekly = path.join(BACKUP_DIR, `db-weekly-${day}.json`);
  step('weekly copy', () => { if (now.getDay() === 0 && !fs.existsSync(weekly) && fs.existsSync(DB_FILE)) fs.copyFileSync(DB_FILE, weekly); });
  step('old copies', () => { trimCopies(/^db-\d{4}-\d\d-\d\d\.json$/, KEEP_BACKUPS); trimCopies(/^db-weekly-\d{4}-\d\d-\d\d\.json$/, KEEP_WEEKLY); });
  for (const f of [USERS_FILE, PUSH_FILE]) try { JSON.parse(fs.readFileSync(f, 'utf8')); fs.copyFileSync(f, f + '.bak'); } catch (e) { if (DISK_CODES.has(e.code)) noteDisk(e, path.basename(f) + '.bak'); }
  for (const [t, s] of Object.entries(users.sessions)) if (s.exp < Date.now() || !users.users[s.uid]) delete users.sessions[t];
  saveUsers();
  step('receipts', receiptsBackup);
  copyOut();
}
// The copy that survives this laptop's disk: today's full backup in BACKUP_COPY_DIR, if it isn't there yet.
// Without BACKUP_PASSPHRASE the copy isn't locked, so it leaves out secret.key while there are bank connections:
// whoever finds the drive gets the budgets, but not a way into anyone's bank. Restoring it on this laptop still works.
const copyState = { at: null, error: null, note: null };
const copyName = day => `budget-it-backup-${day}.${BACKUP_PASSPHRASE ? 'locked' : 'zip'}`;
const sealedCount = (d = db) => Object.keys(d.items || {}).length + Object.keys(d.splitit || {}).length;
const NO_KEY_NOTE = 'Copies leave out the bank key until you set BACKUP_PASSPHRASE. Restoring one needs this laptop’s data/secret.key.';
function copyOut(force) {
  if (!BACKUP_COPY_DIR) return null;
  try {
    fs.mkdirSync(BACKUP_COPY_DIR, { recursive: true });
    const mine = () => fs.readdirSync(BACKUP_COPY_DIR).filter(f => /^budget-it-backup-\d{4}-\d\d-\d\d\.(zip|locked)$/.test(f)).sort();
    const file = path.join(BACKUP_COPY_DIR, copyName(B.ymd(new Date())));
    const noKey = !BACKUP_PASSPHRASE && sealedCount() > 0;
    copyState.note = noKey ? NO_KEY_NOTE : null;
    if (force || !fs.existsSync(file)) writeBackupFile(file, BACKUP_PASSPHRASE, { noKey });
    const all = mine(); for (const f of all.slice(0, Math.max(0, all.length - KEEP_COPIES))) fs.unlinkSync(path.join(BACKUP_COPY_DIR, f));
    copyState.at = fs.statSync(path.join(BACKUP_COPY_DIR, mine().pop())).mtimeMs; copyState.error = null;
  } catch (e) {
    copyState.error = e.code === 'ENOSPC' || e.code === 'EDQUOT' ? `The drive at ${BACKUP_COPY_DIR} is full.` : e.code === 'ENOENT' || e.code === 'EACCES' || e.code === 'EROFS' ? `Can’t write to ${BACKUP_COPY_DIR}. Is the drive plugged in?` : e.message;
    console.error('Backup copy:', e.message);
  }
  return copyState;
}
const backupList = () => { try { return fs.readdirSync(BACKUP_DIR).filter(f => COPY_RE.test(f))
  .map(f => { const st = fs.statSync(path.join(BACKUP_DIR, f)); return { file: f, bytes: st.size, at: st.mtimeMs }; }).sort((a, b) => b.at - a.at); } catch { return []; } };

// A backup locked with a passphrase: "BIBK1\n", 16 bytes of salt, 12 of nonce, a 16 byte seal, then the zip,
// encrypted with AES-256-GCM. The key comes from the passphrase through scrypt, so guessing is slow.
const LOCK_MAGIC = Buffer.from('BIBK1\n');
const lockKey = (pass, salt) => crypto.scryptSync(String(pass), salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 96 * 1024 * 1024 });
function lock(buf, pass) {
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', lockKey(pass, salt), iv);
  const enc = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([LOCK_MAGIC, salt, iv, c.getAuthTag(), enc]);
}
const isLocked = buf => buf.length > 50 && buf.subarray(0, LOCK_MAGIC.length).equals(LOCK_MAGIC);
function unlock(buf, pass) {
  if (!pass) throw new Error('This backup is locked. Enter its passphrase.');
  const o = LOCK_MAGIC.length, d = crypto.createDecipheriv('aes-256-gcm', lockKey(pass, buf.subarray(o, o + 16)), buf.subarray(o + 16, o + 28));
  d.setAuthTag(buf.subarray(o + 28, o + 44));
  try { return Buffer.concat([d.update(buf.subarray(o + 44)), d.final()]); } catch { throw new Error('That passphrase doesn’t open this backup.'); }
}
// Receipt photos never change (a new photo gets a new name), so each one is copied into backups/receipts once.
// Photos no charge points to any more (the charge was deleted) are removed after two days, which leaves time for Undo.
function receiptsBackup() {
  let names; try { names = fs.readdirSync(RECEIPT_DIR); } catch { return; }
  const keep = new Set(); for (const s of Object.values(db.people)) for (const t of s.txns || []) if (t.receipt && !String(t.receipt).startsWith('data:')) keep.add(path.basename(t.receipt));
  const dir = path.join(BACKUP_DIR, 'receipts'); fs.mkdirSync(dir, { recursive: true });
  for (const f of names) {
    const fp = path.join(RECEIPT_DIR, f);
    try {
      if (keep.has(f)) { if (!fs.existsSync(path.join(dir, f))) fs.copyFileSync(fp, path.join(dir, f)); }
      else if (Date.now() - fs.statSync(fp).mtimeMs > 2 * 864e5) fs.rmSync(fp, { force: true });
    } catch {}
  }
}
const CRC_TABLE = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
const crc32 = buf => { let c = -1; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ -1) >>> 0; };
// entries: [{name, data: Buffer, or a function that reads it}], stored (not compressed). The zip goes to write()
// piece by piece, so a backup written to a file holds one receipt photo in memory at a time, not all of them.
function zipStream(entries, write) {
  const central = []; let off = 0, count = 0;
  const d = new Date(), dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  for (const e of entries) {
    const name = e.name, data = typeof e.data === 'function' ? e.data() : e.data;
    if (!data) continue;   // a file that went away while the backup was being made
    const n = Buffer.from(name, 'utf8'), crc = crc32(data);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(0, 8);
    local.writeUInt16LE(dosTime, 10); local.writeUInt16LE(dosDate, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(n.length, 26); local.writeUInt16LE(0, 28);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x800, 8); c.writeUInt16LE(0, 10);
    c.writeUInt16LE(dosTime, 12); c.writeUInt16LE(dosDate, 14); c.writeUInt32LE(crc, 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(n.length, 28);
    c.writeUInt16LE(0, 30); c.writeUInt16LE(0, 32); c.writeUInt16LE(0, 34); c.writeUInt16LE(0, 36); c.writeUInt32LE(0, 38); c.writeUInt32LE(off, 42);
    write(local); write(n); write(data); central.push(c, n); off += local.length + n.length + data.length; count++;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6); end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16); end.writeUInt16LE(0, 20);
  write(cd); write(end);
}
function zipWrite(entries) { const parts = []; zipStream(entries, b => parts.push(b)); return Buffer.concat(parts); }
function zipRead(buf) {   // -> { name: Buffer }, understands stored and deflated entries
  let e = buf.length - 22; while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) throw new Error('That file isn’t a zip.');
  const n = buf.readUInt16LE(e + 10); let o = buf.readUInt32LE(e + 16); const outp = {};
  for (let i = 0; i < n; i++) {
    if (buf.readUInt32LE(o) !== 0x02014b50) throw new Error('That zip is damaged.');
    const method = buf.readUInt16LE(o + 10), csize = buf.readUInt32LE(o + 20), nlen = buf.readUInt16LE(o + 28), xlen = buf.readUInt16LE(o + 30), clen = buf.readUInt16LE(o + 32), lo = buf.readUInt32LE(o + 42);
    const name = buf.subarray(o + 46, o + 46 + nlen).toString('utf8');
    const ds = lo + 30 + buf.readUInt16LE(lo + 26) + buf.readUInt16LE(lo + 28), raw = buf.subarray(ds, ds + csize);
    if (method !== 0 && method !== 8) throw new Error('That zip uses a kind of compression this can’t read.');
    if (!name.endsWith('/')) outp[name] = method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw);
    o += 46 + nlen + xlen + clen;
  }
  return outp;
}
// Put a backup back. What is here now is kept first (data/backups/before-restore-...), so a restore can itself be undone.
// Every file is checked before anything is replaced, so a wrong or damaged file changes nothing.
const isObj = x => !!x && typeof x === 'object' && !Array.isArray(x);
function parseShape(files, name, check) {
  if (!files[name]) return null;
  let x; try { x = JSON.parse(files[name].toString('utf8')); } catch { throw new Error(`${name} in that backup is damaged, so nothing was changed.`); }
  const why = check(x); if (why) throw new Error(`${name} in that backup doesn’t look like Budget it data (${why}), so nothing was changed.`);
  return x;
}
const dbShape = x => !isObj(x) ? 'it isn’t an object' : !isObj(x.people) ? 'no people in it' : Object.values(x.people).some(s => !isObj(s)) ? 'a budget that isn’t one'
  : x.items != null && !isObj(x.items) ? 'its bank connections aren’t a list' : x.splitit != null && !isObj(x.splitit) ? 'its Split it links aren’t a list' : null;
const usersShape = x => !isObj(x) ? 'it isn’t an object' : !isObj(x.users) ? 'no users in it' : x.sessions != null && !isObj(x.sessions) ? 'its sign-ins aren’t a list'
  : x.invites != null && !isObj(x.invites) ? 'its invites aren’t a list' : Object.values(x.users).some(u => !isObj(u) || typeof u.name !== 'string') ? 'a person without a name' : null;
function restoreBackup(buf, pass) {
  if (isLocked(buf)) buf = unlock(buf, pass);
  // A plain db.json (like data/backups/db-2026-11-10.json) restores the budgets alone; sign-ins stay as they are.
  const plain = buf.subarray(0, 64).toString('utf8').trimStart().startsWith('{');
  const files = plain ? { 'db.json': buf } : zipRead(buf);
  if (!files['db.json']) throw new Error('That backup has no db.json in it.');
  const next = parseShape(files, 'db.json', dbShape);
  const nextUsers = parseShape(files, 'users.json', usersShape);
  const nextPush = parseShape(files, 'push.json', x => !isObj(x) || (x.subs != null && !isObj(x.subs)) ? 'no list of phones' : null);
  if (sealedCount(next) && !files['secret.key']) {
    // Copies made without BACKUP_PASSPHRASE leave the key out: the one here has to be the one that sealed them.
    const box = Object.values(next.items || {})[0]?.token || Object.values(next.splitit || {})[0]?.key;
    const noKey = !(process.env.BUDGET_IT_KEY || '').trim() && !fs.existsSync(path.join(DATA_DIR, 'secret.key'));
    let opens = !noKey; if (opens && box) try { plaid.open(box); } catch { opens = false; }
    if (!opens) throw new Error(noKey ? 'That backup has bank connections but not the key that unlocks them (secret.key). Copies made without BACKUP_PASSPHRASE leave it out: put the laptop’s old data/secret.key back first, or restore a backup that has it.'
      : 'That backup has bank connections, and the key on this laptop (secret.key) doesn’t unlock them. Put back the secret.key from the laptop that made it, or restore a backup that has it.');
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  flushDb(); if (dbDirty && diskState.error) throw new Error(diskState.error);
  for (const f of ['db.json', 'users.json', 'push.json', 'secret.key']) { const fp = path.join(DATA_DIR, f); if (fs.existsSync(fp)) fs.copyFileSync(fp, path.join(BACKUP_DIR, `before-restore-${stamp}-${f}`)); }
  if (files['secret.key']) { fs.writeFileSync(path.join(DATA_DIR, 'secret.key'), files['secret.key'], { mode: 0o600 }); plaid.forgetKey(); }
  db = next; db.people = db.people || {}; db.items = db.items || {}; dbDirty = true; flushDb(); undo.clear();
  // Sessions are not restored: the ones signed out since the backup stay signed out, and current ones keep working if that person is still there.
  if (nextUsers) { const now = users.sessions || {}; users = nextUsers; users.sessions = {}; users.sessionsHashed = true;
    for (const [t, x] of Object.entries(now)) if (users.users[x.uid]) users.sessions[t] = x;
    saveUsers(); }
  if (nextPush) { pushes = nextPush; pushes.subs = pushes.subs || {}; savePushes(); }
  if (files['push-keys.json']) { try { const k = JSON.parse(files['push-keys.json'].toString('utf8')); if (k.publicKey && k.privateJwk) { fs.writeFileSync(PUSH_KEYS_FILE, files['push-keys.json'], { mode: 0o600 }); pushKeys = push.loadKeys(PUSH_KEYS_FILE); } } catch {} }
  if (files['oauth.json']) fs.writeFileSync(path.join(DATA_DIR, 'oauth.json'), files['oauth.json'], { mode: 0o600 });
  let receipts = 0;
  for (const [name, data] of Object.entries(files)) if (/^receipts\/u_[a-f0-9]+_[a-f0-9]+\.(jpg|png|webp)$/.test(name)) { fs.mkdirSync(RECEIPT_DIR, { recursive: true }); fs.writeFileSync(path.join(RECEIPT_DIR, name.slice(9)), data, { mode: 0o600 }); receipts++; }
  // anyone whose account isn't in the backup is signed out; everyone else's page reloads its data
  for (const [res, id] of listeners) { if (!users.users[id]) { try { res.end(); } catch {} listeners.delete(res); streamToken.delete(res); } else res.write('event: changed\ndata: {}\n\n'); }
  return { people: Object.keys(db.people).length, users: nextUsers ? Object.keys(nextUsers.users).length : null, banks: Object.keys(db.items).length, receipts };
}
// What goes in a backup. Receipt photos are read one at a time as the zip is written.
// noKey leaves secret.key out (an unlocked copy off the laptop); the README says so.
function backupEntries({ noKey } = {}) {
  flushDb(); if (!fs.existsSync(DB_FILE)) save(DB_FILE, db);   // a brand-new install has nothing on disk yet: a backup still holds a (nearly empty) budget file
  const entries = [], keyIn = !noKey && fs.existsSync(path.join(DATA_DIR, 'secret.key'));
  for (const f of ['db.json', 'users.json', 'push.json', 'push-keys.json', 'oauth.json', 'secret.key']) { const fp = path.join(DATA_DIR, f); if ((f !== 'secret.key' || keyIn) && fs.existsSync(fp)) entries.push({ name: f, data: fs.readFileSync(fp) }); }
  try { for (const f of fs.readdirSync(RECEIPT_DIR)) entries.push({ name: 'receipts/' + f, data: () => { try { return fs.readFileSync(path.join(RECEIPT_DIR, f)); } catch { return null; } } }); } catch {}
  entries.push({ name: 'README.txt', data: Buffer.from(`Budget it backup, ${new Date().toISOString()}\nTo restore: in the app, tap your picture, then People, backups and health, then Restore a backup. Or stop the server and run: node server.js restore THIS-FILE\n`
    + (keyIn ? 'secret.key unlocks the bank connections in db.json. Keep this zip somewhere private.\n'
      : noKey && sealedCount() ? 'This copy leaves out secret.key, the key to the bank connections, because it isn’t locked with a passphrase (set BACKUP_PASSPHRASE to include it).\nRestore it on the laptop that made it, or put that laptop’s data/secret.key back first. It still holds everyone’s budgets: keep it somewhere private.\n'
      : 'Keep this zip somewhere private.\n')) });
  return entries;
}
const backupZip = opts => zipWrite(backupEntries(opts));
// A backup straight to a file, locked when there is a passphrase. Same format as lock(backupZip()), written as it goes:
// the seal sits near the start, so it is filled in last.
function writeBackupFile(file, pass, opts) {
  const tmp = file + '.part', fd = fs.openSync(tmp, 'w', 0o600);
  try {
    const raw = b => { if (b.length) fs.writeSync(fd, b); };
    let write = raw, finish = () => {};
    if (pass) {
      const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', lockKey(pass, salt), iv);
      raw(Buffer.concat([LOCK_MAGIC, salt, iv, Buffer.alloc(16)]));
      write = b => raw(c.update(b));
      finish = () => { raw(c.final()); fs.writeSync(fd, c.getAuthTag(), 0, 16, LOCK_MAGIC.length + 28); };
    }
    zipStream(backupEntries(opts), write); finish(); fs.fsyncSync(fd);
  } catch (e) { fs.closeSync(fd); fs.rmSync(tmp, { force: true }); throw e; }
  fs.closeSync(fd); fs.renameSync(tmp, file);
}

// ---------- passwords and sessions ----------
const hashPw = (pw, salt = crypto.randomBytes(16).toString('hex')) => ({ salt, hash: crypto.scryptSync(pw, salt, 64).toString('hex') });
const checkPw = (pw, u) => {
  if (!u.hash || !u.salt) return false;
  const h = Buffer.from(crypto.scryptSync(pw, u.salt, 64).toString('hex')), want = Buffer.from(u.hash);
  return h.length === want.length && crypto.timingSafeEqual(h, want);
};
const findUser = who => {
  const x = String(who || '').trim().toLowerCase(); if (!x) return undefined;
  return Object.entries(users.users).find(([, u]) => u.name.toLowerCase() === x) || Object.entries(users.users).find(([, u]) => u.emailVerified && u.email === x);
};
const unesc = v => { try { return decodeURIComponent(v); } catch { return v; } };   // another app's odd cookie must not break sign-in
const cookies = req => Object.fromEntries((req.headers.cookie || '').split(';').map(c => c.trim().split('=')).filter(p => p[0]).map(([k, ...v]) => [k, unesc(v.join('='))]));
function sessionUid(req) {
  const s = sessionGet(users, cookies(req).bi);
  if (!s || s.exp < Date.now() || !users.users[s.uid]) return null;
  return s.uid;
}
// A sign-in that is used keeps going: at most once a day it's pushed to SESSION_DAYS from now, and the cookie with it.
function keepSession(req, res) {
  const t = cookies(req).bi, s = sessionGet(users, t);
  if (!s || !users.users[s.uid] || !slideSession(s, SESSION_DAYS)) return;
  saveUsers(); setCookie(req, res, t, SESSION_DAYS * 86400);
}
const secure = req => req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted;
// Adds the sign-in cookie without dropping another one this answer already sets
const setCookie = (req, res, val, maxAge) => res.setHeader('Set-Cookie', [...[].concat(res.getHeader('Set-Cookie') || []).filter(c => !String(c).startsWith('bi=')),
  `bi=${val}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure(req) ? '; Secure' : ''}`]);
const misses = new Map();
const isLocal = a => /^(127\.|::1$|::ffff:127\.)/.test(a || '');
// Who is really asking. Behind Traefik, Coolify or a Cloudflare tunnel every request reaches the app from the
// proxy's address, so the visitor's own address comes from the proxy's headers. Those are only believed when the
// request came from a private, loopback or Docker address (where a proxy lives) or one listed in TRUSTED_PROXY;
// TRUSTED_PROXY=none believes nobody. Cloudflare's CF-Connecting-IP wins; otherwise X-Forwarded-For is read from
// the right, skipping the proxies' own hops, because anything to the left of them is whatever the visitor wrote.
const bareIp = a => String(a || '').trim().replace(/^\[|\](:\d+)?$/g, '').replace(/^(\d+\.\d+\.\d+\.\d+):\d+$/, '$1').replace(/^::ffff:(?=\d+\.)/i, '').replace(/%.*$/, '');
const inList = (list, a) => { a = bareIp(a); const f = net.isIP(a); return !!f && list.check(a, f === 6 ? 'ipv6' : 'ipv4'); };
const subnets = list => { const b = new net.BlockList(); for (const x of list) { const [a, n] = x.split('/'), f = net.isIP(a) === 6 ? 'ipv6' : 'ipv4'; if (n === undefined) b.addAddress(a, f); else b.addSubnet(a, +n, f); } return b; };
const PRIVATE_NETS = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '127.0.0.0/8', '::1/128', 'fc00::/7', 'fe80::/10'];
const TRUSTED_PROXY = (process.env.TRUSTED_PROXY || '').trim();
const PROXIES = subnets(TRUSTED_PROXY.toLowerCase() === 'none' ? [] : PRIVATE_NETS.concat(TRUSTED_PROXY.split(',').map(x => x.trim()).filter(x => {
  const [a, n] = x.split('/'), ok = !!net.isIP(a) && (n === undefined || /^\d{1,3}$/.test(n)); if (x && !ok) console.error(`TRUSTED_PROXY: ${x} isn’t an address, so it’s ignored.`); return ok; })));
// Also never called on the laptop's behalf (Split it): link-local (cloud metadata), shared and "this network" addresses too.
const INTERNAL = subnets(PRIVATE_NETS.concat(['0.0.0.0/8', '169.254.0.0/16', '100.64.0.0/10', '192.0.0.0/24', '198.18.0.0/15', '224.0.0.0/3', '::/128', '::ffff:0:0/96', '64:ff9b::/96', 'fec0::/10', 'ff00::/8']));
const internalIp = a => inList(INTERNAL, a);
const clientIp = req => {
  const peer = bareIp(req.socket.remoteAddress);
  if (!inList(PROXIES, peer)) return peer;
  const cf = bareIp(req.headers['cf-connecting-ip']); if (net.isIP(cf)) return cf;
  const hops = String(req.headers['x-forwarded-for'] || '').split(',').map(bareIp).filter(x => net.isIP(x));
  let ip = peer;
  for (let i = hops.length - 1; i >= 0; i--) { ip = hops[i]; if (!inList(PROXIES, ip)) break; }
  return ip;
};
// A page on another website can make a browser send a request here with its cookie. Changes through /api/
// must come from this app's own page, so one that names another site (in Origin, or Referer when there's no
// Origin) is turned away. Tools that name no site (curl, the laptop commands) still work. /mcp and /oauth/
// aren't under /api/: AI assistants call those from their own sites, with their own keys.
const hostOf = u => { try { return new URL(u).host.toLowerCase().replace(/:(80|443)$/, ''); } catch { return null; } };
function otherSite(req) {
  const from = req.headers.origin || req.headers.referer; if (!from) return false;
  const h = hostOf(from); if (!h) return true;   // "null": a sandboxed frame or a file, never this app's page
  const mine = [req.headers['x-forwarded-host'], req.headers.host].map(x => String(x || '').split(',')[0].trim().toLowerCase().replace(/:(80|443)$/, ''));
  return !mine.includes(h) && h !== hostOf(process.env.PUBLIC_URL || '');
}
// Slow down guessing: 5 misses from one address, then a 15 minute wait.
const recent = k => { const m = misses.get(k); return m && Date.now() - m.at < 15 * 60e3 ? m.n : 0; };
const bump = k => { misses.set(k, { n: recent(k) + 1, at: Date.now() }); if (misses.size > 5000) for (const [key, m] of misses) if (Date.now() - m.at > 15 * 60e3) misses.delete(key); };
const noteMiss = (req, uid) => { bump(clientIp(req)); if (uid) bump('acct:' + uid); };
// Only the address is ever locked out. Misses aimed at one account (from anywhere) slow that account down instead,
// so guessing from many addresses stays slow but nobody can keep a housemate out by typing their name.
const tooManyTries = req => recent(clientIp(req)) >= 5 ? 'Too many tries. Wait 15 minutes.' : null;
const slowFor = uid => { const n = uid ? recent('acct:' + uid) : 0; return n < 10 ? 0 : Math.min(10e3, 1000 * 2 ** (n - 10)); };
const slowDown = uid => { const ms = slowFor(uid); return ms ? new Promise(r => setTimeout(r, ms)) : null; };
async function checkLogin(req, name, password) {   // returns the uid, or null (and counts the miss)
  const found = findUser(name || '');
  if (found && !tooManyTries(req)) { await slowDown(found[0]); if (checkPw(String(password || ''), found[1])) { misses.delete(clientIp(req)); return found[0]; } }
  noteMiss(req, found && found[0]);
  return null;
}
// Sign a person out: their sessions (all, or all but `keep`), the live streams those sessions opened,
// and, when `assistants` is set, any AI assistant they connected. Used by reset, sign out everywhere and the owner tools.
function endSessions(uid, { keep = null, assistants = false } = {}) {
  let n = 0;
  for (const [t, s] of Object.entries(users.sessions)) if (s.uid === uid && t !== keep) { delete users.sessions[t]; n++; }
  saveUsers();
  for (const [res, who] of listeners) if (who === uid && streamToken.get(res) !== keep) { try { res.end(); } catch {} listeners.delete(res); streamToken.delete(res); }
  if (assistants) mcp.revoke(uid);
  return n;
}
const onlyOwner = id => users.users[id]?.owner && Object.values(users.users).filter(x => x.owner).length === 1 && Object.keys(users.users).length > 1;
function removeUser(id) {
  const u = users.users[id]; if (!u) return null;
  endSessions(id, { assistants: true });
  delete users.users[id]; saveUsers();
  delete pushes.subs[id]; savePushes();
  for (const [iid, it] of Object.entries(db.items)) if (it.uid === id) { plaid.remove(plaid.open(it.token)).catch(() => {}); delete db.items[iid]; }
  if (db.splitit) delete db.splitit[id];
  for (const o of Object.values(db.people)) for (const a of o.accounts || []) if (Array.isArray(a.shared)) a.shared = a.shared.filter(x => x !== id);
  for (const k of Object.keys(friendDocs())) if (k.startsWith(`data/users/${id}/`) || k.endsWith('/friends/' + id)) delete db.friends[k];
  if (users.friendReqs) { for (const [k, r] of Object.entries(users.friendReqs)) if (r.from === id || r.to === id) delete users.friendReqs[k]; saveUsers(); }
  try { for (const f of fs.readdirSync(RECEIPT_DIR)) if (f.startsWith(id + '_')) fs.rmSync(path.join(RECEIPT_DIR, f), { force: true }); } catch {}
  delete db.people[id]; undo.delete(id); saveDb();   // undo keeps copies of the budget in memory: those go too
  return true;
}

// ---------- sending things ----------
const gzOk = req => /\bgzip\b/.test(req?.headers?.['accept-encoding'] || '');
const compressible = type => /json|text|javascript|xml|svg|manifest/.test(type);
const SECURITY = {
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'SAMEORIGIN',
  // cdn.plaid.com and *.plaid.com: the Plaid Link window, where people sign in to their bank.
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.plaid.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob:; connect-src 'self' https://*.plaid.com; frame-src https://cdn.plaid.com https://*.plaid.com; frame-ancestors 'self'; base-uri 'self'; form-action 'self' https://accounts.google.com"
};
function out(res, code, headers, body) {
  const req = res.req, h = { ...SECURITY, ...headers };
  let buf = Buffer.isBuffer(body) ? body : Buffer.from(body == null ? '' : String(body));
  if (buf.length > 800 && compressible(h['Content-Type'] || '') && gzOk(req)) { buf = zlib.gzipSync(buf, { level: 6 }); h['Content-Encoding'] = 'gzip'; h.Vary = 'Accept-Encoding'; }
  h['Content-Length'] = buf.length;
  res.writeHead(code, h); res.end(req && req.method === 'HEAD' ? undefined : buf);
}
const send = (res, code, body, type = 'application/json') => out(res, code, { 'Content-Type': type, 'Cache-Control': 'no-store' }, typeof body === 'string' ? body : JSON.stringify(body));
const readBody = (req, limit = 3e6) => new Promise((res, rej) => {
  let n = 0; const chunks = [];
  req.on('data', c => { n += c.length; if (n > limit) { rej(Object.assign(new Error('That’s too big.'), { status: 413 })); req.destroy(); } else chunks.push(c); });
  req.on('end', () => { try { const j = JSON.parse(Buffer.concat(chunks).toString() || '{}'); res(j && typeof j === 'object' && !Array.isArray(j) ? j : {}); } catch (e) { rej(Object.assign(new Error('Bad request'), { status: 400 })); } });
});
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8' };
const fileCache = new Map();
function staticFile(name, dir = PUBLIC) {
  const fp = path.join(dir, name);
  if (!fp.startsWith(dir + path.sep) || !fs.existsSync(fp) || !fs.statSync(fp).isFile()) return null;
  const mtime = fs.statSync(fp).mtimeMs, hit = fileCache.get(fp);
  if (hit && hit.mtime === mtime) return hit;
  const data = fs.readFileSync(fp), etag = '"' + crypto.createHash('sha1').update(data).digest('base64url').slice(0, 20) + '"';
  const entry = { data, etag, mtime, type: TYPES[path.extname(name).toLowerCase()] || 'application/octet-stream' };
  fileCache.set(fp, entry); return entry;
}
function file(res, name, type, cache, dir) {
  const f = staticFile(name, dir); if (!f) return send(res, 404, { error: 'not found' });
  const h = { 'Content-Type': type || f.type, 'Cache-Control': cache || 'no-cache', ETag: f.etag };
  if (res.req.headers['if-none-match'] === f.etag) { res.writeHead(304, { ...SECURITY, ETag: f.etag, 'Cache-Control': h['Cache-Control'] }); return res.end(); }
  out(res, 200, h, f.data);
}
const PUBLIC_FILES = new Set(['/manifest.webmanifest', '/sw.js', '/qr.js', '/icon.svg', '/icon-192.png', '/icon-512.png', '/icon-maskable-512.png', '/apple-touch-icon.png']);

// ---------- the assistant connector and accounts ----------
const mcp = require('./mcp')({ DATA_DIR, users: () => users, findUser, checkLogin, tooManyTries, noteMiss, secure, B, sessionUid, clientIp,
  stateOf, applyOp, today, nameFor, plaidSync: uid => syncAll(uid), version: VERSION,
  needsCode: uid => accounts.needsCode(uid), checkCode: (uid, code) => accounts.checkCode(uid, code) });
// Friends (made by invite links, @tag requests and friend links) live in db.friends, keyed the way accounts.js
// names them: data/users/<uid>/root/friends/<friend uid>. Budget it has no other docs.
const friendDocs = () => (db.friends = db.friends || {});
const accounts = require('./accounts')({ appName: 'Budget it', envFile: 'budget-it.env', cookieName: 'bi', tagline: '',
  users: () => users, saveUsers, endSessions, docs: friendDocs, saveDb, broadcast: paths => changed(paths.map(x => String(x).split('/')[2])), hashPw, findUser, setCookie, cookies, clientIp, misses,
  noteMiss, tooManyTries, slowDown, nameFor, readBody, send, file, secure, SESSION_DAYS,
  notify: (uids, msg) => Promise.all(uids.map(id => notify(id, msg))).catch(e => console.error(e)) });
// Who is your friend here (both ways), so the share list can put them first
const friendsOf = uid => new Set(Object.keys(friendDocs()).filter(k => k.startsWith(`data/users/${uid}/root/friends/`)).map(k => k.split('/').pop())
  .filter(f => friendDocs()[`data/users/${f}/root/friends/${uid}`]?.kind === 'account'));

// ---------- live updates: the page reloads its data when something changes elsewhere ----------
const listeners = new Map();   // res -> uid
const streamToken = new Map(); // res -> the (hashed) session it was opened with
function changed(uids) { for (const [res, id] of listeners) if (uids.includes(id)) res.write('event: changed\ndata: {}\n\n'); }
// You, and the people who can see one of your accounts: the ones whose page should reload when your budget changes.
const householdOf = uid => [...new Set([uid, ...(db.people[uid]?.accounts || []).flatMap(a => sharedWith(a, uid))])];

// ---------- is there a newer Budget it? ----------
// Asked only when the owner opens their page, at most twice a day. It reads the public release list on GitHub
// and sends nothing about you. UPDATE_CHECK=off turns it off.
const RELEASES_URL = process.env.RELEASES_URL || 'https://api.github.com/repos/sherrypanaich/budget-it/releases/latest';
const newerThan = (a, b) => { const x = String(a).replace(/^v/, '').split('.').map(Number), y = String(b).replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); } return false; };
let release = { at: 0, data: { current: VERSION, latest: null, newer: false, url: null } };
async function latestRelease() {
  if ((process.env.UPDATE_CHECK || '').toLowerCase() === 'off') return { ...release.data, off: true };
  if (Date.now() - release.at < 12 * 3600e3) return release.data;
  release.at = Date.now();
  try {
    const r = await fetch(RELEASES_URL, { headers: { 'User-Agent': 'budget-it', Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(6000) });
    const d = r.ok ? await r.json() : null;
    if (d && /^v?\d+\.\d+\.\d+$/.test(d.tag_name || '')) release.data = { current: VERSION, latest: String(d.tag_name).replace(/^v/, ''), newer: newerThan(d.tag_name, VERSION),
      url: /^https:\/\/github\.com\//.test(d.html_url || '') ? d.html_url : null, name: String(d.name || '').slice(0, 120) };
  } catch {}
  return release.data;
}
const readRaw = (req, limit) => new Promise((res, rej) => {
  let n = 0; const chunks = [];
  req.on('data', c => { n += c.length; if (n > limit) { rej(Object.assign(new Error('That file is too big.'), { status: 413 })); req.destroy(); } else chunks.push(c); });
  req.on('end', () => res(Buffer.concat(chunks))); req.on('error', rej);
});
const isOwner = uid => !!users.users[uid]?.owner;
// What the owner should know about the laptop's disk: saving is failing, or it's 90% full.
function diskWarning() {
  if (diskState.error) { const min = Math.max(1, Math.round((Date.now() - diskState.since) / 60e3));
    const full = diskState.code === 'ENOSPC' || diskState.code === 'EDQUOT';
    return `${full ? 'The laptop’s disk is full' : `The laptop can’t write to its disk (${diskState.code || 'write error'})`}. Saving has failed for ${min} minute${min === 1 ? '' : 's'}: what changed since is only in memory and is saved as soon as there’s room.`; }
  try { const st = fs.statfsSync(DATA_DIR), used = st.blocks ? 1 - st.bavail / st.blocks : 0;
    if (used >= 0.9) return `The laptop’s disk is ${Math.floor(used * 100)}% full (${(st.bavail * st.bsize / 1e9).toFixed(1)} GB free). When it’s full, changes can’t be saved.`; } catch {}
  return null;
}
// For the owner: the budgets were put back from a safety copy at start (db.json was damaged), until they dismiss it.
const recoveryNote = () => recovered && !recovered.dismissed ? { from: recovered.from, copyAt: recovered.copyAt, at: recovered.at, damaged: recovered.damaged } : null;

async function handle(req, res) {
  // Laptop commands (node server.js set-password NAME ...) reach the running app here. Only from this computer,
  // never through a tunnel or proxy, and only with the secret from data/server.lock.
  if (req.url === '/api/local/cli') {
    const tok = Buffer.from(String(req.headers['x-local-token'] || '')), want = Buffer.from(localToken || '');
    const direct = isLocal(req.socket.remoteAddress) && !req.headers['x-forwarded-for'] && !req.headers['x-forwarded-host'];
    if (req.method !== 'POST' || !direct || !want.length || tok.length !== want.length || !crypto.timingSafeEqual(tok, want)) return send(res, 404, { error: 'not found' });
    return send(res, 200, localCommand(await readBody(req)));
  }
  if (await mcp.handle(req, res)) return;
  const url = new URL(req.url, 'http://x'), p = url.pathname, m = req.method;
  if (p.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(m) && otherSite(req)) return send(res, 403, { error: 'That came from another website, so Budget it didn’t do it. Open Budget it itself and try again.' });
  const uid = sessionUid(req);
  if (uid && !p.startsWith('/auth/')) keepSession(req, res);
  if (PUBLIC_FILES.has(p)) return file(res, p.slice(1), null, p === '/sw.js' ? 'no-cache' : 'public, max-age=86400');
  if (/^\/art\/[a-z0-9-]+\.(webp|png)$/.test(p)) return file(res, p.slice(1), null, 'public, max-age=604800');
  if (p === '/budget.js' || p === '/sample.js' || p === '/ops.js') return file(res, p.slice(1), null, 'no-cache', __dirname);
  if (p === '/login' && m === 'GET') return file(res, 'login.html');
  if (p === '/api/login' && m === 'POST') {
    const { name, password } = await readBody(req);
    const wait = tooManyTries(req); if (wait) return send(res, 429, { error: wait });
    const id = await checkLogin(req, name, password);
    if (!id) return send(res, 401, { error: 'That name and password don’t match.' });
    // a sign-in code is on for this person: the password was step one, the code is step two (accounts.js)
    if (accounts.needsCode(id)) return send(res, 200, { need: 'code', ticket: accounts.codeTicket(id) });
    accounts.startSession(req, res, id);
    return send(res, 200, { ok: true });
  }
  if (p === '/api/logout') {
    if (sessionDrop(users, cookies(req).bi)) saveUsers();
    setCookie(req, res, '', 0); res.writeHead(302, { Location: '/login' }); return res.end();
  }
  if (await accounts(req, res, url, uid)) return;   // invites, email, Google, password reset (accounts.js)
  if (!uid) {
    if (p.startsWith('/api/')) return send(res, 401, { error: 'signed out' });
    res.writeHead(302, { Location: '/login' }); return res.end();
  }
  const me = users.users[uid];
  if (!me.lastSeen || Date.now() - me.lastSeen > 3600e3) { me.lastSeen = Date.now(); saveUsers(); }
  if (p === '/' || p === '/index.html') return file(res, 'index.html', null, 'private, no-cache');
  // Where a bank's own app or site sends people back after they approve the connection (needs PLAID_REDIRECT_URI).
  // The page itself picks the connection up again; nothing from the address is kept on the laptop.
  if (p === '/plaid/return' && m === 'GET') { res.writeHead(302, { Location: '/?bank=back' + (url.search ? '&' + url.search.slice(1) : ''), 'Cache-Control': 'no-store' }); return res.end(); }
  if (p === '/api/state' && m === 'GET') return send(res, 200, viewFor(uid));

  // ---------- the owner's page: people, backups, health. Never anyone's budget. ----------
  if (p.startsWith('/api/admin/')) {
    if (!isOwner(uid)) return send(res, 403, { error: 'Only the owner can do that.' });
    if (p === '/api/admin/overview' && m === 'GET') {
      flushDb();
      const sessions = {}; for (const x of Object.values(users.sessions)) if (x.exp > Date.now()) sessions[x.uid] = (sessions[x.uid] || 0) + 1;
      const banks = {}; for (const it of Object.values(db.items)) banks[it.uid] = (banks[it.uid] || 0) + 1;
      const people = Object.entries(users.users).map(([id, u]) => ({ id, name: u.name, owner: !!u.owner, email: u.emailVerified ? u.email : null, hasPassword: !!u.hash, google: !!u.google,
        code: accounts.needsCode(id), createdAt: u.createdAt || null, lastSeen: u.lastSeen || null, push: (pushes.subs[id] || []).length, sessions: sessions[id] || 0, mcp: mcp.connected(id), banks: banks[id] || 0 }));
      let receipts = 0, receiptBytes = 0; try { for (const f of fs.readdirSync(RECEIPT_DIR)) { receiptBytes += fs.statSync(path.join(RECEIPT_DIR, f)).size; receipts++; } } catch {}
      let disk = null; try { const st = fs.statfsSync(DATA_DIR); disk = { free: st.bavail * st.bsize, total: st.blocks * st.bsize }; } catch {}
      const invites = Object.values(users.invites || {}).filter(v => !v.used && v.exp > Date.now()).length;
      return send(res, 200, { people, invites, backups: backupList().slice(0, 40),
        health: { version: VERSION, node: process.version, uptime: Date.now() - STARTED, dbBytes: fs.existsSync(DB_FILE) ? fs.statSync(DB_FILE).size : 0, receipts, receiptBytes, disk, lastBackupAt,
          copyDir: BACKUP_COPY_DIR, copyAt: copyState.at, copyError: copyState.error, copyNote: copyState.note, copyLocked: !!BACKUP_PASSPHRASE, diskWarning: diskWarning(), recovered: recoveryNote(), publicUrl: process.env.PUBLIC_URL || null, email: !!process.env.RESEND_API_KEY, google: !!process.env.GOOGLE_CLIENT_ID,
          plaid: { configured: plaid.configured, env: plaid.env, banks: Object.keys(db.items).length, used: db.plaidUsed || 0, limit: plaid.env === 'production' ? PLAID_LIMIT : null, back: plaid.redirect || null,
            errors: Object.values(db.items).filter(i => i.error).length }, syncHours: SYNC_HOURS, listeners: listeners.size, dataDir: DATA_DIR } });
    }
    if (p === '/api/admin/update' && m === 'GET') return send(res, 200, await latestRelease());
    if (p === '/api/admin/recovery-seen' && m === 'POST') {
      if (recovered) { recovered.dismissed = Date.now(); try { fs.writeFileSync(RECOVERY_FILE, JSON.stringify(recovered), { mode: 0o600 }); } catch (e) { noteDisk(e, 'last-recovery.json'); } }
      return send(res, 200, { ok: true });
    }
    if (p === '/api/admin/backup' && (m === 'GET' || m === 'POST')) {   // POST carries a passphrase to lock it with
      const { passphrase } = m === 'POST' ? await readBody(req) : {};
      if (passphrase != null && String(passphrase).length < 8) return send(res, 400, { error: 'Use at least 8 characters for the passphrase.' });
      const zip = backupZip(), locked = !!passphrase;
      return out(res, 200, { 'Content-Type': locked ? 'application/octet-stream' : 'application/zip', 'Content-Disposition': `attachment; filename="budget-it-backup-${today()}.${locked ? 'locked' : 'zip'}"`, 'Cache-Control': 'no-store' },
        locked ? lock(zip, String(passphrase)) : zip);
    }
    if (p === '/api/admin/restore' && m === 'POST') {
      const buf = await readRaw(req, 400e6);
      let pass = ''; try { pass = decodeURIComponent(String(req.headers['x-backup-passphrase'] || '')); } catch {}
      if (isLocked(buf) && !pass) return send(res, 401, { error: 'This backup is locked. Enter its passphrase.', locked: true });
      try { const r = restoreBackup(buf, pass); return send(res, 200, { ok: true, ...r }); }
      catch (e) { return send(res, /passphrase/.test(e.message) ? 401 : 400, { error: e.message || 'Couldn’t restore that.', locked: /passphrase/.test(e.message) || undefined }); }
    }
    if (p === '/api/admin/copy-now' && m === 'POST') {
      if (!BACKUP_COPY_DIR) return send(res, 400, { error: 'No second backup place is set. Add BACKUP_COPY_DIR to budget-it.env and restart.' });
      const st = copyOut(true);
      return st.error ? send(res, 500, { error: st.error }) : send(res, 200, { ok: true, at: st.at });
    }
    if (m !== 'POST') return send(res, 404, { error: 'not found' });
    const { id, owner, name } = await readBody(req);
    if (!users.users[id]) return send(res, 404, { error: 'No such person.' });
    if (p === '/api/admin/reset-link') return send(res, 200, { url: accounts.resetLink(req, id), name: users.users[id].name });
    if (p === '/api/admin/signout') return send(res, 200, { ok: true, sessions: endSessions(id, { assistants: true }) });
    if (p === '/api/admin/code-off') return send(res, 200, { ok: true, was: accounts.codeOff(id) });
    if (p === '/api/admin/owner') {
      if (!owner && users.users[id].owner && Object.values(users.users).filter(x => x.owner).length === 1) return send(res, 400, { error: 'Budget it needs at least one owner.' });
      users.users[id].owner = !!owner; saveUsers(); return send(res, 200, { ok: true });
    }
    if (p === '/api/admin/rename') {
      const n = String(name || '').trim().replace(/\s+/g, ' ').slice(0, 30); if (!n) return send(res, 400, { error: 'Give a name.' });
      const taken = findUser(n); if (taken && taken[0] !== id) return send(res, 400, { error: 'Someone already has that name.' });
      users.users[id].name = n; saveUsers(); return send(res, 200, { ok: true });
    }
    if (p === '/api/admin/remove') {
      if (id === uid) return send(res, 400, { error: 'You can’t remove yourself. Make someone else the owner first.' });
      removeUser(id); return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: 'not found' });
  }
  if (p === '/api/export.csv' && m === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="budget-it-${today()}.csv"`, 'Cache-Control': 'no-store' });
    return res.end(B.toCsv(stateOf(uid)));
  }
  // ---------- your own data: everyone can take a copy of it, or delete it and their account ----------
  if (p === '/api/me/export' && m === 'GET') {
    const s = stateOf(uid), u = users.users[uid];
    const out = { app: 'Budget it', version: VERSION, exportedAt: new Date().toISOString(),
      you: { name: u.name, email: u.emailVerified ? u.email : null, createdAt: u.createdAt || null, owner: !!u.owner },
      budget: s,   // your own budget only: accounts others share with you are theirs, so they aren't in here
      banks: Object.values(db.items).filter(i => i.uid === uid).map(i => ({ inst: i.inst, connectedAt: i.at || null, syncedAt: i.syncedAt || null })),
      receipts: s.txns.filter(t => t.receipt).map(t => ({ txn: t.id, date: t.date, name: t.m, file: String(t.receipt).startsWith('data:') ? '(in this file)' : path.basename(t.receipt) })),
      splitit: db.splitit?.[uid] ? { url: db.splitit[uid].url } : null, phones: (pushes.subs[uid] || []).length };
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="budget-it-my-data-${today()}.json"`, 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(out, null, 1));
  }
  if (p === '/api/me/delete' && m === 'POST') {
    const { name } = await readBody(req), u = users.users[uid];
    if (String(name || '').trim().toLowerCase() !== u.name.toLowerCase()) return send(res, 400, { error: `Type your name, ${u.name}, to confirm.` });
    if (u.owner && Object.values(users.users).filter(x => x.owner).length === 1)
      return send(res, 400, { error: Object.keys(users.users).length > 1 ? 'You’re the only one who runs this Budget it. Make someone else the owner first (People, backups and health), then delete your data.'
        : 'You’re the only person here, and you run it. To remove everything, stop Budget it on the laptop and delete its data folder.' });
    // Each bank is disconnected at Plaid first, like Disconnect does; if Plaid can't be reached, nothing is deleted yet.
    for (const [iid, it] of Object.entries(db.items)) if (it.uid === uid) {
      try { await removeItem(uid, iid); } catch (e) { return send(res, 502, { error: `Couldn’t disconnect ${it.inst} at Plaid (${e.message}). Nothing was deleted. Try again.` }); }
    }
    const household = Object.keys(users.users);
    removeUser(uid); flushDb();
    changed(household);
    setCookie(req, res, '', 0);
    return send(res, 200, { ok: true });
  }
  // Receipt photos: data/receipts/<owner>_<random>.jpg, only the owner can see them
  if (p === '/api/receipt' && m === 'POST') {
    const { id, data } = await readBody(req, 6e6);
    if (!data) {   // remove the photo
      const t = stateOf(uid).txns.find(x => x.id === id && !x.other); if (!t) return send(res, 404, { error: 'That transaction isn’t there any more.' });
      if (t.receipt && !t.receipt.startsWith('data:')) fs.rmSync(path.join(RECEIPT_DIR, path.basename(t.receipt)), { force: true });
      const r = applyOp(uid, 'txn.receipt', { id, receipt: '' }, true); return send(res, 200, { ok: true, msg: r.msg, ...viewFor(uid) });
    }
    const mm = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(data || ''));
    if (!mm) return send(res, 400, { error: 'That photo didn’t come through. Try again.' });
    const t = stateOf(uid).txns.find(x => x.id === id && !x.other); if (!t) return send(res, 404, { error: 'That transaction isn’t there any more.' });
    const name = `${uid}_${crypto.randomBytes(9).toString('hex')}.${mm[1] === 'jpeg' ? 'jpg' : mm[1]}`;
    try { fs.mkdirSync(RECEIPT_DIR, { recursive: true }); fs.writeFileSync(path.join(RECEIPT_DIR, name), Buffer.from(mm[2], 'base64'), { mode: 0o600 }); }
    catch (e) { try { fs.rmSync(path.join(RECEIPT_DIR, name), { force: true }); } catch {} noteDisk(e, 'a receipt photo'); return send(res, 507, { error: diskMsg(e) }); }
    if (t.receipt && !t.receipt.startsWith('data:')) fs.rmSync(path.join(RECEIPT_DIR, path.basename(t.receipt)), { force: true });
    const r = applyOp(uid, 'txn.receipt', { id, receipt: name }, true);
    durable();
    return send(res, 200, { ok: true, msg: r.msg, ...viewFor(uid) });
  }
  if (p.startsWith('/api/receipt/') && m === 'GET') {
    const name = path.basename(p.slice(13));
    if (!/^u_[a-f0-9]+_[a-f0-9]+\.(jpg|png|webp)$/.test(name) || !name.startsWith(uid + '_')) return send(res, 404, { error: 'Not found' });
    const fp = path.join(RECEIPT_DIR, name); if (!fs.existsSync(fp)) return send(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'Content-Type': name.endsWith('png') ? 'image/png' : name.endsWith('webp') ? 'image/webp' : 'image/jpeg', 'Cache-Control': 'private, max-age=86400' });
    return res.end(fs.readFileSync(fp));
  }
  // Send a charge to Split it, through Split it's assistant connection, as this person
  if (p === '/api/splitit/connect' && m === 'POST') {
    const { url, key } = await readBody(req);
    if (!url && !key) { if (db.splitit) delete db.splitit[uid]; saveDb(); return send(res, 200, { ok: true, msg: 'Split it disconnected', ...viewFor(uid) }); }
    let base; try { base = new URL(String(url || SPLIT_IT_URL)); if (!/^https?:$/.test(base.protocol)) throw 0; } catch { return send(res, 400, { error: 'That address doesn’t look right. It looks like https://split.example.com' }); }
    const why = await splitItOk(base.origin); if (why) return send(res, 400, { error: why });
    if (!/^[A-Za-z0-9_\-.]{20,200}$/.test(String(key || ''))) return send(res, 400, { error: 'Paste the key from: node server.js mcp-key YOURNAME (in Split it’s folder).' });
    db.splitit = db.splitit || {}; db.splitit[uid] = { url: base.origin, key: plaid.seal(String(key)) };
    try { await splitIt(uid, 'list_groups', {}); } catch (e) { delete db.splitit[uid]; return send(res, 400, { error: e.message }); }
    saveDb(); return send(res, 200, { ok: true, msg: 'Connected to Split it', ...viewFor(uid) });
  }
  if (p === '/api/splitit/groups' && m === 'GET') {
    const txt = await splitIt(uid, 'list_groups', {});
    return send(res, 200, { groups: txt.split('\n').map(l => l.split(':')[0].trim()).filter(g => g && !/not in any groups/i.test(g)) });
  }
  if (p === '/api/splitit/send' && m === 'POST') {
    const { id, group, amount, title, mine } = await readBody(req);
    const t = stateOf(uid).txns.find(x => x.id === id && !x.other); if (!t) return send(res, 404, { error: 'That transaction isn’t there any more.' });
    const amt = num(amount ?? -t.a); if (!(amt > 0)) return send(res, 400, { error: 'Enter the amount to split.' });
    const SPLIT_CATS = { groceries: 'groceries', dining: 'food', transport: 'transport', home: 'household', fun: 'fun' };
    const { text: msg, result: said } = await splitItCall(uid, 'add_expense', { title: text(title || B.baseName(t.m), 60), amount: amt, group: text(group, 60), category: SPLIT_CATS[t.c] || 'other', date: t.date, note: 'From Budget it' });
    applyOp(uid, 'txn.sent', { id, to: text(group, 60) }, true);
    // "Count only my share": the part housemates owe back stops counting as my spending
    let extra = '';
    if (mine) {
      const share = myShareFrom(msg, said), back = share == null ? null : B.round2(amt - share);
      if (back == null) extra = ' Split it didn’t say what your share is, so the whole amount still counts in your budget.';
      else if (back > 0 && back < -t.a && !t.split) { const r = applyOp(uid, 'txn.share', { id, amount: back, to: text(group, 60) }, true); extra = r.msg ? '. ' + r.msg : ''; }
      else if (back > 0 && back >= -t.a && !t.split) { applyOp(uid, 'txn.update', { id, c: 'transfer' }); extra = '. None of it is yours, so it no longer counts as spending'; }
    }
    changed([uid]);
    return send(res, 200, { ok: true, msg: msg.split(' paid by')[0].replace(/[.,]$/, '') + extra, ...viewFor(uid) });
  }
  if (p === '/api/op' && m === 'POST') {
    const { op, args } = await readBody(req);
    const was = householdOf(uid);   // someone you just stopped sharing with gets a reload too
    const r = applyOp(uid, String(op || ''), args && typeof args === 'object' && !Array.isArray(args) ? args : {});
    durable();
    changed([...new Set([...was, ...householdOf(uid)])]);
    return send(res, 200, { ok: true, msg: r.msg, ...viewFor(uid) });
  }
  // Today's exchange rates from the Bank of Canada (free, no key). Only for a CAD home, which is what it publishes.
  if (p === '/api/rates/today' && m === 'POST') {
    const s = stateOf(uid);
    const home = B.homeCur(s);
    const want = [...new Set([...(s.accounts || []).filter(a => !a.other && a.cur).map(a => a.cur), ...Object.keys(s.rates || {})])].filter(c => c !== home);
    if (home !== 'CAD') {   // other home currencies: the European Central Bank's daily rates (frankfurter.app, free, no key)
      const others = want.filter(c => c !== home);
      if (!others.length) return send(res, 200, { ok: true, msg: `All your accounts are in ${home}.`, ...viewFor(uid) });
      let rates, day;
      try {
        const r = await fetch((process.env.FX_URL || 'https://api.frankfurter.app') + `/latest?from=${home}&to=${others.join(',')}`, { signal: AbortSignal.timeout(10000) });
        if (!r.ok) throw new Error(r.status); const j = await r.json(); rates = j.rates || {}; day = j.date;
      } catch { return send(res, 502, { error: `Couldn’t get today’s rates for ${home}. Try again later, or enter the rate yourself.` }); }
      // it answers "1 home = r other"; we keep "1 other = x home"
      const got = others.filter(c => +rates[c] > 0);
      for (const c of got) applyOp(uid, 'money.rate', { cur: c, rate: +(1 / +rates[c]).toFixed(6) }, true);
      changed(householdOf(uid));
      const miss = others.filter(c => !got.includes(c));
      return send(res, 200, { ok: true, msg: (got.length ? `Updated ${got.join(', ')} (${day || 'today'})` : 'No rates came back') + (miss.length ? `. Enter ${miss.join(', ')} yourself.` : ''), ...viewFor(uid) });
    }
    if (!want.length) return send(res, 200, { ok: true, msg: 'All your accounts are in CAD.', ...viewFor(uid) });
    let obs;
    try {
      const r = await fetch((process.env.BOC_URL || 'https://www.bankofcanada.ca/valet') + '/observations/' + want.map(c => 'FX' + c + 'CAD').join(',') + '/json?recent=1', { signal: AbortSignal.timeout(10000) });
      if (!r.ok) throw new Error(r.status); obs = ((await r.json()).observations || [])[0] || {};
    } catch { return send(res, 502, { error: 'Couldn’t reach the Bank of Canada. Try again later, or enter the rate yourself.' }); }
    const got = want.filter(c => +(obs['FX' + c + 'CAD'] || {}).v > 0);
    for (const c of got) applyOp(uid, 'money.rate', { cur: c, rate: +obs['FX' + c + 'CAD'].v }, true);
    changed(householdOf(uid));
    const miss = want.filter(c => !got.includes(c));
    return send(res, 200, { ok: true, msg: (got.length ? `Updated ${got.join(', ')} (${obs.d || 'today'})` : 'No rates came back') + (miss.length ? `. Enter ${miss.join(', ')} yourself.` : ''), ...viewFor(uid) });
  }
  if (p === '/api/events' && m === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    res.write('retry: 5000\n\n'); listeners.set(res, uid); streamToken.set(res, cookies(req).bi ? sessionKey(cookies(req).bi) : null);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => { clearInterval(ping); listeners.delete(res); streamToken.delete(res); });
    return;
  }
  // Plaid
  if (p === '/api/plaid/link-token' && m === 'POST') {
    const { item } = await readBody(req);
    const it = item && db.items[item]; if (item && (!it || it.uid !== uid)) return send(res, 404, { error: 'That bank isn’t connected.' });
    return send(res, 200, { link_token: await plaid.linkToken(uid, it ? plaid.open(it.token) : undefined) });
  }
  if (p === '/api/plaid/exchange' && m === 'POST') {
    const { public_token, institution, institution_id } = await readBody(req);
    if (typeof public_token !== 'string' || !public_token) return send(res, 400, { error: 'Missing public_token' });
    const r = await connectItem(uid, public_token, institution, typeof institution_id === 'string' ? institution_id : '');
    changed([uid]);
    return send(res, 200, { ok: true, msg: `Connected ${text(institution || 'your bank', 40)}. ${r.added} transaction${r.added === 1 ? '' : 's'} came in.`, ...viewFor(uid) });
  }
  if (p === '/api/plaid/sync' && m === 'POST') {
    const r = await syncAll(uid); changed(householdOf(uid));
    return send(res, 200, { ok: true, msg: r.errors.length ? r.errors.join(' ') : r.added ? `${r.added} new transaction${r.added === 1 ? '' : 's'}` : 'Up to date', ...viewFor(uid) });
  }
  if (p === '/api/plaid/fixed' && m === 'POST') {   // after a "Reconnect" in Plaid Link (update mode)
    const { item } = await readBody(req); const it = db.items[item];
    if (!it || it.uid !== uid) return send(res, 404, { error: 'That bank isn’t connected.' });
    it.error = null; saveDb(); const r = await syncItem(item).catch(e => ({ added: 0, err: e.message }));
    return send(res, 200, { ok: true, msg: r.err || 'Reconnected', ...viewFor(uid) });
  }
  if (p === '/api/plaid/remove' && m === 'POST') {
    const { item } = await readBody(req); await removeItem(uid, item); changed(householdOf(uid));
    return send(res, 200, { ok: true, msg: 'Disconnected. Its history is kept here.', ...viewFor(uid) });
  }
  // Phone notifications
  if (p === '/api/push/key') return send(res, 200, { key: pushKeys.publicKey });
  if (p === '/api/push/subscribe' && m === 'POST') {
    const sub = await readBody(req);
    if (!sub || typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint) || !sub.keys?.p256dh || !sub.keys?.auth) return send(res, 400, { error: 'bad subscription' });
    for (const id in pushes.subs) pushes.subs[id] = pushes.subs[id].filter(s => s.endpoint !== sub.endpoint);
    (pushes.subs[uid] = pushes.subs[uid] || []).push({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } });
    savePushes();
    await notify(uid, { title: 'Budget it', body: 'Notifications are on. You’ll hear when a budget is nearly used up and the evening before a bill.', tag: 'test' });
    return send(res, 200, { ok: true });
  }
  if (p === '/api/push/unsubscribe' && m === 'POST') {
    const { endpoint } = await readBody(req);
    if (pushes.subs[uid]) { pushes.subs[uid] = pushes.subs[uid].filter(s => s.endpoint !== endpoint); savePushes(); }
    return send(res, 200, { ok: true });
  }
  // ---------- your own AI assistants: the link, keys you make, and disconnecting them (see mcp.js) ----------
  if (p === '/api/assistants' && m === 'GET') return send(res, 200, { url: mcp.address(req), list: mcp.mine(uid), idleDays: mcp.idleDays });
  if (p === '/api/assistants/key' && m === 'POST') {
    const { name, readOnly } = await readBody(req);
    try { return send(res, 200, { key: mcp.makeKey(uid, name, { readOnly: readOnly === true }), url: mcp.address(req) }); } catch (e) { return send(res, 400, { error: e.message }); }
  }
  if (p === '/api/assistants/remove' && m === 'POST') {
    const { id } = await readBody(req);
    if (typeof id !== 'string' || !id) return send(res, 400, { error: 'Pick an assistant.' });
    return send(res, 200, { ok: true, removed: mcp.removeMine(uid, id) });
  }
  if (p === '/api/assistant' && m === 'GET') return send(res, 200, { connected: mcp.connected(uid) });
  return send(res, 404, { error: 'not found' });
}

// ---------- command line ----------
const ask = q => new Promise(res => { const rl = readline.createInterface({ input: process.stdin, output: process.stdout }); let got = false;
  rl.question(q, a => { got = true; rl.close(); res(a); }); rl.on('close', () => { if (!got) res(''); }); });
async function cli([cmd, ...rest]) {
  const name = rest.join(' ').trim();
  if (mcp.cli(cmd, name)) return;
  if (cmd === 'list-users') { for (const [id, u] of Object.entries(users.users)) console.log(`${u.name}${u.owner ? ' (owner)' : ''}  ${id}`); return; }
  if (cmd === 'backup') {
    const pass = process.env.BACKUP_PASSPHRASE || await ask('Passphrase to lock it with (8+ characters, or Enter for none): ');
    if (pass && pass.length < 8) return console.log('Too short, nothing written.');
    const f = name || `budget-it-backup-${B.ymd(new Date())}.${pass ? 'locked' : 'zip'}`;
    writeBackupFile(f, pass);
    return console.log(pass ? `Wrote ${f}, locked with your passphrase. Without the passphrase nobody can open it, you included.` : `Wrote ${f}. It can unlock your bank connections, so keep it somewhere private.`);
  }
  if (cmd === 'restore') {
    if (!name || !fs.existsSync(name)) return console.log('Usage: node server.js restore FILE  (a .zip or .locked backup, or a db-....json copy from data/backups)');
    if (await askServer({ cmd: 'ping' })) return console.log('The app is running. Stop it first (systemctl --user stop budget-it), or restore from the app: People, backups and health.');
    const buf = fs.readFileSync(name), pass = isLocked(buf) ? (process.env.BACKUP_PASSPHRASE || await ask('Passphrase for this backup: ')) : '';
    try { const r = restoreBackup(buf, pass); flushDb(); return console.log(`Restored ${r.people} budget${r.people === 1 ? '' : 's'}, ${r.banks} bank connection${r.banks === 1 ? '' : 's'} and ${r.receipts} receipt photo${r.receipts === 1 ? '' : 's'}. What was there before is in data/backups (before-restore-...).`); }
    catch (e) { return console.log(e.message); }
  }
  if (!['add-user', 'set-password', 'remove-user', 'code-off', 'sample'].includes(cmd)) return console.log('Commands: add-user NAME, set-password NAME, remove-user NAME, code-off NAME, list-users, sample NAME, backup FILE, restore FILE, mcp-key NAME, mcp-revoke NAME');
  if (!name) return console.log(`Usage: node server.js ${cmd} NAME`);
  const found = findUser(name), job = { cmd, name };
  if (cmd === 'add-user' && found) return console.log(`${name} already exists. Use set-password to change it.`);
  if (cmd !== 'add-user' && !found) return console.log(`No user called ${name}.`);
  if (cmd === 'remove-user') {
    if (onlyOwner(found[0])) return console.log(`${found[1].name} is the owner. Make someone else the owner first, or remove the others.`);
    const ok = await ask(`Remove ${found[1].name}? This deletes their budget and disconnects their banks. Type yes: `);
    if (ok.trim().toLowerCase() !== 'yes') return console.log('Nothing changed.');
  }
  if (cmd === 'add-user' || cmd === 'set-password') {
    job.password = await ask(`Password for ${name} (8+ characters): `);
    if (job.password.length < 8) return console.log('Too short, nothing saved.');
  }
  // A running app keeps everything in memory and would write its own copy back over ours, so it does the job itself.
  const answer = await askServer(job);
  if (answer && answer.text) return console.log(answer.text);
  const r = localCommand(job); flushDb();
  console.log(r.text + (answer ? ' The app is running but didn’t answer, so restart it to pick this up.' : ''));
}
// What those commands do. Used here when the app is stopped, and by the running app when it is asked (see /api/local/cli).
function localCommand({ cmd, name, password }) {
  if (cmd === 'ping') return { text: 'running' };
  const found = findUser(name || '');
  if (cmd === 'add-user') {
    if (found) return { text: `${name} already exists. Use set-password to change it.` };
    if (String(password || '').length < 8) return { text: 'Too short, nothing saved.' };
    const clean = String(name).trim().replace(/\s+/g, ' ').slice(0, 30);
    users.users['u_' + crypto.randomBytes(11).toString('hex')] = { name: clean, owner: !Object.keys(users.users).length, createdAt: Date.now(), ...hashPw(String(password)) };
    saveUsers(); accounts.ensureTags?.();   // everyone gets a unique @tag
    return { text: `Added ${clean}. They can sign in now.` };
  }
  if (!found) return { text: `No user called ${name}.` };
  const [id, u] = found;
  if (cmd === 'set-password') {
    if (String(password || '').length < 8) return { text: 'Too short, nothing saved.' };
    Object.assign(u, hashPw(String(password)));
    const n = endSessions(id, { assistants: true });
    return { text: `New password saved for ${u.name}. Signed out ${n} session${n === 1 ? '' : 's'} and any AI assistant.` };
  }
  if (cmd === 'remove-user') {
    if (onlyOwner(id)) return { text: `${u.name} is the owner. Make someone else the owner first, or remove the others.` };
    removeUser(id);
    return { text: `Removed ${u.name}. Their budget is deleted and their banks are disconnected.` };
  }
  if (cmd === 'code-off') return { text: accounts.codeOff(id) ? `Sign-in code turned off for ${u.name}. They can sign in with just their password and turn it on again.` : `${u.name} didn’t have a sign-in code on.` };
  if (cmd === 'sample') {
    const s = stateOf(id);
    if (s.txns.length) return { text: `${u.name} already has transactions, so nothing was changed.` };
    db.people[id] = { ...blank(), ...sample(today()) }; saveDb(); changed([id]);
    return { text: `Filled ${u.name}'s budget with sample data. Remove it later in the app: Settings, Remove sample data.` };
  }
  return { text: 'Unknown command.' };
}
// The running app writes data/server.lock: where it listens and a secret only this computer's user can read.
const LOCK_FILE = path.join(DATA_DIR, 'server.lock');
let localToken = null;
function claimLock() {
  localToken = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, port: PORT, token: localToken }), { mode: 0o600 });
}
const dropLock = () => { try { if (JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8')).pid === process.pid) fs.unlinkSync(LOCK_FILE); } catch {} };
async function askServer(job) {   // -> the running app's answer, null when none is running, {} when it didn't answer
  let lk; try { lk = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8')); process.kill(lk.pid, 0); } catch { return null; }
  try {
    const r = await fetch(`http://127.0.0.1:${lk.port}/api/local/cli`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Local-Token': lk.token },
      body: JSON.stringify(job), signal: AbortSignal.timeout(8000) });
    return r.ok ? await r.json() : {};
  } catch { return {}; }
}

if (require.main === module) {
  if (process.argv[2]) cli(process.argv.slice(2));
  else {
    if (!Object.keys(users.users).length) console.log('No users yet. Add one with: node server.js add-user YOURNAME');
    if (+process.versions.node.split('.')[0] < 22) console.log(`Heads-up: this is Node ${process.version}. Budget it is tested on Node 22 and 24; older ones no longer get security fixes.`);
    // secret.key is there but can't be read or is damaged: never make a new one over it while bank links depend on it.
    const keyBad = plaid.keyProblem();
    if (keyBad && sealedCount()) {
      console.error(`${keyBad}. It’s the key to the bank connections${db.splitit && Object.keys(db.splitit).length ? ' and Split it links' : ''}, so Budget it won’t start rather than lose them.\n`
        + 'Put back a good secret.key (every full backup has one; data/backups/before-restore-...-secret.key may too), or set BUDGET_IT_KEY if you used that, then start it again.');
      process.exit(1);
    }
    if (keyBad) {   // nothing is sealed with it yet: keep it aside, and a new key is made when a bank is connected
      const aside = path.join(DATA_DIR, 'secret.key.damaged-' + Date.now());
      try { fs.renameSync(path.join(DATA_DIR, 'secret.key'), aside); console.error(`${keyBad}. No bank is connected yet, so it was kept as ${path.basename(aside)} and a new key will be made.`); }
      catch (e) { console.error(`${keyBad}, and it couldn’t be moved aside (${e.message}). Connecting a bank won’t work until it’s fixed.`); }
    }
    try { claimLock(); } catch (e) { console.error('Couldn’t write data/server.lock, so laptop commands can’t reach the running app:', e.message); }
    process.on('exit', dropLock);
    migrateShares();
    if (!plaid.configured) console.log('Plaid isn’t set up, so banks can’t connect yet. Add PLAID_CLIENT_ID and PLAID_SECRET to budget-it.env (see README). CSV import and cash still work.');
    safetyCopy('start');
    const safely = (what, fn) => () => { try { fn(); } catch (e) { console.error(what + ':', e.message); } };
    safely('Backup', backup)();
    setInterval(safely('Backup', () => { safetyCopy('6h'); backup(); }), 6 * 3600e3);
    // Once a day in the log too, when the disk is nearly full (the owner's page shows it all the time)
    let diskLogged = 0;
    setInterval(safely('Disk check', () => { const w = diskWarning(); if (w && Date.now() - diskLogged > 864e5) { diskLogged = Date.now(); console.error(w); } }), 10 * 60e3);
    setInterval(() => billReminders().catch(e => console.error('Bill reminders:', e.message)), 15 * 60e3);
    setInterval(() => weeklyCheckIn().catch(e => console.error('Weekly check-in:', e.message)), 15 * 60e3);
    if (plaid.configured) setInterval(() => syncAll().then(r => r.errors.length && console.error('Bank sync:', r.errors.join(' '))).catch(e => console.error('Bank sync:', e.message)), SYNC_HOURS * 3600e3);
    http.createServer((req, res) => handle(req, res).catch(e => {
      if (!e.status) console.error(e);
      if (!res.headersSent) { if (DISK_CODES.has(e.code)) { noteDisk(e, req.url); return send(res, 507, { error: diskMsg(e) }); }
        send(res, e.status || (e.code ? 502 : 500), { error: e.status || e.code ? e.message : 'Something went wrong on the laptop. Try again.' }); }
    })).on('error', e => { console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is already in use. Is Budget it already running? Stop it, or set PORT to another number.` : 'Couldn’t start: ' + e.message); process.exit(1); })
      .listen(PORT, HOST, () => console.log(`Budget it ${VERSION} running at http://${HOST}:${PORT}`));
  }
}
module.exports = { OPS, applyOp, viewFor, syncAll, connectItem, removeItem, _db: () => db, zipWrite, zipRead, lock, unlock, isLocked, newerThan, myShareFrom };
