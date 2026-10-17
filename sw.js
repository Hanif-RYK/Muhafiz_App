// Muhafiz Service Worker v3
// - App page (HTML): served instantly from cache, then refreshed from the network in
//   the background. If a newer version was downloaded, open pages are told so they
//   can offer an "Update" button. Opening the app never waits for the internet.
// - Static assets: stale-while-revalidate.
const CACHE_NAME = 'muhafiz-v3';
const ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png'
];

// Install — cache all assets (bypass the HTTP cache so we store the latest files)
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS.map(u => new Request(u, { cache: 'reload' }))))
  );
  self.skipWaiting();
});

// Activate — delete old caches
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function putInCache(request, response) {
  if (response && response.status === 200 && response.type === 'basic') {
    const clone = response.clone();
    caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
  }
  return response;
}

// Tell open pages a new version is saved. The page that triggered this check may
// still be loading, so the message is repeated a few times (the page ignores repeats).
async function notifyUpdated() {
  for (const wait of [0, 1500, 4000]) {
    await new Promise(r => setTimeout(r, wait));
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    clients.forEach(c => c.postMessage({ type: 'APP_UPDATED' }));
  }
}

// Download the latest page; store it (as both "/" and "/index.html") only if it changed
async function refreshPage(req, cached) {
  // A navigation Request can't be re-fetched with options, so fetch its URL instead
  const res = await fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' });
  if (!res || res.status !== 200 || res.type !== 'basic') return res;
  const newText = await res.clone().text();
  const oldText = cached ? await cached.text() : null;  // `cached` is our own copy (see below)
  if (newText !== oldText) {
    const cache = await caches.open(CACHE_NAME);
    const headers = { 'Content-Type': res.headers.get('Content-Type') || 'text/html; charset=utf-8' };
    await Promise.all(['/', '/index.html'].map(u => cache.put(u, new Response(newText, { headers }))));
    if (oldText !== null) await notifyUpdated();
  }
  return res;
}

self.addEventListener('fetch', e => {
  const req = e.request;
  // Only handle same-origin GET requests
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  const isPage = req.mode === 'navigate' || req.destination === 'document';
  if (isPage) {
    e.respondWith((async () => {
      const cached = (await caches.match(req, { ignoreSearch: true })) || (await caches.match('/index.html'));
      // Copy the saved page BEFORE handing it to the browser — once the browser starts
      // reading a response, its body can no longer be read or cloned for comparison.
      const update = refreshPage(req, cached ? cached.clone() : null).catch(() => null);
      if (cached) { e.waitUntil(update); return cached; }  // instant open, update in background
      return (await update) || Response.error();           // very first visit: needs the network
    })());
    return;
  }

  e.respondWith(
    caches.match(req).then(cached => {
      const network = fetch(req).then(res => putInCache(req, res)).catch(() => cached);
      return cached || network;
    })
  );
});
