const BUILD_VERSION = 'v12.0.0-20260922';
const CACHE_NAME = `endpaper-shell-${BUILD_VERSION}`;
const RUNTIME_CACHE_NAME = `endpaper-runtime-${BUILD_VERSION}`;
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/app.css',
  '/app.js',
  '/jszip.min.js',
  '/epub.min.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
});

async function cachedRangeResponse(request, cached) {
  const range = request.headers.get('range');
  if (!range || !cached) return cached;
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) return new Response(null, { status: 416 });
  const blob = await cached.blob();
  let start = match[1] ? Number(match[1]) : Math.max(0, blob.size - Number(match[2] || 0));
  let end = match[2] && match[1] ? Number(match[2]) : blob.size - 1;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start > end || start >= blob.size) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${blob.size}` } });
  }
  end = Math.min(end, blob.size - 1);
  return new Response(blob.slice(start, end + 1), { status: 206, headers: { 'Content-Type': cached.headers.get('Content-Type') || 'application/epub+zip', 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${blob.size}`, 'Accept-Ranges': 'bytes' } });
}

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
    const cacheRequest = new Request(e.request.url, { credentials: 'same-origin' });
    e.respondWith(
      fetch(e.request).then((fetchRes) => {
        if (fetchRes && fetchRes.status === 200) {
          const resClone = fetchRes.clone();
          caches.open(RUNTIME_CACHE_NAME).then((cache) => cache.put(cacheRequest, resClone)).catch(() => {});
        }
        return fetchRes;
      }).catch(() => {
        return caches.open(RUNTIME_CACHE_NAME).then(async cache => cachedRangeResponse(e.request, await cache.match(cacheRequest)));
      })
    );
    return;
  }

  // Personal API payloads are deliberately not placed in a shared service-
  // worker cache. Return an explicit offline response instead of pretending a
  // cache fallback exists (and avoid leaking one account's data to another).
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(
      fetch(e.request).catch(() => new Response(JSON.stringify({ error: 'Offline' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      }))
    );
    return;
  }

  // External lookups (currently the optional dictionary service) are managed
  // by the bounded application cache rather than an unbounded CacheStorage.
  if (url.origin !== location.origin) {
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
