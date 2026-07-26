// The page registers this worker as `service-worker.js?v=<APP_VERSION>`.
// Browsers detect a worker update by byte-comparing the worker URL's
// response, so putting the version in the URL guarantees a new deploy is
// noticed. Deriving the cache name from it means new code never reads an
// old cache.
const APP_VERSION = new URL(self.location).searchParams.get('v') || 'dev';

const SHELL_CACHE_NAME = `dro-canvass-shell-${APP_VERSION}`;
const TILE_CACHE_NAME = 'dro-canvass-tiles-v1';
const TILE_HOST = 'tile.openstreetmap.org';

const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './css/styles.css',
  './css/vendor/maplibre-gl.css',
  './js/version.js',
  './js/app.js',
  './js/export.js',
  './js/db.js',
  './js/hash.js',
  './js/import.js',
  './js/map.js',
  './js/geo.js',
  './js/sheet.js',
  './js/vendor/papaparse.min.js',
  './js/vendor/maplibre-gl.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-192-maskable.png',
  './icons/icon-512-maskable.png',
  './icons/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  // Deliberately no skipWaiting() here. A new worker stays waiting until the
  // walker taps Update, so code never swaps out from under someone standing
  // on a doorstep mid-entry.
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE_NAME);
    // cache:'reload' rather than cache.addAll(): addAll goes through the HTTP
    // cache, so a freshly installed worker could populate its brand-new cache
    // with stale files still inside their max-age window and pin the old build
    // in place. This forces every shell asset to come from the network.
    await Promise.all(APP_SHELL.map(async (url) => {
      const response = await fetch(url, { cache: 'reload' });
      if (response.ok) await cache.put(url, response);
    }));
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key !== SHELL_CACHE_NAME && key !== TILE_CACHE_NAME)
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

async function cacheFirstShell(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok && response.type === 'basic') {
      const cache = await caches.open(SHELL_CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    return cached || Response.error();
  }
}

async function cacheFirstTile(request) {
  const cache = await caches.open(TILE_CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch (err) {
    return Response.error();
  }
}

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // The update check must be able to see past this worker's own cache,
  // otherwise a stale build can never discover that it is stale.
  if (url.searchParams.has('freshcheck')) return;

  if (url.hostname === TILE_HOST) {
    event.respondWith(cacheFirstTile(event.request));
    return;
  }

  event.respondWith(cacheFirstShell(event.request));
});
