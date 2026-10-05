/* GPS Navigation - service worker
 * - App shell + CDN libraries: cached, so the app opens offline
 * - Map tiles (CARTO): cached automatically as you browse, so areas you drive in often are kept
 * - Routing / search (OSRM, Valhalla, Nominatim): always live, never cached
 */
const SHELL_CACHE = 'nav-shell-v1';
const TILE_CACHE  = 'nav-tiles-v1';          // kept across app updates
const MAX_TILES   = 6000;                    // roughly 100-150 MB at most
const TILE_MAX_AGE_MS = 30 * 24 * 3600 * 1000; // refresh a cached tile in the background after 30 days

const SCOPE = self.registration.scope;
const INDEX_URL = new URL('./index.html', SCOPE).href;
const SHELL_FILES = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png'];

const LIVE_HOSTS = [
  'router.project-osrm.org',
  'valhalla1.openstreetmap.de',
  'nominatim.openstreetmap.org'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((c) => c.addAll(SHELL_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter((n) => n.startsWith('nav-shell-') && n !== SHELL_CACHE)
      .map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (LIVE_HOSTS.includes(url.hostname)) return;            // always network

  if (url.hostname.endsWith('.basemaps.cartocdn.com')) {    // map tiles
    event.respondWith(handleTile(event, req, url));
    return;
  }

  if (req.mode === 'navigate') {                            // opening the app
    event.respondWith(handleNavigate(req));
    return;
  }

  event.respondWith(staleWhileRevalidate(event, req));      // libs, fonts, icons...
});

/* ---------- map tiles ---------- */
function tileKey(url) {
  // Same tile is served from subdomains a-d and with an API key query; use one cache key for all.
  return new Request('https://a.basemaps.cartocdn.com' + url.pathname);
}

async function handleTile(event, req, url) {
  const cache = await caches.open(TILE_CACHE);
  const key = tileKey(url);
  const hit = await cache.match(key);

  if (hit) {
    const ts = Number(hit.headers.get('x-cached-at') || 0);
    if (ts && Date.now() - ts > TILE_MAX_AGE_MS) {
      event.waitUntil(fetchAndStoreTile(req, key, cache).catch(() => {}));
    }
    return hit;
  }

  try {
    return await fetchAndStoreTile(req, key, cache, event);
  } catch (e) {
    return new Response('', { status: 504, statusText: 'Offline and tile not cached' });
  }
}

async function fetchAndStoreTile(req, key, cache, event) {
  const res = await fetch(req);
  if (res.ok && res.type !== 'opaque') {
    const copy = res.clone();
    const work = (async () => {
      const blob = await copy.blob();
      await cache.put(key, new Response(blob, {
        status: 200,
        headers: {
          'content-type': copy.headers.get('content-type') || 'image/png',
          'x-cached-at': String(Date.now())
        }
      }));
      if (Math.random() < 0.02) await trimTiles(cache);
    })().catch(() => {});
    if (event) event.waitUntil(work);
  }
  return res;
}

async function trimTiles(cache) {
  const keys = await cache.keys();
  if (keys.length <= MAX_TILES) return;
  const excess = keys.length - MAX_TILES + 300;   // oldest-first (insertion order)
  await Promise.all(keys.slice(0, excess).map((k) => cache.delete(k)));
}

/* ---------- app shell ---------- */
async function handleNavigate(req) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);   // slow network in the car -> use cached copy
    const res = await fetch(req.url, { signal: ctrl.signal, cache: 'no-cache' });
    clearTimeout(timer);
    if (res.ok) cache.put(INDEX_URL, res.clone());
    return res;
  } catch (e) {
    return (await cache.match(INDEX_URL)) || (await cache.match(SCOPE)) || Response.error();
  }
}

async function staleWhileRevalidate(event, req) {
  const cache = await caches.open(SHELL_CACHE);
  const hit = await cache.match(req);
  const network = fetch(req)
    .then((res) => {
      if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
      return res;
    })
    .catch(() => null);

  if (hit) { event.waitUntil(network); return hit; }
  const res = await network;
  return res || new Response('Offline', { status: 503 });
}
