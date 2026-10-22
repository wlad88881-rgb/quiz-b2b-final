// Service worker нужен только для установки панели как приложения (PWA).
// Раньше он кэшировал страницы и при обрыве связи подсовывал устаревшую версию
// интерфейса — из-за этого на некоторых компьютерах панель «зависала».
// Теперь он ничего не перехватывает: страницы всегда берутся с сервера.
const CACHE_NAME = 'b2b-quiz-shell-v3';

self.addEventListener('install', () => { self.skipWaiting(); });

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) => Promise.all(names.map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

// Обработчик нужен браузеру для установки как приложения; запросы идут напрямую в сеть.
self.addEventListener('fetch', () => {});
