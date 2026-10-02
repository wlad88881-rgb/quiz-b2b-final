// Модуль «Акт дефектации»: тренажёры с выбором диагноза/причины и рукописным описанием.
// Подключается из server.js одной строкой (см. README_DEFECT.md). Данные хранятся в db.defectTasks
// (наборы тренажёров) и в общих db.sessions с type: 'defect'.

const path = require('path');
const XLSX = require('xlsx');
const { SOUNDS, SCHEMES, schemeSvg, SEED_DEFECT_SET } = require('./defect-content');

const MAX_IMAGE_LEN = 1500000;
const MAX_TASKS = 60;
const OWN_IMAGE_MARK = '[своё изображение]';

const COLS = [
  ['id', 'ID'], ['title', 'Название'], ['node', 'Узел'], ['scheme', 'Схема'],
  ['vibValue', 'Вибрация (знач.)'], ['vibDesc', 'Вибрация (описание)'],
  ['tempValue', 'Температура (знач.)'], ['tempDesc', 'Температура (описание)'],
  ['soundType', 'Тип звука'], ['soundDesc', 'Описание звука'],
  ['diagQ', 'Вопрос (диагноз)'], ['d1', 'Диагноз 1'], ['d2', 'Диагноз 2'], ['d3', 'Диагноз 3'], ['d4', 'Диагноз 4'], ['diagOk', 'Правильный диагноз №'],
  ['causeQ', 'Вопрос (причина)'], ['c1', 'Причина 1'], ['c2', 'Причина 2'], ['c3', 'Причина 3'], ['c4', 'Причина 4'], ['causeOk', 'Правильная причина №'],
  ['explain', 'Пояснение'], ['reference', 'Эталон описания (для преподавателя)']
];

module.exports = function registerDefect(ctx) {
  const { app, db, io, checkAuth, safeGet, nanoid, participantId, QRCode, getBaseUrl,
    joinLimiter, upload, trialBlockedForCompany, incrementSubmissions } = ctx;

  const shuffle = (a) => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const str = (v, n) => (v === undefined || v === null ? '' : String(v)).trim().slice(0, n || 500);
  const getSets = (data) => data.defectTasks || {};
  const visibleSet = (data, id, companyId) => {
    const s = safeGet(getSets(data), id);
    return s && (s.shared || s.companyId === companyId) ? s : null;
  };
  const cleanImage = (img) => (typeof img === 'string' && img.startsWith('data:image/') && img.length <= MAX_IMAGE_LEN ? img : null);

  function schemeUrl(t) {
    if (t.image) return t.image;
    if (t.scheme && SCHEMES.some(s => s.id === t.scheme)) return `/api/defect-scheme/${t.scheme}.svg`;
    if (/^https?:\/\//i.test(t.scheme || '')) return t.scheme;
    return null;
  }

  // ---------- проверка и нормализация тренажёра (из JSON или строки Excel) ----------
  function soundId(v) {
    const s = str(v).toLowerCase();
    if (!s) return null;
    const hit = SOUNDS.find(x => x.id === s || x.label.toLowerCase() === s);
    return hit ? hit.id : null;
  }

  function buildTask(r, rowLabel) {
    const err = (m) => ({ error: `${rowLabel}: ${m}` });
    if (!str(r.title)) return err('не заполнено «Название»');
    if (!str(r.node)) return err('не заполнено «Узел»');
    if (!str(r.vibValue) || !str(r.tempValue)) return err('заполните значения вибрации и температуры');
    const sid = soundId(r.soundType);
    if (!sid) return err(`неизвестный «Тип звука» «${str(r.soundType)}» (допустимые: ${SOUNDS.map(s => s.id).join(', ')})`);
    const dOpts = ['d1', 'd2', 'd3', 'd4'].map(k => str(r[k], 300));
    const dFilled = dOpts.filter(Boolean).length;
    if (dFilled < 3 || dOpts.slice(0, dFilled).some(x => !x)) return err('нужно 3–4 варианта диагноза подряд, без пропусков');
    const dOk = parseInt(r.diagOk, 10);
    if (!(dOk >= 1 && dOk <= dFilled)) return err(`«Правильный диагноз №» должен быть от 1 до ${dFilled}`);
    if (!str(r.explain)) return err('не заполнено «Пояснение»');

    const cOpts = ['c1', 'c2', 'c3', 'c4'].map(k => str(r[k], 300));
    const cFilled = cOpts.filter(Boolean).length;
    let cause = null;
    if (cFilled > 0) {
      if (cFilled < 3 || cOpts.slice(0, cFilled).some(x => !x)) return err('нужно 3–4 варианта причины подряд, без пропусков (или оставьте все пустыми)');
      const cOk = parseInt(r.causeOk, 10);
      if (!(cOk >= 1 && cOk <= cFilled)) return err(`«Правильная причина №» должна быть от 1 до ${cFilled}`);
      cause = {
        question: str(r.causeQ, 300) || 'Какова наиболее вероятная причина?',
        options: cOpts.slice(0, cFilled).map((t, i) => ({ id: 'o' + (i + 1), text: t })),
        correct: 'o' + cOk
      };
    }
    let scheme = str(r.scheme, 500);
    let keepImage = false;
    if (scheme === OWN_IMAGE_MARK) { keepImage = true; scheme = ''; }
    else if (scheme && !SCHEMES.some(s => s.id === scheme) && !/^https?:\/\//i.test(scheme)) {
      return err(`неизвестная «Схема» «${scheme}» (допустимые: ${SCHEMES.map(s => s.id).join(', ')}, ссылка http(s) или пусто)`);
    }
    return {
      keepImage,
      task: {
        id: str(r.id, 40) || '',
        title: str(r.title, 200), node: str(r.node, 200), scheme,
        vibration: { value: str(r.vibValue, 80), desc: str(r.vibDesc, 300) },
        temp: { value: str(r.tempValue, 80), desc: str(r.tempDesc, 300) },
        sound: { type: sid, desc: str(r.soundDesc, 300) },
        diag: {
          question: str(r.diagQ, 300) || 'Какая неисправность наиболее вероятна?',
          options: dOpts.slice(0, dFilled).map((t, i) => ({ id: 'o' + (i + 1), text: t })),
          correct: 'o' + dOk
        },
        cause,
        explain: str(r.explain, 1000),
        reference: str(r.reference, 2000)
      }
    };
  }

  function taskToRow(t) {
    const row = {};
    const d = t.diag.options, c = t.cause ? t.cause.options : [];
    row.id = t.id; row.title = t.title; row.node = t.node;
    row.scheme = t.image ? OWN_IMAGE_MARK : (t.scheme || '');
    row.vibValue = t.vibration.value; row.vibDesc = t.vibration.desc;
    row.tempValue = t.temp.value; row.tempDesc = t.temp.desc;
    row.soundType = t.sound.type; row.soundDesc = t.sound.desc;
    row.diagQ = t.diag.question;
    for (let i = 0; i < 4; i++) row['d' + (i + 1)] = d[i] ? d[i].text : '';
    row.diagOk = parseInt(t.diag.correct.slice(1), 10);
    row.causeQ = t.cause ? t.cause.question : '';
    for (let i = 0; i < 4; i++) row['c' + (i + 1)] = c[i] ? c[i].text : '';
    row.causeOk = t.cause ? parseInt(t.cause.correct.slice(1), 10) : '';
    row.explain = t.explain; row.reference = t.reference;
    return row;
  }

  function setToWorkbook(set) {
    const aoa = [COLS.map(c => c[1])].concat(set.tasks.map(t => { const r = taskToRow(t); return COLS.map(c => r[c[0]]); }));
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = COLS.map(c => ({ wch: Math.max(14, Math.min(40, c[1].length + 4)) }));
    const wsMeta = XLSX.utils.aoa_to_sheet([['Название', set.title], ['Вводная', set.intro || '']]);
    wsMeta['!cols'] = [{ wch: 14 }, { wch: 80 }];
    const ref = [['Типы звука (столбец «Тип звука»)', '']].concat(SOUNDS.map(s => [s.id, s.label]))
      .concat([['', ''], ['Схемы (столбец «Схема»)', '']]).concat(SCHEMES.map(s => [s.id, s.label]))
      .concat([['', ''], ['Также в «Схеме» можно указать ссылку http(s) на картинку; значение «' + OWN_IMAGE_MARK + '» сохраняет загруженное в панели фото.', '']]);
    const wsRef = XLSX.utils.aoa_to_sheet(ref);
    wsRef['!cols'] = [{ wch: 36 }, { wch: 40 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Тренажёры');
    XLSX.utils.book_append_sheet(wb, wsMeta, 'Комплект');
    XLSX.utils.book_append_sheet(wb, wsRef, 'Справочник');
    return wb;
  }

  function sendXlsx(res, wb, filename) {
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  }

  // ---------- справочники и схемы ----------
  app.get('/api/defect-meta', checkAuth, (req, res) => res.json({ sounds: SOUNDS, schemes: SCHEMES.map(({ id, label }) => ({ id, label })) }));

  app.get('/api/defect-scheme/:key.svg', (req, res) => {
    const svg = schemeSvg(req.params.key);
    if (!svg) return res.status(404).send('Схема не найдена');
    res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(svg);
  });

  // ---------- наборы тренажёров ----------
  app.get('/api/defect-sets', checkAuth, (req, res) => {
    const data = db.load();
    res.json(Object.values(getSets(data))
      .filter(s => s.shared || s.companyId === req.companyId)
      .map(s => ({ id: s.id, title: s.title, intro: s.intro, taskCount: s.tasks.length, shared: !!s.shared })));
  });

  app.get('/api/defect-sets/:id', checkAuth, (req, res) => {
    const set = visibleSet(db.load(), req.params.id, req.companyId);
    if (!set) return res.status(404).json({ error: 'Комплект не найден' });
    res.json({ ...set, tasks: set.tasks.map(t => ({ ...t, image: undefined, hasImage: !!t.image, schemeUrl: schemeUrl(t) })) });
  });

  app.post('/api/defect-sets/:id/clone', checkAuth, async (req, res) => {
    const src = visibleSet(db.load(), req.params.id, req.companyId);
    if (!src) return res.status(404).json({ error: 'Комплект не найден' });
    const id = participantId();
    const copy = { ...JSON.parse(JSON.stringify(src)), id, companyId: req.companyId, shared: false, title: src.title + ' (копия)', createdAt: Date.now() };
    await db.update((d) => { if (!d.defectTasks) d.defectTasks = {}; d.defectTasks[id] = copy; });
    res.json({ id });
  });

  app.delete('/api/defect-sets/:id', checkAuth, async (req, res) => {
    await db.update((d) => {
      const s = safeGet(getSets(d), req.params.id);
      if (s && !s.shared && s.companyId === req.companyId) {
        delete d.defectTasks[req.params.id];
        Object.keys(d.sessions).forEach(code => {
          const ss = d.sessions[code];
          if (ss.type === 'defect' && ss.setId === req.params.id && ss.companyId === req.companyId) delete d.sessions[code];
        });
      }
    });
    res.json({ ok: true });
  });

  // Своё изображение/фото узла (клиент присылает уже сжатый data URL).
  app.put('/api/defect-sets/:id/tasks/:tid/image', checkAuth, async (req, res) => {
    const img = req.body.image === null ? null : cleanImage(req.body.image);
    if (req.body.image !== null && !img) return res.status(400).json({ error: 'Картинка слишком большая или неверный формат' });
    const ok = await db.update((d) => {
      const s = safeGet(getSets(d), req.params.id);
      if (!s || s.shared || s.companyId !== req.companyId) return false;
      const t = s.tasks.find(x => x.id === req.params.tid);
      if (!t) return false;
      if (img) t.image = img; else delete t.image;
      return true;
    });
    if (!ok) return res.status(404).json({ error: 'Тренажёр не найден (общие комплекты сначала скопируйте)' });
    res.json({ ok: true });
  });

  // ---------- Excel ----------
  app.get('/api/defect-template', checkAuth, (req, res) => sendXlsx(res, setToWorkbook(SEED_DEFECT_SET), 'shablon_trenazhery.xlsx'));

  app.get('/api/defect-sets/:id/export', checkAuth, (req, res) => {
    const set = visibleSet(db.load(), req.params.id, req.companyId);
    if (!set) return res.status(404).send('Комплект не найден');
    sendXlsx(res, setToWorkbook(set), 'trenazhery_' + set.id + '.xlsx');
  });

  app.post('/api/defect-sets/import', checkAuth, upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });
    let wb;
    try { wb = XLSX.read(req.file.buffer, { type: 'buffer' }); } catch (e) { return res.status(400).json({ error: 'Не удалось прочитать файл. Нужен .xlsx' }); }
    const sheet = wb.Sheets['Тренажёры'] || wb.Sheets[wb.SheetNames[0]];
    const raw = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
    const byHeader = {};
    COLS.forEach(([k, h]) => { byHeader[h] = k; });
    const rows = raw.map(r => { const o = {}; Object.keys(r).forEach(h => { const k = byHeader[String(h).trim()]; if (k) o[k] = r[h]; }); return o; })
      .map((o, i) => ({ o, line: i + 2 })).filter(x => Object.values(x.o).some(v => String(v).trim() !== ''));
    if (!rows.length) return res.status(400).json({ error: 'В файле нет строк с тренажёрами. Скачайте «Шаблон» и заполните его.' });
    if (rows.length > MAX_TASKS) return res.status(400).json({ error: `Слишком много тренажёров (максимум ${MAX_TASKS})` });

    const errors = [], parsed = [], ids = new Set();
    rows.forEach(({ o, line }) => {
      const r = buildTask(o, `Строка ${line}`);
      if (r.error) return errors.push(r.error);
      if (!r.task.id) r.task.id = 't' + (parsed.length + 1);
      if (ids.has(r.task.id)) return errors.push(`Строка ${line}: повторяющийся ID «${r.task.id}»`);
      ids.add(r.task.id); parsed.push(r);
    });
    if (errors.length) return res.status(400).json({ error: 'Найдены ошибки, ничего не загружено', errors: errors.slice(0, 50) });

    let metaTitle = '', metaIntro = '';
    const meta = wb.Sheets['Комплект'];
    if (meta) {
      const m = XLSX.utils.sheet_to_json(meta, { header: 1, defval: '' });
      m.forEach(r => { if (String(r[0]).trim() === 'Название') metaTitle = str(r[1], 200); if (String(r[0]).trim() === 'Вводная') metaIntro = str(r[1], 1000); });
    }
    const mode = ['append', 'replace'].includes(req.body.mode) ? req.body.mode : 'new';

    const result = await db.update((d) => {
      if (!d.defectTasks) d.defectTasks = {};
      let set;
      if (mode === 'new') {
        const id = participantId();
        set = d.defectTasks[id] = { id, companyId: req.companyId, shared: false, title: metaTitle || str(req.file.originalname.replace(/\.xlsx?$/i, ''), 200) || 'Импортированный комплект', intro: metaIntro, tasks: [], createdAt: Date.now() };
      } else {
        set = safeGet(d.defectTasks, req.body.setId);
        if (!set || set.shared || set.companyId !== req.companyId) return null;
        if (mode === 'replace') { if (metaTitle) set.title = metaTitle; if (metaIntro) set.intro = metaIntro; }
      }
      const oldById = {};
      set.tasks.forEach(t => { oldById[t.id] = t; });
      const incoming = parsed.map(p => {
        const t = p.task, old = oldById[t.id];
        if (p.keepImage && old && old.image) t.image = old.image;
        return t;
      });
      if (mode === 'append') {
        const inIds = new Set(incoming.map(t => t.id));
        set.tasks = set.tasks.filter(t => !inIds.has(t.id)).concat(incoming);
      } else set.tasks = incoming;
      if (set.tasks.length > MAX_TASKS) throw new Error('limit');
      return { id: set.id, count: set.tasks.length };
    }).catch(() => 'limit');
    if (result === 'limit') return res.status(400).json({ error: `В комплекте не может быть больше ${MAX_TASKS} тренажёров` });
    if (!result) return res.status(404).json({ error: 'Комплект для обновления не найден (или он общий — сначала скопируйте его)' });
    res.json({ ok: true, setId: result.id, imported: parsed.length, total: result.count });
  });

  // ---------- сессии (преподаватель) ----------
  async function sessionView(session, data) {
    const url = `${getBaseUrl()}/a/${session.code}`;
    return { session, url, qrDataUrl: await QRCode.toDataURL(url, { width: 360, margin: 1 }) };
  }

  app.post('/api/defect-sessions', checkAuth, async (req, res) => {
    const data = db.load();
    const set = visibleSet(data, req.body.setId, req.companyId);
    if (!set) return res.status(404).json({ error: 'Комплект не найден' });
    let scheduledAt = null;
    if (req.body.scheduledAt) { const ts = parseInt(req.body.scheduledAt, 10); if (!isNaN(ts) && ts > Date.now()) scheduledAt = ts; }
    let code;
    do { code = nanoid(); } while (safeGet(data.sessions, code));
    const session = { code, companyId: req.companyId, type: 'defect', setId: set.id, testTitle: set.title, startedAt: Date.now(), scheduledAt, ended: false, participants: {} };
    await db.update((d) => { d.sessions[code] = session; });
    res.json(await sessionView(session, data));
  });

  app.get('/api/defect-sessions', checkAuth, (req, res) => {
    const data = db.load();
    res.json(Object.values(data.sessions).filter(s => s.type === 'defect' && s.companyId === req.companyId)
      .sort((a, b) => b.startedAt - a.startedAt)
      .map(s => ({ code: s.code, title: s.testTitle, startedAt: s.startedAt, ended: !!s.ended,
        participants: Object.keys(s.participants).length, finished: Object.values(s.participants).filter(p => p.finished).length })));
  });

  app.get('/api/defect-sessions/:code', checkAuth, async (req, res) => {
    const data = db.load();
    const session = safeGet(data.sessions, req.params.code);
    if (!session || session.companyId !== req.companyId || session.type !== 'defect') return res.status(404).json({ error: 'Сессия не найдена' });
    const set = safeGet(getSets(data), session.setId);
    const view = await sessionView(session, data);
    res.json({ ...view, set: set ? { title: set.title, tasks: set.tasks.map(t => ({ id: t.id, title: t.title, reference: t.reference })) } : null });
  });

  app.post('/api/defect-sessions/:code/start-now', checkAuth, async (req, res) => {
    const r = await db.update((d) => {
      const s = safeGet(d.sessions, req.params.code);
      if (!s || s.companyId !== req.companyId || s.type !== 'defect') return null;
      s.scheduledAt = null; return s;
    });
    if (!r) return res.status(404).json({ error: 'Сессия не найдена' });
    res.json({ ok: true });
  });

  app.post('/api/defect-sessions/:code/end', checkAuth, async (req, res) => {
    await db.update((d) => { const s = safeGet(d.sessions, req.params.code); if (s && s.companyId === req.companyId && s.type === 'defect') s.ended = true; });
    io.to('session:' + req.params.code).emit('session:ended');
    res.json({ ok: true });
  });

  // Ручная оценка рукописных описаний: textGrades[i] = true | false | null по каждому тренажёру.
  app.post('/api/defect-sessions/:code/grade', checkAuth, async (req, res) => {
    const { participantId: pid, textGrades, comment } = req.body;
    const r = await db.update((d) => {
      const s = safeGet(d.sessions, req.params.code);
      if (!s || s.companyId !== req.companyId || s.type !== 'defect') return null;
      const p = safeGet(s.participants, pid);
      if (!p || !p.review) return null;
      p.review.forEach((it, i) => {
        const g = Array.isArray(textGrades) ? textGrades[i] : null;
        it.textGrade = g === true ? true : g === false ? false : null;
      });
      p.manualScore = p.review.filter(it => it.textGrade === true).length;
      p.gradeComment = str(comment, 1000);
      p.graded = true;
      return p;
    });
    if (!r) return res.status(404).json({ error: 'Участник не найден или ещё не сдал акты' });
    res.json({ ok: true });
  });

  app.get('/api/defect-sessions/:code/export', checkAuth, (req, res) => {
    const data = db.load();
    const s = safeGet(data.sessions, req.params.code);
    if (!s || s.companyId !== req.companyId || s.type !== 'defect') return res.status(404).send('Сессия не найдена');
    const rows = Object.values(s.participants).map(p => {
      const row = {
        'Имя': p.name,
        'Статус': p.finished ? 'Сдал' : 'В процессе',
        'Автобаллы (выбор)': p.finished ? p.score : '—',
        'Из': p.finished ? p.total : '—',
        'Описания (зачёт)': p.graded ? p.manualScore : '—',
        'Проверено': p.graded ? 'Да' : 'Нет'
      };
      (p.review || []).forEach((it, i) => {
        const n = `№${i + 1} ${it.title}`;
        row[n + ': диагноз'] = it.diag.ok ? 'Верно' : 'Неверно (' + it.diag.correctText + ')';
        if (it.cause) row[n + ': причина'] = it.cause.ok ? 'Верно' : 'Неверно (' + it.cause.correctText + ')';
        row[n + ': описание'] = it.desc;
        row[n + ': действия'] = it.actions;
        row[n + ': оценка описания'] = it.textGrade === true ? 'Зачёт' : it.textGrade === false ? 'Незачёт' : '—';
      });
      row['Комментарий проверяющего'] = p.gradeComment || '';
      return row;
    });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Результаты');
    sendXlsx(res, wb, `defect_results_${req.params.code}.xlsx`);
  });

  // ---------- публичные маршруты ученика ----------
  const clientTask = (t, order) => ({
    id: t.id, title: t.title, node: t.node, schemeUrl: schemeUrl(t),
    vibration: t.vibration, temp: t.temp, sound: t.sound,
    diag: { question: t.diag.question, options: order.diag.map(id => t.diag.options.find(o => o.id === id)) },
    cause: t.cause ? { question: t.cause.question, options: order.cause.map(id => t.cause.options.find(o => o.id === id)) } : null
  });

  app.get('/api/defect-sessions/:code/info', (req, res) => {
    const data = db.load();
    const s = safeGet(data.sessions, req.params.code);
    if (!s || s.type !== 'defect') return res.status(404).json({ error: 'Сессия не найдена' });
    if (s.ended) return res.status(410).json({ error: 'Задание завершено' });
    const trial = trialBlockedForCompany(data, s.companyId);
    if (trial) return res.status(403).json({ error: 'TRIAL_ENDED', message: trial });
    const set = safeGet(getSets(data), s.setId);
    res.json({ testTitle: s.testTitle, intro: set ? set.intro : '', taskCount: set ? set.tasks.length : 0, scheduledAt: s.scheduledAt || null });
  });

  app.post('/api/defect-sessions/:code/join', joinLimiter, async (req, res) => {
    const name = str(req.body.name, 80);
    if (!name) return res.status(400).json({ error: 'Введите имя' });
    const data = db.load();
    const s = safeGet(data.sessions, req.params.code);
    if (!s || s.type !== 'defect') return res.status(404).json({ error: 'Сессия не найдена' });
    if (s.ended) return res.status(410).json({ error: 'Задание завершено' });
    if (s.scheduledAt && Date.now() < s.scheduledAt) {
      return res.status(403).json({ error: 'NOT_STARTED', message: `Задание ещё не началось. Начало: ${new Date(s.scheduledAt).toLocaleString('ru-RU')}.`, scheduledAt: s.scheduledAt });
    }
    const trial = trialBlockedForCompany(data, s.companyId);
    if (trial) return res.status(403).json({ error: 'TRIAL_ENDED', message: trial });
    const set = safeGet(getSets(data), s.setId);
    if (!set) return res.status(404).json({ error: 'Комплект не найден' });
    const pid = participantId();
    // Порядок вариантов у каждого ученика свой — чтобы нельзя было списать «по буквам».
    const orders = set.tasks.map(t => ({
      diag: shuffle(t.diag.options.map(o => o.id)),
      cause: t.cause ? shuffle(t.cause.options.map(o => o.id)) : []
    }));
    const participant = { id: pid, name, joinedAt: Date.now(), orders, finished: false, score: null, total: null, graded: false };
    await db.update((d) => { d.sessions[req.params.code].participants[pid] = participant; });
    io.to('session:' + req.params.code).emit('participant:joined', { id: pid, name });
    res.json({ participantId: pid, testTitle: set.title, intro: set.intro, tasks: set.tasks.map((t, i) => clientTask(t, orders[i])) });
  });

  app.post('/api/defect-sessions/:code/submit', async (req, res) => {
    const { participantId: pid, answers } = req.body;
    const data = db.load();
    const s = safeGet(data.sessions, req.params.code);
    if (!s || s.type !== 'defect') return res.status(404).json({ error: 'Сессия не найдена' });
    const p = safeGet(s.participants, pid);
    if (!p) return res.status(404).json({ error: 'Участник не найден' });
    if (p.finished) return res.status(400).json({ error: 'Акты уже сданы' });
    const set = safeGet(getSets(data), s.setId);
    if (!set) return res.status(404).json({ error: 'Комплект не найден' });
    const list = Array.isArray(answers) ? answers : [];
    let score = 0, total = 0;
    const review = set.tasks.map((t, i) => {
      const a = list[i] && typeof list[i] === 'object' ? list[i] : {};
      const order = p.orders[i];
      const pick = (q, given, ord) => {
        const g = typeof given === 'string' ? given : '';
        const ok = g === q.correct;
        total++; if (ok) score++;
        const textOf = (id) => (q.options.find(o => o.id === id) || {}).text || '';
        return { question: q.question, options: ord.map(id => ({ id, text: textOf(id) })), given: g, givenText: textOf(g), correct: q.correct, correctText: textOf(q.correct), ok };
      };
      return {
        title: t.title, node: t.node, schemeUrl: schemeUrl(t), vibration: t.vibration, temp: t.temp, sound: t.sound,
        diag: pick(t.diag, a.diag, order.diag),
        cause: t.cause ? pick(t.cause, a.cause, order.cause) : null,
        desc: str(a.desc, 3000), actions: str(a.actions, 3000),
        explain: t.explain, textGrade: null
      };
    });
    const result = await db.update((d) => {
      const pp = safeGet(d.sessions[req.params.code].participants, pid);
      pp.finished = true; pp.finishedAt = Date.now(); pp.score = score; pp.total = total; pp.review = review; pp.manualScore = 0;
      return pp;
    });
    await incrementSubmissions(s.companyId);
    io.to('session:' + req.params.code).emit('participant:finished', { id: pid, name: result.name, score, total });
    res.json(publicResult(result));
  });

  function publicResult(p) {
    return { finished: true, graded: !!p.graded, score: p.score, total: p.total, manualScore: p.manualScore || 0, manualTotal: (p.review || []).length, gradeComment: p.gradeComment || '', review: p.review };
  }

  app.get('/api/defect-sessions/:code/result', (req, res) => {
    const data = db.load();
    const s = safeGet(data.sessions, req.params.code);
    if (!s || s.type !== 'defect') return res.status(404).json({ error: 'Сессия не найдена' });
    const p = safeGet(s.participants, String(req.query.participantId || ''));
    if (!p) return res.status(404).json({ error: 'Участник не найден' });
    res.json(p.finished ? publicResult(p) : { finished: false });
  });

  app.get('/a/:code', (req, res) => res.sendFile(path.join(__dirname, 'public', 'defect-student.html')));

  async function seed() {
    await db.update((d) => {
      if (!d.defectTasks) d.defectTasks = {};
      const old = d.defectTasks[SEED_DEFECT_SET.id];
      d.defectTasks[SEED_DEFECT_SET.id] = { ...JSON.parse(JSON.stringify(SEED_DEFECT_SET)), shared: true, createdAt: old ? old.createdAt : Date.now() };
    });
    console.log(`[defect] Синхронизирован общий комплект: ${SEED_DEFECT_SET.tasks.length} тренажёров`);
  }

  return { seed };
};
