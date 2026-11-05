/* Автоповтор запросов, пока бесплатный сервер «просыпается».
   Render усыпляет сервис без трафика: первые секунды запросы возвращают 502/503/504 или обрываются.
   Раньше приходилось нажимать кнопки по несколько раз — теперь страница сама повторяет запрос и
   показывает понятное сообщение. Повторяются только запросы к /api и /health. */
(function () {
  'use strict';
  if (window.__wakePatched || !window.fetch) return;
  window.__wakePatched = true;
  var orig = window.fetch.bind(window);
  var banner = null, active = 0, hideTimer = null;

  function show(text) {
    if (!document.body) return;
    if (!banner) {
      banner = document.createElement('div');
      banner.setAttribute('data-no-i18n', '1');
      banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483000;background:#fff4e0;color:#7a4a00;' +
        'border-bottom:2px solid #F07C00;padding:9px 12px;text-align:center;font:600 14px system-ui,sans-serif;';
      document.body.appendChild(banner);
    }
    banner.textContent = text;
  }
  function hide() {
    if (banner && active === 0) { banner.remove(); banner = null; }
  }

  function isOurs(url) {
    if (!url) return false;
    var path = url;
    try { var u = new URL(url, location.href); if (u.origin !== location.origin) return false; path = u.pathname; } catch (e) { return false; }
    return path.indexOf('/api/') === 0 || path === '/health';
  }

  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    if (!isOurs(url)) return orig(input, init);
    var method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
    var idempotent = method === 'GET' || method === 'HEAD';
    var MAX = idempotent ? 24 : 8;           // ~1–2 минуты ожидания для чтения, меньше — для записи
    var attempt = 0;
    var counted = false;

    function done() { if (counted) { counted = false; active--; } hideTimer = setTimeout(hide, 300); }
    function retry(reason) {
      attempt++;
      if (!counted) { counted = true; active++; }
      clearTimeout(hideTimer);
      show('⏳ Сервер просыпается или занят — подождите, пробую снова (' + attempt + ')…');
      var delay = Math.min(1000 + attempt * 700, 5000);
      return new Promise(function (r) { setTimeout(r, delay); }).then(once);
    }
    function once() {
      return orig(input, init).then(function (res) {
        var st = res.status;
        // 502/503 — запрос до приложения не дошёл (сервер просыпается / база подключается): можно повторять всё.
        // 504 — неизвестно, обработан ли запрос, поэтому повторяем только чтение.
        var retriable = st === 502 || st === 503 || (st === 504 && idempotent);
        if (retriable && attempt < MAX) return retry('status ' + st);
        done();
        try {
          // Перевод заданий, загруженный преподавателем (kk-upload): сервер помечает такие ответы заголовком.
          if (res.headers && res.headers.get('X-KK-Dict') === '1') {
            res.clone().json().then(function (d) {
              if (d && d.kkDict) {
                window.__kkSession = Object.assign(window.__kkSession || {}, d.kkDict);
                window.dispatchEvent(new Event('kkdict'));
              }
            }).catch(function () {});
          }
        } catch (e) {}
        return res;
      }, function (err) {
        if (idempotent && attempt < MAX && !(init && init.signal && init.signal.aborted)) return retry('network');
        done();
        throw err;
      });
    }
    return once();
  };
})();
