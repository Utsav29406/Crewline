/*
 * Crewline service worker. It makes the site installable as a phone app and shows a friendly page when there's
 * no internet. It never caches API data (attendance must always be live); pages and files come from the network.
 */
const CACHE = 'crewline-shell-v1';
const OFFLINE = '/offline.html';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll([OFFLINE, '/icon-192.png'])));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || req.mode !== 'navigate') return; // only page loads; everything else goes straight through
  event.respondWith(fetch(req).catch(() => caches.match(OFFLINE)));
});
