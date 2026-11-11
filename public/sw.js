// Budget it service worker: lets phones install the app, keeps a copy of the app and the
// latest data so it opens away from wifi, and shows notifications.
// The page and its code are always asked for fresh first, so an update reaches phones on their next open;
// these copies are only for when the laptop can't be reached. A new name here drops the old copies.
const SHELL = 'budget-it-shell-v3', DATA = 'budget-it-data-v1';
// The page's own code too (ops.js makes changes offline): without it a phone opened offline can't change anything
const CODE = ['/budget.js', '/ops.js', '/sample.js', '/qr.js'];
const PRECACHE = ['/manifest.webmanifest', '/icon-192.png', '/icon-512.png', ...CODE];
// The page too, so a phone that goes offline right after the first visit still opens it. Only the app itself:
// signed out, '/' is a redirect to the sign-in page, and that's never kept as the app.
const keepPage = c => fetch('/', { credentials: 'same-origin' }).then(r => cacheable(r) && c.put('/', r)).catch(() => {});
self.addEventListener('install', e => { e.waitUntil(caches.open(SHELL).then(c => Promise.all([...PRECACHE.map(u => c.add(u).catch(() => {})), keepPage(c)]))); self.skipWaiting(); });
self.addEventListener('activate', e => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== SHELL && k !== DATA) await caches.delete(k);
  await self.clients.claim();
})()));

// If the laptop can't be reached and nothing is saved yet, show a friendly page instead of a browser error.
const OFFLINE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Budget it</title><body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#F5F1E8;color:#14112A;font:16px system-ui,sans-serif;text-align:center;padding:24px">
<div><div style="font-size:2.2rem;font-weight:800">Can’t reach Budget it</div>
<p>Check your internet, or the laptop at home might be off or asleep.</p>
<button onclick="location.reload()" style="font:inherit;font-weight:700;padding:12px 20px;border:2.5px solid #14112A;border-radius:12px;background:#FFD23F;box-shadow:3px 3px 0 #14112A">Try again</button></div>`;

const cacheable = r => r && r.ok && !r.redirected && r.type === 'basic';
const fromCache = r => { if (!r) return r; const h = new Headers(r.headers); h.set('X-From-Cache', '1'); return new Response(r.body, { status: r.status, statusText: r.statusText, headers: h }); };
// Network first, remember the answer, fall back to the remembered one. A 5xx page that isn't the app's own
// (the tunnel's "502 Bad Gateway" while the laptop is off or asleep) counts as not reaching it.
const unreachable = r => r.status >= 500 && !/json/.test(r.headers.get('content-type') || '');
async function networkFirst(req, cacheName, key) {
  const c = await caches.open(cacheName);
  try {
    const r = await fetch(req); if (cacheable(r)) c.put(key || req, r.clone());
    if (unreachable(r)) { const hit = await c.match(key || req); if (hit) return fromCache(hit); }
    return r;
  } catch (e) { const hit = await c.match(key || req); if (hit) return fromCache(hit); throw e; }
}
// Serve what we have, refresh it quietly for next time.
async function staleWhileRevalidate(req, cacheName) {
  const c = await caches.open(cacheName), hit = await c.match(req);
  const net = fetch(req).then(r => { if (cacheable(r)) c.put(req, r.clone()); return r; }).catch(() => null);
  return hit || (await net) || Response.error();
}
const READ_API = /^\/api\/(state|auth-options|push\/key)(\?|$)/;
self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (url.origin !== self.location.origin || req.method !== 'GET') return;
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      const offline = () => new Response(OFFLINE, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      try { const r = await networkFirst(req, SHELL, url.pathname === '/' || url.pathname === '/index.html' ? '/' : undefined); return unreachable(r) ? offline() : r; }
      catch { return (await caches.match('/')) || offline(); }
    })());
    return;
  }
  if (CODE.includes(url.pathname)) return e.respondWith(networkFirst(req, SHELL));
  if (/^\/(art\/|icon|apple-touch-icon|manifest\.webmanifest)/.test(url.pathname)) return e.respondWith(staleWhileRevalidate(req, SHELL));
  if (READ_API.test(url.pathname + url.search)) return e.respondWith(networkFirst(req, DATA));
});

self.addEventListener('message', e => {
  if (e.data === 'clear-data') e.waitUntil(caches.delete(DATA));
});

self.addEventListener('push', e => {
  let m = {};
  try { m = e.data ? e.data.json() : {}; } catch { m = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(m.title || 'Budget it', {
    body: m.body || '', tag: m.tag, renotify: !!m.tag, icon: '/icon-192.png', badge: '/icon-192.png', data: { url: m.url || '/' }
  }));
});

// The browser renewed this phone's subscription: tell the laptop the new one (the old one is dropped when it's refused).
self.addEventListener('pushsubscriptionchange', e => e.waitUntil((async () => {
  const sub = e.newSubscription || (e.oldSubscription && await self.registration.pushManager.subscribe(e.oldSubscription.options));
  if (sub) await fetch('/api/push/subscribe', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...sub.toJSON(), quiet: true }) });
})().catch(() => {})));

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) if ('focus' in c) { c.navigate && c.url !== new URL(url, self.location).href && c.navigate(url); return c.focus(); }
    return self.clients.openWindow(url);
  }));
});
