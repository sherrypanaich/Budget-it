// Phone notifications (Web Push) with no extra packages.
// Implements RFC 8291 (message encryption) and RFC 8292 (VAPID sign-in) with Node's crypto.
'use strict';
const crypto = require('crypto');
const fs = require('fs');

const b64u = buf => Buffer.from(buf).toString('base64url');
const fromB64u = s => Buffer.from(String(s), 'base64url');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

// One key pair per install, created on first run and kept in the data folder.
function loadKeys(file) {
  try {
    const k = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (k.publicKey && k.privateJwk) return k;
  } catch {}
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const k = {
    publicKey: b64u(Buffer.concat([Buffer.from([4]), fromB64u(jwk.x), fromB64u(jwk.y)])),
    privateJwk: privateKey.export({ format: 'jwk' })
  };
  fs.writeFileSync(file, JSON.stringify(k), { mode: 0o600 });
  return k;
}

// Encrypt one message for one browser subscription (aes128gcm content coding).
function encrypt(sub, payload) {
  const uaPublic = fromB64u(sub.keys.p256dh), authSecret = fromB64u(sub.keys.auth);
  const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  const prkKey = hmac(authSecret, shared);
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]));
  const salt = crypto.randomBytes(16);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const c = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([c.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), c.final(), c.getAuthTag()]);
  const header = Buffer.alloc(21); salt.copy(header, 0); header.writeUInt32BE(4096, 16); header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, body]);
}

function vapidHeader(keys, endpoint, contact) {
  const aud = new URL(endpoint).origin;
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: contact }));
  const key = crypto.createPrivateKey({ key: keys.privateJwk, format: 'jwk' });
  const sig = crypto.sign('sha256', Buffer.from(head + '.' + claims), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${head}.${claims}.${b64u(sig)}, k=${keys.publicKey}`;
}

// Returns 'ok', 'gone' (subscription expired or made with another key: drop it) or 'error' (try again later; a timeout counts as this).
async function sendOne(keys, sub, message, contact) {
  try {
    const r = await fetch(sub.endpoint, {
      method: 'POST',
      headers: {
        'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream',
        TTL: '86400', Urgency: 'normal', Authorization: vapidHeader(keys, sub.endpoint, contact)
      },
      body: encrypt(sub, JSON.stringify(message)),
      signal: AbortSignal.timeout(10000)   // a push service that hangs must not hold up turning notifications on, or other sends
    });
    // 404/410: the subscription expired. 403: it was made with another sending key (push-keys.json replaced), so it can never work again.
    if (r.status === 404 || r.status === 410 || r.status === 403) return 'gone';
    if (!r.ok) { console.error('push failed', r.status, (await r.text()).slice(0, 200)); return 'error'; }
    return 'ok';
  } catch (e) { console.error('push failed', e.message); return 'error'; }
}

module.exports = { loadKeys, encrypt, sendOne };
