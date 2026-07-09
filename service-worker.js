// Service worker: caches the "app shell" (everything needed to run the
// app itself) so the reader keeps working with no network connection.
// Your actual books live in IndexedDB, not here - they're already local
// and don't need caching by this file.
//
// NOTE: bump CACHE_NAME (e.g. 'v1' -> 'v2') any time you change one of the
// PRECACHE_URLS files and redeploy, so returning visitors pick up the new
// version instead of the old cached one.
const CACHE_NAME = 'ereader-shell-v2';

const PRECACHE_URLS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/base.css',
  './css/library.css',
  './css/reader.css',
  './css/chat.css',
  './js/app.js',
  './js/constants.js',
  './js/db.js',
  './js/library.js',
  './js/reader.js',
  './js/chat.js',
  './js/context-builder.js',
  './js/summarizer.js',
  './js/claude-api.js',
  './js/settings.js',
  './vendor/epub.min.js',
  './vendor/jszip.min.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS))
  );
  // Activate this new service worker as soon as it's installed, rather
  // than waiting for all tabs of the old version to close.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // Only handle simple GETs - anything else (e.g. the API calls this app
  // makes to Anthropic) should just go over the network untouched.
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;

      return fetch(event.request)
        .then((response) => {
          // Cache a copy of anything same-origin we successfully fetch,
          // so it's available offline next time too.
          const responseCopy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseCopy));
          return response;
        })
        .catch(() => {
          // Offline and not cached: for page navigations, fall back to the
          // cached app shell so the SPA can still boot and route itself.
          if (event.request.mode === 'navigate') {
            return caches.match('./index.html');
          }
          throw new Error('Network request failed and no cache entry exists');
        });
    })
  );
});
