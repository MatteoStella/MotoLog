const CACHE = 'motolog-v3';
const SHELL = ['./', './index.html', './app.js', './manifest.json', './icon-192.png', './icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
  );
  self.clients.claim();
});

// Network-first per restare aggiornati: cache:'no-store' forza il bypass
// della cache HTTP del browser, non solo della Cache Storage del SW.
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request, { cache: 'no-store' })
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});

self.addEventListener('periodicsync', (e) => {
  if (e.tag === 'km-reminder') {
    e.waitUntil(self.registration.showNotification('MyGarage', {
      body: 'Ricordati di aggiornare i km dei tuoi mezzi',
      icon: './icon-192.png'
    }));
  }
});
