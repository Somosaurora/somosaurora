/* Service worker de la app (PWA) de Somos Aurora.
   Solo muestra una página "sin conexión" cuando no hay internet. No guarda copias de la web,
   del formulario ni de /api: todo lo demás va siempre a la red, así nunca se ve una versión vieja.
   Si se cambia offline.html, subir la versión de CACHE para que se actualice. */
const CACHE = 'aurora-offline-v1';
const OFFLINE = '/offline.html';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.add(OFFLINE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.mode !== 'navigate') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/admin') || url.pathname.startsWith('/api/')) return;
  e.respondWith(fetch(req).catch(() => caches.match(OFFLINE)));
});
