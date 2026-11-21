const CACHE_NAME = 'photoswiper-v7';
const CACHE_PREFIX = 'photoswiper-';
const ASSETS = [
  './',
  './index.html',
  './app.js',
  './style.css',
  './tailwind.css',
  './ia-alert.js',
  './ia-alert.css',
  './duplicate-worker.js',
  './thumbnail-worker.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];
const ASSET_PATHS = new Set(ASSETS.map(path => new URL(path, self.registration.scope).pathname));

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter(name => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
      .map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  if (!ASSET_PATHS.has(new URL(request.url).pathname)) return;

  const cachePromise = caches.open(CACHE_NAME);
  const cachedPromise = cachePromise.then(cache => cache.match(request, { ignoreSearch: true }));
  const updatePromise = cachePromise.then(cache => fetch(request).then(async response => {
    if (response.ok) {
      try { await cache.put(request, response.clone()); } catch (_) { /* retain the network response */ }
    }
    return response;
  }));
  // Register the background refresh while the fetch event is still dispatching.
  event.waitUntil(updatePromise.then(() => undefined, () => undefined));
  event.respondWith(cachedPromise.then(cached => {
    if (cached) return cached;
    return updatePromise.catch(async error => {
      if (request.mode === 'navigate') {
        const cache = await cachePromise;
        const shell = await cache.match(new URL('./index.html', self.registration.scope).href);
        if (shell) return shell;
      }
      throw error;
    });
  }));
});
