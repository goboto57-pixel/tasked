// tasked service worker: offline shell and static assets
const CACHE = 'tasked-v11';
const CORE = [
  '/', '/offline.html', '/lesson.html', '/student.html', '/teacher.html',
  '/css/style.css', '/css/corporate.css',
  '/js/icons.js', '/js/theme.js', '/js/i18n.js', '/js/voice.js',
  '/img/logo.svg', '/img/favicon.svg',
  '/manifest.webmanifest',
];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // API requests require live data and are never persisted by the service worker.
  if (url.pathname.startsWith('/api/')) {
    // Never serve cached account or progress responses: they can be stale or
    // belong to a different session. APIs should fail clearly while offline.
    if (url.pathname.startsWith('/api/auth/') || url.pathname.startsWith('/api/me') || url.pathname.startsWith('/api/student') || url.pathname.startsWith('/api/classes')) return;
    e.respondWith(fetch(request));
    return;
  }
  // pages: network first, offline fallback
  if (request.mode === 'navigate') {
    e.respondWith(fetch(request).catch(() => caches.match('/offline.html')));
    return;
  }
  // static: cache first
  e.respondWith(
    caches.match(request).then((hit) => hit || fetch(request).then((r) => {
      if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(request, copy)); }
      return r;
    }))
  );
});
