// Offline support + updates.
// Network-first, and it always asks the server whether a file changed (cache: 'no-cache',
// a cheap ETag check), so new versions show up instead of a copy GitHub Pages told the
// browser to keep for 10 minutes. Falls back to the cached copy when offline.
//
// Bump VERSION on every release; it must match APP_VERSION in app.js.
const VERSION = '11';
const CACHE = `session-timer-v${VERSION}`;
const ASSETS = [
  './', 'index.html', 'style.css', 'app.js', 'manifest.json',
  'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    // Fetch by URL: a navigation Request can't be re-created with new options.
    fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' })
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(async () =>
        (await caches.match(req, { ignoreSearch: true })) ||
        (req.mode === 'navigate' ? caches.match('index.html') : Response.error()))
  );
});

// ---- Hourly "Still studying?" reminders (sent by the push server in worker/) ----
self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch (err) { /* show a generic reminder */ }
  e.waitUntil(self.registration.showNotification(data.title || 'Session Timer', {
    body: data.body || '',
    tag: `checkin-${data.sessionId || ''}`, // a newer reminder replaces the older one
    renotify: true,
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
    data,
  }));
});

// Tap on the notification: focus the open app and ask it to show the check-in,
// or open the app with ?checkin=<session>.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const sessionId = (e.notification.data && e.notification.data.sessionId) || '';
  e.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if ('focus' in client) {
        client.postMessage({ type: 'checkin', sessionId });
        return client.focus();
      }
    }
    return self.clients.openWindow(new URL(`./?checkin=${encodeURIComponent(sessionId)}`, self.registration.scope).href);
  })());
});
