// ── Production Dashboard service worker ──────────────────────────────
// NETWORK-FIRST strategy: always tries the network first so updates show
// up immediately; falls back to cache only when offline.
//
// TO FORCE EVERYONE ONTO A FRESH COPY: bump CACHE_VERSION below (e.g. v2 → v3).
// Old caches are deleted on activate.
const CACHE_VERSION = 'v2';
const CACHE_NAME = 'prod-dash-' + CACHE_VERSION;

// Install immediately, don't wait for old tabs to close
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

// Clean up old version caches on activate
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Only handle GET requests
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Never cache API/data calls — always go to network (these must be live)
  const livePaths = ['/pco', '/userdata', '/homelayout', '/accounts', '/auth',
                     '/users', '/inventory', '/announcements', '/patch', '/signalflow',
                     '/config.js'];
  if (livePaths.some(p => url.pathname.startsWith(p))) {
    return; // let the browser handle it normally (network)
  }

  // Network-first for everything else (HTML, icons, manifest)
  event.respondWith(
    fetch(req)
      .then(res => {
        // Cache a copy of successful same-origin responses for offline fallback
        if (res && res.status === 200 && url.origin === self.location.origin) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then(c => c || caches.match('/')))
  );
});
