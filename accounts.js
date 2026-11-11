// Accounts: invite links, email (through Resend), password reset, email sign-in links,
// Sign in with Google, change password, a sign-in code from an authenticator app, sign out everywhere.
// Split it and Budget it share this file word for word (Budget it's tests check it), so a fix made
// for one reaches the other. Anything that differs between them comes in through `h`.
//
// It stays private: nobody can sign up on their own. A new account needs an
// invite link from someone already in. Google and email only sign in people
// who already have an account (or who hold an invite).
//
// Settings (environment variables, or the app's .env file next to server.js):
//   PUBLIC_URL            the address people use, e.g. https://laptop.tail1234.ts.net
//   RESEND_API_KEY        from resend.com, turns on emails
//   MAIL_FROM             e.g. "Split it <hello@yourdomain.com>" (a domain verified in Resend)
//   GOOGLE_CLIENT_ID      from Google Cloud, turns on "Continue with Google"
//   GOOGLE_CLIENT_SECRET
'use strict';
const crypto = require('crypto');

module.exports = function accounts(h) {
  const { users, saveUsers, docs, saveDb, broadcast, hashPw, findUser, setCookie, cookies, clientIp, misses,
    tooManyTries, nameFor, readBody, send, file, secure, SESSION_DAYS } = h;
  const APP = h.appName || 'Split it', ENVFILE = h.envFile || 'split-it.env', COOKIE = h.cookieName || 'hs', TAG = h.tagline || '';
  const env = k => (process.env[k] || '').trim();
  // Emails carry sign-in links, so they only go out once PUBLIC_URL says where those links point.
  // Without it a link would be built from whatever address the request claimed to come to.
  if (env('RESEND_API_KEY') && !env('PUBLIC_URL')) console.error(`Emails are off: set PUBLIC_URL in ${ENVFILE} to turn them on.`);
  const RESEND = env('PUBLIC_URL') ? env('RESEND_API_KEY') : '', FROM = env('MAIL_FROM') || `${APP} <onboarding@resend.dev>`;
  const G_ID = env('GOOGLE_CLIENT_ID'), G_SECRET = env('GOOGLE_CLIENT_SECRET');
  const G_AUTH = env('GOOGLE_AUTH_URL') || 'https://accounts.google.com/o/oauth2/v2/auth';
  const G_TOKEN = env('GOOGLE_TOKEN_URL') || 'https://oauth2.googleapis.com/token';
  const RESEND_URL = env('RESEND_URL') || 'https://api.resend.com/emails';
  const now = () => Date.now();
  const U = () => users();
  const sha = t => crypto.createHash('sha256').update(String(t)).digest('hex');
  const rand = (n = 32) => crypto.randomBytes(n).toString('base64url');
  const cleanEmail = e => String(e || '').trim().toLowerCase();
  const okEmail = e => /^[^\s@]{1,64}@[^\s@]{1,255}\.[a-z]{2,}$/i.test(e) && e.length <= 254;
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  function base(req) {
    const set = env('PUBLIC_URL').replace(/\/+$/, '');
    if (set) return set;
    return (secure(req) ? 'https://' : 'http://') + String(req.headers.host || 'localhost');
  }
  // A wrong try counts against the address it came from and, when we know it, the account it was aimed at.
  const miss = h.noteMiss || (req => { const ip = clientIp(req), m = misses.get(ip); misses.set(ip, { n: (m && now() - m.at < 15 * 60e3 ? m.n : 0) + 1, at: now() }); });
  function startSession(req, res, uid) {
    const t = crypto.randomBytes(32).toString('hex');
    for (const [k, s] of Object.entries(U().sessions)) if (s.exp < now()) delete U().sessions[k];
    U().sessions[t] = { uid, exp: now() + SESSION_DAYS * 864e5 };
    saveUsers();
    setCookie(req, res, t, SESSION_DAYS * 86400);
  }
  const userByEmail = e => Object.entries(U().users).find(([, u]) => u.emailVerified && u.email === cleanEmail(e));
  const userByGoogle = sub => Object.entries(U().users).find(([, u]) => u.google === sub);

  // ---------- one-time codes (stored hashed) ----------
  function makeCode(kind, data, minutes) {
    U().codes = U().codes || {};
    for (const [k, c] of Object.entries(U().codes)) if (c.exp < now() - 864e5) delete U().codes[k];
    const t = rand();
    U().codes[sha(t)] = { kind, ...data, exp: now() + minutes * 60e3 };
    saveUsers();
    return t;
  }
  function takeCode(kind, t, peek) {
    const k = sha(t), c = (U().codes || {})[k];
    if (!c || c.kind !== kind || c.used || c.exp < now()) return null;
    if (!peek) { c.used = now(); saveUsers(); }
    return c;
  }

  // ---------- sign-in code: a second step from an authenticator app (TOTP, RFC 6238) ----------
  // Optional, per person. Once it's on, a password or an emailed sign-in link is not enough by itself:
  // the 6-digit code from the app, or one of eight one-time backup codes, is needed too.
  // Google sign-in is left alone, because Google asks for its own second step.
  const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const toB32 = buf => { let bits = '', out = ''; for (const b of buf) bits += b.toString(2).padStart(8, '0');
    for (let i = 0; i + 5 <= bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)]; return out; };
  const fromB32 = s => { let bits = ''; for (const c of String(s).toUpperCase().replace(/[^A-Z2-7]/g, '')) bits += B32.indexOf(c).toString(2).padStart(5, '0');
    const out = []; for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2)); return Buffer.from(out); };
  const totp = (secret, step) => { const c = Buffer.alloc(8); c.writeBigUInt64BE(BigInt(step));
    const m = crypto.createHmac('sha1', fromB32(secret)).update(c).digest(), o = m[19] & 15;
    return String((m.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0'); };
  const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  // The 30-second step a code belongs to (this one, the one before or the one after), or 0 when it's wrong.
  const stepFor = (secret, code) => { const t = Math.floor(now() / 30e3); for (const st of [t, t - 1, t + 1]) if (same(totp(secret, st), code)) return st; return 0; };
  const cleanBackup = c => String(c || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const newBackupCodes = () => Array.from({ length: 8 }, () => { const c = toB32(crypto.randomBytes(5)).toLowerCase(); return c.slice(0, 4) + '-' + c.slice(4); });
  const needsCode = uid => !!U().users[uid]?.totp?.on;
  function checkCode(uid, input) {   // right code -> true, and that code can't be used again
    const u = U().users[uid]; if (!u?.totp?.on) return true;
    const digits = String(input || '').replace(/\s/g, '');
    if (/^\d{6}$/.test(digits)) {
      const st = stepFor(u.totp.secret, digits);
      if (!st || st <= (u.totp.last || 0)) return false;
      u.totp.last = st; saveUsers(); return true;
    }
    const i = (u.totp.backup || []).indexOf(sha(cleanBackup(input)));
    if (i < 0 || !cleanBackup(input)) return false;
    u.totp.backup.splice(i, 1); saveUsers(); return true;
  }
  // Turn it off for someone (they lost their phone): used by the owner's page and `node server.js code-off NAME`.
  const codeOff = uid => { const u = U().users[uid]; if (!u) return false; const had = !!u.totp?.on; delete u.totp; delete u.totpPending; saveUsers(); return had; };
  // The first step was right and a code is still needed: a ticket, good for 10 minutes, to finish signing in with.
  const codeTicket = uid => makeCode('2fa', { uid }, 10);

  // ---------- email ----------
  async function mail(to, subject, lines, link, button) {
    if (!RESEND) throw new Error(`Email isn’t set up on this ${APP} yet.`);
    const html = `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:auto;padding:24px;color:#14112A">
      <h2 style="margin:0 0 ${TAG ? 4 : 18}px">${esc(APP)}</h2>${TAG ? `<p style="margin:0 0 18px;color:#5D5870;font-size:13px">${esc(TAG)}</p>` : ''}
      ${lines.map(l => `<p>${esc(l)}</p>`).join('')}
      <p style="margin:24px 0"><a href="${esc(link)}" style="background:#FFD23F;color:#14112A;padding:12px 20px;border-radius:10px;border:2px solid #14112A;font-weight:700;text-decoration:none">${esc(button)}</a></p>
      <p style="color:#5D5870;font-size:13px">If the button doesn’t work, copy this link: ${esc(link)}</p>
      <p style="color:#5D5870;font-size:13px">Didn’t ask for this? You can ignore this email.</p></div>`;
    const text = `${lines.join('\n\n')}\n\n${button}: ${link}\n\nDidn’t ask for this? You can ignore this email.`;
    const r = await fetch(RESEND_URL, { method: 'POST', headers: { Authorization: `Bearer ${RESEND}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM, to: [to], subject, html, text }) });
    if (!r.ok) { console.error('Resend error', r.status, await r.text().catch(() => '')); throw new Error('The email didn’t send. Try again in a minute.'); }
  }
  const lastMail = new Map();   // person + kind -> time, so nobody can be flooded with emails
  const tooSoon = (uid, kind) => { const k = uid + ':' + kind, t = lastMail.get(k); if (t && now() - t < 60e3) return true; lastMail.set(k, now()); return false; };

  // ---------- new accounts (only through an invite) ----------
  function liveInvite(token) {
    const inv = typeof token === 'string' && Object.hasOwn(U().invites || {}, token) ? U().invites[token] : null;
    return inv && !inv.used && inv.exp > now() ? inv : null;
  }
  function uniqueName(n) {
    n = String(n || '').trim().replace(/\s+/g, ' ').slice(0, 30) || 'Friend';
    if (!findUser(n)) return n;
    for (let i = 2; i < 100; i++) if (!findUser(`${n} ${i}`)) return `${n} ${i}`;
    return `${n} ${rand(3)}`;
  }
  function createFromInvite(inv, fields) {
    const id = 'u_' + crypto.randomBytes(11).toString('hex');
    U().users[id] = { owner: false, invitedBy: inv.by, createdAt: now(), ...fields };
    inv.used = now(); inv.uid = id;
    saveUsers();
    if (U().users[inv.by]) {   // friends with whoever sent the link, both ways
      const a = `data/users/${inv.by}/root/friends/${id}`, b = `data/users/${id}/root/friends/${inv.by}`;
      docs()[a] = { kind: 'account', addedAt: now() }; docs()[b] = { kind: 'account', addedAt: now() };
      saveDb(); broadcast([a, b]);
    }
    return id;
  }

  // ---------- Google ----------
  const gStates = new Map();   // state -> { mode, uid, invite, exp }
  function googleStart(req, res, mode, uid, invite) {
    for (const [k, v] of gStates) if (v.exp < now()) gStates.delete(k);
    const state = rand(24);
    gStates.set(state, { mode, uid, invite, exp: now() + 10 * 60e3 });
    res.setHeader('Set-Cookie', `gst=${state}; Path=/auth/google; HttpOnly; SameSite=Lax; Max-Age=600${secure(req) ? '; Secure' : ''}`);
    const q = new URLSearchParams({ client_id: G_ID, redirect_uri: base(req) + '/auth/google/callback', response_type: 'code',
      scope: 'openid email profile', state, prompt: 'select_account' });
    res.writeHead(302, { Location: `${G_AUTH}?${q}` }); res.end();
  }
  const back = (res, where, msg) => { res.writeHead(302, { Location: msg ? `${where}#msg=${encodeURIComponent(msg)}` : where }); res.end(); };
  async function googleCallback(req, res, url) {
    const state = url.searchParams.get('state') || '', code = url.searchParams.get('code') || '';
    const st = gStates.get(state); gStates.delete(state);
    res.setHeader('Set-Cookie', `gst=; Path=/auth/google; HttpOnly; SameSite=Lax; Max-Age=0`);
    if (!st || st.exp < now() || cookies(req).gst !== state) return back(res, '/login', 'That Google sign-in timed out. Try again.');
    if (!code) return back(res, st.mode === 'link' ? '/' : '/login', 'Google sign-in was cancelled.');
    let p;
    try {
      const r = await fetch(G_TOKEN, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ code, client_id: G_ID, client_secret: G_SECRET, redirect_uri: base(req) + '/auth/google/callback', grant_type: 'authorization_code' }) });
      const d = await r.json();
      if (!r.ok || !d.id_token) throw new Error('no token');
      // The token came straight from Google over HTTPS, so its contents can be trusted; still check who it's for.
      p = JSON.parse(Buffer.from(String(d.id_token).split('.')[1], 'base64url').toString());
      if (p.aud !== G_ID || !['accounts.google.com', 'https://accounts.google.com'].includes(p.iss) || p.exp * 1000 < now() || !p.sub) throw new Error('bad token');
    } catch (e) { console.error('Google sign-in failed:', e.message); return back(res, st.mode === 'link' ? '/' : '/login', 'Google sign-in didn’t work. Try again.'); }
    const email = p.email_verified ? cleanEmail(p.email) : '';
    const taken = userByGoogle(p.sub);
    if (st.mode === 'link') {
      const me = U().users[st.uid];
      if (!me) return back(res, '/login');
      if (taken && taken[0] !== st.uid) return back(res, '/', `That Google account is already used by someone else on ${APP}.`);
      me.google = p.sub; me.googleEmail = email || undefined;
      if (email && !me.emailVerified && !userByEmail(email)) { me.email = email; me.emailVerified = true; delete me.pendingEmail; }
      saveUsers();
      return back(res, '/', 'Google is connected. You can sign in with it now.');
    }
    if (st.mode === 'join') {
      const inv = liveInvite(st.invite);
      if (taken) { startSession(req, res, taken[0]); return back(res, '/'); }   // already in, just sign in
      if (!inv) return back(res, '/login', 'This invite link has expired or was already used. Ask your friend for a new one.');
      const fields = { name: uniqueName(p.given_name || p.name || (email || '').split('@')[0]), google: p.sub, googleEmail: email || undefined };
      if (email && !userByEmail(email)) { fields.email = email; fields.emailVerified = true; }
      startSession(req, res, createFromInvite(inv, fields));
      return back(res, '/');
    }
    // sign in: Google account already connected, or its email matches a checked email on an account
    let found = taken;
    if (!found && email) { found = userByEmail(email); if (found) { found[1].google = p.sub; found[1].googleEmail = email; saveUsers(); } }
    if (!found) return back(res, '/login', `That Google account isn’t on ${APP}. Ask a friend for an invite link, or sign in another way.`);
    startSession(req, res, found[0]);
    return back(res, '/');
  }

  // ---------- requests ----------
  const handle = async function handle(req, res, url, uid) {
    const p = url.pathname, m = req.method;
    const me = uid && U().users[uid];

    if (p === '/api/auth-options' && m === 'GET') return send(res, 200, { google: !!(G_ID && G_SECRET), email: !!RESEND }), true;

    // invite links
    if (p === '/join' && m === 'GET') return file(res, 'join.html', 'text/html; charset=utf-8'), true;
    if (p === '/api/join' && m === 'POST') {
      const wait = tooManyTries(req); if (wait) return send(res, 429, { error: wait }), true;
      const { token, name, password } = await readBody(req);
      const inv = liveInvite(token);
      if (!inv) { miss(req); return send(res, 410, { error: 'This invite link has expired or was already used. Ask your friend for a new one.' }), true; }
      if (name === undefined) return send(res, 200, { ok: true, from: nameFor(inv.by), google: !!(G_ID && G_SECRET) }), true;
      const n = String(name || '').trim().replace(/\s+/g, ' ');
      if (n.length < 2 || n.length > 30) return send(res, 400, { error: 'Pick a name between 2 and 30 characters.' }), true;
      if (n.includes('@')) return send(res, 400, { error: 'Use a name, not an email. You can add your email after.' }), true;
      if (findUser(n)) return send(res, 409, { error: 'Someone already uses that name. Try adding your last initial.' }), true;
      if (String(password || '').length < 8) return send(res, 400, { error: 'Use at least 8 characters for your password.' }), true;
      startSession(req, res, createFromInvite(inv, { name: n, ...hashPw(String(password)) }));
      return send(res, 200, { ok: true }), true;
    }

    // Google
    if (p === '/auth/google' && m === 'GET') {
      if (!G_ID || !G_SECRET) return back(res, '/login', `Google sign-in isn’t set up on this ${APP} yet.`), true;
      const mode = url.searchParams.get('mode');
      if (mode === 'link') { if (!me) return back(res, '/login'), true; googleStart(req, res, 'link', uid); return true; }
      if (mode === 'join') { googleStart(req, res, 'join', null, url.searchParams.get('invite') || ''); return true; }
      googleStart(req, res, 'login'); return true;
    }
    if (p === '/auth/google/callback' && m === 'GET') { await googleCallback(req, res, url); return true; }

    // forgot password and email sign-in links (always the same answer, so nobody can probe who has an account)
    if ((p === '/api/forgot' || p === '/api/email-link') && m === 'POST') {
      const wait = tooManyTries(req); if (wait) return send(res, 429, { error: wait }), true;
      if (!RESEND) return send(res, 400, { error: `Email isn’t set up on this ${APP} yet. Ask whoever runs it to reset your password.` }), true;
      const { who } = await readBody(req);
      miss(req);   // counts toward the 5-per-15-minutes limit either way
      const found = findUser(String(who || ''));
      const u = found && found[1];
      if (u && u.emailVerified && u.email && !tooSoon(found[0], p)) {
        const reset = p === '/api/forgot';
        const t = makeCode(reset ? 'reset' : 'signin', { uid: found[0] }, reset ? 60 : 15);
        try {
          await mail(u.email, reset ? `Reset your ${APP} password` : `Your ${APP} sign-in link`,
            reset ? [`Hi ${u.name}, someone asked to reset your ${APP} password.`, 'The link works once, for the next hour.']
                  : [`Hi ${u.name}, here’s your link to sign in to ${APP}.`, 'The link works once, for the next 15 minutes.'],
            `${base(req)}/login#${reset ? 'reset' : 'signin'}=${t}`, reset ? 'Pick a new password' : 'Sign in');
        } catch (e) { console.error(e.message); }
      }
      return send(res, 200, { ok: true, note: 'If that account has a checked email, a link is on its way. Check your inbox and spam folder.' }), true;
    }
    if (p === '/api/email-link/use' && m === 'POST') {
      const wait = tooManyTries(req); if (wait) return send(res, 429, { error: wait }), true;
      const { token } = await readBody(req);
      const c = takeCode('signin', String(token || ''));
      if (!c || !U().users[c.uid]) { miss(req); return send(res, 410, { error: 'This sign-in link has expired or was already used. Ask for a new one.' }), true; }
      if (needsCode(c.uid)) return send(res, 200, { need: 'code', ticket: codeTicket(c.uid) }), true;
      startSession(req, res, c.uid);
      return send(res, 200, { ok: true }), true;
    }
    // second step of signing in: the code from the authenticator app, or a backup code
    if (p === '/api/login/code' && m === 'POST') {
      const { ticket, code } = await readBody(req);
      const c = takeCode('2fa', String(ticket || ''), true);
      if (!c || !U().users[c.uid]) return send(res, 410, { error: 'That took too long. Sign in again.' }), true;
      const wait = tooManyTries(req, c.uid); if (wait) return send(res, 429, { error: wait }), true;
      if (!checkCode(c.uid, code)) { miss(req, c.uid); return send(res, 401, { error: 'That code isn’t right. Check your authenticator app, or use a backup code.' }), true; }
      takeCode('2fa', String(ticket));
      startSession(req, res, c.uid);
      return send(res, 200, { ok: true }), true;
    }
    if (p === '/api/reset' && m === 'POST') {
      const wait = tooManyTries(req); if (wait) return send(res, 429, { error: wait }), true;
      const { token, password } = await readBody(req);
      const c = takeCode('reset', String(token || ''), true);
      if (!c || !U().users[c.uid]) { miss(req); return send(res, 410, { error: 'This reset link has expired or was already used. Ask for a new one.' }), true; }
      if (String(password || '').length < 8) return send(res, 400, { error: 'Use at least 8 characters.' }), true;
      takeCode('reset', String(token));
      Object.assign(U().users[c.uid], hashPw(String(password)));
      h.endSessions(c.uid, { assistants: true });   // sign out everywhere else, assistants too
      // With a sign-in code on, a reset link alone doesn't sign you in: you sign in with the new password and the code.
      if (needsCode(c.uid)) return send(res, 200, { ok: true, signin: true }), true;
      startSession(req, res, c.uid);
      return send(res, 200, { ok: true }), true;
    }
    if (p === '/auth/verify' && m === 'GET') {
      const c = takeCode('verify', url.searchParams.get('t') || '');
      const u = c && U().users[c.uid];
      if (!u || u.pendingEmail !== c.email) return back(res, uid ? '/' : '/login', 'That email link has expired. Add your email again to get a new one.'), true;
      if (userByEmail(c.email)) return back(res, uid ? '/' : '/login', 'That email is already on another account.'), true;
      u.email = c.email; u.emailVerified = true; delete u.pendingEmail; saveUsers();
      return back(res, uid ? '/' : '/login', 'Email checked. You can use it to sign in and reset your password.'), true;
    }

    if (!me) return false;   // everything below needs a signed-in person

    if (p === '/api/invite' && m === 'POST') {
      U().invites = U().invites || {};
      for (const [k, v] of Object.entries(U().invites)) if (v.exp < now() - 30 * 864e5) delete U().invites[k];
      const open = Object.values(U().invites).filter(v => v.by === uid && !v.used && v.exp > now()).length;
      if (open >= 20) return send(res, 429, { error: 'You have 20 unused invite links. Wait for some to be used or to expire.' }), true;
      const token = rand(18);
      U().invites[token] = { by: uid, at: now(), exp: now() + 7 * 864e5 };
      saveUsers();
      return send(res, 200, { token, exp: U().invites[token].exp }), true;
    }
    if (p === '/api/account' && m === 'GET') {
      return send(res, 200, { name: me.name, email: me.emailVerified ? me.email : null, pendingEmail: me.pendingEmail || null,
        google: !!me.google, googleEmail: me.googleEmail || null, hasPassword: !!me.hash,
        code: needsCode(uid), backupCodes: me.totp?.on ? (me.totp.backup || []).length : 0,
        options: { google: !!(G_ID && G_SECRET), email: !!RESEND } }), true;
    }
    if (p === '/api/account/email' && m === 'POST') {
      const { email } = await readBody(req);
      const e = cleanEmail(email);
      if (!e) { delete me.pendingEmail; if (me.google || me.hash) { delete me.email; delete me.emailVerified; } saveUsers(); return send(res, 200, { ok: true }), true; }
      if (!okEmail(e)) return send(res, 400, { error: 'That doesn’t look like an email address.' }), true;
      const other = userByEmail(e); if (other && other[0] !== uid) return send(res, 409, { error: 'That email is already on another account.' }), true;
      if (me.emailVerified && me.email === e) return send(res, 200, { ok: true }), true;
      if (!RESEND) return send(res, 400, { error: `Email isn’t set up on this ${APP} yet.` }), true;
      if (tooSoon(uid, 'verify')) return send(res, 429, { error: 'Wait a minute before asking for another email.' }), true;
      me.pendingEmail = e; saveUsers();
      const t = makeCode('verify', { uid, email: e }, 24 * 60);
      try { await mail(e, `Check your email for ${APP}`, [`Hi ${me.name}, tap below to add this email to your ${APP} account.`, 'Then you can sign in with it and reset your password if you forget it.'], `${base(req)}/auth/verify?t=${t}`, 'Yes, this is my email'); }
      catch (err) { return send(res, 502, { error: err.message }), true; }
      return send(res, 200, { ok: true, pending: e }), true;
    }
    if (p === '/api/account/password' && m === 'POST') {
      const { current, next } = await readBody(req);
      if (me.hash) {
        const wait = tooManyTries(req); if (wait) return send(res, 429, { error: wait }), true;
        const h2 = Buffer.from(crypto.scryptSync(String(current || ''), me.salt, 64).toString('hex')), want = Buffer.from(me.hash);
        if (h2.length !== want.length || !crypto.timingSafeEqual(h2, want)) { miss(req); return send(res, 401, { error: 'Your current password isn’t right.' }), true; }
      }
      if (String(next || '').length < 8) return send(res, 400, { error: 'Use at least 8 characters for the new password.' }), true;
      Object.assign(me, hashPw(String(next)));
      const mine = cookies(req)[COOKIE];
      h.endSessions(uid, { keep: mine });
      return send(res, 200, { ok: true }), true;
    }
    if (p === '/api/account/google' && m === 'DELETE') {
      if (!me.hash && !(me.emailVerified && RESEND)) return send(res, 400, { error: 'Set a password first, so you can still sign in.' }), true;
      delete me.google; delete me.googleEmail; saveUsers();
      return send(res, 200, { ok: true }), true;
    }
    // sign-in code: start (get a key for the app), confirm (prove the app works), off, new backup codes
    if (p === '/api/account/code/start' && m === 'POST') {
      if (needsCode(uid)) return send(res, 400, { error: 'A sign-in code is already on.' }), true;
      if (!me.hash && !(me.emailVerified && RESEND)) return send(res, 400, { error: 'A sign-in code goes with a password or an email sign-in link. Set a password first.' }), true;
      const secret = toB32(crypto.randomBytes(20));
      me.totpPending = { secret, at: now() }; saveUsers();
      return send(res, 200, { secret, uri: `otpauth://totp/${encodeURIComponent(APP + ':' + me.name)}?secret=${secret}&issuer=${encodeURIComponent(APP)}&digits=6&period=30` }), true;
    }
    if (p === '/api/account/code/confirm' && m === 'POST') {
      const { code } = await readBody(req), pend = me.totpPending;
      if (needsCode(uid)) return send(res, 400, { error: 'A sign-in code is already on.' }), true;
      if (!pend || now() - pend.at > 30 * 60e3) return send(res, 410, { error: 'That took too long. Start again.' }), true;
      const st = stepFor(pend.secret, String(code || '').replace(/\s/g, '').padEnd(6, 'x').slice(0, 6));
      if (!st) return send(res, 401, { error: 'That code isn’t right. Check the key in your app and try the newest code.' }), true;
      const backup = newBackupCodes();
      me.totp = { on: true, secret: pend.secret, at: now(), last: st, backup: backup.map(c => sha(cleanBackup(c))) };
      delete me.totpPending; saveUsers();
      return send(res, 200, { ok: true, backup }), true;
    }
    if ((p === '/api/account/code/off' || p === '/api/account/code/backup') && m === 'POST') {
      if (!needsCode(uid)) return send(res, 400, { error: 'A sign-in code isn’t on.' }), true;
      const wait = tooManyTries(req, uid); if (wait) return send(res, 429, { error: wait }), true;
      const { code } = await readBody(req);
      if (!checkCode(uid, code)) { miss(req, uid); return send(res, 401, { error: 'That code isn’t right.' }), true; }
      if (p.endsWith('/off')) { codeOff(uid); return send(res, 200, { ok: true }), true; }
      const backup = newBackupCodes(); me.totp.backup = backup.map(c => sha(cleanBackup(c))); saveUsers();
      return send(res, 200, { ok: true, backup }), true;
    }
    if (p === '/api/account/signout-all' && m === 'POST') {
      h.endSessions(uid, { assistants: true }); setCookie(req, res, '', 0);
      return send(res, 200, { ok: true }), true;
    }
    return false;
  };
  handle.base = base;
  // A one-time reset link the owner can hand to someone who is locked out (works for a day).
  handle.resetLink = (req, uid) => `${base(req)}/login#reset=${makeCode('reset', { uid }, 60 * 24)}`;
  Object.assign(handle, { needsCode, checkCode, codeTicket, codeOff, totp });
  return handle;
};
