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

function checkPlanLimits(req, res, next) {
  const company = req.company;
  const data = db.load();
  
  const totalTests = Object.values(data.tests).filter(t => t.companyId === req.companyId).length;
  const planLimits = {
    free: { tests: 5, sessionsPerTest: 10 },
    pro: { tests: 9999, sessionsPerTest: 9999 }
  };
  
  const limits = planLimits[company.plan] || planLimits.free;
  
  if (req.method === 'POST' && req.path === '/api/tests') {
    if (totalTests >= limits.tests) {
      return res.status(403).json({ error: `Достигнут лимит бесплатного тарифа (макс. ${limits.tests} тестов).` });
    }
  }
  
  if (req.method === 'POST' && (req.path === '/api/sessions' || req.path === '/api/lab-sessions')) {
    const testId = req.body.testId || req.body.labId;
    if (testId) {
      const testSessions = Object.values(data.sessions).filter(s => s.testId === testId && s.companyId === req.companyId);
      if (testSessions.length >= limits.sessionsPerTest) {
        return res.status(403).json({ error: `Достигнут лимит сессий для этого теста (макс. ${limits.sessionsPerTest}).` });
      }
    }
  }
  
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

app.get('/api/plan', checkAuth, (req, res) => {
  const data = db.load();
  const totalTests = Object.values(data.tests).filter(t => t.companyId === req.companyId).length;
  const totalSessions = Object.values(data.sessions).filter(s => s.companyId === req.companyId).length;
  res.json({ plan: req.company.plan, totalTests, totalSessions });
});

app.put('/api/upgrade', checkAuth, async (req, res) => {
  await db.update((d) => {
    if (d.companies[req.companyId]) {
      d.companies[req.companyId].plan = 'pro';
    }
  });
  res.json({ ok: true, plan: 'pro' });
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

app.post('/api/tests', checkAuth, checkPlanLimits, async (req, res) => {
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
    const avgScore = count > 0
      ? Math.round((participants.reduce((sum, p) => sum + (p.score / p.total * 100), 0) / count) * 10) / 10
      : null;
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

app.delete('/api/tests/:id/sessions', checkAuth, async (req, res) => {
  await db.update((d) => {
    Object.keys(d.sessions).forEach(code => {
      const s = d.sessions[code];
      if (s.testId === req.params.id && s.companyId === req.companyId && !s.type) {
        delete d.sessions[code];
      }
    });
  });
  res.json({ ok: true });
});

// ==================== СЕССИИ ====================

app.post('/api/sessions', checkAuth, checkPlanLimits, async (req, res) => {
  const { testId } = req.body;
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
    timeLimit: req.body.timeLimit || null,
    startedAt: Date.now(),
    ended: false,
    participants: {}
  };
  await db.update((d) => { d.sessions[code] = session; });
  const url = `${getBaseUrl()}/s/${code}`;
  const qrDataUrl = await QRCode.toDataURL(url, { width: 400, margin: 1 });
  res.json({ session, url, qrDataUrl });
});

app.get('/api/sessions', checkAuth, (req, res) => {
  const data = db.load();
  const list = Object.values(data.sessions)
    .filter(s => s.companyId === req.companyId)
    .sort((a, b) => b.startedAt - a.startedAt);
  res.json(list);
});

app.get('/api/sessions/:code', checkAuth, (req, res) => {
  const data = db.load();
  const session = data.sessions[req.params.code];
  if (!session || session.companyId !== req.companyId) return res.status(404).json({ error: 'Сессия не найдена' });
  res.json(session);
});

app.get('/api/sessions/:code/quiz', checkAuth, (req, res) => {
  const data = db.load();
  const session = data.sessions[req.params.code];
  if (!session || session.companyId !== req.companyId) return res.status(404).json({ error: 'Сессия не найдена' });
  if (session.ended) return res.status(410).json({ error: 'Тестирование завершено' });
  
  const test = data.tests[session.testId];
  if (!test || test.companyId !== req.companyId) return res.status(404).json({ error: 'Тест не найден' });
  
  res.json({
    testTitle: test.title,
    questions: test.questions.map(q => ({
      id: q.id,
      text: q.text,
      options: q.options,
      multi: q.multi
    })),
    timeLimit: session.timeLimit
  });
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
