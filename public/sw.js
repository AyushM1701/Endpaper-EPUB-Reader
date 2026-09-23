const BUILD_VERSION = 'v15.0.3-20260923';
const CACHE_NAME = `endpaper-shell-${BUILD_VERSION}`;
const RUNTIME_CACHE_NAME = `endpaper-runtime-${BUILD_VERSION}`;
const PINNED_BOOK_CACHE_NAME = 'endpaper-pinned-books';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  `/app.css?v=${BUILD_VERSION}`,
  `/app.js?v=${BUILD_VERSION}`,
  `/mobile.js?v=${BUILD_VERSION}`,
  `/jszip.min.js?v=${BUILD_VERSION}`,
  `/epub.min.js?v=${BUILD_VERSION}`,
  '/fonts/AtkinsonHyperlegible-Regular.woff2',
  '/fonts/AtkinsonHyperlegible-Bold.woff2',
  '/fonts/AtkinsonHyperlegible-Italic.woff2',
  '/fonts/AtkinsonHyperlegible-BoldItalic.woff2',
  '/fonts/WorkSans-Regular.woff2',
  '/fonts/WorkSans-Bold.woff2',
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
          .filter((key) => key !== CACHE_NAME && key !== RUNTIME_CACHE_NAME && key !== PINNED_BOOK_CACHE_NAME)
          .map((key) => caches.delete(key))
      );
    }).then(() => self.clients.claim())
  );
});

// Listen for active book messages to prune runtime cache for non-active books
let activeBookId = null;
self.addEventListener('message', (e) => {
  e.waitUntil(handleMessage(e).catch(error => {
    console.error('[SW] Message failed:', error);
    e.ports[0]?.postMessage({ ok: false, error: String(error?.message || error) });
  }));
});

async function handleMessage(e) {
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
  } else if (e.data && e.data.type === 'PIN_BOOK') {
    const bookId = e.data.bookId;
    if (!bookId) return;
    const cache = await caches.open(PINNED_BOOK_CACHE_NAME);
    const fileRequest = new Request(`/api/books/${encodeURIComponent(bookId)}/file`, { credentials: 'same-origin' });
    const coverRequest = new Request(`/api/books/${encodeURIComponent(bookId)}/cover`, { credentials: 'same-origin' });
    if (e.data.fileBlob instanceof Blob && e.data.fileBlob.size > 0) {
      await cache.put(fileRequest, new Response(e.data.fileBlob, { headers: { 'Content-Type': 'application/epub+zip' } }));
    } else {
      const runtime = await caches.open(RUNTIME_CACHE_NAME);
      const cached = await runtime.match(fileRequest);
      if (cached) await cache.put(fileRequest, cached);
    }
    if (e.data.coverBlob instanceof Blob && e.data.coverBlob.size > 0) {
      await cache.put(coverRequest, new Response(e.data.coverBlob));
    }
    const confirmed = Boolean(await cache.match(fileRequest));
    e.ports[0]?.postMessage({ ok: confirmed, bookId });
  } else if (e.data && e.data.type === 'UNPIN_BOOK') {
    const bookId = e.data.bookId;
    if (!bookId) return;
    const cache = await caches.open(PINNED_BOOK_CACHE_NAME);
    await Promise.all(['file', 'cover'].map(suffix => cache.delete(`/api/books/${bookId}/${suffix}`)));
    e.ports[0]?.postMessage({ ok: true, bookId });
  } else if (e.data && e.data.type === 'GET_PINNED_BOOKS') {
    const cache = await caches.open(PINNED_BOOK_CACHE_NAME);
    const requests = await cache.keys();
    const bookIds = [...new Set(requests.map(request => /\/api\/books\/([^/]+)\/file$/.exec(new URL(request.url).pathname)?.[1]).filter(Boolean))];
    e.ports[0]?.postMessage({ ok: true, bookIds });
  } else if (e.data && e.data.type === 'CLEAR_RUNTIME_CACHE') {
    activeBookId = null;
    try {
      await caches.delete(RUNTIME_CACHE_NAME);
    } catch (_) {}
  } else if (e.data && e.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
}

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);

  // Book files and covers: Network first with runtime cache fallback and background cache write
  if (url.pathname.includes('/api/books/') && (url.pathname.includes('/file') || url.pathname.includes('/cover'))) {
    const cacheRequest = new Request(e.request.url, { credentials: 'same-origin' });
    e.respondWith(
      fetch(e.request).then(async (fetchRes) => {
        if (fetchRes && fetchRes.status === 200) {
          const resClone = fetchRes.clone();
          caches.open(RUNTIME_CACHE_NAME).then((cache) => cache.put(cacheRequest, resClone)).catch(() => {});
        }
        // Authentication and missing-book responses must reach the page. A
        // temporary server failure can use a previously downloaded copy.
        if (fetchRes.status >= 500) {
          const pinned = await caches.open(PINNED_BOOK_CACHE_NAME);
          const pinnedResponse = await pinned.match(cacheRequest);
          if (pinnedResponse) return cachedRangeResponse(e.request, pinnedResponse);
          const runtime = await caches.open(RUNTIME_CACHE_NAME);
          const runtimeResponse = await runtime.match(cacheRequest);
          if (runtimeResponse) return cachedRangeResponse(e.request, runtimeResponse);
        }
        return fetchRes;
      }).catch(() => {
        return caches.open(PINNED_BOOK_CACHE_NAME).then(async pinned => {
          const pinnedResponse = await pinned.match(cacheRequest);
          if (pinnedResponse) return cachedRangeResponse(e.request, pinnedResponse);
          const runtime = await caches.open(RUNTIME_CACHE_NAME);
          return cachedRangeResponse(e.request, await runtime.match(cacheRequest));
        });
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

  // Keep HTML and scripts from one installed build together until the new
  // worker activates. The registration script explicitly checks for updates.
  e.respondWith(
    caches.open(CACHE_NAME).then(async cache => {
      const cached = e.request.mode === 'navigate'
        ? (await cache.match('/index.html') || await cache.match('/'))
        : await cache.match(e.request);
      if (cached) return cached;
      const response = await fetch(e.request);
      if (response.ok) await cache.put(e.request, response.clone());
      return response;
    })
  );
});
