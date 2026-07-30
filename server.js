const express = require('express');
const http = require('http');
const path = require('path');
const os = require('os');
const QRCode = require('qrcode');
const XLSX = require('xlsx');
const multer = require('multer');
const { customAlphabet } = require('nanoid');
const { Server } = require('socket.io');
const crypto = require('crypto');
const db = require('./db');
const { SEED_LABS } = require('./labs-content');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const nanoid = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 5);
const participantId = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 12);
const companyIdGen = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 12);

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function getLocalIp() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

function getBaseUrl() {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  if (process.env.RENDER_EXTERNAL_URL) return process.env.RENDER_EXTERNAL_URL.replace(/\/$/, '');
  return `http://${getLocalIp()}:${PORT}`;
}

// ==================== КАЗАХСКИЕ ТЕСТЫ (ВШИТЫ В КОД) ====================
const KZ_TESTS = [
  {
    "id": "1eaqcxg0hwsr",
    "title": "Металтану",
    "questions": [
      {"id":"q0","text":"Құрамы бойынша болат дегеніміз не?","options":["Темірдің көміртегімен қоспасы (2,14%-ға дейін)","Қоспасыз таза темір","Мыс пен мырыш қоспасы","Алюминийдің кремниймен қоспасы"],"correct":0,"multi":false},
      {"id":"q1","text":"Құрамы бойынша шойын дегеніміз не?","options":["Темірдің көміртегімен қоспасы (0,8%-дан аз)","Темірдің көміртегімен қоспасы (2,14%-дан көп)","Таза темір","Темірдің мыспен қоспасы"],"correct":1,"multi":false},
      {"id":"q2","text":"Феррит — бұл:","options":["Көміртегінің α-темірдегі қатты ерітіндісі","Темірдің көміртегімен химиялық қосылысы","Көміртегінің γ-темірдегі ерітіндісі","Феррит пен цементит қоспасы"],"correct":0,"multi":false},
      {"id":"q3","text":"Цементит — бұл:","options":["Көміртегінің темірдегі қатты ерітіндісі","Феррит пен перлиттің механикалық қоспасы","Fe3C химиялық қосылысы","Аустениттің бір түрі"],"correct":2,"multi":false},
      {"id":"q4","text":"Перлит дегеніміз:","options":["Феррит пен цементиттің механикалық қоспасы","Таза көміртегі","Көміртегінің γ-темірдегі қатты ерітіндісі","Темірдің кремниймен химиялық қосылысы"],"correct":0,"multi":false},
      {"id":"q5","text":"Аустенит — бұл:","options":["Көміртегінің γ-темірдегі қатты ерітіндісі","Феррит пен перлит қоспасы","Темірдің химиялық қосылысы","Көміртегінің α-темірдегі ерітіндісі"],"correct":0,"multi":false},
      {"id":"q6","text":"Ледебурит көміртегі мөлшері шамамен қандай болғанда түзіледі?","options":["0,8%","2,14%","4,3%","6,67%"],"correct":2,"multi":false},
      {"id":"q7","text":"Болаттағы қандай қоспа иілгіштікті төмендетеді және суыққа сынғыштық тудырады?","options":["Марганец","Кремний","Фосфор","Күкірт"],"correct":2,"multi":false},
      {"id":"q8","text":"Қандай қоспа болаттың қызыл сынғыштығын тудырады?","options":["Күкірт","Фосфор","Марганец","Кремний"],"correct":0,"multi":false},
      {"id":"q9","text":"Болаттағы марганец не үшін қолданылады?","options":["Тотықсыздандыру және күкіртті кетіру үшін","Сынғыштықты арттыру үшін","Қаттылықты төмендету үшін","Балқу температурасын төмендету үшін"],"correct":0,"multi":false},
      {"id":"q10","text":"Көміртегі мөлшері 0,25%-дан аз болат қалай аталады?","options":["Жоғары көміртекті","Орта көміртекті","Төмен көміртекті","Легирленген"],"correct":2,"multi":false},
      {"id":"q11","text":"Көміртегі мөлшері 0,6%-дан көп болат қалай аталады?","options":["Төмен көміртекті","Жоғары көміртекті","Орта көміртекті","Аспаптық төмен легирленген"],"correct":1,"multi":false},
      {"id":"q12","text":"Легирленген болат — бұл құрамында бар болат:","options":["Тек көміртегі мен темір","Қасиеттерін өзгерту үшін арнайы енгізілген қоспалар","Тек күкірт пен фосфор қоспалары","Тек хром"],"correct":1,"multi":false},
      {"id":"q13","text":"Болат маркасындағы «Х» әрпі нені білдіреді?","options":["Хром","Хлор","Бұрандалы қадам","Суыққа төзімділік"],"correct":0,"multi":false},
      {"id":"q14","text":"Болат маркасындағы «Н» әрпі нені білдіреді?","options":["Натрий","Никель","Азот","Бетондау"],"correct":1,"multi":false},
      {"id":"q15","text":"Болат маркасындағы «Г» әрпі нені білдіреді?","options":["Германий","Гальваника","Марганец","Графит"],"correct":2,"multi":false},
      {"id":"q16","text":"Легирленген болат маркасындағы әріптен кейінгі сан нені көрсетеді?","options":["Балқыту нөмірі","Элементтің шамамен % мөлшері","МЕМСТ шығарылған жылы","Беріктік класы"],"correct":1,"multi":false},
      {"id":"q17","text":"45 болат маркасы нені білдіреді?","options":["0,45% көміртегі","4,5% көміртегі","45% легирлеуші элементтер","45 топтама нөмірі"],"correct":0,"multi":false},
      {"id":"q18","text":"Қола — бұл қорытпа:","options":["Мыстың қалайымен немесе мырыштан басқа элементтермен","Мыстың мырышпен","Темірдің көміртегімен","Алюминийдің магниймен"],"correct":0,"multi":false},
      {"id":"q19","text":"Дюралюминий негізіндегі қорытпаларға жатады:","options":["Мыс","Темір","Алюминий","Титан"],"correct":2,"multi":false}
    ],
    "createdAt":1785228090312
  },
  {
    "id": "nxa9levbivx0",
    "title": "Механизациялау",
    "questions": [
      {"id":"q0","text":"Көтергіштің шағын механизация құралы ретіндегі негізгі параметрі қандай?","options":["Жүк көтерімділігі","Қозғалтқыш қуаты","Жылдамдықтар диапазоны","Салмағы","Жүкті көтеру жылдамдығы"],"correct":0,"multi":false},
      {"id":"q1","text":"Жөндеу жұмыстарын механизациялау дегеніміз не?","options":["Барлық өндірістік процестерді толық автоматтандыру","Тек қол құралын пайдалану","Жөндеуді басқару үшін компьютерлік бағдарламаларды қолдану","Қол еңбегін механизмдер мен машиналармен ауыстыру немесе толықтыру"],"correct":3,"multi":false},
      {"id":"q2","text":"Жөндеуде экзоскелеттерді қолдану қандай артықшылықтар береді? (бірнеше жауап)","options":["Жарақаттануды азайту","Өнімділіктің өсуі","Операторлардың төзімділігін арттыру","Шаршатпай тасымалданатын жүк салмағын арттыру"],"correct":[0,1,2,3],"multi":true},
      {"id":"q3","text":"Механикаландырылған құралдың жылжымалы түйіндерін терең майлау қаншалықты жиі жүргізілуі керек?","options":["Күн сайын","Апта сайын","4 айда бір реттен сирек емес","Жылына бір рет","2 жылда бір рет"],"correct":2,"multi":false},
      {"id":"q4","text":"Біліктегі 0,08 мм керіліспен отырған мойынтіректің ішкі сақинасын бөлшектеуге арналған гидравликалық тартқышты таңдағанда, механик 15 тс тарту күшіне бағдарланады. Алайда 12 тс күш салғанда сақина жылжымайды. Қандай операция бөлшектерді зақымдамай қажетті күшті төмендете алады?","options":["Сақинаны индуктормен 120°C-қа дейін қыздыру","Гидравликалық жүйедегі қысымды максималдыға дейін арттыру","Білікті сұйық азотпен салқындату","Сақина мен білікті бір уақытта қыздыру"],"correct":0,"multi":false},
      {"id":"q5","text":"Жөндеу шеберханасында салмағы 1,2 т болатын түйінді көтеру үшін бір рельсті жолдағы электр тельфері пайдаланылады. Көтеру кезінде түйін 30 см амплитудамен тербеле бастайды. Оператор көтеруді тоқтатып, жүкті тұрақтандыруды шешеді. Тербелістерді сөндірудің ең қауіпсіз және тиімді әрекеті қандай?","options":["Тельферді қарама-қарсы бағытта күрт қосу","Резонансты бұзу үшін көтеру жылдамдығын арттыру","Көтеруді тоқтатып, жүкті тербелістер толық басылғанша салмақта бекіту","Жүктің екі жағынан төменгі нүктеде бекітілген тартпаларды (арқандарды) пайдалану"],"correct":3,"multi":false},
      {"id":"q6","text":"Мойынтіректерді суық отырғызуға арналған гидравликалық пресс 50 тс күш жасайды. Диаметрі 120 мм, керілісі 0,06 мм мойынтіректі басқанда, жүйедегі қысым 28 МПа-ға жетті, бірақ мойынтірек тірекке 5 мм жетпей тоқтап қалды. Отырғызуды аяқтау үшін қандай шешім дұрыс болады?","options":["Мойынтіректі шығарып алып, отырғызу орнын сызаттар мен қылшықтарға тексеру, қажет болғанда тазалап, басуды қайталау","Мойынтіректі сұйық азотта салқындатып, шығармай қайталау","Мойынтірек орнында тұрғанда корпусты оттықпен 200°C-қа дейін қыздыру","Қысымды 35 МПа-ға дейін жеткізу"],"correct":0,"multi":false},
      {"id":"q7","text":"Жүк көтерімділігі 100 т гидравликалық домкратты бөлшектегенде, жүйедегі майдың қара түсті және өзіне тән күйік иісі бар екені анықталды. Бұл не туралы куәландырады?","options":["Майдың табиғи ескіруі","Майдың металл тозу өнімдерімен ластануы","Майдың рұқсат етілген температурадан жоғары қызуы (деструкция)","Басқа маркалы маймен араласуы"],"correct":2,"multi":false},
      {"id":"q8","text":"Екі строптың көмегімен салмағы 3 тонна болатын станинаны көтергенде, строптар арасындағы бұрыш 120°-ты құрайды. Тік көтерумен салыстырғанда әрбір строптағы күш қалай өзгереді?","options":["1,2 есе артады","1,5 есе азаяды","1,7 есе артады","2 есе артады"],"correct":3,"multi":false}
    ],
    "createdAt":1785135535667
  }
];

// ==================== B2B: АВТОРИЗАЦИЯ И ТАРИФЫ ====================

function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

function checkAuth(req, res, next) {
  const companyId = req.headers['x-company-id'];
  if (!companyId) {
    return res.status(401).json({ error: 'Не авторизован' });
  }
  const data = db.load();
  const company = data.companies[companyId];
  if (!company) {
    return res.status(401).json({ error: 'Компания не найдена' });
  }
  req.company = company;
  req.companyId = companyId;
  next();
}

// ==================== РЕГИСТРАЦИЯ / ВХОД ====================

app.post('/api/register', async (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password || !email.trim() || !password.trim()) {
    return res.status(400).json({ error: 'Заполните email и пароль' });
  }
  const data = db.load();
  const existing = Object.values(data.companies).find(c => c.email === email.trim());
  if (existing) {
    return res.status(400).json({ error: 'Эта почта уже зарегистрирована' });
  }
  const id = companyIdGen();
  const hash = hashPassword(password.trim());
  data.companies[id] = {
    id,
    email: email.trim(),
    name: name ? name.trim() : 'Моя компания',
    passwordHash: hash,
    plan: 'free',
    registeredAt: Date.now()
  };
  db.save(data);
  res.json({ ok: true, companyId: id, email: email.trim(), plan: 'free' });
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password || !email.trim() || !password.trim()) {
    return res.status(400).json({ error: 'Заполните email и пароль' });
  }
  const data = db.load();
  const company = Object.values(data.companies).find(c => c.email === email.trim());
  if (!company) {
    return res.status(401).json({ error: 'Неверная почта или пароль' });
  }
  const hash = hashPassword(password.trim());
  if (hash !== company.passwordHash) {
    return res.status(401).json({ error: 'Неверная почта или пароль' });
  }
  res.json({ ok: true, companyId: company.id, email: company.email, plan: company.plan });
});

app.get('/api/me', checkAuth, (req, res) => {
  res.json({ companyId: req.companyId, email: req.company.email, plan: req.company.plan });
});

// ==================== ТЕСТЫ ====================

app.get('/api/tests', checkAuth, (req, res) => {
  const data = db.load();
  const list = Object.values(data.tests)
    .filter(t => t.companyId === req.companyId)
    .sort((a, b) => b.createdAt - a.createdAt);
  res.json(list);
});

app.get('/api/tests/:id', checkAuth, (req, res) => {
  const data = db.load();
  const test = data.tests[req.params.id];
  if (!test || test.companyId !== req.companyId) return res.status(404).json({ error: 'Тест не найден' });
  res.json(test);
});

app.post('/api/tests', checkAuth, async (req, res) => {
  const { title, questions } = req.body;
  if (!title || !Array.isArray(questions) || questions.length === 0) {
    return res.status(400).json({ error: 'Нужны название и хотя бы один вопрос' });
  }
  const id = participantId();
  const test = {
    id,
    companyId: req.companyId,
    title,
    questions: questions.map((q, i) => ({
      id: 'q' + i,
      text: q.text,
      options: q.options,
      correct: q.correct,
      multi: !!q.multi
    })),
    createdAt: Date.now()
  };
  await db.update((data) => { data.tests[id] = test; });
  res.json(test);
});

app.put('/api/tests/:id', checkAuth, async (req, res) => {
  const { title, questions } = req.body;
  const result = await db.update((data) => {
    const test = data.tests[req.params.id];
    if (!test || test.companyId !== req.companyId) return null;
    test.title = title;
    test.questions = questions.map((q, i) => ({
      id: q.id || 'q' + i,
      text: q.text,
      options: q.options,
      correct: q.correct,
      multi: !!q.multi
    }));
    return test;
  });
  if (!result) return res.status(404).json({ error: 'Тест не найден' });
  res.json(result);
});

app.delete('/api/tests/:id', checkAuth, async (req, res) => {
  await db.update((data) => {
    const test = data.tests[req.params.id];
    if (test && test.companyId === req.companyId) {
      delete data.tests[req.params.id];
    }
  });
  res.json({ ok: true });
});

// ==================== ИМПОРТ И ШАБЛОНЫ ====================

app.get('/api/import-template', checkAuth, (req, res) => {
  const headers = ['Вопрос', 'Вариант 1', 'Вариант 2', 'Вариант 3', 'Вариант 4', 'Вариант 5', 'Правильные (номера через запятую)'];
  const example1 = ['Какая муфта применяется во избежание поломок деталей механизма из-за перегрузок?', 'Компенсирующая муфта', 'Жёсткая муфта', 'Предохранительная муфта', 'Обгонная муфта', '', '3'];
  const example2 = ['Выберите чётные числа', '1', '2', '3', '4', '', '2,4'];
  const ws = XLSX.utils.aoa_to_sheet([headers, example1, example2]);
  ws['!cols'] = [{ wch: 45 }, { wch: 20 }, { wch: 20 }, { wch: 20 }, { wch: 20 }, { wch: 20 }, { wch: 30 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Вопросы');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename="shablon_voprosov.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

app.post('/api/import-questions', checkAuth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });
  let rows;
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  } catch (e) {
    return res.status(400).json({ error: 'Не удалось прочитать файл. Убедитесь, что это .xlsx или .xls' });
  }
  if (rows.length < 2) {
    return res.status(400).json({ error: 'В файле нет вопросов. Заполните строки под заголовком.' });
  }
  const questions = [];
  const skipped = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.every(c => String(c).trim() === '')) continue;
    const text = String(row[0] || '').trim();
    const options = [];
    for (let c = 1; c <= 5; c++) {
      const val = String(row[c] || '').trim();
      if (val) options.push(val);
    }
    const correctRaw = String(row[6] || '').trim();
    if (!text || options.length < 2 || !correctRaw) {
      skipped.push({ row: i + 1, reason: 'нет текста вопроса, вариантов (мин. 2) или правильного ответа' });
      continue;
    }
    const correctNums = correctRaw.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
    const correctIdxs = correctNums.map(n => n - 1).filter(idx => idx >= 0 && idx < options.length);
    if (correctIdxs.length === 0) {
      skipped.push({ row: i + 1, reason: 'номер правильного ответа не соответствует вариантам' });
      continue;
    }
    const multi = correctIdxs.length > 1;
    questions.push({ text, options, correct: multi ? correctIdxs : correctIdxs[0], multi });
  }
  if (questions.length === 0) {
    return res.status(400).json({ error: 'Не удалось распознать ни одного вопроса. Проверьте формат файла (скачайте шаблон).', skipped });
  }
  res.json({ questions, skipped });
});

// ==================== СТАТИСТИКА ====================

app.get('/api/tests/:id/stats', checkAuth, (req, res) => {
  const data = db.load();
  const test = data.tests[req.params.id];
  if (!test || test.companyId !== req.companyId) return res.status(404).json({ error: 'Тест не найден' });
  const sessions = Object.values(data.sessions)
    .filter(s => s.testId === req.params.id && s.companyId === req.companyId && !s.type)
    .sort((a, b) => a.startedAt - b.startedAt);
  const sessionStats = sessions.map(s => {
    const participants = Object.values(s.participants).filter(p => p.finished);
    const count = participants.length;
    const avgScore = count > 0 ? Math.round((participants.reduce((sum, p) => sum + (p.score / p.total * 100), 0) / count) * 10) / 10 : null;
    return {
      code: s.code,
      startedAt: s.startedAt,
      ended: s.ended,
      totalParticipants: Object.keys(s.participants).length,
      finishedParticipants: count,
      avgScore
    };
  });
  const questionStats = test.questions.map(q => {
    let correct = 0;
    let total = 0;
    sessions.forEach(s => {
      Object.values(s.participants).forEach(p => {
        if (!p.finished || !p.answers) return;
        const a = p.answers[q.id];
        if (!a) return;
        total++;
        if (a.isCorrect) correct++;
      });
    });
    return {
      id: q.id,
      text: q.text,
      correct,
      total,
      errorRate: total > 0 ? Math.round(((total - correct) / total) * 100) : null
    };
  }).sort((a, b) => (b.errorRate || 0) - (a.errorRate || 0));
  res.json({ test: { id: test.id, title: test.title }, sessionStats, questionStats });
});

// ==================== QR-КОД ====================
app.get('/api/sessions/:code/qr', async (req, res) => {
  const data = db.load();
  const session = data.sessions[req.params.code];
  if (!session) return res.status(404).json({ error: 'Сессия не найдена' });
  const url = `${getBaseUrl()}/s/${req.params.code}`;
  const qrDataUrl = await QRCode.toDataURL(url, { width: 400, margin: 1 });
  res.setHeader('Content-Type', 'image/png');
  res.send(Buffer.from(qrDataUrl.split(',')[1], 'base64'));
});

// ==================== СЕССИИ ====================

app.post('/api/sessions', checkAuth, async (req, res) => {
  const { testId, timeLimit } = req.body;
  const data = db.load();
  const test = data.tests[testId];
  if (!test || test.companyId !== req.companyId) return res.status(404).json({ error: 'Тест не найден' });
  let code;
  do { code = nanoid(); } while (data.sessions[code]);
  const session = {
    code,
    companyId: req.companyId,
    testId,
    testTitle: test.title,
    timeLimit: timeLimit || null,
    startedAt: Date.now(),
    ended: false,
    participants: {}
  };
  await db.update((d) => { d.sessions[code] = session; });
  const url = `${getBaseUrl()}/s/${code}`;
  const qrDataUrl = await QRCode.toDataURL(url, { width: 400, margin: 1 });
  res.json({ session, url, qrDataUrl, timeLimit: session.timeLimit });
});

app.post('/api/sessions/:code/join', async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Введите имя' });
  const data = db.load();
  const session = data.sessions[req.params.code];
  if (!session) return res.status(404).json({ error: 'Сессия не найдена' });
  if (session.ended) return res.status(410).json({ error: 'Тестирование завершено' });
  const pid = participantId();
  const participant = {
    id: pid,
    name: name.trim(),
    joinedAt: Date.now(),
    answers: {},
    finished: false,
    score: null,
    total: null
  };
  await db.update((d) => { d.sessions[req.params.code].participants[pid] = participant; });
  io.to('session:' + req.params.code).emit('participant:joined', participant);
  res.json({ participantId: pid });
});

app.post('/api/sessions/:code/submit', async (req, res) => {
  const { participantId: pid, answers } = req.body;
  const data = db.load();
  const session = data.sessions[req.params.code];
  if (!session) return res.status(404).json({ error: 'Сессия не найдена' });
  const participant = session.participants[pid];
  if (!participant) return res.status(404).json({ error: 'Участник не найден' });
  if (participant.finished) return res.status(400).json({ error: 'Тест уже сдан' });
  const test = data.tests[session.testId];
  let score = 0;
  const total = test.questions.length;
  const detail = {};
  for (const q of test.questions) {
    const given = answers[q.id];
    let isCorrect = false;
    if (q.multi) {
      const correctSet = JSON.stringify([...q.correct].sort());
      const givenSet = JSON.stringify([...(given || [])].sort());
      isCorrect = correctSet === givenSet;
    } else {
      isCorrect = given === q.correct;
    }
    if (isCorrect) score++;
    detail[q.id] = { given, correct: q.correct, isCorrect };
  }
  const result = await db.update((d) => {
    const p = d.sessions[req.params.code].participants[pid];
    p.answers = detail;
    p.finished = true;
    p.finishedAt = Date.now();
    p.score = score;
    p.total = total;
    return p;
  });
  const review = test.questions.map(q => ({
    text: q.text,
    options: q.options,
    multi: q.multi,
    given: detail[q.id].given,
    correct: detail[q.id].correct,
    isCorrect: detail[q.id].isCorrect
  }));
  io.to('session:' + req.params.code).emit('participant:finished', result);
  res.json({ score, total, review });
});

app.post('/api/sessions/:code/end', checkAuth, async (req, res) => {
  await db.update((d) => {
    const s = d.sessions[req.params.code];
    if (s && s.companyId === req.companyId) {
      s.ended = true;
    }
  });
  io.to('session:' + req.params.code).emit('session:ended');
  res.json({ ok: true });
});

app.get('/api/sessions/:code/export', checkAuth, (req, res) => {
  const data = db.load();
  const session = data.sessions[req.params.code];
  if (!session || session.companyId !== req.companyId) return res.status(404).send('Сессия не найдена');
  const test = data.tests[session.testId];
  const rows = Object.values(session.participants).map(p => {
    const row = {
      'Имя': p.name,
      'Баллы': p.score !== null ? p.score : '—',
      'Всего вопросов': p.total !== null ? p.total : '—',
      'Процент': p.total ? Math.round((p.score / p.total) * 100) + '%' : '—',
      'Статус': p.finished ? 'Завершил' : 'В процессе'
    };
    if (test) {
      test.questions.forEach((q, i) => {
        const d = p.answers[q.id];
        row[`В${i + 1}: ${q.text}`] = d ? (d.isCorrect ? 'Верно' : 'Неверно') : '—';
      });
    }
    return row;
  });
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, 'Результаты');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', `attachment; filename="results_${req.params.code}.xlsx"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

// ==================== ЛАБОРАТОРИИ ====================

function shuffleArr(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function buildOptionsPool(lab) {
  return lab.faults.map(f => ({ id: f.id, label: f.label }));
}

function assignCases(lab) {
  const order = shuffleArr(lab.faults.map(f => f.id));
  return order.map(faultId => {
    const fault = lab.faults.find(f => f.id === faultId);
    const variationIndex = Math.floor(Math.random() * fault.variations.length);
    return { faultId, variationIndex };
  });
}

function caseForClient(lab, assignment) {
  const fault = lab.faults.find(f => f.id === assignment.faultId);
  const v = fault.variations[assignment.variationIndex];
  return {
    title: v.title,
    vibration: v.vibration,
    temp: v.temp,
    sound: v.sound,
    options: shuffleArr(buildOptionsPool(lab))
  };
}

app.get('/api/labs', checkAuth, (req, res) => {
  const data = db.load();
  const list = Object.values(data.labs).map(l => ({
    id: l.id,
    title: l.title,
    intro: l.intro,
    faultCount: l.faults.length
  }));
  res.json(list);
});

app.get('/api/labs/:id', checkAuth, (req, res) => {
  const data = db.load();
  const lab = data.labs[req.params.id];
  if (!lab) return res.status(404).json({ error: 'Тренажёр не найден' });
  res.json(lab);
});

function validateLabPayload(body) {
  const { title, faults } = body;
  if (!title || !title.trim()) return 'Введите название тренажёра';
  if (!Array.isArray(faults) || faults.length === 0) return 'Добавьте хотя бы одну неисправность';
  for (const f of faults) {
    if (!f.label || !f.label.trim()) return 'У каждой неисправности должно быть название диагноза';
    if (!f.explain || !f.explain.trim()) return 'У каждой неисправности должно быть объяснение';
    if (!Array.isArray(f.variations) || f.variations.length === 0) {
      return `У неисправности «${f.label}» должна быть хотя бы одна вариация показаний`;
    }
    for (const v of f.variations) {
      if (!v.title || !v.vibration || !v.vibration.value || !v.temp || !v.temp.value || !v.sound || !v.sound.type) {
        return `Заполните все поля показаний в вариациях для «${f.label}»`;
      }
    }
  }
  return null;
}

app.post('/api/labs', checkAuth, async (req, res) => {
  const err = validateLabPayload(req.body);
  if (err) return res.status(400).json({ error: err });
  const id = participantId();
  const lab = {
    id,
    companyId: req.companyId,
    title: req.body.title.trim(),
    intro: (req.body.intro || '').trim(),
    faults: req.body.faults.map((f, fi) => ({
      id: f.id || ('f' + fi + '_' + id),
      label: f.label.trim(),
      explain: f.explain.trim(),
      variations: f.variations.map(v => ({
        title: v.title.trim(),
        vibration: { value: v.vibration.value.trim(), desc: (v.vibration.desc || '').trim() },
        temp: { value: v.temp.value.trim(), desc: (v.temp.desc || '').trim() },
        sound: { type: v.sound.type, desc: (v.sound.desc || '').trim() }
      }))
    })),
    createdAt: Date.now(),
    custom: true
  };
  await db.update((d) => { d.labs[id] = lab; });
  res.json(lab);
});

app.put('/api/labs/:id', checkAuth, async (req, res) => {
  const err = validateLabPayload(req.body);
  if (err) return res.status(400).json({ error: err });
  const result = await db.update((d) => {
    const existing = d.labs[req.params.id];
    if (!existing || existing.companyId !== req.companyId) return null;
    existing.title = req.body.title.trim();
    existing.intro = (req.body.intro || '').trim();
    existing.faults = req.body.faults.map((f, fi) => ({
      id: f.id || ('f' + fi + '_' + req.params.id),
      label: f.label.trim(),
      explain: f.explain.trim(),
      variations: f.variations.map(v => ({
        title: v.title.trim(),
        vibration: { value: v.vibration.value.trim(), desc: (v.vibration.desc || '').trim() },
        temp: { value: v.temp.value.trim(), desc: (v.temp.desc || '').trim() },
        sound: { type: v.sound.type, desc: (v.sound.desc || '').trim() }
      }))
    }));
    return existing;
  });
  if (!result) return res.status(404).json({ error: 'Тренажёр не найден' });
  res.json(result);
});

app.delete('/api/labs/:id', checkAuth, async (req, res) => {
  await db.update((d) => {
    const lab = d.labs[req.params.id];
    if (lab && lab.companyId === req.companyId) {
      delete d.labs[req.params.id];
    }
  });
  res.json({ ok: true });
});

app.post('/api/lab-sessions', checkAuth, async (req, res) => {
  const { labId } = req.body;
  const data = db.load();
  const lab = data.labs[labId];
  if (!lab || lab.companyId !== req.companyId) return res.status(404).json({ error: 'Тренажёр не найден' });
  let code;
  do { code = nanoid(); } while (data.sessions[code]);
  const session = {
    code,
    companyId: req.companyId,
    type: 'lab',
    labId,
    testTitle: lab.title,
    startedAt: Date.now(),
    ended: false,
    participants: {}
  };
  await db.update((d) => { d.sessions[code] = session; });
  const url = `${getBaseUrl()}/l/${code}`;
  const qrDataUrl = await QRCode.toDataURL(url, { width: 400, margin: 1 });
  res.json({ session, url, qrDataUrl });
});

app.get('/api/lab-sessions/:code', checkAuth, (req, res) => {
  const data = db.load();
  const session = data.sessions[req.params.code];
  if (!session || session.companyId !== req.companyId || session.type !== 'lab') {
    return res.status(404).json({ error: 'Сессия не найдена' });
  }
  res.json(session);
});

app.get('/api/lab-sessions/:code/info', checkAuth, (req, res) => {
  const data = db.load();
  const session = data.sessions[req.params.code];
  if (!session || session.companyId !== req.companyId || session.type !== 'lab') return res.status(404).json({ error: 'Сессия не найдена' });
  if (session.ended) return res.status(410).json({ error: 'Тренажёр завершён' });
  const lab = data.labs[session.labId];
  res.json({ testTitle: session.testTitle, intro: lab ? lab.intro : '' });
});

app.post('/api/lab-sessions/:code/join', async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Введите имя' });
  const data = db.load();
  const session = data.sessions[req.params.code];
  if (!session || session.type !== 'lab') return res.status(404).json({ error: 'Сессия не найдена' });
  if (session.ended) return res.status(410).json({ error: 'Тренажёр завершён' });
  const lab = data.labs[session.labId];
  if (!lab) return res.status(404).json({ error: 'Тренажёр не найден' });
  const pid = participantId();
  const caseAssignment = assignCases(lab);
  const participant = {
    id: pid,
    name: name.trim(),
    joinedAt: Date.now(),
    caseAssignment,
    finished: false,
    score: null,
    total: null
  };
  await db.update((d) => { d.sessions[req.params.code].participants[pid] = participant; });
  io.to('session:' + req.params.code).emit('participant:joined', participant);
  res.json({
    participantId: pid,
    testTitle: lab.title,
    cases: caseAssignment.map(a => caseForClient(lab, a))
  });
});

app.post('/api/lab-sessions/:code/submit', async (req, res) => {
  const { participantId: pid, answers } = req.body;
  const data = db.load();
  const session = data.sessions[req.params.code];
  if (!session || session.type !== 'lab') return res.status(404).json({ error: 'Сессия не найдена' });
  const participant = session.participants[pid];
  if (!participant) return res.status(404).json({ error: 'Участник не найден' });
  if (participant.finished) return res.status(400).json({ error: 'Тренажёр уже сдан' });
  const lab = data.labs[session.labId];
  let score = 0;
  const total = participant.caseAssignment.length;
  const review = [];
  participant.caseAssignment.forEach((assignment, i) => {
    const fault = lab.faults.find(f => f.id === assignment.faultId);
    const v = fault.variations[assignment.variationIndex];
    const given = answers ? answers[i] : undefined;
    const isCorrect = given === assignment.faultId;
    if (isCorrect) score++;
    review.push({
      title: v.title,
      vibration: v.vibration,
      temp: v.temp,
      sound: v.sound,
      options: buildOptionsPool(lab),
      given,
      correct: assignment.faultId,
      correctLabel: fault.label,
      isCorrect,
      explain: fault.explain
    });
  });
  const result = await db.update((d) => {
    const p = d.sessions[req.params.code].participants[pid];
    p.finished = true;
    p.finishedAt = Date.now();
    p.score = score;
    p.total = total;
    p.review = review;
    return p;
  });
  io.to('session:' + req.params.code).emit('participant:finished', result);
  res.json({ score, total, review });
});

app.post('/api/lab-sessions/:code/end', checkAuth, async (req, res) => {
  await db.update((d) => {
    const s = d.sessions[req.params.code];
    if (s && s.companyId === req.companyId) {
      s.ended = true;
    }
  });
  io.to('session:' + req.params.code).emit('session:ended');
  res.json({ ok: true });
});

app.get('/api/lab-sessions/:code/export', checkAuth, (req, res) => {
  const data = db.load();
  const session = data.sessions[req.params.code];
  if (!session || session.companyId !== req.companyId || session.type !== 'lab') return res.status(404).send('Сессия не найдена');
  const lab = data.labs[session.labId];
  const rows = Object.values(session.participants).map(p => {
    const row = {
      'Имя': p.name,
      'Баллы': p.score !== null ? p.score : '—',
      'Всего случаев': p.total !== null ? p.total : '—',
      'Процент': p.total ? Math.round((p.score / p.total) * 100) + '%' : '—',
      'Статус': p.finished ? 'Завершил' : 'В процессе'
    };
    if (p.review) {
      p.review.forEach((c, i) => {
        row[`Случай ${i + 1}: ${c.title}`] = c.isCorrect ? 'Верно' : `Неверно (${c.correctLabel})`;
      });
    }
    return row;
  });
  const faultStats = {};
  if (lab) lab.faults.forEach(f => { faultStats[f.label] = { wrong: 0, total: 0 }; });
  Object.values(session.participants).forEach(p => {
    if (!p.review) return;
    p.review.forEach(c => {
      if (!faultStats[c.correctLabel]) faultStats[c.correctLabel] = { wrong: 0, total: 0 };
      faultStats[c.correctLabel].total++;
      if (!c.isCorrect) faultStats[c.correctLabel].wrong++;
    });
  });
  const summaryRows = Object.entries(faultStats).map(([label, s]) => ({
    'Тип неисправности': label,
    'Ошибок': s.wrong,
    'Всего показов': s.total,
    'Доля ошибок': s.total ? Math.round((s.wrong / s.total) * 100) + '%' : '—'
  }));
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, 'Результаты');
  const wsSummary = XLSX.utils.json_to_sheet(summaryRows);
  XLSX.utils.book_append_sheet(wb, wsSummary, 'Проблемные типы');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', `attachment; filename="lab_results_${req.params.code}.xlsx"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

app.get('/l/:code', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'lab-student.html'));
});

app.get('/s/:code', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'student.html'));
});

io.on('connection', (socket) => {
  socket.on('teacher:watch', (code) => {
    socket.join('session:' + code);
  });
});

async function seedLabs() {
  await db.update((d) => {
    if (!d.labs) d.labs = {};
    SEED_LABS.forEach(l => { d.labs[l.id] = l; });
  });
  console.log(`[labs] Синхронизировано тренажёров: ${SEED_LABS.length}`);
}

async function start() {
  await db.initCache();
  await seedLabs();
  server.listen(PORT, '0.0.0.0', () => {
    console.log('');
    console.log('=== Приложение для тестирования запущено ===');
    console.log(`Панель преподавателя: http://localhost:${PORT}`);
    console.log(`Публичный адрес (для QR): ${getBaseUrl()}`);
    console.log('==============================================');
  });
}

start();
