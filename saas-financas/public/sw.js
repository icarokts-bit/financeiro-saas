self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(clients.claim());
});

self.addEventListener('fetch', (event) => {
  // Apenas permite que o browser trate o site como app instalável PWA
  event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
});