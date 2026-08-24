// Cache the shell so the app opens without a network. BLE needs no network at all.
// Network-first: a served update is picked up immediately, and the cache is only
// a fallback for going offline. Cache-first would strand you on a stale build.
const CACHE = 'hammer-v1';
const SHELL = [
  '.', 'index.html', 'style.css', 'app.js', 'trainer.js', 'ftms.js',
  'workout.js', 'manifest.json', 'icon.svg',
  'diagnostics.html', 'diagnostics.js', 'diagnostics.css',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req)),
  );
});
