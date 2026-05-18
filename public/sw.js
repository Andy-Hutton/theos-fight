const CACHE_NAME = 'theos-fight-v1';
const ASSETS = [
  '/',
  '/index.html',
  '/about.html',
  '/contact.html',
  '/privacy.html',
  '/feedback.html',
  '/testimonials.html',
  '/monkey.webp',
  '/favicon.ico'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
});

self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request).then(response => {
      return response || fetch(event.request);
    })
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)))
    )
  );
});