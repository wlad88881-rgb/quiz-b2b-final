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
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
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

// ==================== КОНФИГУРАЦИЯ БЕЗОПАСНОСТИ И ТАРИФОВ ====================
// ВАЖНО: перед деплоем в продакшн задайте эти переменные окружения на хостинге (например, в Render → Environment):
//   ADMIN_PASSWORD       — ваш собственный пароль для входа в /admin
//   SESSION_SECRET       — любая длинная случайная строка (секрет для подписи токенов)
//   DEVELOPER_CONTACTS   — текст с вашими контактами, который увидят клиенты после окончания пробного периода
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin-change-me-2024';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const DEVELOPER_CONTACTS = process.env.DEVELOPER_CONTACTS ||
  'Свяжитесь с разработчиком, чтобы продолжить работу (контакты не настроены — задайте переменную окружения DEVELOPER_CONTACTS).';

const FREE_MAX_TESTS = 3;
const FREE_MAX_QUESTIONS = 20;
const FREE_MAX_SUBMISSIONS = 20;

if (!process.env.ADMIN_PASSWORD) {
  console.warn('[security] ВНИМАНИЕ: ADMIN_PASSWORD не задан в переменных окружения — используется пароль по умолчанию. Задайте свой пароль перед выходом в продакшн!');
}
if (!process.env.SESSION_SECRET) {
  console.warn('[security] ВНИМАНИЕ: SESSION_SECRET не задан — сгенерирован случайный на время работы процесса (все токены станут недействительны при перезапуске сервера). Рекомендуется задать постоянный секрет в переменных окружения.');
}

app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(express.json({ limit: '3mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Ограничение частоты запросов на чувствительные маршруты (защита от подбора паролей и злоупотреблений)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Слишком много попыток. Попробуйте снова через несколько минут.' }
});
const translateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Слишком много запросов на перевод. Подождите немного.' }
});
const joinLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Слишком много попыток присоединения с этой сети. Подождите немного.' }
});

// ==================== БЕЗОПАСНЫЙ ДОСТУП К ОБЪЕКТАМ ПО КЛЮЧУ ====================
// Защита от подмены ключа (например "__proto__"), который иначе мог бы вернуть
// Object.prototype вместо undefined и обмануть проверки на существование записи.
function safeGet(dict, key) {
  if (!dict || typeof key !== 'string' || !key) return undefined;
  if (!Object.prototype.hasOwnProperty.call(dict, key)) return undefined;
  return dict[key];
}

// ==================== ПОДПИСАННЫЕ ТОКЕНЫ (вместо передачи "голого" id компании) ====================
function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function signToken(payload, ttlMs) {
  const body = base64url(Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + ttlMs })));
  const sig = base64url(crypto.createHmac('sha256', SESSION_SECRET).update(body).digest());
  return `${body}.${sig}`;
}
function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const expectedSig = base64url(crypto.createHmac('sha256', SESSION_SECRET).update(body).digest());
  if (sig.length !== expectedSig.length) return null;
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) return null;
  } catch (e) {
    return null;
  }
  try {
    const data = JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
    if (!data.exp || Date.now() > data.exp) return null;
    return data;
  } catch (e) {
    return null;
  }
}

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
  // Устаревшая схема — оставлена только для проверки паролей, созданных до обновления безопасности.
  return crypto.createHash('sha256').update(password).digest('hex');
}

function hashPasswordSecure(password, existingSalt) {
  const salt = existingSalt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPasswordSecure(password, stored) {
  if (typeof stored !== 'string' || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  try {
    const check = crypto.scryptSync(password, salt, 64).toString('hex');
    const a = Buffer.from(hash, 'hex');
    const b = Buffer.from(check, 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch (e) {
    return false;
  }
}

// ==================== ПЕРЕВОД (RU -> KK) ====================

function translationCacheKey(text, target) {
  return crypto.createHash('sha1').update(target + '::' + text).digest('hex');
}

async function translateOne(text, target) {
  const clean = (text || '').toString();
  if (!clean.trim()) return clean;
  const data = db.load();
  const key = translationCacheKey(clean, target);
  if (data.translations[key]) return data.translations[key];
  try {
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(clean)}&langpair=ru|${target}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!resp.ok) throw new Error('translate http ' + resp.status);
    const json = await resp.json();
    const translated = json && json.responseData && json.responseData.translatedText
      ? json.responseData.translatedText
      : clean;
    // Иногда сервис возвращает служебные сообщения об ошибках вместо перевода
    const looksLikeError = /MYMEMORY WARNING|INVALID|QUERY LENGTH LIMIT/i.test(translated);
    const finalText = looksLikeError ? clean : translated;
    await db.update((d) => { if (!d.translations) d.translations = {}; d.translations[key] = finalText; });
    return finalText;
  } catch (e) {
    console.error('[translate] Ошибка перевода:', e.message);
    return clean; // при недоступности сервиса возвращаем оригинал, чтобы приложение не падало
  }
}

async function translateBatch(texts, target) {
  const results = new Array(texts.length);
  const CONCURRENCY = 4;
  let idx = 0;
  async function worker() {
    while (idx < texts.length) {
      const i = idx++;
      results[i] = await translateOne(texts[i], target);
    }
  }
  const workers = [];
  for (let w = 0; w < CONCURRENCY; w++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

app.post('/api/translate', translateLimiter, async (req, res) => {
  const { texts, target } = req.body;
  if (!Array.isArray(texts)) return res.status(400).json({ error: 'texts должен быть массивом' });
  const targetLang = target === 'kk' ? 'kk' : null;
  if (!targetLang) return res.status(400).json({ error: 'Поддерживается только target=kk' });
  if (texts.length === 0) return res.json({ translations: [] });
  if (texts.length > 300) return res.status(400).json({ error: 'Слишком много строк за один запрос' });
  try {
    const translations = await translateBatch(texts, targetLang);
    res.json({ translations });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервиса перевода' });
  }
});

function checkAuth(req, res, next) {
  const token = req.headers['x-company-id'] || req.query.companyId;
  const payload = verifyToken(token);
  if (!payload || !payload.companyId) {
    return res.status(401).json({ error: 'Не авторизован' });
  }
  const data = db.load();
  const company = safeGet(data.companies, payload.companyId);
  if (!company) {
    return res.status(401).json({ error: 'Компания не найдена' });
  }
  if (company.blocked) {
    return res.status(403).json({ error: 'BLOCKED', message: 'Доступ заблокирован администратором. ' + DEVELOPER_CONTACTS });
  }
  if (company.plan === 'free' && (company.usage && company.usage.submissions || 0) >= FREE_MAX_SUBMISSIONS) {
    return res.status(403).json({
      error: 'TRIAL_ENDED',
      message: `Пробный период завершён: достигнут лимит ${FREE_MAX_SUBMISSIONS} прохождений тестов. ${DEVELOPER_CONTACTS}`
    });
  }
  req.company = company;
  req.companyId = payload.companyId;
  next();
}

function checkAdmin(req, res, next) {
  const token = req.headers['x-admin-token'];
  const payload = verifyToken(token);
  if (!payload || payload.role !== 'admin') {
    return res.status(401).json({ error: 'Требуется вход администратора' });
  }
  next();
}

// Проверка лимита компании до того, как студент присоединится/сдаст тест (публичные маршруты)
function trialBlockedForCompany(data, companyId) {
  const company = safeGet(data.companies, companyId);
  if (!company) return null;
  if (company.blocked) {
    return 'Доступ к этому тесту временно закрыт. ' + DEVELOPER_CONTACTS;
  }
  if (company.plan === 'free' && (company.usage && company.usage.submissions || 0) >= FREE_MAX_SUBMISSIONS) {
    return `Пробный период организатора теста завершён. ${DEVELOPER_CONTACTS}`;
  }
  return null;
}

async function incrementSubmissions(companyId) {
  await db.update((d) => {
    const c = safeGet(d.companies, companyId);
    if (c) {
      if (!c.usage) c.usage = { submissions: 0 };
      c.usage.submissions = (c.usage.submissions || 0) + 1;
    }
  });
}

// ==================== РЕГИСТРАЦИЯ / ВХОД ====================

app.post('/api/register', authLimiter, async (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password || !email.trim() || !password.trim()) {
    return res.status(400).json({ error: 'Заполните email и пароль' });
  }
  const cleanEmail = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    return res.status(400).json({ error: 'Некорректный формат email' });
  }
  if (password.trim().length < 6) {
    return res.status(400).json({ error: 'Пароль должен быть не короче 6 символов' });
  }
  const data = db.load();
  const existing = Object.values(data.companies).find(c => c.email === cleanEmail);
  if (existing) {
    return res.status(400).json({ error: 'Эта почта уже зарегистрирована' });
  }
  const id = companyIdGen();
  const passwordHash = hashPasswordSecure(password.trim());
  const company = {
    id,
    email: cleanEmail,
    name: name ? name.trim().slice(0, 120) : 'Моя компания',
    passwordHash,
    plan: 'free',
    blocked: false,
    usage: { submissions: 0 },
    registeredAt: Date.now()
  };
  await db.update((d) => { d.companies[id] = company; });
  const token = signToken({ companyId: id }, 30 * 24 * 60 * 60 * 1000);
  res.json({ ok: true, companyId: id, token, email: cleanEmail, plan: 'free' });
});

app.post('/api/login', authLimiter, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password || !email.trim() || !password.trim()) {
    return res.status(400).json({ error: 'Заполните email и пароль' });
  }
  const cleanEmail = email.trim().toLowerCase();
  const data = db.load();
  const company = Object.values(data.companies).find(c => c.email === cleanEmail);
  if (!company) {
    return res.status(401).json({ error: 'Неверная почта или пароль' });
  }
  let ok = verifyPasswordSecure(password.trim(), company.passwordHash);
  if (!ok && hashPassword(password.trim()) === company.passwordHash) {
    // Аккаунт создан до обновления безопасности — принимаем старый хеш и обновляем на новый.
    ok = true;
    await db.update((d) => {
      const c = safeGet(d.companies, company.id);
      if (c) c.passwordHash = hashPasswordSecure(password.trim());
    });
  }
  if (!ok) {
    return res.status(401).json({ error: 'Неверная почта или пароль' });
  }
  if (company.blocked) {
    return res.status(403).json({ error: 'BLOCKED', message: 'Доступ заблокирован администратором. ' + DEVELOPER_CONTACTS });
  }
  const token = signToken({ companyId: company.id }, 30 * 24 * 60 * 60 * 1000);
  res.json({ ok: true, companyId: company.id, token, email: company.email, plan: company.plan });
});

app.post('/api/admin/login', authLimiter, (req, res) => {
  const { password } = req.body;
  if (!password || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Неверный пароль' });
  }
  const token = signToken({ role: 'admin' }, 12 * 60 * 60 * 1000);
  res.json({ ok: true, token });
});

app.get('/api/me', checkAuth, (req, res) => {
  res.json({
    companyId: req.companyId,
    email: req.company.email,
    plan: req.company.plan,
    usage: {
      submissions: (req.company.usage && req.company.usage.submissions) || 0,
      submissionsLimit: req.company.plan === 'free' ? FREE_MAX_SUBMISSIONS : null,
      testsLimit: req.company.plan === 'free' ? FREE_MAX_TESTS : null,
      questionsLimit: req.company.plan === 'free' ? FREE_MAX_QUESTIONS : null
    }
  });
});

// ==================== ТЕСТЫ ====================

app.get('/api/tests', checkAuth, (req, res) => {
  const data = db.load();
  const list = Object.values(data.tests)
    .filter(t => t.companyId === req.companyId)
    .sort((a, b) => b.createdAt - a.createdAt);
  res.json(list);
});

// Сводка по тегам вопросов компании: сколько вопросов помечено каждым тегом
// (вопросы собираются по всем тестам компании — это и есть общий «банк вопросов»).
// ВАЖНО: этот маршрут должен идти РАНЬШЕ '/api/tests/:id', иначе Express
// примет "tags-summary" за значение :id.
app.get('/api/tests/tags-summary', checkAuth, (req, res) => {
  const data = db.load();
  const counts = {};
  Object.values(data.tests)
    .filter(t => t.companyId === req.companyId)
    .forEach(t => {
      t.questions.forEach(q => {
        (q.tags || []).forEach(tag => { counts[tag] = (counts[tag] || 0) + 1; });
      });
    });
  const tags = Object.entries(counts)
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count);
  res.json({ tags });
});

app.get('/api/tests/:id', checkAuth, (req, res) => {
  const data = db.load();
  const test = safeGet(data.tests, req.params.id);
  if (!test || test.companyId !== req.companyId) return res.status(404).json({ error: 'Тест не найден' });
  res.json(test);
});

app.post('/api/tests', checkAuth, async (req, res) => {
  const { title, questions } = req.body;
  if (!title || !Array.isArray(questions) || questions.length === 0) {
    return res.status(400).json({ error: 'Нужны название и хотя бы один вопрос' });
  }
  if (req.company.plan === 'free') {
    const data = db.load();
    const count = Object.values(data.tests).filter(t => t.companyId === req.companyId).length;
    if (count >= FREE_MAX_TESTS) {
      return res.status(403).json({ error: `Бесплатный тариф позволяет создать не более ${FREE_MAX_TESTS} тестов. ${DEVELOPER_CONTACTS}` });
    }
    if (questions.length > FREE_MAX_QUESTIONS) {
      return res.status(400).json({ error: `Бесплатный тариф — максимум ${FREE_MAX_QUESTIONS} вопросов в тесте.` });
    }
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
      multi: !!q.multi,
      tags: Array.isArray(q.tags) ? [...new Set(q.tags.map(t => String(t).trim()).filter(Boolean))] : []
    })),
    createdAt: Date.now()
  };
  await db.update((data) => { data.tests[id] = test; });
  res.json(test);
});

app.put('/api/tests/:id', checkAuth, async (req, res) => {
  const { title, questions } = req.body;
  if (req.company.plan === 'free' && Array.isArray(questions) && questions.length > FREE_MAX_QUESTIONS) {
    return res.status(400).json({ error: `Бесплатный тариф — максимум ${FREE_MAX_QUESTIONS} вопросов в тесте.` });
  }
  const result = await db.update((data) => {
    const test = safeGet(data.tests, req.params.id);
    if (!test || test.companyId !== req.companyId) return null;
    test.title = title;
    test.questions = questions.map((q, i) => ({
      id: q.id || 'q' + i,
      text: q.text,
      options: q.options,
      correct: q.correct,
      multi: !!q.multi,
      tags: Array.isArray(q.tags) ? [...new Set(q.tags.map(t => String(t).trim()).filter(Boolean))] : []
    }));
    return test;
  });
  if (!result) return res.status(404).json({ error: 'Тест не найден' });
  res.json(result);
});

app.delete('/api/tests/:id', checkAuth, async (req, res) => {
  await db.update((data) => {
    const test = safeGet(data.tests, req.params.id);
    if (test && test.companyId === req.companyId) {
      delete data.tests[req.params.id];
      Object.keys(data.sessions).forEach(code => {
        if (data.sessions[code].testId === req.params.id && data.sessions[code].companyId === req.companyId) {
          delete data.sessions[code];
        }
      });
    }
  });
  res.json({ ok: true });
});

// Собирает новый тест «вразброс» из вопросов с выбранными тегами (по всем тестам компании).
app.post('/api/tests/generate', checkAuth, async (req, res) => {
  const { title, tags, count } = req.body;
  if (!title || !Array.isArray(tags) || tags.length === 0) {
    return res.status(400).json({ error: 'Укажите название и хотя бы один тег' });
  }
  const wantCount = Math.max(1, Math.min(200, parseInt(count, 10) || 20));
  const data = db.load();
  if (req.company.plan === 'free') {
    const existingCount = Object.values(data.tests).filter(t => t.companyId === req.companyId).length;
    if (existingCount >= FREE_MAX_TESTS) {
      return res.status(403).json({ error: `Бесплатный тариф позволяет создать не более ${FREE_MAX_TESTS} тестов. ${DEVELOPER_CONTACTS}` });
    }
  }
  const tagSet = new Set(tags);
  const pool = [];
  const seenText = new Set(); // защита от дублей одного и того же вопроса из разных тестов
  Object.values(data.tests)
    .filter(t => t.companyId === req.companyId)
    .forEach(t => {
      t.questions.forEach(q => {
        if ((q.tags || []).some(tag => tagSet.has(tag)) && !seenText.has(q.text)) {
          seenText.add(q.text);
          pool.push(q);
        }
      });
    });
  if (pool.length === 0) {
    return res.status(400).json({ error: 'По выбранным темам не нашлось вопросов' });
  }
  // Перемешиваем и берём нужное количество (или все, если запрошено больше, чем есть)
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const maxAllowed = req.company.plan === 'free' ? Math.min(wantCount, FREE_MAX_QUESTIONS) : wantCount;
  const selected = pool.slice(0, Math.min(maxAllowed, pool.length));

  const id = participantId();
  const test = {
    id,
    companyId: req.companyId,
    title,
    questions: selected.map((q, i) => ({
      id: 'q' + i,
      text: q.text,
      options: q.options,
      correct: q.correct,
      multi: !!q.multi,
      tags: q.tags || []
    })),
    createdAt: Date.now()
  };
  await db.update((d) => { d.tests[id] = test; });
  res.json({ test, availableInPool: pool.length, selectedCount: selected.length });
});

// Очистка истории прохождений теста (сессии удаляются, счётчик пробного периода НЕ сбрасывается)
app.delete('/api/tests/:id/sessions', checkAuth, async (req, res) => {
  const result = await db.update((data) => {
    const test = safeGet(data.tests, req.params.id);
    if (!test || test.companyId !== req.companyId) return null;
    Object.keys(data.sessions).forEach(code => {
      const s = data.sessions[code];
      if (s.testId === req.params.id && s.companyId === req.companyId && !s.type) {
        delete data.sessions[code];
      }
    });
    return true;
  });
  if (!result) return res.status(404).json({ error: 'Тест не найден' });
  res.json({ ok: true });
});

// ==================== СТАТИСТИКА ====================

app.get('/api/tests/:id/stats', checkAuth, (req, res) => {
  const data = db.load();
  const test = safeGet(data.tests, req.params.id);
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

// ==================== QR-КОД (ОТДЕЛЬНЫЙ МАРШРУТ ДЛЯ КАРТИНКИ) ====================
app.get('/api/sessions/:code/qr', async (req, res) => {
  const data = db.load();
  const session = safeGet(data.sessions, req.params.code);
  if (!session) return res.status(404).json({ error: 'Сессия не найдена' });
  const url = `${getBaseUrl()}/s/${req.params.code}`;
  const qrDataUrl = await QRCode.toDataURL(url, { width: 400, margin: 1 });
  res.setHeader('Content-Type', 'image/png');
  res.send(Buffer.from(qrDataUrl.split(',')[1], 'base64'));
});

// ==================== СЕССИИ ====================

app.post('/api/sessions', checkAuth, async (req, res) => {
  const { testId } = req.body;
  const data = db.load();
  const test = safeGet(data.tests, testId);
  if (!test || test.companyId !== req.companyId) return res.status(404).json({ error: 'Тест не найден' });
  let code;
  do { code = nanoid(); } while (safeGet(data.sessions, code));
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

app.get('/api/sessions/:code/info', (req, res) => {
  const data = db.load();
  const session = safeGet(data.sessions, req.params.code);
  if (!session || session.type === 'lab') return res.status(404).json({ error: 'Сессия не найдена' });
  const trialMsg = trialBlockedForCompany(data, session.companyId);
  if (trialMsg) return res.status(403).json({ error: 'TRIAL_ENDED', message: trialMsg });
  const test = safeGet(data.tests, session.testId);
  res.json({
    testTitle: session.testTitle,
    timeLimit: session.timeLimit || null,
    ended: !!session.ended,
    questionCount: test ? test.questions.length : 0
  });
});

app.post('/api/sessions/:code/join', joinLimiter, async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Введите имя' });
  const data = db.load();
  const session = safeGet(data.sessions, req.params.code);
  if (!session || session.type === 'lab') return res.status(404).json({ error: 'Сессия не найдена' });
  if (session.ended) return res.status(410).json({ error: 'Тестирование завершено' });
  const trialMsg = trialBlockedForCompany(data, session.companyId);
  if (trialMsg) return res.status(403).json({ error: 'TRIAL_ENDED', message: trialMsg });
  const test = safeGet(data.tests, session.testId);
  if (!test) return res.status(404).json({ error: 'Тест не найден' });
  const pid = participantId();
  const participant = {
    id: pid,
    name: name.trim().slice(0, 80),
    joinedAt: Date.now(),
    answers: {},
    finished: false,
    score: null,
    total: null
  };
  await db.update((d) => { d.sessions[req.params.code].participants[pid] = participant; });
  io.to('session:' + req.params.code).emit('participant:joined', participant);
  res.json({
    participantId: pid,
    testTitle: test.title,
    timeLimit: session.timeLimit || null,
    questions: test.questions.map(q => ({
      id: q.id,
      text: q.text,
      options: q.options,
      multi: !!q.multi
    }))
  });
});

app.post('/api/sessions/:code/submit', async (req, res) => {
  const { participantId: pid, answers } = req.body;
  const safeAnswers = answers && typeof answers === 'object' ? answers : {};
  const data = db.load();
  const session = safeGet(data.sessions, req.params.code);
  if (!session) return res.status(404).json({ error: 'Сессия не найдена' });
  const participant = safeGet(session.participants, pid);
  if (!participant) return res.status(404).json({ error: 'Участник не найден' });
  if (participant.finished) return res.status(400).json({ error: 'Тест уже сдан' });
  const test = safeGet(data.tests, session.testId);
  if (!test) return res.status(404).json({ error: 'Тест не найден' });
  let score = 0;
  const total = test.questions.length;
  const detail = {};
  for (const q of test.questions) {
    const given = safeAnswers[q.id];
    let isCorrect = false;
    if (q.multi) {
      const correctSet = JSON.stringify([...q.correct].sort());
      const givenSet = JSON.stringify([...(Array.isArray(given) ? given : [])].sort());
      isCorrect = correctSet === givenSet;
    } else {
      isCorrect = given === q.correct;
    }
    if (isCorrect) score++;
    detail[q.id] = { given, correct: q.correct, isCorrect };
  }
  const result = await db.update((d) => {
    const p = safeGet(d.sessions[req.params.code].participants, pid);
    p.answers = detail;
    p.finished = true;
    p.finishedAt = Date.now();
    p.score = score;
    p.total = total;
    return p;
  });
  await incrementSubmissions(session.companyId);
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

// Анонимный топ-3 по сессии для студента: без имён, только позиции и проценты,
// плюс собственное место (если передан participantId). Публичный маршрут —
// доступен со страницы прохождения теста, авторизация преподавателя не нужна.
app.get('/api/sessions/:code/leaderboard', (req, res) => {
  const data = db.load();
  const session = safeGet(data.sessions, req.params.code);
  if (!session || session.type === 'lab') return res.status(404).json({ error: 'Сессия не найдена' });
  const finished = Object.entries(session.participants)
    .filter(([, p]) => p.finished && p.total > 0)
    .map(([pid, p]) => ({ pid, percent: Math.round((p.score / p.total) * 100), finishedAt: p.finishedAt }))
    .sort((a, b) => b.percent - a.percent || a.finishedAt - b.finishedAt);
  const top = finished.slice(0, 3).map((p, i) => ({ rank: i + 1, percent: p.percent }));
  const myPid = req.query.participantId;
  let yourRank = null;
  if (myPid) {
    const idx = finished.findIndex(p => p.pid === myPid);
    if (idx >= 0) yourRank = idx + 1;
  }
  res.json({ top, yourRank, totalParticipants: finished.length });
});

app.post('/api/sessions/:code/end', checkAuth, async (req, res) => {
  await db.update((d) => {
    const s = safeGet(d.sessions, req.params.code);
    if (s && s.companyId === req.companyId) {
      s.ended = true;
    }
  });
  io.to('session:' + req.params.code).emit('session:ended');
  res.json({ ok: true });
});

app.get('/api/sessions/:code/export', checkAuth, (req, res) => {
  const data = db.load();
  const session = safeGet(data.sessions, req.params.code);
  if (!session || session.companyId !== req.companyId) return res.status(404).send('Сессия не найдена');
  const test = safeGet(data.tests, session.testId);
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

// ==================== ИМПОРТ И ШАБЛОНЫ ====================

app.get('/api/import-template', checkAuth, (req, res) => {
  const headers = ['Вопрос', 'Вариант 1', 'Вариант 2', 'Вариант 3', 'Вариант 4', 'Вариант 5', 'Правильные (номера через запятую)', 'Теги (через запятую, необязательно)'];
  const example1 = ['Какая муфта применяется во избежание поломок деталей механизма из-за перегрузок?', 'Компенсирующая муфта', 'Жёсткая муфта', 'Предохранительная муфта', 'Обгонная муфта', '', '3', 'приводы и передачи'];
  const example2 = ['Выберите чётные числа', '1', '2', '3', '4', '', '2,4', ''];
  const ws = XLSX.utils.aoa_to_sheet([headers, example1, example2]);
  ws['!cols'] = [{ wch: 45 }, { wch: 20 }, { wch: 20 }, { wch: 20 }, { wch: 20 }, { wch: 20 }, { wch: 30 }, { wch: 30 }];
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
    const tagsRaw = String(row[7] || '').trim();
    const tags = tagsRaw ? [...new Set(tagsRaw.split(',').map(t => t.trim()).filter(Boolean))] : [];
    questions.push({ text, options, correct: multi ? correctIdxs : correctIdxs[0], multi, tags });
  }
  if (questions.length === 0) {
    return res.status(400).json({ error: 'Не удалось распознать ни одного вопроса. Проверьте формат файла (скачайте шаблон).', skipped });
  }
  res.json({ questions, skipped });
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
  const list = Object.values(data.labs)
    .filter(l => l.shared || l.companyId === req.companyId)
    .map(l => ({
      id: l.id,
      title: l.title,
      intro: l.intro,
      faultCount: l.faults.length,
      shared: !!l.shared
    }));
  res.json(list);
});

app.get('/api/labs/:id', checkAuth, (req, res) => {
  const data = db.load();
  const lab = safeGet(data.labs, req.params.id);
  if (!lab || (!lab.shared && lab.companyId !== req.companyId)) return res.status(404).json({ error: 'Тренажёр не найден' });
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
    shared: false,
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
    const existing = safeGet(d.labs, req.params.id);
    if (!existing || existing.shared || existing.companyId !== req.companyId) return null;
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
    const lab = safeGet(d.labs, req.params.id);
    if (lab && !lab.shared && lab.companyId === req.companyId) {
      delete d.labs[req.params.id];
      Object.keys(d.sessions).forEach(code => {
        if (d.sessions[code].labId === req.params.id && d.sessions[code].companyId === req.companyId) {
          delete d.sessions[code];
        }
      });
    }
  });
  res.json({ ok: true });
});

app.post('/api/lab-sessions', checkAuth, async (req, res) => {
  const { labId } = req.body;
  const data = db.load();
  const lab = safeGet(data.labs, labId);
  if (!lab || (!lab.shared && lab.companyId !== req.companyId)) return res.status(404).json({ error: 'Тренажёр не найден' });
  let code;
  do { code = nanoid(); } while (safeGet(data.sessions, code));
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
  const session = safeGet(data.sessions, req.params.code);
  if (!session || session.companyId !== req.companyId || session.type !== 'lab') {
    return res.status(404).json({ error: 'Сессия не найдена' });
  }
  res.json(session);
});

// Публичный маршрут — его вызывает страница студента (/l/:code) ДО присоединения, без авторизации компании.
app.get('/api/lab-sessions/:code/info', (req, res) => {
  const data = db.load();
  const session = safeGet(data.sessions, req.params.code);
  if (!session || session.type !== 'lab') return res.status(404).json({ error: 'Сессия не найдена' });
  if (session.ended) return res.status(410).json({ error: 'Тренажёр завершён' });
  const trialMsg = trialBlockedForCompany(data, session.companyId);
  if (trialMsg) return res.status(403).json({ error: 'TRIAL_ENDED', message: trialMsg });
  const lab = safeGet(data.labs, session.labId);
  res.json({ testTitle: session.testTitle, intro: lab ? lab.intro : '', caseCount: lab ? lab.faults.length : 0 });
});

app.post('/api/lab-sessions/:code/join', joinLimiter, async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Введите имя' });
  const data = db.load();
  const session = safeGet(data.sessions, req.params.code);
  if (!session || session.type !== 'lab') return res.status(404).json({ error: 'Сессия не найдена' });
  if (session.ended) return res.status(410).json({ error: 'Тренажёр завершён' });
  const trialMsg = trialBlockedForCompany(data, session.companyId);
  if (trialMsg) return res.status(403).json({ error: 'TRIAL_ENDED', message: trialMsg });
  const lab = safeGet(data.labs, session.labId);
  if (!lab) return res.status(404).json({ error: 'Тренажёр не найден' });
  const pid = participantId();
  const caseAssignment = assignCases(lab);
  const participant = {
    id: pid,
    name: name.trim().slice(0, 80),
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
  const safeAnswers = Array.isArray(answers) ? answers : [];
  const data = db.load();
  const session = safeGet(data.sessions, req.params.code);
  if (!session || session.type !== 'lab') return res.status(404).json({ error: 'Сессия не найдена' });
  const participant = safeGet(session.participants, pid);
  if (!participant) return res.status(404).json({ error: 'Участник не найден' });
  if (participant.finished) return res.status(400).json({ error: 'Тренажёр уже сдан' });
  const lab = safeGet(data.labs, session.labId);
  if (!lab) return res.status(404).json({ error: 'Тренажёр не найден' });
  let score = 0;
  const total = participant.caseAssignment.length;
  const review = [];
  participant.caseAssignment.forEach((assignment, i) => {
    const fault = lab.faults.find(f => f.id === assignment.faultId);
    const v = fault.variations[assignment.variationIndex];
    const given = safeAnswers[i];
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
    const p = safeGet(d.sessions[req.params.code].participants, pid);
    p.finished = true;
    p.finishedAt = Date.now();
    p.score = score;
    p.total = total;
    p.review = review;
    return p;
  });
  await incrementSubmissions(session.companyId);
  io.to('session:' + req.params.code).emit('participant:finished', result);
  res.json({ score, total, review });
});

app.post('/api/lab-sessions/:code/end', checkAuth, async (req, res) => {
  await db.update((d) => {
    const s = safeGet(d.sessions, req.params.code);
    if (s && s.companyId === req.companyId) {
      s.ended = true;
    }
  });
  io.to('session:' + req.params.code).emit('session:ended');
  res.json({ ok: true });
});

app.get('/api/lab-sessions/:code/export', checkAuth, (req, res) => {
  const data = db.load();
  const session = safeGet(data.sessions, req.params.code);
  if (!session || session.companyId !== req.companyId || session.type !== 'lab') return res.status(404).send('Сессия не найдена');
  const lab = safeGet(data.labs, session.labId);
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

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

io.on('connection', (socket) => {
  socket.on('teacher:watch', (code) => {
    if (typeof code === 'string') socket.join('session:' + code);
  });
  socket.on('teacher:unwatch', (code) => {
    if (typeof code === 'string') socket.leave('session:' + code);
  });
});

// ==================== АДМИН-ПАНЕЛЬ ====================

app.get('/api/admin/overview', checkAdmin, (req, res) => {
  const data = db.load();
  res.json({
    companies: Object.keys(data.companies).length,
    tests: Object.keys(data.tests).length,
    sessions: Object.keys(data.sessions).length,
    labs: Object.keys(data.labs).length
  });
});

app.get('/api/admin/companies', checkAdmin, (req, res) => {
  const data = db.load();
  const list = Object.values(data.companies).map(c => ({
    id: c.id,
    email: c.email,
    name: c.name,
    plan: c.plan,
    blocked: !!c.blocked,
    registeredAt: c.registeredAt,
    testsCount: Object.values(data.tests).filter(t => t.companyId === c.id).length,
    submissions: (c.usage && c.usage.submissions) || 0,
    submissionsLimit: FREE_MAX_SUBMISSIONS
  })).sort((a, b) => b.registeredAt - a.registeredAt);
  res.json(list);
});

app.post('/api/admin/companies/:id/plan', checkAdmin, async (req, res) => {
  const { plan } = req.body;
  if (!['free', 'unlimited'].includes(plan)) return res.status(400).json({ error: 'Некорректный тариф' });
  const result = await db.update((d) => {
    const c = safeGet(d.companies, req.params.id);
    if (!c) return null;
    c.plan = plan;
    return c;
  });
  if (!result) return res.status(404).json({ error: 'Компания не найдена' });
  res.json({ ok: true });
});

app.post('/api/admin/companies/:id/block', checkAdmin, async (req, res) => {
  const result = await db.update((d) => {
    const c = safeGet(d.companies, req.params.id);
    if (!c) return null;
    c.blocked = !!req.body.blocked;
    return c;
  });
  if (!result) return res.status(404).json({ error: 'Компания не найдена' });
  res.json({ ok: true });
});

app.post('/api/admin/companies/:id/reset-usage', checkAdmin, async (req, res) => {
  const result = await db.update((d) => {
    const c = safeGet(d.companies, req.params.id);
    if (!c) return null;
    c.usage = { submissions: 0 };
    return c;
  });
  if (!result) return res.status(404).json({ error: 'Компания не найдена' });
  res.json({ ok: true });
});

app.delete('/api/admin/companies/:id', checkAdmin, async (req, res) => {
  const cid = req.params.id;
  await db.update((d) => {
    if (!Object.prototype.hasOwnProperty.call(d.companies, cid)) return;
    delete d.companies[cid];
    Object.keys(d.tests).forEach(id => { if (d.tests[id].companyId === cid) delete d.tests[id]; });
    Object.keys(d.sessions).forEach(code => { if (d.sessions[code].companyId === cid) delete d.sessions[code]; });
    Object.keys(d.labs).forEach(id => { if (d.labs[id].companyId === cid) delete d.labs[id]; });
  });
  res.json({ ok: true });
});

// Резервная копия всей базы данных целиком (компании, тесты, сессии, тренажёры) в виде
// скачиваемого JSON-файла. Доступно только администратору.
app.get('/api/admin/backup', checkAdmin, (req, res) => {
  const data = db.load();
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  res.setHeader('Content-Disposition', `attachment; filename="quiz-b2b-backup-${stamp}.json"`);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.send(JSON.stringify(data, null, 2));
});

async function seedLabs() {
  await db.update((d) => {
    if (!d.labs) d.labs = {};
    SEED_LABS.forEach(l => { d.labs[l.id] = { ...l, shared: true }; });
  });
  console.log(`[labs] Синхронизировано общих тренажёров: ${SEED_LABS.length}`);
}

// ==================== ГЛОБАЛЬНАЯ ОБРАБОТКА ОШИБОК ====================
// Ловит любую ошибку, брошенную (или переданную через next(err)) внутри
// обработчиков маршрутов, чтобы один сбойный запрос не ронял весь процесс.
app.use((err, req, res, next) => {
  console.error('[unhandled route error]', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Внутренняя ошибка сервера. Попробуйте ещё раз.' });
});

// Последний рубеж: если ошибка всё же произошла вне express (например, в
// таймере или сокет-обработчике), логируем и продолжаем работу вместо краша.
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException] Сервер продолжает работу:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection] Сервер продолжает работу:', reason);
});

async function start() {
  await db.initCache();
  await seedLabs();
  server.listen(PORT, '0.0.0.0', () => {
    console.log('');
    console.log('=== Приложение для тестирования запущено ===');
    console.log(`Панель преподавателя: http://localhost:${PORT}`);
    console.log(`Админ-панель: ${getBaseUrl()}/admin`);
    console.log(`Публичный адрес (для QR): ${getBaseUrl()}`);
    console.log('==============================================');
  });
}

start();
