/* Кнопки «⬇ Шаблон KZ» и «📥 KZ Excel» для заданий: Чертежи, Квалитеты, Тренажёры.
   Работает через атрибуты data-kk-tpl="раздел:id" и data-kk-up="раздел:id" — подключать на страницах преподавателя. */
(function () {
  'use strict';
  var summary = {};

  function token() { return localStorage.getItem('b2bToken') || sessionStorage.getItem('itemAnalysisToken') || ''; }
  function api(url, opts) {
    opts = opts || {};
    opts.headers = Object.assign({ 'x-company-id': token() }, opts.headers || {});
    return fetch(url, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, status: r.status, d: d }; });
    });
  }
  function el(tag, css, text) { var e = document.createElement(tag); if (css) e.style.cssText = css; if (text !== undefined) e.textContent = text; return e; }
  function parse(v) { var i = v.indexOf(':'); return { kind: v.slice(0, i), id: v.slice(i + 1) }; }

  // ----- значки «перевод загружен» на кнопках -----
  function decorate() {
    document.querySelectorAll('[data-kk-up]').forEach(function (b) {
      if (!b.dataset.kkBase) b.dataset.kkBase = b.textContent.replace(/\s*·.*$/, '');
      var info = summary[b.getAttribute('data-kk-up')];
      var want = info ? b.dataset.kkBase + ' · ✓ ' + info.count : b.dataset.kkBase;
      if (b.textContent !== want) b.textContent = want;
    });
  }
  function refresh() { return api('/api/kk/summary').then(function (r) { if (r.ok) summary = r.d || {}; decorate(); }); }
  var t = null;
  new MutationObserver(function () { clearTimeout(t); t = setTimeout(decorate, 250); }).observe(document.documentElement, { childList: true, subtree: true });

  // ----- клики -----
  document.addEventListener('click', function (e) {
    var tpl = e.target.closest && e.target.closest('[data-kk-tpl]');
    if (tpl) { e.preventDefault(); var a = parse(tpl.getAttribute('data-kk-tpl')); location.href = '/api/kk/' + a.kind + '/' + encodeURIComponent(a.id) + '/template?companyId=' + encodeURIComponent(token()); return; }
    var up = e.target.closest && e.target.closest('[data-kk-up]');
    if (up) { e.preventDefault(); pick(parse(up.getAttribute('data-kk-up'))); }
  });

  function pick(a) {
    var inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.xlsx,.xls'; inp.style.display = 'none';
    inp.addEventListener('change', function () {
      var f = inp.files && inp.files[0]; inp.remove(); if (!f) return;
      var fd = new FormData(); fd.append('file', f);
      api('/api/kk/' + a.kind + '/' + encodeURIComponent(a.id) + '/import?dry=1', { method: 'POST', body: fd }).then(function (r) {
        if (!r.ok) { alert((r.d && r.d.error) || 'Не удалось прочитать файл'); return; }
        preview(a, f, r.d);
      }).catch(function () { alert('Сеть недоступна'); });
    });
    document.body.appendChild(inp); inp.click();
  }

  function preview(a, file, d) {
    var old = document.getElementById('kk-up-overlay'); if (old) old.remove();
    var ov = el('div', 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:99999;display:flex;align-items:flex-start;justify-content:center;padding:16px;overflow:auto;');
    ov.id = 'kk-up-overlay';
    var box = el('div', 'background:var(--card,#fff);color:var(--text,#222);border-radius:14px;max-width:980px;width:100%;padding:16px;box-shadow:0 10px 40px rgba(0,0,0,.35);font:14px system-ui,sans-serif;');
    ov.appendChild(box);
    box.appendChild(el('h3', 'margin:0 0 6px;', 'Предпросмотр казахской версии задания'));
    box.appendChild(el('div', 'font-size:13px;opacity:.75;margin-bottom:10px;', 'Перевод привязывается к русскому тексту задания и показывается студентам при выборе KZ. Загрузка заменяет ранее загруженный перевод целиком.'));
    var s = d.summary, chips = el('div', 'display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px;');
    [['✅ Готово: ' + s.ok, '#12a150'], ['⚠ С замечаниями: ' + s.warn, '#d9822b'], ['⬜ Не заполнено: ' + s.empty, '#667085']].forEach(function (x) {
      chips.appendChild(el('span', 'border:1px solid ' + x[1] + ';color:' + x[1] + ';border-radius:12px;padding:2px 10px;font-size:13px;', x[0]));
    });
    box.appendChild(chips);
    if (s.empty) box.appendChild(el('div', 'background:#eef4fb;color:#2c3e50;border-radius:8px;padding:8px 10px;margin-bottom:8px;font-size:13px;', 'Незаполненные тексты не пропадут: для них студенты увидят встроенный или автоматический перевод.'));
    if (d.extra && d.extra.length) box.appendChild(el('div', 'background:#fff4e0;color:#8a5200;border-radius:8px;padding:8px 10px;margin-bottom:8px;font-size:13px;', '⚠ В файле ' + d.extra.length + ' строк(и), которых нет в задании, — они будут пропущены (например, строка ' + d.extra[0].line + ').'));

    var only = document.createElement('input'); only.type = 'checkbox'; only.checked = (s.warn + s.empty) > 0 && s.ok > 0 ? false : false;
    var lbl = el('label', 'display:flex;gap:6px;align-items:center;font-size:13px;margin-bottom:8px;');
    lbl.appendChild(only); lbl.appendChild(document.createTextNode('Показывать только строки с замечаниями или пустые'));
    box.appendChild(lbl);
    var wrap = el('div', 'max-height:52vh;overflow:auto;border:1px solid rgba(128,128,128,.3);border-radius:8px;'); box.appendChild(wrap);
    var COL = { ok: '#12a150', warn: '#d9822b', empty: '#667085' }, ICO = { ok: '✅', warn: '⚠', empty: '⬜' };
    function draw() {
      wrap.textContent = '';
      var tbl = el('table', 'width:100%;border-collapse:collapse;font-size:13px;');
      var hr = el('tr'); ['№', '', 'Где', 'Русский', 'Қазақша', 'Замечания'].forEach(function (h) { hr.appendChild(el('th', 'position:sticky;top:0;background:var(--card,#fff);text-align:left;padding:6px 8px;border-bottom:1px solid rgba(128,128,128,.3);', h)); });
      tbl.appendChild(hr);
      d.rows.forEach(function (r) {
        if (only.checked && r.status === 'ok') return;
        var tr = el('tr', 'vertical-align:top;border-bottom:1px solid rgba(128,128,128,.2);');
        tr.appendChild(el('td', 'padding:6px 8px;', String(r.n)));
        tr.appendChild(el('td', 'padding:6px 4px;color:' + COL[r.status] + ';', ICO[r.status]));
        tr.appendChild(el('td', 'padding:6px 8px;opacity:.7;min-width:110px;', r.where));
        tr.appendChild(el('td', 'padding:6px 8px;min-width:220px;', r.ru));
        tr.appendChild(el('td', 'padding:6px 8px;min-width:220px;' + (r.kk ? '' : 'opacity:.5;'), r.kk || '—'));
        var is = el('td', 'padding:6px 8px;min-width:140px;color:' + COL[r.status] + ';');
        r.issues.forEach(function (x) { is.appendChild(el('div', '', x)); });
        tr.appendChild(is); tbl.appendChild(tr);
      });
      wrap.appendChild(tbl);
    }
    only.addEventListener('change', draw); draw();

    var actions = el('div', 'display:flex;gap:8px;justify-content:flex-end;margin-top:12px;flex-wrap:wrap;');
    var cancel = el('button', 'padding:8px 14px;border:1px solid rgba(128,128,128,.4);border-radius:8px;background:transparent;color:inherit;cursor:pointer;', 'Отмена');
    cancel.onclick = function () { ov.remove(); };
    if (d.saved) {
      var del = el('button', 'padding:8px 14px;border:1px solid #d64545;border-radius:8px;background:transparent;color:#d64545;cursor:pointer;', 'Удалить загруженный перевод (' + d.saved + ')');
      del.onclick = function () {
        if (!confirm('Удалить загруженный казахский перевод этого задания? Останутся встроенный словарь и автоперевод.')) return;
        api('/api/kk/' + a.kind + '/' + encodeURIComponent(a.id), { method: 'DELETE' }).then(function () { ov.remove(); refresh(); alert('Загруженный перевод удалён.'); });
      };
      actions.appendChild(del);
    }
    var apply = el('button', 'padding:8px 16px;border:0;border-radius:8px;background:#F07C00;color:#fff;cursor:pointer;font-weight:600;', 'Применить (' + d.applicable + ' из ' + s.total + ')');
    apply.disabled = !d.canApply; if (!d.canApply) apply.style.opacity = '.45';
    apply.onclick = function () {
      apply.disabled = true; apply.textContent = 'Сохраняю…';
      var fd = new FormData(); fd.append('file', file);
      api('/api/kk/' + a.kind + '/' + encodeURIComponent(a.id) + '/import', { method: 'POST', body: fd }).then(function (r) {
        if (!r.ok) { alert((r.d && r.d.error) || 'Не удалось сохранить'); apply.disabled = false; apply.textContent = 'Применить'; return; }
        ov.remove(); refresh();
        alert('Казахская версия загружена: ' + r.d.count + ' текстов' + (r.d.empty ? ' (не заполнено: ' + r.d.empty + ')' : '') + '. Студенты увидят её при выборе KZ.');
      }).catch(function () { alert('Сеть недоступна'); apply.disabled = false; apply.textContent = 'Применить'; });
    };
    actions.appendChild(cancel); actions.appendChild(apply); box.appendChild(actions);
    ov.addEventListener('click', function (e) { if (e.target === ov) ov.remove(); });
    document.body.appendChild(ov);
  }

  if (token()) refresh(); else document.addEventListener('DOMContentLoaded', function () { setTimeout(refresh, 800); });
  window.kkAdminRefresh = refresh;
})();
