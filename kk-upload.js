'use strict';
// Загрузка казахской версии для заданий: «Чертежи», «Квалитеты», «Тренажёры» (диагностика и акт дефектации).
// Работает по образу тестов: скачиваете Excel «русский | казахский», заполняете, загружаете — перед сохранением
// показывается предпросмотр. Перевод хранится как словарь «русский текст → казахский» для конкретного задания
// и приходит студентам вместе с ответами сервера (поле kkDict). Он главнее встроенного словаря и автоперевода.
const vm = require('vm');
const fs = require('fs');
const path = require('path');

const KK_SPECIAL = /[әіңғүұқөһӘІҢҒҮҰҚӨҺ]/;
const KINDS = {
  drawing:   { store: 'drawingTasks',  link: 'drawingTaskId',  title: 'Чертежи' },
  tolerance: { store: 'toleranceTasks', link: 'toleranceTaskId', title: 'Квалитеты' },
  lab:       { store: 'labs',          link: 'labId',          title: 'Тренажёр диагностики' },
  defect:    { store: 'defectTasks',   link: 'setId',          title: 'Акт дефектации' }
};
const wsNorm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const hasWords = (s) => /[А-Яа-яЁё]{2,}/.test(String(s).replace(/мкм|мм|мин/g, ''));
const mapKey = (companyId, kind, id) => companyId + '|' + kind + '|' + id;

// ---------- тексты задания, которые можно перевести ----------
function collect(kind, t) {
  const out = []; const seen = new Set();
  const add = (where, text) => {
    const n = wsNorm(text);
    if (!n || !hasWords(n) || seen.has(n)) return;
    seen.add(n); out.push({ where, text: n });
  };
  if (!t) return out;
  add('Название', t.title); add('Вступление', t.intro);
  if (kind === 'drawing') {
    add('Завершение', t.outro);
    (t.questions || []).forEach((q, i) => {
      add('Пункт ' + (i + 1), q.text); add('Блок', q.section); add('Блок (методика)', q.sectionText);
      add('Подсказка к пункту ' + (i + 1), q.hint); add('Ключ к пункту ' + (i + 1), q.correctAnswer);
    });
  } else if (kind === 'tolerance') {
    (t.methodology || []).forEach((m, i) => add('Методика, шаг ' + (i + 1), typeof m === 'string' ? m : (m && m.text)));
  } else if (kind === 'lab') {
    (t.faults || []).forEach((f) => {
      add('Диагноз', f.label); add('Пояснение к диагнозу «' + wsNorm(f.label).slice(0, 40) + '»', f.explain);
      (f.variations || []).forEach((v) => {
        add('Случай', v.title);
        add('Вибрация', v.vibration && v.vibration.desc); add('Температура', v.temp && v.temp.desc); add('Звук', v.sound && v.sound.desc);
      });
    });
  } else if (kind === 'defect') {
    (t.tasks || []).forEach((k, i) => {
      const w = 'Акт ' + (i + 1);
      add(w + ': название', k.title); add(w + ': узел', k.node);
      add(w + ': вибрация', k.vibration && k.vibration.desc); add(w + ': температура', k.temp && k.temp.desc); add(w + ': звук', k.sound && k.sound.desc);
      if (k.diag) { add(w + ': вопрос о неисправности', k.diag.question); (k.diag.options || []).forEach((o) => add(w + ': вариант диагноза', o && o.text)); }
      if (k.cause) { add(w + ': вопрос о причине', k.cause.question); (k.cause.options || []).forEach((o) => add(w + ': вариант причины', o && o.text)); }
      add(w + ': пояснение', k.explain); add(w + ': эталонное описание', k.reference);
    });
  }
  return out;
}

// ---------- встроенный словарь (тот же, что у студенческих страниц) ----------
let builtin = null;
function loadBuiltin(publicDir) {
  if (builtin) return builtin;
  try {
    const sb = { localStorage: { getItem: () => null, setItem: () => {} }, MutationObserver: function () { this.observe = () => {}; }, NodeFilter: {}, console };
    sb.document = { readyState: 'loading', addEventListener: () => {}, documentElement: { setAttribute: () => {} } };
    sb.window = sb; vm.createContext(sb);
    ['kk-dict-trainers.js', 'kk-i18n.js'].forEach((f) => {
      const p = path.join(publicDir, f);
      if (fs.existsSync(p)) vm.runInContext(fs.readFileSync(p, 'utf8'), sb, { filename: f });
    });
    builtin = sb.KK_I18N || { lookup: () => null };
  } catch (e) { console.warn('[kk-upload] встроенный словарь недоступен:', e.message); builtin = { lookup: () => null }; }
  return builtin;
}

module.exports = function registerKkUpload(ctx) {
  const { app, db, checkAuth, upload, XLSX, safeGet, sendXlsx, publicDir } = ctx;

  const visible = (data, kind, id, companyId) => {
    const t = safeGet(data[KINDS[kind].store] || {}, id);
    return t && (t.shared || !t.companyId || t.companyId === companyId) ? t : null;
  };
  const savedMap = (data, companyId, kind, id) => {
    const e = data.kkMaps && data.kkMaps[mapKey(companyId, kind, id)];
    return (e && e.map) || {};
  };

  // 1) переводы задания приходят студентам вместе с ответами сервера
  app.use(/^\/api\/(lab|drawing|tolerance|defect)-sessions\/([^/]+)\/(info|join|submit|result)$/, (req, res, next) => {
    const kind = req.params[0], code = req.params[1];
    const origJson = res.json.bind(res);
    res.json = function (body) {
      try {
        if (res.statusCode === 200 && body && typeof body === 'object' && !Array.isArray(body)) {
          const d = db.load();
          const s = safeGet(d.sessions, code);
          if (s && s.type === kind) {
            const e = d.kkMaps && d.kkMaps[mapKey(s.companyId, kind, s[KINDS[kind].link])];
            if (e && e.map && Object.keys(e.map).length) { body.kkDict = e.map; res.setHeader('X-KK-Dict', '1'); }
          }
        }
      } catch (e) { /* перевод — не критичный */ }
      return origJson(body);
    };
    next();
  });

  // 2) сводка: у каких заданий уже загружен перевод
  app.get('/api/kk/summary', checkAuth, (req, res) => {
    const data = db.load(); const out = {};
    Object.keys(data.kkMaps || {}).forEach((k) => {
      const [cid, kind, id] = k.split('|');
      if (cid === req.companyId) out[kind + ':' + id] = { count: Object.keys(data.kkMaps[k].map || {}).length, updatedAt: data.kkMaps[k].updatedAt };
    });
    res.json(out);
  });

  // 3) шаблон RU | KZ
  app.get('/api/kk/:kind/:id/template', checkAuth, (req, res) => {
    const kind = req.params.kind;
    if (!KINDS[kind]) return res.status(404).json({ error: 'Неизвестный раздел' });
    const data = db.load();
    const t = visible(data, kind, req.params.id, req.companyId);
    if (!t) return res.status(404).json({ error: 'Задание не найдено' });
    const saved = savedMap(data, req.companyId, kind, req.params.id);
    const KK = loadBuiltin(publicDir);
    const rows = collect(kind, t).map((r, i) => {
      let kz = saved[r.text] || '';
      if (!kz) { const b = KK.lookup ? KK.lookup(r.text) : null; if (typeof b === 'string' && b && b !== r.text) kz = b; }
      return [i + 1, r.where, r.text, kz];
    });
    const ws = XLSX.utils.aoa_to_sheet([['№', 'Где встречается', 'Русский текст (не менять)', 'Қазақша (заполните)'], ...rows]);
    ws['!cols'] = [{ wch: 5 }, { wch: 32 }, { wch: 70 }, { wch: 70 }];
    const help = XLSX.utils.aoa_to_sheet([
      ['Как заполнять'],
      ['1. Заполняйте только колонку D «Қазақша». Колонку C с русским текстом не меняйте: по ней перевод привязывается к заданию.'],
      ['2. Строки можно сортировать и фильтровать. Пустая ячейка в D — для этого текста останется встроенный/автоматический перевод.'],
      ['3. Если в D уже что-то стоит, это сохранённый ранее или встроенный перевод: проверьте его и при необходимости исправьте.'],
      ['4. Загрузите файл кнопкой «📥 KZ Excel» — перед сохранением откроется предпросмотр. Загрузка заменяет прежний загруженный перевод целиком.']
    ]);
    help['!cols'] = [{ wch: 130 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'RU-KZ'); XLSX.utils.book_append_sheet(wb, help, 'Инструкция');
    sendXlsx(res, wb, 'kz-' + kind + '.xlsx');
  });

  // 4) загрузка с предпросмотром (?dry=1 — только показать)
  app.post('/api/kk/:kind/:id/import', checkAuth, upload.single('file'), async (req, res) => {
    const kind = req.params.kind;
    if (!KINDS[kind]) return res.status(404).json({ error: 'Неизвестный раздел' });
    const data = db.load();
    const t = visible(data, kind, req.params.id, req.companyId);
    if (!t) return res.status(404).json({ error: 'Задание не найдено' });
    if (!req.file) return res.status(400).json({ error: 'Нужен Excel-файл' });
    let rows;
    try {
      const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
      rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' });
    } catch (e) { return res.status(400).json({ error: 'Не удалось прочитать Excel' }); }
    if (!rows.length) return res.status(400).json({ error: 'Пустой файл' });
    const head = rows[0].map((c) => String(c || '').toLowerCase());
    let ruCol = head.findIndex((h) => h.includes('русск')); let kzCol = head.findIndex((h) => h.includes('қазақ') || h.includes('kz'));
    if (ruCol < 0) ruCol = 2; if (kzCol < 0) kzCol = 3;
    const fileMap = new Map(); const fileRows = [];
    for (let i = 1; i < rows.length; i++) {
      const ru = wsNorm(rows[i][ruCol]); const kk = wsNorm(rows[i][kzCol]);
      if (!ru) continue;
      fileRows.push({ line: i + 1, ru, kk });
      if (!fileMap.has(ru)) fileMap.set(ru, kk);
    }
    const items = collect(kind, t);
    const out = []; const apply = {};
    const sum = { total: items.length, ok: 0, warn: 0, empty: 0 };
    items.forEach((it, i) => {
      const kk = fileMap.has(it.text) ? fileMap.get(it.text) : '';
      const issues = [];
      let status = 'ok';
      if (!fileMap.has(it.text)) { status = 'empty'; issues.push('Нет строки в файле'); }
      else if (!kk) { status = 'empty'; issues.push('Казахский текст не заполнен'); }
      else {
        if (kk === it.text) issues.push('Совпадает с русским — возможно, не переведено');
        else if (kk.length >= 20 && !KK_SPECIAL.test(kk)) issues.push('Нет казахских букв — похоже на русский текст');
        if (issues.length) status = 'warn';
        apply[it.text] = kk;
      }
      sum[status]++;
      out.push({ n: i + 1, where: it.where, ru: it.text, kk, status, issues });
    });
    const known = new Set(items.map((x) => x.text));
    const extra = fileRows.filter((r) => !known.has(r.ru)).map((r) => ({ line: r.line, text: r.ru.slice(0, 100) }));
    const saved = Object.keys(savedMap(data, req.companyId, kind, req.params.id)).length;
    const applicable = sum.ok + sum.warn;
    const preview = { summary: sum, applicable, saved, extra, rows: out, canApply: applicable > 0 };
    if (req.query.dry === '1') return res.json({ ok: true, dryRun: true, ...preview });
    if (!applicable) return res.status(400).json({ error: 'В файле нет ни одного заполненного казахского текста.' });
    await db.update((d) => {
      if (!d.kkMaps) d.kkMaps = {};
      d.kkMaps[mapKey(req.companyId, kind, req.params.id)] = { kind, taskId: req.params.id, companyId: req.companyId, map: apply, updatedAt: Date.now() };
    });
    res.json({ ok: true, count: applicable, empty: sum.empty });
  });

  // 5) удалить загруженный перевод (останутся встроенный словарь и автоперевод)
  app.delete('/api/kk/:kind/:id', checkAuth, async (req, res) => {
    if (!KINDS[req.params.kind]) return res.status(404).json({ error: 'Неизвестный раздел' });
    await db.update((d) => { if (d.kkMaps) delete d.kkMaps[mapKey(req.companyId, req.params.kind, req.params.id)]; });
    res.json({ ok: true });
  });
};
