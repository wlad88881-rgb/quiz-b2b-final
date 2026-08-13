const CACHE_NAME = 'b2b-quiz-shell-v2';
const APP_SHELL = [
  '/',
  '/admin',
  '/manifest.json',
  '/manifest-admin.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-admin-192.png',
  '/icons/icon-admin-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

// Стратегия «сеть в приоритете»: данные тестов/сессий всегда свежие с сервера.
// Кеш используется только как запасной вариант при обрыве связи (сам интерфейс
// панели, не результаты тестирования — те без сети всё равно не отправить).
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io/')) return;

  event.respondWith(
    fetch(req)
      .then((res) => {
        const resClone = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, resClone)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req))
  );
});
