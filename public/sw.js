const BUILD_VERSION = 'v10.11.0-20260922';
const CACHE_NAME = `endpaper-shell-${BUILD_VERSION}`;
const RUNTIME_CACHE_NAME = `endpaper-runtime-${BUILD_VERSION}`;
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/app.css',
  '/app.js',
  '/epub.min.js',
  '/manifest.json'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME && key !== RUNTIME_CACHE_NAME)
          .map((key) => caches.delete(key))
      );
    }).then(() => self.clients.claim())
  );
});

// Listen for active book messages to prune runtime cache for non-active books
let activeBookId = null;
self.addEventListener('message', async (e) => {
  if (e.data && e.data.type === 'SET_CURRENT_BOOK') {
    activeBookId = e.data.bookId;
    if (activeBookId) {
      try {
        const cache = await caches.open(RUNTIME_CACHE_NAME);
        const requests = await cache.keys();
        for (const req of requests) {
          const url = req.url;
          if (url.includes('/api/books/') && !url.includes(`/api/books/${activeBookId}/`)) {
            await cache.delete(req);
          }
        }
      } catch (err) {
        console.error('[SW] Error pruning runtime cache:', err);
      }
    }
  } else if (e.data && e.data.type === 'CLEAR_RUNTIME_CACHE') {
    activeBookId = null;
    try {
      await caches.delete(RUNTIME_CACHE_NAME);
    } catch (_) {}
  } else if (e.data && e.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);

  // Book files and covers: Network first with runtime cache fallback and background cache write
  if (url.pathname.includes('/api/books/') && (url.pathname.includes('/file') || url.pathname.includes('/cover'))) {
    e.respondWith(
      fetch(e.request).then((fetchRes) => {
        if (fetchRes && fetchRes.status === 200) {
          const resClone = fetchRes.clone();
          caches.open(RUNTIME_CACHE_NAME).then((cache) => cache.put(e.request, resClone)).catch(() => {});
        }
        return fetchRes;
      }).catch(() => {
        return caches.open(RUNTIME_CACHE_NAME).then((cache) => cache.match(e.request));
      })
    );
    return;
  }

  // Other API endpoints: Network first, fallback to offline cache if present
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(
      fetch(e.request).catch(() => caches.match(e.request))
    );
    return;
  }

  // External CDNs & Google Fonts: Stale-While-Revalidate with caching
  if (url.origin !== location.origin) {
    e.respondWith(
      caches.match(e.request).then((cachedRes) => {
        const fetchPromise = fetch(e.request).then((fetchRes) => {
          if (fetchRes && fetchRes.status === 200) {
            const resClone = fetchRes.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(e.request, resClone)).catch(() => {});
          }
          return fetchRes;
        }).catch(() => null);
        return cachedRes || fetchPromise;
      })
    );
    return;
  }

  // Core App Shell (/, /index.html, /app.js, /app.css, /manifest.json):
  // NETWORK-FIRST with CACHE FALLBACK.
  // When online, users instantly receive the latest updates without manual hard refresh or stale cache locks.
  // When offline, seamlessly serves the cached shell assets.
  e.respondWith(
    fetch(e.request).then((fetchRes) => {
      if (fetchRes && fetchRes.status === 200) {
        const resClone = fetchRes.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(e.request, resClone)).catch(() => {});
      }
      return fetchRes;
    }).catch(() => {
      return caches.match(e.request).then((cachedRes) => {
        if (cachedRes) return cachedRes;
        if (e.request.mode === 'navigate') {
          return caches.match('/index.html').then((r) => r || caches.match('/'));
        }
        return null;
      });
    })
  );
});