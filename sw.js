const CACHE_NAME = 'ledger-shell-v4';
const SHELL_FILES = [
  './index.html',
  './app.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Network-first for the app shell: always fetch the latest version when online,
// only fall back to the cached copy if the network is unavailable (offline use).
// This avoids ever getting stuck on a stale mix of old HTML + new JS (or vice versa).
self.addEventListener('fetch', (event) => {
  const url = event.request.url;
  if (url.includes('script.google.com') || url.includes('googleusercontent.com')) {
    return; // let the network handle live data, no offline caching of API responses
  }
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
