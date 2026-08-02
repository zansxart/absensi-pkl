// Service worker minimal — syarat agar browser menawarkan "Install App" (PWA).
// Strategi network-first: data absensi selalu fresh dari server;
// cache hanya dipakai sebagai fallback saat server sedang tidak terjangkau.
const CACHE = 'pkl-absensi-v1';
const PRECACHE = ['/img/logo-192.png', '/img/logo-512.png', '/css/style.css'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Hanya proses request HTTP & HTTPS (abaikan chrome-extension, API, & non-GET)
  if (!url.protocol.startsWith('http')) return;
  if (url.pathname.startsWith('/api/')) return;
  if (e.request.method !== 'GET') return;

  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res.ok && (res.type === 'basic' || res.type === 'cors')) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
