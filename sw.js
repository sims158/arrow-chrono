/* Cache-first service worker with an explicit update handshake.
 *
 * Bump CACHE whenever you change any asset. A new worker installs in the
 * background, then *waits* — it does not take over until the page tells it to.
 * That way a reload never happens underneath someone mid-session; the page
 * shows a prompt and the user decides.
 */
const CACHE = 'arrow-chrono-v10';
const ASSETS = [
  './', './index.html', './app.js', './worklet.js',
  './manifest.webmanifest', './icon-192.v2.png', './icon-512.v2.png', './icon-maskable-512.v2.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then(c =>
      // cache:'reload' bypasses the HTTP cache, so a new worker can never
      // install stale copies of the very files it is supposed to be updating.
      c.addAll(ASSETS.map(u => new Request(u, { cache: 'reload' })))
    )
    // deliberately no skipWaiting() here — the page drives the handover
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;

  e.respondWith(
    caches.match(req).then(hit => {
      if (hit) return hit;
      return fetch(req)
        .then(res => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then(c => c.put(req, copy));
          }
          return res;
        })
        .catch(() => req.mode === 'navigate' ? caches.match('./index.html') : Response.error());
    })
  );
});
