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
const { SEED_DRAWING_TASKS } = require('./drawing-content');
const { SEED_ANSWER_KEYS } = require('./drawing-answer-keys-content');
const { computeAnswer: computeToleranceAnswer, SEED_TOLERANCE_TASK, RANGES: TOLERANCE_RANGES, HOLE_FIELDS, SHAFT_FIELDS, rangeIndex: toleranceRangeIndex } = require('./tolerance-content');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const nanoid = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 5);
const participantId = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 12);
const companyIdGen = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 12);

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const { LOCAL_MODE, APP_DIR } = db;

// config.json рядом с программой (только локальный режим). Создаётся при первом запуске.
//   port        — порт сервера (если занят, берётся следующий свободный)
//   openBrowser — открывать панель преподавателя в браузере при запуске
//   publicUrl   — принудительный адрес для студентов (если определился неверно)
//   remoteUrl   — адрес для удалённых студентов (Tailscale Funnel и т.п.), см. README
function loadLocalConfig() {
  const defaults = { port: 3000, openBrowser: true, publicUrl: '', remoteUrl: '' };
  const file = path.join(APP_DIR, 'config.json');
  try {
    if (!require('fs').existsSync(file)) {
      require('fs').writeFileSync(file, JSON.stringify(defaults, null, 2));
      return defaults;
    }
    return Object.assign({}, defaults, JSON.parse(require('fs').readFileSync(file, 'utf8')));
  } catch (e) {
    console.warn('[config] Не удалось прочитать config.json — используются настройки по умолчанию:', e.message);
    return defaults;
  }
}
const localCfg = LOCAL_MODE ? loadLocalConfig() : {};
let PORT = parseInt(process.env.PORT || localCfg.port || 3000, 10) || 3000;

// ==================== КОНФИГУРАЦИЯ БЕЗОПАСНОСТИ И ТАРИФОВ ====================
// ВАЖНО: перед деплоем в продакшн задайте эти переменные окружения на хостинге (например, в Render → Environment):
//   ADMIN_PASSWORD       — ваш собственный пароль для входа в /admin
//   SESSION_SECRET       — любая длинная случайная строка (секрет для подписи токенов)
//   DEVELOPER_CONTACTS   — текст с вашими контактами, который увидят клиенты после окончания пробного периода
const fs = require('fs');
// Секрет и пароль админа, если не заданы в окружении, один раз создаются и сохраняются
// в папке data/ — поэтому после перезапуска сервера (в т.ч. .exe) преподаватели не
// разлогиниваются, а известного всем пароля по умолчанию больше нет.
function persistentSecret(fileName, generate) {
  try {
    const file = path.join(db.DATA_DIR, fileName);
    if (fs.existsSync(file)) {
      const v = fs.readFileSync(file, 'utf8').trim();
      if (v) return { value: v, created: false, persisted: true };
    }
    const v = generate();
    fs.mkdirSync(db.DATA_DIR, { recursive: true });
    fs.writeFileSync(file, v, { mode: 0o600 });
    return { value: v, created: true, persisted: true };
  } catch (e) {
    return { value: generate(), created: true, persisted: false };
  }
}
const secretInfo = process.env.SESSION_SECRET ? null : persistentSecret('secret.key', () => crypto.randomBytes(32).toString('hex'));
const adminInfo = process.env.ADMIN_PASSWORD ? null : persistentSecret('admin-password.txt', () => crypto.randomBytes(6).toString('hex'));
let ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || adminInfo.value;
let SESSION_SECRET = process.env.SESSION_SECRET || secretInfo.value;
const DEVELOPER_CONTACTS = process.env.DEVELOPER_CONTACTS ||
  'Свяжитесь с разработчиком, чтобы продолжить работу (контакты не настроены — задайте переменную окружения DEVELOPER_CONTACTS).';

const FREE_MAX_TESTS = 3;
const FREE_MAX_QUESTIONS = 20;
const MAX_IMAGE_LEN = 1500000; // ~1.1 МБ бинарных данных в виде base64 data URL

// Проверяет изображение вопроса: допускается только data URL (картинка, отправленная
// с клиента уже сжатой через canvas), с ограничением на размер, чтобы не раздувать
// единый JSON-блок базы данных, который целиком перезаписывается при каждом сохранении.
function sanitizeQuestionImage(img) {
  if (!img || typeof img !== 'string') return null;
  if (!img.startsWith('data:image/')) return null;
  if (img.length > MAX_IMAGE_LEN) return null;
  return img;
}
const FREE_MAX_SUBMISSIONS = 20;

if (adminInfo) {
  if (adminInfo.created) {
    console.warn('[security] ADMIN_PASSWORD не задан — создан случайный пароль админ-панели: ' + adminInfo.value +
      (adminInfo.persisted ? '  (сохранён в data/admin-password.txt, можно заменить своим — просто отредактируйте файл или задайте переменную ADMIN_PASSWORD)' : '  (сохранить в файл не удалось — после перезапуска будет новый!)'));
  }
}
if (secretInfo && !secretInfo.persisted) {
  console.warn('[security] SESSION_SECRET не задан и сохранить его в data/ не удалось — после перезапуска сервера все войдут заново.');
}

app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(express.json({ limit: '3mb' }));

// ---- Облачный режим (Render + Supabase): секреты в самой базе, состояние и «защита от пустой базы» ----
// Диск Render стирается при каждом перезапуске, поэтому файлы secret.key / admin-password.txt там
// не живут. Если SESSION_SECRET / ADMIN_PASSWORD не заданы в переменных окружения, они один раз
// создаются и хранятся в Supabase вместе с остальными данными — преподаватели не разлогиниваются
// при перезапусках сервиса. (Пароль админки при создании печатается в журнал Render.)
let cloudSecretsPromise = null;
function ensureCloudSecrets() {
  if (LOCAL_MODE || !db.USE_SUPABASE) return Promise.resolve();
  if (!cloudSecretsPromise) {
    cloudSecretsPromise = (async () => {
      let adminCreated = false;
      await db.update((d) => {
        d.meta = d.meta || {};
        if (!process.env.SESSION_SECRET) {
          if (!d.meta.sessionSecret) d.meta.sessionSecret = crypto.randomBytes(32).toString('hex');
          SESSION_SECRET = d.meta.sessionSecret;
        }
        if (!process.env.ADMIN_PASSWORD) {
          if (!d.meta.adminPassword) { d.meta.adminPassword = crypto.randomBytes(6).toString('hex'); adminCreated = true; }
          ADMIN_PASSWORD = d.meta.adminPassword;
        }
      });
      if (adminCreated) console.warn('[security] ADMIN_PASSWORD не задан в Render — создан пароль админ-панели: ' + ADMIN_PASSWORD + '  (сохранён в базе; задайте свой в Environment → ADMIN_PASSWORD, чтобы заменить)');
    })().catch((e) => { cloudSecretsPromise = null; throw e; });
  }
  return cloudSecretsPromise;
}

// Проверка состояния для пингеров/мониторинга: без авторизации и без личных данных.
app.get('/health', (req, res) => {
  const st = db.status();
  res.json({ ok: true, uptimeSec: Math.round(process.uptime()), db: { ready: st.ready, unsavedChanges: st.unsavedChanges } });
});

// Пока облачная база не подключена, API не принимает запросы (иначе преподаватель увидел бы пустые
// списки, а новые записи могли бы затереть настоящие данные). Страницы студентов повторяют отправку.
app.use('/api', (req, res, next) => {
  if (!db.isReady()) {
    return res.status(503).json({ error: 'База данных подключается. Подождите 10–20 секунд и повторите.', code: 'DB_UNAVAILABLE' });
  }
  ensureCloudSecrets().then(() => next()).catch(() => res.status(503).json({ error: 'Сервер ещё запускается. Повторите через несколько секунд.', code: 'DB_UNAVAILABLE' }));
});
// Страницы: если рядом с программой лежит папка public — берём файлы оттуда (их можно править
// и заменять без пересборки .exe), иначе — встроенные в программу.
const BUNDLED_PUBLIC = path.join(__dirname, 'public');
const EXTERNAL_PUBLIC = path.join(APP_DIR, 'public');
function publicFile(name) {
  const ext = path.join(EXTERNAL_PUBLIC, name);
  try { if (LOCAL_MODE && require('fs').existsSync(ext)) return ext; } catch (e) { /* берём встроенный */ }
  return path.join(BUNDLED_PUBLIC, name);
}
if (LOCAL_MODE && EXTERNAL_PUBLIC !== BUNDLED_PUBLIC) app.use(express.static(EXTERNAL_PUBLIC)); // папка может появиться и позже
app.use(express.static(BUNDLED_PUBLIC));

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

// ==================== СЕТЬ: АДРЕС ДЛЯ QR-КОДА ====================
// В локальном режиме студенты заходят по IP компьютера преподавателя в общей Wi-Fi сети.
// У компьютера бывает несколько адресов (Wi-Fi, Ethernet, VPN, виртуальные адаптеры, точка
// доступа Windows), поэтому адреса ранжируются, а преподаватель может выбрать нужный на
// странице /network. Выбор хранится в data/network.json.
const NET_PREFS_FILE = path.join(db.DATA_DIR, 'network.json');
let netPrefs = {};
try { netPrefs = JSON.parse(require('fs').readFileSync(NET_PREFS_FILE, 'utf8')) || {}; } catch (e) { netPrefs = {}; }

const VIRTUAL_RE = /vethernet|virtualbox|vmware|vmnet|hyper-v|docker|wsl|veth|br-|bluetooth|loopback|tap-|openvpn|zerotier|vpn|virbr|utun|tun\d/i;
function isPrivateIp(ip) { return /^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip); }
function isTailscaleIp(ip) { const p = ip.split('.').map(Number); return p[0] === 100 && p[1] >= 64 && p[1] <= 127; }

function listNetworkCandidates() {
  const out = [];
  const ifaces = os.networkInterfaces();
  Object.keys(ifaces).forEach(name => (ifaces[name] || []).forEach(i => {
    if (!(i.family === 'IPv4' || i.family === 4) || i.internal) return;
    const ip = i.address;
    if (ip.startsWith('169.254.')) return; // адрес «без сети»
    let kind = 'lan', score = 50;
    if (isTailscaleIp(ip) || /tailscale/i.test(name)) { kind = 'remote'; score = 0; }
    else if (ip === '192.168.137.1') { kind = 'hotspot'; score = 100; } // «Мобильный хот-спот» Windows
    else if (VIRTUAL_RE.test(name)) { kind = 'virtual'; score = 10; }
    else {
      if (/wi-?fi|wlan|wireless|беспровод|ethernet|local area|локальной сети/i.test(name)) score += 20;
      if (isPrivateIp(ip)) score += 20;
    }
    out.push({ name, ip, kind, score });
  }));
  return out.sort((a, b) => b.score - a.score);
}

function getLocalIp() {
  const lan = listNetworkCandidates().filter(c => c.kind !== 'remote');
  const pref = netPrefs.preferredIp && lan.find(c => c.ip === netPrefs.preferredIp);
  return (pref || lan[0] || { ip: 'localhost' }).ip;
}

function getRemoteBase() {
  if (!LOCAL_MODE) return null;
  if (localCfg.remoteUrl) return String(localCfg.remoteUrl).replace(/\/$/, '');
  const ts = listNetworkCandidates().find(c => c.kind === 'remote');
  return ts ? `http://${ts.ip}:${PORT}` : null;
}

// session (необязательно): сессия, открытая «для удалённых студентов», получает адрес Tailscale.
function getBaseUrl(session) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  if (process.env.RENDER_EXTERNAL_URL) return process.env.RENDER_EXTERNAL_URL.replace(/\/$/, '');
  if (LOCAL_MODE && session && session.remote) { const r = getRemoteBase(); if (r) return r; }
  if (LOCAL_MODE && localCfg.publicUrl) return String(localCfg.publicUrl).replace(/\/$/, '');
  return `http://${getLocalIp()}:${PORT}`;
}

function wantsRemote(req) {
  return LOCAL_MODE && !!(req.body && req.body.remote) && !!getRemoteBase();
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

// Основной провайдер — Yandex Cloud Translate. Ключ привязан к аккаунту, а не к
// исходящему IP сервера, поэтому не страдает от общих блокировок анонимного
// доступа, в которые упирается MyMemory на бесплатном тарифе Render (там IP
// общий для многих чужих проектов). Плюс: Yandex принимает целую пачку текстов
// ОДНИМ запросом, поэтому лимиты по скорости запросов почти не встречаются даже
// на больших тестах. Настраивается через переменные окружения
// YANDEX_TRANSLATE_API_KEY и YANDEX_FOLDER_ID (см. Yandex Cloud Console).
const YANDEX_TRANSLATE_API_KEY = process.env.YANDEX_TRANSLATE_API_KEY || '';
const YANDEX_FOLDER_ID = process.env.YANDEX_FOLDER_ID || '';
const USE_YANDEX = !!(YANDEX_TRANSLATE_API_KEY && YANDEX_FOLDER_ID);

// Резервный вариант, если ключ Yandex ещё не настроен — анонимный MyMemory.
// Необязательный email поднимает его дневной лимит (см. документацию MyMemory,
// параметр «de»), но всё равно остаётся подвержен общим блокировкам IP Render.
const MYMEMORY_EMAIL = process.env.MYMEMORY_EMAIL || '';

if (USE_YANDEX) {
  console.log('[translate] Провайдер перевода: Yandex Cloud Translate');
} else {
  console.warn('[translate] ВНИМАНИЕ: YANDEX_TRANSLATE_API_KEY/YANDEX_FOLDER_ID не заданы — используется анонимный MyMemory (менее надёжен на общем IP Render, может упираться в лимит запросов). Задайте переменные окружения, чтобы включить Yandex.');
}

function translationCacheKey(text, target) {
  return crypto.createHash('sha1').update(target + '::' + text).digest('hex');
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Переводит пачку текстов ОДНИМ запросом к Yandex Cloud Translate API.
async function translateBatchViaYandex(texts) {
  const resp = await fetch('https://translate.api.cloud.yandex.net/translate/v2/translate', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Api-Key ${YANDEX_TRANSLATE_API_KEY}`
    },
    body: JSON.stringify({
      folderId: YANDEX_FOLDER_ID,
      texts,
      sourceLanguageCode: 'ru',
      targetLanguageCode: 'kk'
    }),
    signal: AbortSignal.timeout(15000)
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`yandex translate http ${resp.status}: ${body.slice(0, 200)}`);
  }
  const json = await resp.json();
  if (!json || !Array.isArray(json.translations)) throw new Error('yandex translate: неожиданный формат ответа');
  return json.translations.map(t => (t && t.text) || '');
}

async function translateOneViaMyMemory(text, target, attempt = 0) {
  try {
    let url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=ru|${target}`;
    if (MYMEMORY_EMAIL) url += `&de=${encodeURIComponent(MYMEMORY_EMAIL)}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (resp.status === 429) {
      // Превышена скорость запросов (не дневной лимит — тот приходит как 200 с
      // текстовым предупреждением, см. ниже). Даём сервису «отдышаться» и пробуем
      // ещё раз один раз, прежде чем сдаться и вернуть оригинал.
      if (attempt < 1) {
        await sleep(1500);
        return translateOneViaMyMemory(text, target, attempt + 1);
      }
      console.warn('[translate] MyMemory: превышен лимит запросов в секунду (429), временно возвращаем оригинал');
      return text;
    }
    if (!resp.ok) throw new Error('translate http ' + resp.status);
    const json = await resp.json();
    const translated = json && json.responseData && json.responseData.translatedText
      ? json.responseData.translatedText
      : text;
    // Иногда сервис возвращает служебные сообщения об ошибках вместо перевода
    // (например, исчерпан дневной бесплатный лимит) — такое НЕ кэшируем выше по стеку.
    const looksLikeError = /MYMEMORY WARNING|INVALID|QUERY LENGTH LIMIT/i.test(translated);
    return looksLikeError ? text : translated;
  } catch (e) {
    console.error('[translate] Ошибка перевода (MyMemory):', e.message);
    return text; // при недоступности сервиса возвращаем оригинал, чтобы приложение не падало
  }
}

// Переводит список текстов, используя кэш и выбранного провайдера (Yandex, если
// настроен, иначе резервный MyMemory). Кэшируются только реально переведённые
// тексты — ошибки/лимиты никогда не кэшируются, чтобы не «замораживать» текст
// непереведённым навсегда после временного сбоя сервиса.
async function translateBatch(texts, target) {
  const data = db.load();
  const results = new Array(texts.length);
  const toTranslate = []; // { index, text, key }

  texts.forEach((text, i) => {
    const clean = (text || '').toString();
    if (!clean.trim()) { results[i] = clean; return; }
    const key = translationCacheKey(clean, target);
    if (data.translations[key]) { results[i] = data.translations[key]; return; }
    toTranslate.push({ index: i, text: clean, key });
  });

  if (toTranslate.length === 0) return results;

  if (USE_YANDEX) {
    const GROUP_SIZE = 100; // с запасом по лимитам Yandex на размер одного запроса
    for (let g = 0; g < toTranslate.length; g += GROUP_SIZE) {
      const group = toTranslate.slice(g, g + GROUP_SIZE);
      try {
        const translated = await translateBatchViaYandex(group.map(t => t.text));
        const updates = {};
        group.forEach((t, i) => {
          const finalText = translated[i] || t.text;
          results[t.index] = finalText;
          updates[t.key] = finalText;
        });
        await db.update((d) => { if (!d.translations) d.translations = {}; Object.assign(d.translations, updates); });
      } catch (e) {
        console.error('[translate] Ошибка перевода (Yandex):', e.message);
        group.forEach((t) => { results[t.index] = t.text; }); // не кэшируем — попробуем снова в следующий раз
      }
    }
    return results;
  }

  // Резервный вариант без ключа Yandex — старая логика через анонимный MyMemory
  // (медленнее и менее надёжно на общем IP Render).
  const CONCURRENCY = 2;
  const DELAY_MS = 150;
  let idx = 0;
  async function worker() {
    while (idx < toTranslate.length) {
      const i = idx++;
      const t = toTranslate[i];
      const translated = await translateOneViaMyMemory(t.text, target);
      results[t.index] = translated;
      if (translated !== t.text) {
        await db.update((d) => { if (!d.translations) d.translations = {}; d.translations[t.key] = translated; });
      }
      if (idx < toTranslate.length) await sleep(DELAY_MS);
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

// REGISTRATION=first-only — регистрация открыта только пока нет ни одной учётной записи
// (для сервера в интернете: после создания вашей записи посторонние зарегистрироваться не смогут);
// REGISTRATION=closed — закрыта полностью. Чтобы добавить преподавателя, временно уберите настройку.
app.post('/api/register', authLimiter, async (req, res) => {
  const regMode = process.env.REGISTRATION;
  if (regMode === 'closed' || (regMode === 'first-only' && Object.keys(db.load().companies).length > 0)) {
    return res.status(403).json({ error: 'Регистрация закрыта администратором. Для нового преподавателя обратитесь к владельцу сервера.' });
  }
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
    plan: LOCAL_MODE ? 'unlimited' : 'free',
    blocked: false,
    usage: { submissions: 0 },
    registeredAt: Date.now()
  };
  await db.update((d) => { d.companies[id] = company; });
  const token = signToken({ companyId: id }, 30 * 24 * 60 * 60 * 1000);
  res.json({ ok: true, companyId: id, token, email: cleanEmail, plan: LOCAL_MODE ? 'unlimited' : 'free' });
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
      tags: Array.isArray(q.tags) ? [...new Set(q.tags.map(t => String(t).trim()).filter(Boolean))] : [],
      explain: (q.explain || '').toString().trim(),
      image: sanitizeQuestionImage(q.image)
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
      tags: Array.isArray(q.tags) ? [...new Set(q.tags.map(t => String(t).trim()).filter(Boolean))] : [],
      explain: (q.explain || '').toString().trim(),
      image: sanitizeQuestionImage(q.image)
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
      tags: q.tags || [],
      explain: q.explain || '',
      image: q.image || null
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

// Ручной предварительный перевод всего теста на казахский ОДНИМ нажатием кнопки
// в редакторе (вместо перевода «на лету» во время реальной сдачи студентами).
// Собирает заголовок теста и все тексты вопросов/вариантов ответов, прогоняет их
// через переводчик (Yandex, если настроен, иначе резервный MyMemory) и складывает
// в общий кэш переводов. После этого студенты при переключении на KZ будут читать
// уже готовый перевод из кэша — без единого живого запроса к сервису перевода
// во время самого тестирования, что снимает любые проблемы с лимитами запросов.
app.post('/api/tests/:id/translate', checkAuth, async (req, res) => {
  const data = db.load();
  const test = safeGet(data.tests, req.params.id);
  if (!test || test.companyId !== req.companyId) return res.status(404).json({ error: 'Тест не найден' });

  const texts = [test.title];
  test.questions.forEach(q => {
    texts.push(q.text);
    (q.options || []).forEach(o => texts.push(o));
  });
  const uniqueTexts = [...new Set(texts.filter(t => (t || '').toString().trim()))];

  try {
    await translateBatch(uniqueTexts, 'kk');
    res.json({ ok: true, translated: uniqueTexts.length, provider: USE_YANDEX ? 'yandex' : 'mymemory' });
  } catch (e) {
    console.error('[translate] Ошибка предварительного перевода теста:', e.message);
    res.status(500).json({ error: 'Не удалось выполнить перевод, попробуйте ещё раз' });
  }
});


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

// Статистика по вопросам за ОДНУ конкретную сессию (группу), а не по всей истории
// теста. Нужна, чтобы посмотреть ошибки текущей/только что прошедшей группы прямо
// во время работы, не трогая и не стирая общую историю теста перед следующей группой.
app.get('/api/sessions/:code/stats', checkAuth, (req, res) => {
  const data = db.load();
  const session = safeGet(data.sessions, req.params.code);
  if (!session || session.companyId !== req.companyId || session.type === 'lab') {
    return res.status(404).json({ error: 'Сессия не найдена' });
  }
  const test = safeGet(data.tests, session.testId);
  if (!test) return res.status(404).json({ error: 'Тест не найден' });

  const allParticipants = Object.values(session.participants);
  const finished = allParticipants.filter(p => p.finished);

  const questionStats = test.questions.map(q => {
    let correct = 0;
    let total = 0;
    finished.forEach(p => {
      if (!p.answers) return;
      const a = p.answers[q.id];
      if (!a) return;
      total++;
      if (a.isCorrect) correct++;
    });
    return {
      id: q.id,
      text: q.text,
      correct,
      total,
      errorRate: total > 0 ? Math.round(((total - correct) / total) * 100) : null
    };
  }).sort((a, b) => (b.errorRate || 0) - (a.errorRate || 0));

  res.json({
    testTitle: test.title,
    code: session.code,
    totalParticipants: allParticipants.length,
    finishedParticipants: finished.length,
    questionStats
  });
});

// ==================== QR-КОД (ОТДЕЛЬНЫЙ МАРШРУТ ДЛЯ КАРТИНКИ) ====================
app.get('/api/sessions/:code/qr', async (req, res) => {
  const data = db.load();
  const session = safeGet(data.sessions, req.params.code);
  if (!session) return res.status(404).json({ error: 'Сессия не найдена' });
  const url = `${getBaseUrl(session)}/s/${req.params.code}`;
  const qrDataUrl = await QRCode.toDataURL(url, { width: 400, margin: 1 });
  res.setHeader('Content-Type', 'image/png');
  res.send(Buffer.from(qrDataUrl.split(',')[1], 'base64'));
});

// ==================== ГРУППЫ И СПИСКИ СТУДЕНТОВ ====================
// Преподаватель заводит группу (список ФИО) на странице /groups и привязывает её к новым
// сессиям. Тогда при входе введённое имя сопоставляется со списком: опечатки, регистр,
// «Иван Иванов» вместо «Иванов Иван» и «Иванов И.» приводятся к одному написанию из списка.
// Посторонний человек (или тот, кто ошибся в фамилии) в сессию не попадёт, а повторные
// заходы под разными написаниями одного имени невозможны. Если группа не привязана —
// всё работает как раньше (вход по любому имени).
const MAX_GROUPS_PER_COMPANY = 50;
const MAX_STUDENTS_PER_GROUP = 300;

function normName(s) {
  return String(s || '').toLowerCase().replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9\s-]/g, ' ').replace(/\s+/g, ' ').trim();
}
function sortedNameKey(s) { return normName(s).split(' ').filter(Boolean).sort().join(' '); }

function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

// Каждое введённое слово должно быть началом какого-то (своего) слова из ФИО: «иванов и» → «иванов иван».
function prefixMatches(inputTokens, studentTokens) {
  const used = new Set();
  for (const t of inputTokens) {
    const idx = studentTokens.findIndex((st, i) => !used.has(i) && st.startsWith(t));
    if (idx === -1) return false;
    used.add(idx);
  }
  return true;
}

// Разбор вставленного списка: по строке на студента; из Excel берутся текстовые ячейки,
// номера строк («1.», «2)», отдельные числовые столбцы) отбрасываются.
function parseStudentList(input) {
  const raw = Array.isArray(input) ? input.map(String) : String(input || '').split(/\r?\n|;/);
  const seen = new Set();
  const students = [];
  let duplicates = 0;
  for (const line of raw) {
    const cells = line.split('\t').map(c => c.trim()).filter(c => c && !/^\d+[.)]?$/.test(c));
    let name = cells.join(' ').replace(/^\d+[.)]\s*/, '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!name) continue;
    const key = sortedNameKey(name);
    if (!key) continue;
    if (seen.has(key)) { duplicates++; continue; }
    seen.add(key);
    students.push({ id: companyIdGen().slice(0, 8), name });
  }
  return { students: students.slice(0, MAX_STUDENTS_PER_GROUP), duplicates, truncated: students.length > MAX_STUDENTS_PER_GROUP };
}

function getGroup(data, session) {
  if (!session || !session.groupId) return null;
  const company = safeGet(data.companies, session.companyId);
  const group = company && company.groups ? safeGet(company.groups, session.groupId) : null;
  return group && Array.isArray(group.students) && group.students.length ? group : null;
}

// null — сессия без списка (работаем как раньше); {ok:true,name} — найден; {ok:false,message} — отказ.
function resolveRoster(data, session, rawName) {
  const group = getGroup(data, session);
  if (!group) return null;
  const students = group.students;
  const key = sortedNameKey(rawName);
  const exact = students.find(s => sortedNameKey(s.name) === key);
  if (exact) return { ok: true, name: exact.name };

  const tokens = normName(rawName).split(' ').filter(Boolean);
  if (tokens.join('').length >= 3) {
    const cands = students.filter(s => prefixMatches(tokens, normName(s.name).split(' ')));
    if (cands.length === 1) return { ok: true, name: cands[0].name };
    if (cands.length > 1) {
      return { ok: false, message: `Уточните имя — в группе «${group.name}» подходят несколько человек: ${cands.slice(0, 5).map(c => c.name).join('; ')}. Введите фамилию и имя полностью.` };
    }
  }
  const near = students
    .map(s => ({ name: s.name, d: levenshtein(key, sortedNameKey(s.name)) }))
    .filter(x => x.d <= Math.max(2, Math.round(key.length * 0.3)))
    .sort((a, b) => a.d - b.d).slice(0, 3);
  const hint = near.length ? ` Возможно, вы имели в виду: ${near.map(n => n.name).join('; ')}.` : '';
  return { ok: false, message: `Вас нет в списке группы «${group.name}». Проверьте написание фамилии и имени.${hint} Если вы не нашли себя — сообщите преподавателю.` };
}

// Какую группу привязать к создаваемой сессии: явный groupId из запроса
// (пустой/неизвестный — «без группы»), иначе — активная группа компании.
function pickGroupId(req) {
  const groups = (req.company && req.company.groups) || {};
  const explicit = req.body ? req.body.groupId : undefined;
  if (explicit !== undefined) return explicit && safeGet(groups, explicit) ? explicit : null;
  const active = req.company && req.company.activeGroupId;
  return active && safeGet(groups, active) ? active : null;
}

function groupSummary(g) { return { id: g.id, name: g.name, count: g.students.length }; }

app.get('/api/groups', checkAuth, (req, res) => {
  const groups = Object.values(req.company.groups || {}).map(groupSummary)
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  const active = req.company.activeGroupId && safeGet(req.company.groups || {}, req.company.activeGroupId)
    ? req.company.activeGroupId : null;
  res.json({ groups, activeGroupId: active });
});

app.get('/api/groups/:id', checkAuth, (req, res) => {
  const g = safeGet(req.company.groups || {}, req.params.id);
  if (!g) return res.status(404).json({ error: 'Группа не найдена' });
  res.json(g);
});

function cleanGroupName(v) { return String(v || '').replace(/\s+/g, ' ').trim().slice(0, 80); }

app.post('/api/groups', checkAuth, async (req, res) => {
  const name = cleanGroupName(req.body.name);
  if (!name) return res.status(400).json({ error: 'Введите название группы' });
  const parsed = parseStudentList(req.body.students !== undefined ? req.body.students : req.body.text);
  if (!parsed.students.length) return res.status(400).json({ error: 'Список студентов пуст' });
  if (Object.keys(req.company.groups || {}).length >= MAX_GROUPS_PER_COMPANY) {
    return res.status(400).json({ error: `Не более ${MAX_GROUPS_PER_COMPANY} групп` });
  }
  const id = companyIdGen();
  await db.update((d) => {
    const c = safeGet(d.companies, req.companyId);
    if (!c.groups) c.groups = {};
    c.groups[id] = { id, name, students: parsed.students, createdAt: Date.now() };
  });
  res.json({ ok: true, id, count: parsed.students.length, duplicates: parsed.duplicates, truncated: parsed.truncated });
});

app.put('/api/groups/:id', checkAuth, async (req, res) => {
  const existing = safeGet(req.company.groups || {}, req.params.id);
  if (!existing) return res.status(404).json({ error: 'Группа не найдена' });
  const name = req.body.name !== undefined ? cleanGroupName(req.body.name) : existing.name;
  if (!name) return res.status(400).json({ error: 'Введите название группы' });
  let students = existing.students, duplicates = 0, truncated = false;
  if (req.body.students !== undefined || req.body.text !== undefined) {
    const parsed = parseStudentList(req.body.students !== undefined ? req.body.students : req.body.text);
    if (!parsed.students.length) return res.status(400).json({ error: 'Список студентов пуст' });
    // Тем, кто остался в списке, сохраняем прежний id (имя могло лишь поменять написание).
    const byKey = new Map(existing.students.map(s => [sortedNameKey(s.name), s.id]));
    students = parsed.students.map(s => ({ id: byKey.get(sortedNameKey(s.name)) || s.id, name: s.name }));
    duplicates = parsed.duplicates; truncated = parsed.truncated;
  }
  await db.update((d) => {
    const c = safeGet(d.companies, req.companyId);
    c.groups[req.params.id] = { ...c.groups[req.params.id], name, students, updatedAt: Date.now() };
  });
  res.json({ ok: true, count: students.length, duplicates, truncated });
});

app.delete('/api/groups/:id', checkAuth, async (req, res) => {
  if (!safeGet(req.company.groups || {}, req.params.id)) return res.status(404).json({ error: 'Группа не найдена' });
  await db.update((d) => {
    const c = safeGet(d.companies, req.companyId);
    delete c.groups[req.params.id];
    if (c.activeGroupId === req.params.id) c.activeGroupId = null;
  });
  res.json({ ok: true });
});

app.post('/api/groups/active', checkAuth, async (req, res) => {
  const gid = req.body.groupId || null;
  if (gid && !safeGet(req.company.groups || {}, gid)) return res.status(404).json({ error: 'Группа не найдена' });
  await db.update((d) => { safeGet(d.companies, req.companyId).activeGroupId = gid; });
  res.json({ ok: true, activeGroupId: gid });
});

// Кто из группы пришёл / проходит / сдал / не пришёл — для любой сессии, привязанной к группе.
app.get('/api/sessions/:code/roster-status', checkAuth, (req, res) => {
  const data = db.load();
  const session = safeGet(data.sessions, req.params.code);
  if (!session || session.companyId !== req.companyId) return res.status(404).json({ error: 'Сессия не найдена' });
  const group = getGroup(data, session);
  if (!group) return res.json({ hasRoster: false });
  const byKey = new Map();
  Object.values(session.participants || {}).forEach(p => {
    const k = sortedNameKey(p.name);
    const prev = byKey.get(k);
    if (!prev || (p.finished && !prev.finished)) byKey.set(k, p); // лучший статус из дублей
  });
  const rows = group.students.map(s => {
    const p = byKey.get(sortedNameKey(s.name));
    const status = !p ? 'absent' : p.finished ? 'finished' : 'in_progress';
    return { name: s.name, status, score: p && p.finished ? p.score : null, total: p && p.finished ? p.total : null };
  });
  const listed = new Set(group.students.map(s => sortedNameKey(s.name)));
  const unlisted = Object.values(session.participants || {}).filter(p => !listed.has(sortedNameKey(p.name))).map(p => p.name);
  const counts = { total: rows.length, finished: 0, in_progress: 0, absent: 0 };
  rows.forEach(r => { counts[r.status]++; });
  res.json({ hasRoster: true, groupName: group.name, counts, rows, unlisted });
});

const GROUPS_PAGE_HTML = String.raw`<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Группы и списки студентов</title>
<style>
  :root { --bg:#f4f6fa; --card:#fff; --text:#1c2333; --muted:#667085; --line:#dfe3ec; --accent:#2f6fed; --ok:#12a150; --warn:#d9822b; --bad:#d64545; }
  @media (prefers-color-scheme: dark) { :root { --bg:#12151c; --card:#1b2030; --text:#e8ebf3; --muted:#9aa3b8; --line:#2b3248; --accent:#6a9bff; --ok:#3ecf7d; --warn:#f0a050; --bad:#ff7070; } }
  * { box-sizing:border-box; }
  body { margin:0; font:15px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; background:var(--bg); color:var(--text); }
  .wrap { max-width:860px; margin:0 auto; padding:16px; }
  h1 { font-size:22px; margin:8px 0 14px; }
  h2 { font-size:17px; margin:0 0 10px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:14px; margin-bottom:14px; }
  input, textarea { width:100%; padding:9px 10px; border:1px solid var(--line); border-radius:8px; background:var(--bg); color:var(--text); font:inherit; }
  textarea { min-height:160px; resize:vertical; }
  button { padding:8px 14px; border:1px solid var(--line); border-radius:8px; background:var(--card); color:var(--text); font:inherit; cursor:pointer; }
  button.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
  button.danger { color:var(--bad); }
  button:disabled { opacity:.5; cursor:default; }
  .row { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
  .grow { flex:1 1 200px; }
  .muted { color:var(--muted); font-size:13px; }
  .banner { padding:10px 12px; border-radius:10px; border:1px solid var(--warn); background:rgba(217,130,43,.12); margin-bottom:14px; }
  .banner.off { border-color:var(--line); background:transparent; color:var(--muted); }
  .err { color:var(--bad); margin-top:8px; }
  .group { display:flex; gap:8px; align-items:center; justify-content:space-between; flex-wrap:wrap; padding:10px 0; border-top:1px solid var(--line); }
  .group:first-of-type { border-top:0; }
  table { width:100%; border-collapse:collapse; margin-top:10px; }
  td, th { padding:6px 8px; border-bottom:1px solid var(--line); text-align:left; }
  .s-finished { color:var(--ok); } .s-in_progress { color:var(--warn); } .s-absent { color:var(--bad); }
  .hidden { display:none; }
</style>
</head>
<body>
<div class="wrap">
  <h1>Группы и списки студентов</h1>
  <p class="muted"><a href="/analytics" style="color:var(--accent);text-decoration:none">Аналитика и журнал →</a></p>

  <div id="loginBox" class="card hidden">
    <h2>Вход преподавателя</h2>
    <div class="row">
      <input id="email" class="grow" type="email" placeholder="Email">
      <input id="password" class="grow" type="password" placeholder="Пароль">
      <button class="primary" id="loginBtn">Войти</button>
    </div>
    <div id="loginErr" class="err"></div>
  </div>

  <div id="main" class="hidden">
    <div id="activeBanner" class="banner off"></div>

    <div class="card">
      <h2 id="formTitle">Новая группа</h2>
      <input id="gName" placeholder="Название группы, например: ТОиР-21">
      <p class="muted">Вставьте список студентов — по одному в строке (можно прямо из Excel: номера и лишние столбцы с цифрами отбрасываются). Студент при входе вводит имя как угодно — оно автоматически сопоставится со списком.</p>
      <textarea id="gStudents" placeholder="Иванов Иван&#10;Петров Пётр&#10;Сидорова Анна"></textarea>
      <div class="row" style="margin-top:10px">
        <button class="primary" id="saveBtn">Сохранить группу</button>
        <button id="cancelBtn" class="hidden">Отмена</button>
        <span id="formMsg" class="muted"></span>
      </div>
    </div>

    <div class="card">
      <h2>Мои группы</h2>
      <div id="groupList" class="muted">Загрузка…</div>
    </div>

    <div class="card">
      <h2>Кто пришёл и сдал</h2>
      <div class="row">
        <input id="codeInput" class="grow" placeholder="Код сессии (5 символов, как в ссылке /s/XXXXX)" maxlength="12">
        <button class="primary" id="statusBtn">Показать</button>
        <button id="copyAbsent" class="hidden">Копировать «не пришли»</button>
      </div>
      <div id="statusOut"></div>
    </div>
  </div>
</div>

<script>
(function () {
  var TOKEN_KEY = 'groupsPageToken';
  var token = sessionStorage.getItem(TOKEN_KEY) || localStorage.getItem('b2bToken') || '';
  var editingId = null;
  var groups = [];
  var activeGroupId = null;
  var lastAbsent = [];

  function $(id) { return document.getElementById(id); }
  function el(tag, props, children) {
    var e = document.createElement(tag);
    if (props) Object.keys(props).forEach(function (k) {
      if (k === 'text') e.textContent = props[k];
      else if (k === 'class') e.className = props[k];
      else if (k.indexOf('on') === 0) e.addEventListener(k.slice(2), props[k]);
      else e.setAttribute(k, props[k]);
    });
    (children || []).forEach(function (c) { if (c) e.appendChild(c); });
    return e;
  }
  function api(method, url, body) {
    return fetch(url, {
      method: method,
      headers: { 'Content-Type': 'application/json', 'x-company-id': token },
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (r.status === 401) { showLogin(); throw new Error('Нужен вход'); }
        if (!r.ok) throw new Error(d.error || d.message || ('Ошибка ' + r.status));
        return d;
      });
    });
  }

  function showLogin() {
    token = ''; sessionStorage.removeItem(TOKEN_KEY);
    $('loginBox').classList.remove('hidden'); $('main').classList.add('hidden');
  }
  function showMain() {
    $('loginBox').classList.add('hidden'); $('main').classList.remove('hidden');
    load();
  }

  $('loginBtn').addEventListener('click', function () {
    $('loginErr').textContent = '';
    fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: $('email').value, password: $('password').value }) })
      .then(function (r) { return r.json().then(function (d) { return { r: r, d: d }; }); })
      .then(function (x) {
        if (!x.r.ok || !x.d.token) { $('loginErr').textContent = x.d.error || x.d.message || 'Не удалось войти'; return; }
        token = x.d.token; sessionStorage.setItem(TOKEN_KEY, token); showMain();
      })
      .catch(function () { $('loginErr').textContent = 'Нет связи с сервером'; });
  });

  function renderBanner() {
    var b = $('activeBanner');
    var g = groups.filter(function (x) { return x.id === activeGroupId; })[0];
    b.textContent = '';
    if (g) {
      b.className = 'banner';
      b.appendChild(el('div', { text: 'Все НОВЫЕ сессии сейчас привязаны к группе «' + g.name + '»: войти смогут только студенты из списка.' }));
      b.appendChild(el('div', { class: 'row', style: 'margin-top:8px' }, [
        el('button', { text: 'Отключить привязку (вход для всех)', onclick: function () { setActive(null); } })
      ]));
    } else {
      b.className = 'banner off';
      b.textContent = 'Привязка к группе выключена: в новые сессии может войти любой, кто знает ссылку.';
    }
  }

  function renderList() {
    var box = $('groupList'); box.textContent = '';
    if (!groups.length) { box.textContent = 'Групп пока нет — создайте первую выше.'; return; }
    groups.forEach(function (g) {
      var isActive = g.id === activeGroupId;
      box.appendChild(el('div', { class: 'group' }, [
        el('div', {}, [
          el('strong', { text: g.name + (isActive ? '  ✓ активная' : '') }),
          el('div', { class: 'muted', text: g.count + ' чел.' })
        ]),
        el('div', { class: 'row' }, [
          isActive ? null : el('button', { text: 'Привязать к новым сессиям', onclick: function () { setActive(g.id); } }),
          el('button', { text: 'Изменить', onclick: function () { edit(g.id); } }),
          el('button', { class: 'danger', text: 'Удалить', onclick: function () { remove(g); } })
        ])
      ]));
    });
  }

  function load() {
    api('GET', '/api/groups').then(function (d) {
      groups = d.groups || []; activeGroupId = d.activeGroupId || null;
      renderBanner(); renderList();
    }).catch(function (e) { $('groupList').textContent = e.message; });
  }

  function setActive(id) {
    api('POST', '/api/groups/active', { groupId: id }).then(load).catch(function (e) { alert(e.message); });
  }

  function resetForm() {
    editingId = null; $('formTitle').textContent = 'Новая группа';
    $('gName').value = ''; $('gStudents').value = ''; $('formMsg').textContent = '';
    $('cancelBtn').classList.add('hidden');
  }
  function edit(id) {
    api('GET', '/api/groups/' + encodeURIComponent(id)).then(function (g) {
      editingId = id; $('formTitle').textContent = 'Изменение группы';
      $('gName').value = g.name; $('gStudents').value = g.students.map(function (s) { return s.name; }).join('\n');
      $('cancelBtn').classList.remove('hidden'); window.scrollTo(0, 0);
    }).catch(function (e) { alert(e.message); });
  }
  function remove(g) {
    if (!confirm('Удалить группу «' + g.name + '»? Уже прошедшие результаты останутся.')) return;
    api('DELETE', '/api/groups/' + encodeURIComponent(g.id)).then(load).catch(function (e) { alert(e.message); });
  }

  $('cancelBtn').addEventListener('click', resetForm);
  $('saveBtn').addEventListener('click', function () {
    var body = { name: $('gName').value, text: $('gStudents').value };
    var req = editingId ? api('PUT', '/api/groups/' + encodeURIComponent(editingId), body) : api('POST', '/api/groups', body);
    $('formMsg').textContent = 'Сохраняю…';
    req.then(function (d) {
      var msg = 'Сохранено: ' + d.count + ' чел.';
      if (d.duplicates) msg += ' (повторов отброшено: ' + d.duplicates + ')';
      resetForm(); $('formMsg').textContent = msg; load();
    }).catch(function (e) { $('formMsg').textContent = e.message; });
  });

  var LABELS = { finished: 'сдал', in_progress: 'проходит', absent: 'не пришёл' };
  $('statusBtn').addEventListener('click', function () {
    var code = $('codeInput').value.trim().toUpperCase();
    var out = $('statusOut'); out.textContent = ''; $('copyAbsent').classList.add('hidden');
    if (!code) return;
    api('GET', '/api/sessions/' + encodeURIComponent(code) + '/roster-status').then(function (d) {
      if (!d.hasRoster) { out.appendChild(el('p', { class: 'muted', text: 'Эта сессия не привязана к группе — список недоступен.' })); return; }
      out.appendChild(el('p', { text: 'Группа «' + d.groupName + '»: сдали ' + d.counts.finished + ', проходят ' + d.counts.in_progress + ', не пришли ' + d.counts.absent + ' из ' + d.counts.total + '.' }));
      var tb = el('table');
      tb.appendChild(el('tr', {}, [el('th', { text: 'Студент' }), el('th', { text: 'Статус' }), el('th', { text: 'Результат' })]));
      d.rows.forEach(function (r) {
        tb.appendChild(el('tr', {}, [
          el('td', { text: r.name }),
          el('td', { class: 's-' + r.status, text: LABELS[r.status] }),
          el('td', { text: r.status === 'finished' && r.total ? (r.score + ' / ' + r.total) : '' })
        ]));
      });
      out.appendChild(tb);
      lastAbsent = d.rows.filter(function (r) { return r.status === 'absent'; }).map(function (r) { return r.name; });
      if (lastAbsent.length) $('copyAbsent').classList.remove('hidden');
      if (d.unlisted && d.unlisted.length) out.appendChild(el('p', { class: 'muted', text: 'Вне списка (вошли до привязки): ' + d.unlisted.join(', ') }));
    }).catch(function (e) { out.appendChild(el('p', { class: 'err', text: e.message })); });
  });
  $('copyAbsent').addEventListener('click', function () {
    var text = lastAbsent.join('\n');
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(function () { $('copyAbsent').textContent = 'Скопировано'; });
    else window.prompt('Скопируйте:', text);
  });

  if (token) showMain(); else showLogin();
})();
</script>
</body>
</html>
`;
app.get('/groups', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(GROUPS_PAGE_HTML);
});

// ==================== АНАЛИТИКА: ТЕМЫ, ВОПРОСЫ, ГРУППА ====================
// Считается по уже сохранённым ответам (p.answers), поэтому работает и во время
// занятия (по тем, кто успел сдать), и после него. Страница — /analytics.
const WEAK_PCT = 60;              // ниже этого процента тема считается «слабой»
const WEAK_MIN_ATTEMPTS_STUDENT = 2; // у одного студента — не меньше 2 вопросов по теме
const WEAK_MIN_ATTEMPTS_GROUP = 5;   // по группе — не меньше 5 ответов по теме
const NO_TAG = 'Без темы';

function pct(correct, total) { return total > 0 ? Math.round((correct / total) * 1000) / 10 : null; }

function addTagStat(map, tag, ok) {
  const t = map.get(tag) || { tag, attempts: 0, correct: 0 };
  t.attempts++; if (ok) t.correct++;
  map.set(tag, t);
}
function tagList(map, minAttempts) {
  return [...map.values()]
    .map(t => ({ tag: t.tag, attempts: t.attempts, correct: t.correct, pct: pct(t.correct, t.attempts), weak: t.attempts >= minAttempts && pct(t.correct, t.attempts) < WEAK_PCT }))
    .sort((a, b) => (a.pct - b.pct) || (b.attempts - a.attempts));
}
function xl(v) { // защита от «формул» в ячейках Excel
  return typeof v === 'string' && /^[=+\-@]/.test(v) ? "'" + v : v;
}
function shortText(s, n) { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

// Самый частый неверный выбор по вопросу (анализ «отвлекающих» вариантов).
function topWrongAnswer(q, answers) {
  const picks = new Map(); let noAnswer = 0;
  answers.forEach(a => {
    if (a.isCorrect) return;
    if (q.multi) {
      const given = Array.isArray(a.given) ? a.given : [];
      const correct = Array.isArray(q.correct) ? q.correct : [];
      if (!given.length) noAnswer++;
      given.filter(i => !correct.includes(i)).forEach(i => picks.set('лишний: ' + i, (picks.get('лишний: ' + i) || 0) + 1));
      correct.filter(i => !given.includes(i)).forEach(i => picks.set('пропущен: ' + i, (picks.get('пропущен: ' + i) || 0) + 1));
    } else if (a.given === undefined || a.given === null || a.given === '') {
      noAnswer++;
    } else {
      picks.set('выбран: ' + a.given, (picks.get('выбран: ' + a.given) || 0) + 1);
    }
  });
  let best = null;
  picks.forEach((count, key) => { if (!best || count > best.count) best = { key, count }; });
  let top = null;
  if (best) {
    const idx = parseInt(best.key.split(': ')[1], 10);
    const label = (q.options && q.options[idx] !== undefined) ? shortText(q.options[idx], 80) : ('вариант ' + (idx + 1));
    top = { kind: best.key.split(': ')[0], option: label, count: best.count };
  }
  return { top, noAnswer };
}

function analyzeTestSessions(test, sessions) {
  // Результаты завершивших по всем переданным сессиям одного теста.
  const results = [];
  sessions.forEach(s => {
    Object.values(s.participants || {}).forEach(p => {
      if (!p.finished || !p.answers) return;
      results.push({ session: s, p });
    });
  });
  const tagMap = new Map();
  const questionRows = test.questions.map(q => {
    const tags = (q.tags && q.tags.length) ? q.tags : [NO_TAG];
    const answers = [];
    results.forEach(({ p }) => { const a = p.answers[q.id]; if (a) answers.push(a); });
    const correct = answers.filter(a => a.isCorrect).length;
    answers.forEach(a => tags.forEach(t => addTagStat(tagMap, t, a.isCorrect)));
    const wrong = topWrongAnswer(q, answers);
    return { id: q.id, text: shortText(q.text, 140), tags: q.tags || [], total: answers.length, correct, pct: pct(correct, answers.length), topWrong: wrong.top, noAnswer: wrong.noAnswer };
  }).filter(r => r.total > 0).sort((a, b) => a.pct - b.pct);
  return { results, tagMap, questionRows };
}

function studentTagStats(test, p) {
  const m = new Map();
  test.questions.forEach(q => {
    const a = p.answers && p.answers[q.id]; if (!a) return;
    ((q.tags && q.tags.length) ? q.tags : [NO_TAG]).forEach(t => addTagStat(m, t, a.isCorrect));
  });
  return tagList(m, WEAK_MIN_ATTEMPTS_STUDENT).filter(t => t.weak).map(t => t.tag);
}

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b), m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round(((s[m - 1] + s[m]) / 2) * 10) / 10;
}

function sendXlsx(res, wb, fileName) {
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
}

app.get('/api/sessions/:code/analytics', checkAuth, (req, res) => {
  const data = db.load();
  const session = safeGet(data.sessions, req.params.code);
  if (!session || session.companyId !== req.companyId || session.type) return res.status(404).json({ error: 'Сессия с тестом не найдена' });
  const test = safeGet(data.tests, session.testId);
  if (!test) return res.status(404).json({ error: 'Тест не найден' });

  const { results, tagMap, questionRows } = analyzeTestSessions(test, [session]);
  const pcts = results.map(({ p }) => pct(p.score, p.total) || 0);
  const buckets = [
    { label: '0–39%', count: pcts.filter(v => v < 40).length },
    { label: '40–59%', count: pcts.filter(v => v >= 40 && v < 60).length },
    { label: '60–79%', count: pcts.filter(v => v >= 60 && v < 80).length },
    { label: '80–100%', count: pcts.filter(v => v >= 80).length }
  ];
  const students = results.map(({ p }) => ({
    name: p.name, score: p.score, total: p.total, pct: pct(p.score, p.total),
    late: !!p.late, tabLong: p.tabSwitchLongCount || 0, weakTags: studentTagStats(test, p)
  })).sort((a, b) => b.pct - a.pct || a.name.localeCompare(b.name, 'ru'));
  const tags = tagList(tagMap, WEAK_MIN_ATTEMPTS_GROUP);
  const group = getGroup(data, session);
  const payload = {
    session: { code: session.code, testTitle: test.title, startedAt: session.startedAt, ended: !!session.ended,
      groupName: group ? group.name : null, participants: Object.keys(session.participants || {}).length, finished: results.length },
    summary: { count: results.length, avg: results.length ? Math.round(pcts.reduce((a, b) => a + b, 0) / results.length * 10) / 10 : null,
      median: median(pcts), min: pcts.length ? Math.min(...pcts) : null, max: pcts.length ? Math.max(...pcts) : null, buckets },
    tags, weakTags: tags.filter(t => t.weak).map(t => t.tag),
    questions: questionRows, students
  };
  if (req.query.format === 'xlsx') {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(tags.map(t => ({ 'Тема': xl(t.tag), 'Ответов': t.attempts, 'Верных': t.correct, '% верных': t.pct, 'Слабая': t.weak ? 'да' : '' }))), 'Темы');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(questionRows.map(q => ({
      'Вопрос': xl(q.text), 'Темы': xl(q.tags.join(', ')), 'Ответов': q.total, '% верных': q.pct,
      'Частая ошибка': q.topWrong ? xl(q.topWrong.kind + ': ' + q.topWrong.option + ' (' + q.topWrong.count + ')') : '', 'Без ответа': q.noAnswer }))), 'Вопросы');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(students.map(s => ({
      'Студент': xl(s.name), 'Баллы': s.score, 'Из': s.total, '%': s.pct, 'Слабые темы': xl(s.weakTags.join(', ')),
      'Сдан с опозданием': s.late ? 'да' : '', 'Долгих уходов с вкладки': s.tabLong }))), 'Студенты');
    return sendXlsx(res, wb, `analytics_${session.code}.xlsx`);
  }
  res.json(payload);
});

// Журнал группы: все тестовые сессии, привязанные к группе (последние 30).
app.get('/api/groups/:id/analytics', checkAuth, (req, res) => {
  const data = db.load();
  const group = safeGet(req.company.groups || {}, req.params.id);
  if (!group) return res.status(404).json({ error: 'Группа не найдена' });
  const sessions = Object.values(data.sessions)
    .filter(s => s.companyId === req.companyId && !s.type && s.groupId === group.id && safeGet(data.tests, s.testId))
    .sort((a, b) => a.startedAt - b.startedAt).slice(-30);

  const students = group.students.map(st => ({ name: st.name, key: sortedNameKey(st.name), results: [], tagMap: new Map() }));
  const byKey = new Map(students.map(s => [s.key, s]));
  const groupTags = new Map();
  const sessionRows = sessions.map(s => {
    const test = safeGet(data.tests, s.testId);
    let finished = 0, sum = 0;
    const seen = new Set();
    Object.values(s.participants || {}).forEach(p => {
      const st = byKey.get(sortedNameKey(p.name));
      if (!st || !p.finished || !p.answers || seen.has(st.key)) return;
      seen.add(st.key);
      const v = pct(p.score, p.total);
      st.results[sessions.indexOf(s)] = v;
      finished++; sum += v;
      test.questions.forEach(q => {
        const a = p.answers[q.id]; if (!a) return;
        ((q.tags && q.tags.length) ? q.tags : [NO_TAG]).forEach(t => { addTagStat(st.tagMap, t, a.isCorrect); addTagStat(groupTags, t, a.isCorrect); });
      });
    });
    return { code: s.code, testTitle: test.title, startedAt: s.startedAt, finished, absent: group.students.length - finished, avg: finished ? Math.round(sum / finished * 10) / 10 : null };
  });
  const out = students.map(st => {
    const cells = sessions.map((_, i) => (st.results[i] === undefined ? null : st.results[i]));
    const done = cells.filter(v => v !== null);
    const weakTags = tagList(st.tagMap, WEAK_MIN_ATTEMPTS_STUDENT).filter(t => t.weak).map(t => t.tag);
    return {
      name: st.name, cells, done: done.length, missed: sessions.length - done.length,
      avg: done.length ? Math.round(done.reduce((a, b) => a + b, 0) / done.length * 10) / 10 : null,
      trend: done.length >= 2 ? Math.round((done[done.length - 1] - done[0]) * 10) / 10 : null,
      weakTags
    };
  });
  const tags = tagList(groupTags, WEAK_MIN_ATTEMPTS_GROUP);
  if (req.query.format === 'xlsx') {
    const wb = XLSX.utils.book_new();
    const rows = out.map(s => {
      const r = { 'Студент': xl(s.name) };
      sessionRows.forEach((sr, i) => { r[new Date(sr.startedAt).toLocaleDateString('ru-RU') + ' ' + shortText(sr.testTitle, 25) + ' (' + sr.code + ')'] = s.cells[i] === null ? 'не сдал' : s.cells[i]; });
      r['Среднее %'] = s.avg; r['Пропусков'] = s.missed; r['Слабые темы'] = xl(s.weakTags.join(', '));
      return r;
    });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Журнал');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(tags.map(t => ({ 'Тема': xl(t.tag), 'Ответов': t.attempts, '% верных': t.pct, 'Слабая': t.weak ? 'да' : '' }))), 'Темы');
    return sendXlsx(res, wb, 'journal.xlsx');
  }
  res.json({ group: groupSummary(group), sessions: sessionRows, students: out, tags, weakTags: tags.filter(t => t.weak).map(t => t.tag) });
});

const ANALYTICS_PAGE_HTML = String.raw`<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Аналитика</title>
<style>
  :root { --bg:#f4f6fa; --card:#fff; --text:#1c2333; --muted:#667085; --line:#dfe3ec; --accent:#2f6fed; --ok:#12a150; --warn:#d9822b; --bad:#d64545; }
  @media (prefers-color-scheme: dark) { :root { --bg:#12151c; --card:#1b2030; --text:#e8ebf3; --muted:#9aa3b8; --line:#2b3248; --accent:#6a9bff; --ok:#3ecf7d; --warn:#f0a050; --bad:#ff7070; } }
  * { box-sizing:border-box; }
  body { margin:0; font:15px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; background:var(--bg); color:var(--text); }
  .wrap { max-width:980px; margin:0 auto; padding:16px; }
  h1 { font-size:22px; margin:8px 0 6px; }
  h2 { font-size:17px; margin:0 0 10px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:14px; margin-bottom:14px; overflow-x:auto; }
  input, select { padding:9px 10px; border:1px solid var(--line); border-radius:8px; background:var(--bg); color:var(--text); font:inherit; }
  button { padding:8px 14px; border:1px solid var(--line); border-radius:8px; background:var(--card); color:var(--text); font:inherit; cursor:pointer; }
  button.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
  button.on { background:var(--accent); border-color:var(--accent); color:#fff; }
  .row { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
  .grow { flex:1 1 200px; }
  .muted { color:var(--muted); font-size:13px; }
  .err { color:var(--bad); margin:8px 0; }
  .hidden { display:none; }
  .kpis { display:flex; gap:10px; flex-wrap:wrap; }
  .kpi { flex:1 1 120px; border:1px solid var(--line); border-radius:10px; padding:10px; }
  .kpi b { display:block; font-size:22px; }
  table { width:100%; border-collapse:collapse; }
  td, th { padding:6px 8px; border-bottom:1px solid var(--line); text-align:left; vertical-align:top; }
  th { font-size:13px; color:var(--muted); font-weight:600; }
  .bar { height:10px; border-radius:5px; background:var(--line); overflow:hidden; min-width:90px; }
  .bar > i { display:block; height:100%; }
  .good { background:var(--ok); } .mid { background:var(--warn); } .low { background:var(--bad); }
  .tag { display:inline-block; padding:1px 8px; margin:1px 3px 1px 0; border-radius:10px; font-size:12px; border:1px solid var(--line); }
  .tag.weak { border-color:var(--bad); color:var(--bad); }
  .cell { text-align:center; min-width:46px; border-radius:6px; font-size:13px; }
  .c-none { color:var(--muted); }
  .c-good { background:rgba(18,161,80,.22); } .c-mid { background:rgba(217,130,43,.25); } .c-low { background:rgba(214,69,69,.25); }
  .nav a { color:var(--accent); text-decoration:none; margin-right:12px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>Аналитика</h1>
  <p class="nav muted"><a href="/groups">← Группы и списки</a></p>

  <div id="loginBox" class="card hidden">
    <h2>Вход преподавателя</h2>
    <div class="row">
      <input id="email" class="grow" type="email" placeholder="Email">
      <input id="password" class="grow" type="password" placeholder="Пароль">
      <button class="primary" id="loginBtn">Войти</button>
    </div>
    <div id="loginErr" class="err"></div>
  </div>

  <div id="main" class="hidden">
    <div class="card">
      <div class="row" style="margin-bottom:10px">
        <button id="tabSession" class="on">По сессии</button>
        <button id="tabGroup">По группе (журнал)</button>
      </div>
      <div id="sessionCtl" class="row">
        <input id="codeInput" class="grow" placeholder="Код сессии теста" maxlength="12">
        <button class="primary" id="showSession">Показать</button>
      </div>
      <div id="groupCtl" class="row hidden">
        <select id="groupSel" class="grow"></select>
        <button class="primary" id="showGroup">Показать</button>
      </div>
      <div id="msg" class="err"></div>
    </div>
    <div id="out"></div>
  </div>
</div>

<script>
(function () {
  var TOKEN_KEY = 'groupsPageToken';
  var token = sessionStorage.getItem(TOKEN_KEY) || localStorage.getItem('b2bToken') || '';
  var current = null; // {kind:'session'|'group', id}
  var groupData = null, sortMode = 'name';

  function $(id) { return document.getElementById(id); }
  function el(tag, props, children) {
    var e = document.createElement(tag);
    if (props) Object.keys(props).forEach(function (k) {
      if (k === 'text') e.textContent = props[k];
      else if (k === 'class') e.className = props[k];
      else if (k.indexOf('on') === 0) e.addEventListener(k.slice(2), props[k]);
      else e.setAttribute(k, props[k]);
    });
    (children || []).forEach(function (c) { if (c) e.appendChild(c); });
    return e;
  }
  function headers() { return { 'Content-Type': 'application/json', 'x-company-id': token }; }
  function api(method, url, body) {
    return fetch(url, { method: method, headers: headers(), body: body ? JSON.stringify(body) : undefined }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (r.status === 401) { showLogin(); throw new Error('Нужен вход'); }
        if (!r.ok) throw new Error(d.error || d.message || ('Ошибка ' + r.status));
        return d;
      });
    });
  }
  function showLogin() { token = ''; sessionStorage.removeItem(TOKEN_KEY); $('loginBox').classList.remove('hidden'); $('main').classList.add('hidden'); }
  function showMain() { $('loginBox').classList.add('hidden'); $('main').classList.remove('hidden'); loadGroups().then(handleParams); }

  $('loginBtn').addEventListener('click', function () {
    $('loginErr').textContent = '';
    fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: $('email').value, password: $('password').value }) })
      .then(function (r) { return r.json().then(function (d) { return { r: r, d: d }; }); })
      .then(function (x) {
        if (!x.r.ok || !x.d.token) { $('loginErr').textContent = x.d.error || x.d.message || 'Не удалось войти'; return; }
        token = x.d.token; sessionStorage.setItem(TOKEN_KEY, token); showMain();
      }).catch(function () { $('loginErr').textContent = 'Нет связи с сервером'; });
  });

  function loadGroups() {
    return api('GET', '/api/groups').then(function (d) {
      var sel = $('groupSel'); sel.textContent = '';
      if (!d.groups.length) sel.appendChild(el('option', { value: '', text: 'Групп нет — создайте на странице «Группы»' }));
      d.groups.forEach(function (g) { sel.appendChild(el('option', { value: g.id, text: g.name + ' (' + g.count + ' чел.)' })); });
    }).catch(function () {});
  }

  function setTab(kind) {
    $('tabSession').className = kind === 'session' ? 'on' : ''; $('tabGroup').className = kind === 'group' ? 'on' : '';
    $('sessionCtl').classList.toggle('hidden', kind !== 'session'); $('groupCtl').classList.toggle('hidden', kind !== 'group');
    $('out').textContent = ''; $('msg').textContent = '';
  }
  $('tabSession').addEventListener('click', function () { setTab('session'); });
  $('tabGroup').addEventListener('click', function () { setTab('group'); });

  function level(p) { return p === null || p === undefined ? '' : p >= 80 ? 'good' : p >= 60 ? 'mid' : 'low'; }
  function fmt(p) { return p === null || p === undefined ? '—' : (Math.round(p * 10) / 10) + '%'; }
  function bar(p) { return el('div', { class: 'bar' }, [el('i', { class: level(p), style: 'width:' + Math.max(0, Math.min(100, p || 0)) + '%' })]); }
  function tags(list, weakList) {
    var box = el('span');
    (list || []).forEach(function (t) { box.appendChild(el('span', { class: 'tag' + ((weakList || []).indexOf(t) >= 0 ? ' weak' : ''), text: t })); });
    return box;
  }
  function table(head, rows) {
    var t = el('table');
    t.appendChild(el('tr', {}, head.map(function (h) { return el('th', { text: h }); })));
    rows.forEach(function (r) { t.appendChild(el('tr', {}, r.map(function (c) { return el('td', {}, [typeof c === 'string' ? document.createTextNode(c) : c]); }))); });
    return t;
  }
  function card(title, child) { return el('div', { class: 'card' }, [el('h2', { text: title }), child]); }

  function download(url, name) {
    fetch(url, { headers: headers() }).then(function (r) {
      if (!r.ok) throw new Error('Не удалось скачать');
      return r.blob();
    }).then(function (b) {
      var a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = name; document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    }).catch(function (e) { $('msg').textContent = e.message; });
  }

  function weakTestForm(weakTags) {
    var box = el('div', { class: 'card' });
    box.appendChild(el('h2', { text: 'Тест по слабым темам' }));
    if (!weakTags.length) { box.appendChild(el('p', { class: 'muted', text: 'Слабых тем (ниже 60%) пока нет — ничего повторять не нужно.' })); return box; }
    box.appendChild(el('p', {}, [document.createTextNode('Слабые темы: '), tags(weakTags, weakTags)]));
    var title = el('input', { class: 'grow', value: 'Повторение: ' + weakTags.slice(0, 3).join(', ') });
    var count = el('input', { type: 'number', min: '1', max: '200', value: '10', style: 'width:90px' });
    var result = el('div', { class: 'muted', style: 'margin-top:8px' });
    var btn = el('button', { class: 'primary', text: 'Создать тест', onclick: function () {
      result.className = 'muted'; result.textContent = 'Создаю…';
      api('POST', '/api/tests/generate', { title: title.value, tags: weakTags, count: parseInt(count.value, 10) || 10 })
        .then(function (d) { result.textContent = 'Готово: тест «' + d.test.title + '» — ' + d.selectedCount + ' вопросов (в банке по этим темам: ' + d.availableInPool + '). Он появился в списке ваших тестов.'; })
        .catch(function (e) { result.className = 'err'; result.textContent = e.message; });
    } });
    box.appendChild(el('div', { class: 'row' }, [title, el('span', { class: 'muted', text: 'вопросов:' }), count, btn]));
    box.appendChild(result);
    box.appendChild(el('p', { class: 'muted', text: 'Вопросы берутся из ваших тестов по тегам этих тем. Если вопросов без повторов не хватает, тест будет короче.' }));
    return box;
  }

  function renderSession(d) {
    var out = $('out'); out.textContent = '';
    var s = d.session, sm = d.summary;
    out.appendChild(el('div', { class: 'card' }, [
      el('h2', { text: s.testTitle + ' — сессия ' + s.code }),
      el('p', { class: 'muted', text: new Date(s.startedAt).toLocaleString('ru-RU') + (s.groupName ? ' · группа «' + s.groupName + '»' : '') + (s.ended ? ' · завершена' : ' · идёт') + ' · сдали ' + s.finished + ' из ' + s.participants }),
      el('div', { class: 'kpis' }, [
        el('div', { class: 'kpi' }, [el('b', { text: fmt(sm.avg) }), document.createTextNode('средний результат')]),
        el('div', { class: 'kpi' }, [el('b', { text: fmt(sm.median) }), document.createTextNode('медиана')]),
        el('div', { class: 'kpi' }, [el('b', { text: fmt(sm.min) + ' – ' + fmt(sm.max) }), document.createTextNode('разброс')])
      ]),
      el('div', { style: 'margin-top:10px' }, [el('button', { text: 'Скачать в Excel', onclick: function () { download('/api/sessions/' + encodeURIComponent(s.code) + '/analytics?format=xlsx', 'analytics_' + s.code + '.xlsx'); } })])
    ]));
    if (!sm.count) { out.appendChild(el('div', { class: 'card muted', text: 'Пока никто не сдал — аналитика появится после первых сдач (можно обновлять во время занятия).' })); return; }
    out.appendChild(card('Распределение результатов', table(['Диапазон', 'Человек', ''], sm.buckets.map(function (b) {
      return [b.label, String(b.count), bar(sm.count ? b.count / sm.count * 100 : 0)];
    }))));
    out.appendChild(card('Темы (слабые — первыми)', table(['Тема', 'Верных', 'Ответов', ''], d.tags.map(function (t) {
      return [el('span', { class: 'tag' + (t.weak ? ' weak' : ''), text: t.tag }), fmt(t.pct), String(t.attempts), bar(t.pct)];
    }))));
    out.appendChild(card('Сложные вопросы и частые ошибки', table(['Вопрос', 'Верных', 'Частая ошибка'], d.questions.slice(0, 15).map(function (q) {
      var wrong = q.topWrong ? (q.topWrong.kind + ': «' + q.topWrong.option + '» — ' + q.topWrong.count + ' чел.') : '';
      if (q.noAnswer) wrong += (wrong ? '; ' : '') + 'без ответа: ' + q.noAnswer;
      return [el('div', {}, [document.createTextNode(q.text), el('div', {}, [tags(q.tags)])]), fmt(q.pct), wrong];
    }))));
    out.appendChild(card('Студенты', table(['Студент', 'Результат', 'Слабые темы', 'Отметки'], d.students.map(function (st) {
      var notes = []; if (st.late) notes.push('сдал с опозданием'); if (st.tabLong) notes.push('уходов с вкладки: ' + st.tabLong);
      return [st.name, st.score + '/' + st.total + ' (' + fmt(st.pct) + ')', tags(st.weakTags, st.weakTags), notes.join('; ')];
    }))));
    out.appendChild(weakTestForm(d.weakTags));
  }

  function renderGroup() {
    var d = groupData, out = $('out'); out.textContent = '';
    out.appendChild(el('div', { class: 'card' }, [
      el('h2', { text: 'Журнал группы «' + d.group.name + '»' }),
      el('p', { class: 'muted', text: 'Тестовых сессий с привязкой к группе: ' + d.sessions.length + ' (показаны последние 30). Ячейка — % верных, «—» — не сдал.' }),
      el('div', { class: 'row' }, [
        el('span', { class: 'muted', text: 'Сортировка:' }),
        (function () {
          var sel = el('select', {}, [el('option', { value: 'name', text: 'по алфавиту' }), el('option', { value: 'low', text: 'сначала отстающие' }), el('option', { value: 'high', text: 'сначала лучшие' }), el('option', { value: 'missed', text: 'по пропускам' })]);
          sel.value = sortMode; sel.addEventListener('change', function () { sortMode = sel.value; renderGroup(); }); return sel;
        })(),
        el('button', { text: 'Скачать журнал в Excel', onclick: function () { download('/api/groups/' + encodeURIComponent(d.group.id) + '/analytics?format=xlsx', 'journal.xlsx'); } })
      ])
    ]));
    if (!d.sessions.length) { out.appendChild(el('div', { class: 'card muted', text: 'Нет сессий, привязанных к этой группе. Включите «Привязать к новым сессиям» на странице групп и проведите тест.' })); return; }
    var students = d.students.slice();
    function avgKey(s, empty) { return s.avg === null ? empty : s.avg; }
    if (sortMode === 'low') students.sort(function (a, b) { return avgKey(a, -1) - avgKey(b, -1); });
    else if (sortMode === 'high') students.sort(function (a, b) { return avgKey(b, -1) - avgKey(a, -1); });
    else if (sortMode === 'missed') students.sort(function (a, b) { return b.missed - a.missed; });
    else students.sort(function (a, b) { return a.name.localeCompare(b.name, 'ru'); });

    var t = el('table');
    var head = [el('th', { text: 'Студент' })];
    d.sessions.forEach(function (s) { head.push(el('th', { title: s.testTitle + ' (' + s.code + ')', text: new Date(s.startedAt).toLocaleDateString('ru-RU').slice(0, 5) })); });
    head.push(el('th', { text: 'Среднее' })); head.push(el('th', { text: 'Динамика' })); head.push(el('th', { text: 'Слабые темы' }));
    t.appendChild(el('tr', {}, head));
    students.forEach(function (s) {
      var tr = el('tr', {}, [el('td', { text: s.name })]);
      s.cells.forEach(function (v) { tr.appendChild(el('td', {}, [el('div', { class: 'cell ' + (v === null ? 'c-none' : 'c-' + level(v)), text: v === null ? '—' : String(Math.round(v)) })])); });
      tr.appendChild(el('td', { text: fmt(s.avg) }));
      tr.appendChild(el('td', { text: s.trend === null ? '' : (s.trend > 0 ? '▲ +' : s.trend < 0 ? '▼ ' : '= ') + s.trend }));
      tr.appendChild(el('td', {}, [tags(s.weakTags, s.weakTags)]));
      t.appendChild(tr);
    });
    out.appendChild(el('div', { class: 'card' }, [t]));
    out.appendChild(card('Темы по группе', table(['Тема', 'Верных', 'Ответов', ''], d.tags.map(function (x) {
      return [el('span', { class: 'tag' + (x.weak ? ' weak' : ''), text: x.tag }), fmt(x.pct), String(x.attempts), bar(x.pct)];
    }))));
    out.appendChild(weakTestForm(d.weakTags));
  }

  function handleParams() {
    var q = new URLSearchParams(location.search);
    if (q.get('code')) { $('codeInput').value = q.get('code'); $('showSession').click(); }
    else if (q.get('group')) { setTab('group'); $('groupSel').value = q.get('group'); $('showGroup').click(); }
  }

  $('showSession').addEventListener('click', function () {
    var code = $('codeInput').value.trim().toUpperCase(); $('msg').textContent = ''; $('out').textContent = '';
    if (!code) return;
    api('GET', '/api/sessions/' + encodeURIComponent(code) + '/analytics').then(renderSession).catch(function (e) { $('msg').textContent = e.message; });
  });
  $('showGroup').addEventListener('click', function () {
    var id = $('groupSel').value; $('msg').textContent = ''; $('out').textContent = '';
    if (!id) return;
    api('GET', '/api/groups/' + encodeURIComponent(id) + '/analytics').then(function (d) { groupData = d; renderGroup(); }).catch(function (e) { $('msg').textContent = e.message; });
  });

  if (token) showMain(); else showLogin();
})();
</script>
</body>
</html>
`;
app.get('/analytics', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(ANALYTICS_PAGE_HTML);
});

// ---------- страница «Сеть»: какой адрес увидят студенты ----------
app.get('/api/network', checkAuth, async (req, res) => {
  const baseUrl = getBaseUrl();
  let qr = '';
  try { qr = await QRCode.toDataURL(baseUrl, { width: 300, margin: 1 }); } catch (e) {}
  const remoteBase = getRemoteBase();
  res.json({
    localMode: LOCAL_MODE, port: PORT, baseUrl, qr,
    candidates: listNetworkCandidates().filter(c => c.kind !== 'remote').map(c => ({ name: c.name, ip: c.ip, kind: c.kind, url: `http://${c.ip}:${PORT}` })),
    preferredIp: netPrefs.preferredIp || null,
    remote: { available: !!remoteBase, url: remoteBase }
  });
});

app.post('/api/network', checkAuth, async (req, res) => {
  if (!LOCAL_MODE) return res.status(400).json({ error: 'Выбор адреса доступен только в локальной версии' });
  const ip = req.body && req.body.preferredIp ? String(req.body.preferredIp) : null;
  if (ip && !listNetworkCandidates().some(c => c.ip === ip && c.kind !== 'remote')) {
    return res.status(400).json({ error: 'Такого сетевого адреса сейчас нет на этом компьютере' });
  }
  netPrefs.preferredIp = ip;
  try { require('fs').writeFileSync(NET_PREFS_FILE, JSON.stringify(netPrefs)); } catch (e) { console.error('[net] не удалось сохранить network.json', e); }
  res.json({ ok: true, baseUrl: getBaseUrl() });
});

const NETWORK_PAGE_HTML = String.raw`<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Сеть — адрес для студентов</title>
<style>
  :root { --bg:#f4f6fa; --card:#fff; --text:#1c2333; --muted:#667085; --line:#dfe3ec; --accent:#2f6fed; --ok:#12a150; --warn:#d9822b; --bad:#d64545; }
  @media (prefers-color-scheme: dark) { :root { --bg:#12151c; --card:#1b2030; --text:#e8ebf3; --muted:#9aa3b8; --line:#2b3248; --accent:#6a9bff; --ok:#3ecf7d; --warn:#f0a050; --bad:#ff7070; } }
  * { box-sizing:border-box; }
  body { margin:0; font:15px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; background:var(--bg); color:var(--text); }
  .wrap { max-width:760px; margin:0 auto; padding:16px; }
  h1 { font-size:22px; margin:8px 0 14px; }
  h2 { font-size:17px; margin:0 0 10px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:14px; margin-bottom:14px; }
  input[type=email], input[type=password] { padding:9px 10px; border:1px solid var(--line); border-radius:8px; background:var(--bg); color:var(--text); font:inherit; }
  button { padding:8px 14px; border:1px solid var(--line); border-radius:8px; background:var(--card); color:var(--text); font:inherit; cursor:pointer; }
  button.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
  .row { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
  .grow { flex:1 1 200px; }
  .muted { color:var(--muted); font-size:13px; }
  .err { color:var(--bad); margin:8px 0; }
  .hidden { display:none; }
  .big { font-size:22px; font-weight:700; word-break:break-all; }
  .cand { display:flex; gap:10px; align-items:flex-start; padding:10px 0; border-top:1px solid var(--line); cursor:pointer; }
  .cand:first-of-type { border-top:0; }
  .badge { font-size:12px; padding:1px 8px; border-radius:10px; border:1px solid var(--line); color:var(--muted); }
  .badge.hotspot { border-color:var(--ok); color:var(--ok); }
  .badge.virtual { border-color:var(--warn); color:var(--warn); }
  img.qr { width:180px; height:180px; border-radius:8px; background:#fff; padding:4px; }
  ol { margin:6px 0 0 18px; padding:0; }
</style>
</head>
<body>
<div class="wrap">
  <h1>Сеть: адрес для студентов</h1>

  <div id="loginBox" class="card hidden">
    <h2>Вход преподавателя</h2>
    <div class="row">
      <input id="email" class="grow" type="email" placeholder="Email">
      <input id="password" class="grow" type="password" placeholder="Пароль">
      <button class="primary" id="loginBtn">Войти</button>
    </div>
    <div id="loginErr" class="err"></div>
  </div>

  <div id="main" class="hidden">
    <div class="card">
      <h2>Сейчас QR-коды ведут на</h2>
      <div class="big" id="baseUrl">…</div>
      <div class="row" style="margin-top:10px">
        <img id="qr" class="qr hidden" alt="QR">
        <div class="muted grow">Проверка: возьмите телефон, подключённый к <b>той же Wi-Fi сети</b>, и наведите камеру на этот код. Если открылась страница теста — студенты тоже зайдут. Если нет — смотрите подсказки ниже.</div>
      </div>
    </div>

    <div class="card" id="candCard">
      <h2>Адреса этого компьютера</h2>
      <div class="muted" style="margin-bottom:6px">Выберите тот, что в одной сети со студентами. Обычно подходит первый.</div>
      <div id="cands"></div>
      <div class="row" style="margin-top:10px">
        <button class="primary" id="saveBtn">Использовать выбранный</button>
        <button id="autoBtn">Выбирать автоматически</button>
        <span id="msg" class="muted"></span>
      </div>
    </div>

    <div class="card">
      <h2>Если студенты не могут открыть страницу</h2>
      <ol class="muted">
        <li>Телефон и компьютер должны быть в <b>одной Wi-Fi сети</b>. В гостевых и офисных сетях часто включена «изоляция клиентов» — устройства не видят друг друга. Надёжный вариант: включить на ноутбуке <b>«Мобильный хот-спот»</b> (Параметры → Сеть и Интернет) и подключить телефоны к нему.</li>
        <li>При первом запуске Windows спрашивает про брандмауэр — нужно нажать <b>«Разрешить доступ»</b> (отметьте и «частные», и «общедоступные» сети). Если окно не появилось или доступ уже запретили — запустите файл «open-firewall.bat» от администратора.</li>
        <li>Если адрес определился неверно — выберите другой в списке выше или впишите нужный в <code>config.json</code> (поле <code>publicUrl</code>).</li>
      </ol>
    </div>
  </div>
</div>

<script>
(function () {
  var TOKEN_KEY = 'groupsPageToken';
  var token = sessionStorage.getItem(TOKEN_KEY) || localStorage.getItem('b2bToken') || '';
  var data = null, selected = null;
  function $(id) { return document.getElementById(id); }
  function api(method, url, body) {
    return fetch(url, { method: method, headers: { 'Content-Type': 'application/json', 'x-company-id': token }, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (d) {
          if (r.status === 401) { showLogin(); throw new Error('Нужен вход'); }
          if (!r.ok) throw new Error(d.error || d.message || ('Ошибка ' + r.status));
          return d;
        });
      });
  }
  function showLogin() { token = ''; sessionStorage.removeItem(TOKEN_KEY); $('loginBox').classList.remove('hidden'); $('main').classList.add('hidden'); }
  function showMain() { $('loginBox').classList.add('hidden'); $('main').classList.remove('hidden'); load(); }
  $('loginBtn').addEventListener('click', function () {
    $('loginErr').textContent = '';
    fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: $('email').value, password: $('password').value }) })
      .then(function (r) { return r.json().then(function (d) { return { r: r, d: d }; }); })
      .then(function (x) {
        if (!x.r.ok || !x.d.token) { $('loginErr').textContent = x.d.error || x.d.message || 'Не удалось войти'; return; }
        token = x.d.token; sessionStorage.setItem(TOKEN_KEY, token); showMain();
      }).catch(function () { $('loginErr').textContent = 'Нет связи с сервером'; });
  });

  var KIND = { hotspot: 'точка доступа Windows', lan: 'локальная сеть', virtual: 'виртуальный адаптер — обычно не подходит' };
  function render() {
    $('baseUrl').textContent = data.baseUrl;
    if (data.qr) { $('qr').src = data.qr; $('qr').classList.remove('hidden'); }
    var box = $('cands'); box.textContent = '';
    if (!data.localMode) { $('candCard').classList.add('hidden'); return; }
    if (!data.candidates.length) { box.textContent = 'Сеть не найдена. Подключитесь к Wi-Fi или включите «Мобильный хот-спот».'; return; }
    data.candidates.forEach(function (c, i) {
      var row = document.createElement('label'); row.className = 'cand';
      var radio = document.createElement('input'); radio.type = 'radio'; radio.name = 'cand'; radio.value = c.ip;
      radio.checked = selected ? selected === c.ip : (data.preferredIp ? data.preferredIp === c.ip : data.baseUrl.indexOf('//' + c.ip + ':') >= 0);
      radio.addEventListener('change', function () { selected = c.ip; });
      var info = document.createElement('div');
      var t = document.createElement('div'); t.textContent = c.url; t.style.fontWeight = '600';
      var m = document.createElement('div'); m.className = 'muted'; m.textContent = c.name + ' ';
      var b = document.createElement('span'); b.className = 'badge ' + c.kind; b.textContent = KIND[c.kind] || c.kind; m.appendChild(b);
      info.appendChild(t); info.appendChild(m); row.appendChild(radio); row.appendChild(info); box.appendChild(row);
    });
  }
  function load() { api('GET', '/api/network').then(function (d) { data = d; selected = null; render(); }).catch(function (e) { $('baseUrl').textContent = e.message; }); }
  function save(ip) {
    $('msg').textContent = 'Сохраняю…';
    api('POST', '/api/network', { preferredIp: ip }).then(function () { $('msg').textContent = 'Сохранено'; load(); }).catch(function (e) { $('msg').textContent = e.message; });
  }
  $('saveBtn').addEventListener('click', function () { var r = document.querySelector('input[name=cand]:checked'); if (r) save(r.value); });
  $('autoBtn').addEventListener('click', function () { save(null); });
  if (token) showMain(); else showLogin();
})();
</script>
</body>
</html>
`;
app.get('/network', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(NETWORK_PAGE_HTML);
});

// ==================== СЕССИИ ====================

// Режим показа разбора студенту после сдачи теста:
//   immediately — сразу (как раньше), after_end — только после завершения сессии
//   преподавателем, score_only — никогда, только баллы.
const SHOW_ANSWERS_MODES = ['immediately', 'after_end', 'score_only'];
function normalizeShowAnswers(v) { return SHOW_ANSWERS_MODES.includes(v) ? v : 'immediately'; }
const SUBMIT_GRACE_MS = 30 * 1000; // допуск на задержку сети при автоотправке по таймеру

function buildReview(test, detail) {
  return test.questions.map(q => ({
    text: q.text,
    options: q.options,
    multi: q.multi,
    given: detail[q.id].given,
    correct: detail[q.id].correct,
    isCorrect: detail[q.id].isCorrect,
    explain: q.explain || '',
    image: q.image || null
  }));
}
function reviewAllowed(session) {
  const mode = session.showAnswers || 'immediately';
  if (mode === 'immediately') return true;
  if (mode === 'after_end') return !!session.ended;
  return false;
}

app.post('/api/sessions/:code/show-answers', checkAuth, async (req, res) => {
  const mode = req.body && req.body.mode;
  if (!SHOW_ANSWERS_MODES.includes(mode)) return res.status(400).json({ error: 'Неверный режим' });
  let found = false;
  await db.update((d) => {
    const s = safeGet(d.sessions, req.params.code);
    if (s && s.companyId === req.companyId) { s.showAnswers = mode; found = true; }
  });
  if (!found) return res.status(404).json({ error: 'Сессия не найдена' });
  res.json({ ok: true, mode });
});

// Студент запрашивает разбор позже (когда преподаватель завершил сессию).
app.get('/api/sessions/:code/review', (req, res) => {
  const data = db.load();
  const session = safeGet(data.sessions, req.params.code);
  if (!session || session.type === 'lab') return res.status(404).json({ error: 'Сессия не найдена' });
  const p = safeGet(session.participants, req.query.participantId);
  if (!p || !p.finished) return res.status(404).json({ error: 'Участник не найден' });
  const test = safeGet(data.tests, session.testId);
  if (!test) return res.status(404).json({ error: 'Тест не найден' });
  if (!reviewAllowed(session)) {
    return res.json({ available: false, reviewHidden: session.showAnswers || 'immediately', score: p.score, total: p.total, review: [] });
  }
  res.json({ available: true, score: p.score, total: p.total, review: buildReview(test, p.answers || {}) });
});

app.post('/api/sessions', checkAuth, async (req, res) => {
  const { testId } = req.body;
  const data = db.load();
  const test = safeGet(data.tests, testId);
  if (!test || test.companyId !== req.companyId) return res.status(404).json({ error: 'Тест не найден' });
  let scheduledAt = null;
  if (req.body.scheduledAt) {
    const ts = parseInt(req.body.scheduledAt, 10);
    if (!isNaN(ts) && ts > Date.now()) scheduledAt = ts;
  }
  let code;
  do { code = nanoid(); } while (safeGet(data.sessions, code));
  const tl = Number(req.body.timeLimit);
  const session = {
    code,
    companyId: req.companyId,
    testId,
    testTitle: test.title,
    timeLimit: Number.isFinite(tl) && tl > 0 && tl <= 600 ? tl : null,
    showAnswers: normalizeShowAnswers(req.body.showAnswers),
    startedAt: Date.now(),
    scheduledAt,
    ended: false,
    participants: {},
    groupId: pickGroupId(req),
    remote: wantsRemote(req)
  };
  await db.update((d) => { d.sessions[code] = session; });
  const url = `${getBaseUrl(session)}/s/${code}`;
  const qrDataUrl = await QRCode.toDataURL(url, { width: 400, margin: 1 });
  res.json({ session, url, qrDataUrl });
});

app.post('/api/sessions/:code/start-now', checkAuth, async (req, res) => {
  const result = await db.update((d) => {
    const session = safeGet(d.sessions, req.params.code);
    if (!session || session.companyId !== req.companyId) return null;
    session.scheduledAt = null;
    return session;
  });
  if (!result) return res.status(404).json({ error: 'Сессия не найдена' });
  res.json({ ok: true });
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
    scheduledAt: session.scheduledAt || null,
    questionCount: test ? test.questions.length : 0
  });
});

// Публичный эндпоинт для «витрины показа» (/present.html): повторно отдаёт QR-код и
// ссылку по коду сессии — без имён участников, результатов и другой чувствительной информации,
// чтобы можно было безопасно открыть на проекторе/втором экране в классе.
app.get('/api/sessions/:code/present', async (req, res) => {
  const data = db.load();
  const session = safeGet(data.sessions, req.params.code);
  if (!session) return res.status(404).json({ error: 'Сессия не найдена' });
  const pathPrefix = session.type === 'lab' ? 'l' : session.type === 'drawing' ? 'd' : session.type === 'tolerance' ? 'k' : 's';
  const url = `${getBaseUrl(session)}/${pathPrefix}/${session.code}`;
  try {
    const qrDataUrl = await QRCode.toDataURL(url, { width: 500, margin: 1 });
    res.json({
      testTitle: session.testTitle,
      code: session.code,
      url,
      qrDataUrl,
      type: session.type || 'test',
      ended: !!session.ended,
      scheduledAt: session.scheduledAt || null
    });
  } catch (e) {
    res.status(500).json({ error: 'Не удалось сформировать QR-код' });
  }
});

app.post('/api/sessions/:code/join', joinLimiter, async (req, res) => {
  let { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Введите имя' });
  const data = db.load();
  const session = safeGet(data.sessions, req.params.code);
  if (!session || session.type === 'lab') return res.status(404).json({ error: 'Сессия не найдена' });
  if (session.ended) return res.status(410).json({ error: 'Тестирование завершено' });
  if (session.scheduledAt && Date.now() < session.scheduledAt) {
    return res.status(403).json({
      error: 'NOT_STARTED',
      message: `Тестирование ещё не началось. Начало запланировано на ${new Date(session.scheduledAt).toLocaleString('ru-RU')}.`,
      scheduledAt: session.scheduledAt
    });
  }
  const trialMsg = trialBlockedForCompany(data, session.companyId);
  if (trialMsg) return res.status(403).json({ error: 'TRIAL_ENDED', message: trialMsg });
  const roster = resolveRoster(data, session, name);
  if (roster) {
    if (!roster.ok) return res.status(400).json({ error: roster.message, code: 'NOT_IN_ROSTER', message: roster.message });
    name = roster.name; // каноническое написание из списка группы
    req.body.forceNew = false; // в списочной сессии «другого человека с таким же именем» не бывает
  }
  const test = safeGet(data.tests, session.testId);
  if (!test) return res.status(404).json({ error: 'Тест не найден' });

  // Запрет повторного захода под тем же именем в уже пройденную сессию: если участник
  // с таким именем (без учёта регистра и лишних пробелов) уже завершил тест в этой
  // сессии — не даём открыть его заново под тем же именем (защита от повторной сдачи
  // за себя или подглядывания в свой же уже сданный результат).
  const nameKey = name.trim().toLowerCase();
  const alreadyFinished = Object.values(session.participants).some(
    p => p.finished && p.name.trim().toLowerCase() === nameKey
  );
  if (alreadyFinished && !req.body.forceNew) {
    return res.status(409).json({
      error: 'ALREADY_SUBMITTED',
      roster: !!roster,
      message: `Участник «${name.trim()}» уже сдал это тестирование.` +
        (roster ? ' Если это произошло по ошибке — сообщите преподавателю.' : ' Если это другой человек с таким же именем, войдите как новый участник.')
    });
  }

  const inProgress = findUnfinishedByName(session, name);
  if (inProgress && !req.body.forceNew) return nameInProgress(res, inProgress, !!roster);

  const pid = participantId();

  // Перемешиваем порядок вопросов и порядок вариантов ответа индивидуально для
  // каждого участника (защита от списывания у соседа на очном тестировании).
  // Карта optionShuffle[qId][новая_позиция] = исходный_индекс — сохраняется у
  // участника, чтобы при проверке ответов перевести их обратно в исходную систему координат.
  const optionShuffle = {};
  const shuffledQuestions = test.questions.map(q => {
    const order = shuffleArr(q.options.map((_, i) => i));
    optionShuffle[q.id] = order;
    return {
      id: q.id,
      text: q.text,
      options: order.map(origIdx => q.options[origIdx]),
      multi: !!q.multi,
      image: q.image || null
    };
  });
  const orderedQuestions = shuffleArr(shuffledQuestions);

  const participant = {
    id: pid,
    restarted: !!req.body.forceNew,
    name: name.trim().slice(0, 80),
    joinedAt: Date.now(),
    answers: {},
    finished: false,
    score: null,
    total: null,
    optionShuffle,
    questionOrder: orderedQuestions.map(q => q.id),
    tabSwitchCount: 0,
    tabSwitchTotalMs: 0
  };
  await db.update((d) => { d.sessions[req.params.code].participants[pid] = participant; });
  io.to('session:' + req.params.code).emit('participant:joined', participant);
  res.json({
    participantId: pid,
    testTitle: test.title,
    timeLimit: session.timeLimit || null,
    deadline: session.timeLimit ? participant.joinedAt + session.timeLimit * 60 * 1000 : null,
    serverNow: Date.now(),
    questions: orderedQuestions
  });
});

app.post('/api/sessions/:code/submit', async (req, res) => {
  const { participantId: pid, answers, tabSwitchLog } = req.body;
  const safeAnswers = answers && typeof answers === 'object' ? answers : {};
  const safeTabLog = Array.isArray(tabSwitchLog) ? tabSwitchLog.slice(0, 200) : [];
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
  const optionShuffle = participant.optionShuffle || {};
  for (const q of test.questions) {
    const rawGiven = safeAnswers[q.id];
    const mapping = optionShuffle[q.id]; // [новая_позиция] = исходный_индекс
    let given = rawGiven;
    if (mapping) {
      if (q.multi) {
        given = Array.isArray(rawGiven) ? rawGiven.map(i => mapping[i]).filter(v => v !== undefined) : [];
      } else if (rawGiven !== undefined && rawGiven !== null) {
        given = mapping[rawGiven] !== undefined ? mapping[rawGiven] : rawGiven;
      }
    }
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
  const submittedAt = Date.now();
  const testDeadline = session.timeLimit ? participant.joinedAt + session.timeLimit * 60 * 1000 : null;
  const lateMs = testDeadline ? Math.max(0, submittedAt - testDeadline) : 0;
  const isLate = lateMs > SUBMIT_GRACE_MS;
  const result = await db.update((d) => {
    const p = safeGet(d.sessions[req.params.code].participants, pid);
    p.answers = detail;
    p.finished = true;
    p.finishedAt = submittedAt;
    if (isLate) { p.late = true; p.lateSec = Math.round(lateMs / 1000); }
    p.score = score;
    p.total = total;
    const totalAwayMs = safeTabLog.reduce((sum, e) => sum + (Math.max(0, parseInt(e.awayMs, 10) || 0)), 0);
    p.tabSwitchCount = safeTabLog.length;
    p.tabSwitchTotalMs = totalAwayMs;
    p.tabSwitchLongCount = safeTabLog.filter(e => (Math.max(0, parseInt(e.awayMs, 10) || 0)) >= 5000).length;
    return p;
  });
  await incrementSubmissions(session.companyId);
  io.to('session:' + req.params.code).emit('participant:finished', result);
  const canReview = reviewAllowed(session);
  res.json({
    score, total,
    review: canReview ? buildReview(test, detail) : [],
    reviewHidden: canReview ? null : (session.showAnswers || 'immediately')
  });
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
      'Статус': p.finished ? 'Завершил' : 'В процессе',
      'Переключений вкладки': p.tabSwitchCount || 0,
      'Из них долгих (5+ сек)': p.tabSwitchLongCount || 0,
      'Время вне теста, сек': p.tabSwitchTotalMs ? Math.round(p.tabSwitchTotalMs / 1000) : 0,
      'Сдан с опозданием, сек': p.late ? (p.lateSec || 0) : ''
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
  const headers = ['Вопрос', 'Вариант 1', 'Вариант 2', 'Вариант 3', 'Вариант 4', 'Вариант 5', 'Правильные (номера через запятую)', 'Теги (через запятую, необязательно)', 'Пояснение (необязательно, показывается после сдачи теста)'];
  const example1 = ['Какая муфта применяется во избежание поломок деталей механизма из-за перегрузок?', 'Компенсирующая муфта', 'Жёсткая муфта', 'Предохранительная муфта', 'Обгонная муфта', '', '3', 'приводы и передачи', 'Предохранительная муфта разъединяет вал при превышении допустимого крутящего момента, защищая механизм от поломки.'];
  const example2 = ['Выберите чётные числа', '1', '2', '3', '4', '', '2,4', '', ''];
  const ws = XLSX.utils.aoa_to_sheet([headers, example1, example2]);
  ws['!cols'] = [{ wch: 45 }, { wch: 20 }, { wch: 20 }, { wch: 20 }, { wch: 20 }, { wch: 20 }, { wch: 30 }, { wch: 30 }, { wch: 50 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Вопросы');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename="shablon_voprosov.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

// Экспорт существующего теста обратно в Excel — тот же формат, что и шаблон импорта,
// чтобы можно было забрать вопросы для правки офлайн и загрузить их снова.
// Изображения вопросов в экспорт не попадают (в файле остаётся только текстовое содержимое).
app.get('/api/tests/:id/export-excel', checkAuth, (req, res) => {
  const data = db.load();
  const test = safeGet(data.tests, req.params.id);
  if (!test || test.companyId !== req.companyId) return res.status(404).json({ error: 'Тест не найден' });
  const headers = ['Вопрос', 'Вариант 1', 'Вариант 2', 'Вариант 3', 'Вариант 4', 'Вариант 5', 'Правильные (номера через запятую)', 'Теги (через запятую, необязательно)', 'Пояснение (необязательно, показывается после сдачи теста)'];
  const rows = test.questions.map(q => {
    const correctIdxs = q.multi ? q.correct : [q.correct];
    const opts = [0, 1, 2, 3, 4].map(i => q.options[i] !== undefined ? q.options[i] : '');
    return [
      q.text,
      ...opts,
      correctIdxs.map(i => i + 1).join(','),
      (q.tags || []).join(', '),
      q.explain || ''
    ];
  });
  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  ws['!cols'] = [{ wch: 45 }, { wch: 20 }, { wch: 20 }, { wch: 20 }, { wch: 20 }, { wch: 20 }, { wch: 30 }, { wch: 30 }, { wch: 50 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Вопросы');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const asciiFallback = test.title.replace(/[^\x20-\x7E]/g, '_').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) || 'test';
  const utf8Name = encodeURIComponent(test.title.slice(0, 80) + '.xlsx');
  res.setHeader('Content-Disposition', `attachment; filename="${asciiFallback}.xlsx"; filename*=UTF-8''${utf8Name}`);
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
    const explain = String(row[8] || '').trim();
    questions.push({ text, options, correct: multi ? correctIdxs : correctIdxs[0], multi, tags, explain });
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
  let scheduledAt = null;
  if (req.body.scheduledAt) {
    const ts = parseInt(req.body.scheduledAt, 10);
    if (!isNaN(ts) && ts > Date.now()) scheduledAt = ts;
  }
  let code;
  do { code = nanoid(); } while (safeGet(data.sessions, code));
  const session = {
    code,
    companyId: req.companyId,
    type: 'lab',
    labId,
    testTitle: lab.title,
    startedAt: Date.now(),
    scheduledAt,
    ended: false,
    participants: {},
    groupId: pickGroupId(req),
    remote: wantsRemote(req)
  };
  await db.update((d) => { d.sessions[code] = session; });
  const url = `${getBaseUrl(session)}/l/${code}`;
  const qrDataUrl = await QRCode.toDataURL(url, { width: 400, margin: 1 });
  res.json({ session, url, qrDataUrl });
});

app.post('/api/lab-sessions/:code/start-now', checkAuth, async (req, res) => {
  const result = await db.update((d) => {
    const session = safeGet(d.sessions, req.params.code);
    if (!session || session.companyId !== req.companyId) return null;
    session.scheduledAt = null;
    return session;
  });
  if (!result) return res.status(404).json({ error: 'Сессия не найдена' });
  res.json({ ok: true });
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
  res.json({ testTitle: session.testTitle, intro: lab ? lab.intro : '', caseCount: lab ? lab.faults.length : 0, scheduledAt: session.scheduledAt || null });
});

app.post('/api/lab-sessions/:code/join', joinLimiter, async (req, res) => {
  let { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Введите имя' });
  const data = db.load();
  const session = safeGet(data.sessions, req.params.code);
  if (!session || session.type !== 'lab') return res.status(404).json({ error: 'Сессия не найдена' });
  if (session.ended) return res.status(410).json({ error: 'Тренажёр завершён' });
  if (session.scheduledAt && Date.now() < session.scheduledAt) {
    return res.status(403).json({
      error: 'NOT_STARTED',
      message: `Тренажёр ещё не начался. Начало запланировано на ${new Date(session.scheduledAt).toLocaleString('ru-RU')}.`,
      scheduledAt: session.scheduledAt
    });
  }
  const trialMsg = trialBlockedForCompany(data, session.companyId);
  if (trialMsg) return res.status(403).json({ error: 'TRIAL_ENDED', message: trialMsg });
  const roster = resolveRoster(data, session, name);
  if (roster) {
    if (!roster.ok) return res.status(400).json({ error: roster.message, code: 'NOT_IN_ROSTER', message: roster.message });
    name = roster.name; // каноническое написание из списка группы
    req.body.forceNew = false; // в списочной сессии «другого человека с таким же именем» не бывает
  }
  const lab = safeGet(data.labs, session.labId);
  if (!lab) return res.status(404).json({ error: 'Тренажёр не найден' });
  const inProgress = findUnfinishedByName(session, name);
  if (inProgress && !req.body.forceNew) return nameInProgress(res, inProgress, !!roster);
  const pid = participantId();
  const caseAssignment = assignCases(lab);
  const participant = {
    id: pid,
    restarted: !!req.body.forceNew,
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
  res.sendFile(publicFile('lab-student.html'));
});

app.get('/s/:code', (req, res) => {
  res.sendFile(publicFile('student.html'));
});

app.get('/d/:code', (req, res) => {
  res.sendFile(publicFile('drawing-student.html'));
});

app.get('/k/:code', (req, res) => {
  res.sendFile(publicFile('tolerance-student.html'));
});

// ==================== ЗАДАНИЯ ПО ЧЕРТЕЖАМ (открытые вопросы, ручная проверка) ====================
// Структура и роуты намеренно зеркалят /api/labs и /api/lab-sessions выше, но вместо
// автопроверки по вариантам ответа — свободный текст, который заполняет ученик,
// а преподаватель проверяет и выставляет зачёт/незачёт по каждому пункту вручную.

app.get('/api/drawing-tasks', checkAuth, (req, res) => {
  const data = db.load();
  const list = Object.values(data.drawingTasks)
    .filter(t => t.shared || t.companyId === req.companyId)
    .map(t => ({
      id: t.id,
      title: t.title,
      intro: t.intro,
      questionCount: t.questions.length,
      shared: !!t.shared
    }));
  res.json(list);
});

app.get('/api/drawing-tasks/:id', checkAuth, (req, res) => {
  const data = db.load();
  const task = safeGet(data.drawingTasks, req.params.id);
  if (!task || (!task.shared && task.companyId !== req.companyId)) return res.status(404).json({ error: 'Задание не найдено' });
  res.json(task);
});

function normalizeForMatch(s) {
  return (s || '').toString().toLowerCase().replace(/ё/g, 'е')
    .replace(/[.,;:()«»"'`\-_/\\№#]/g, ' ').replace(/\s+/g, ' ').trim();
}

function textSimilarity(a, b) {
  const na = normalizeForMatch(a), nb = normalizeForMatch(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.9;
  const wa = new Set(na.split(' ').filter(Boolean));
  const wb = new Set(nb.split(' ').filter(Boolean));
  if (wa.size === 0 || wb.size === 0) return 0;
  let inter = 0;
  wa.forEach(w => { if (wb.has(w)) inter++; });
  const union = new Set([...wa, ...wb]).size;
  return union ? inter / union : 0;
}

// Сопоставляет то, что ученик вписал в поле «Деталь / задание №» при входе, с одним из
// готовых ключей ответов (сначала по номеру детали, затем по похожести названия).
// Возвращает { key, confidence } или null, если ничего похожего не нашлось —
// в этом случае преподаватель выбирает деталь вручную на экране проверки.
function matchAnswerKey(data, companyId, partInfo) {
  const keys = Object.values(data.answerKeys).filter(k => k.shared || k.companyId === companyId);
  if (keys.length === 0 || !partInfo || !partInfo.trim()) return null;

  const numMatch = partInfo.match(/(\d{1,3})/);
  if (numMatch) {
    const num = parseInt(numMatch[1], 10);
    const byNumber = keys.find(k => k.number === num);
    if (byNumber) return { key: byNumber, confidence: 1 };
  }

  let best = null, bestScore = 0;
  keys.forEach(k => {
    const score = Math.max(textSimilarity(partInfo, k.name), textSimilarity(partInfo, k.title));
    if (score > bestScore) { bestScore = score; best = k; }
  });
  if (best && bestScore >= 0.5) return { key: best, confidence: bestScore };
  return null;
}

// Сопоставляет вопросы задания (task.questions) с вопросами ключа по тексту, а не по
// порядку/id — так матчинг переживает правки текста пункта бланка преподавателем.
function resolveKeyAnswers(taskQuestions, key) {
  if (!key) return null;
  return taskQuestions.map(q => {
    const found = key.questions.find(kq => normalizeForMatch(kq.text) === normalizeForMatch(q.text))
      || key.questions.find(kq => textSimilarity(kq.text, q.text) >= 0.7);
    return found ? found.answer : null;
  });
}

// Поля пункта бланка, кроме текста и ключа: заголовок блока и его указание, порядок выполнения
// (методика) конкретного пункта и необязательная схема (только из папки /img/ нашего сервера).
function cleanDrawingQuestion(q, fallbackId) {
  const img = typeof q.imageUrl === 'string' ? q.imageUrl.trim() : '';
  const imageUrl = /^\/img\/[\w\-.\/]+$/.test(img) && !img.includes('..') ? img : '';
  return {
    id: q.id || fallbackId,
    text: q.text.trim(),
    correctAnswer: (q.correctAnswer || '').trim(),
    section: (q.section || '').trim().slice(0, 200),
    sectionText: (q.sectionText || '').trim().slice(0, 1000),
    hint: (q.hint || '').trim().slice(0, 1500),
    imageUrl
  };
}

function studentQuestionView(q) {
  return { id: q.id, text: q.text, section: q.section || '', sectionText: q.sectionText || '', hint: q.hint || '', imageUrl: q.imageUrl || '' };
}

function validateDrawingTaskPayload(body) {
  const { title, questions } = body;
  if (!title || !title.trim()) return 'Введите название задания';
  if (!Array.isArray(questions) || questions.length === 0) return 'Добавьте хотя бы один вопрос';
  for (const q of questions) {
    if (!q.text || !q.text.trim()) return 'У каждого пункта бланка должен быть текст вопроса';
  }
  return null;
}

const DRAWING_IMPORT_HEADERS = [
  'Пункт бланка (вопрос)',
  'Правильный ответ (ключ, необязательно)',
  'Блок (заголовок)',
  'Указание к блоку',
  'Порядок выполнения / методика пункта',
  'Схема (путь /img/..., необязательно)'
];

app.get('/api/drawing-import-template', checkAuth, (req, res) => {
  const rows = SEED_DRAWING_TASKS[0].questions.map(q => [q.text, '', '', '', '', '']);
  const ws = XLSX.utils.aoa_to_sheet([DRAWING_IMPORT_HEADERS, ...rows]);
  ws['!cols'] = [{ wch: 55 }, { wch: 40 }, { wch: 35 }, { wch: 45 }, { wch: 60 }, { wch: 30 }];
  const info = XLSX.utils.aoa_to_sheet([
    ['Название', ''],
    ['Вступление (общее указание ученику)', ''],
    ['Завершение (что сделать в конце работ)', '']
  ]);
  info['!cols'] = [{ wch: 40 }, { wch: 100 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Бланк');
  XLSX.utils.book_append_sheet(wb, info, 'Описание');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename="shablon_chertezh.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

// Импорт из Excel. Лист 1 «Бланк»: A — пункт, B — ключ, C — заголовок блока, D — указание к блоку,
// E — порядок выполнения пункта, F — схема. Блок указывают в первой строке блока: пустые ячейки C/D
// ниже означают «тот же блок». Лист «Описание» (необязательно): название, вступление, завершение.
// Ничего не сохраняет — возвращает распознанное в редактор, где преподаватель всё проверяет.
app.post('/api/drawing-tasks/import', checkAuth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });
  let rows, infoRows = [];
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' });
    if (wb.SheetNames[1]) infoRows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[1]], { header: 1, defval: '' });
  } catch (e) {
    return res.status(400).json({ error: 'Не удалось прочитать файл. Убедитесь, что это .xlsx или .xls' });
  }
  if (rows.length < 2) {
    return res.status(400).json({ error: 'В файле нет строк с вопросами под заголовком.' });
  }
  const cell = (row, i) => String((row && row[i]) || '').trim();
  const questions = [];
  const skipped = [];
  let curSection = '', curSectionText = '';
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.every(c => String(c).trim() === '')) continue;
    const text = cell(row, 0);
    if (!text) { skipped.push({ row: i + 1, reason: 'пустой текст вопроса' }); continue; }
    if (cell(row, 2)) { curSection = cell(row, 2); curSectionText = cell(row, 3); }
    questions.push({
      text,
      correctAnswer: cell(row, 1),
      section: curSection,
      sectionText: curSectionText,
      hint: cell(row, 4),
      imageUrl: cell(row, 5)
    });
  }
  if (questions.length === 0) {
    return res.status(400).json({ error: 'Не удалось распознать ни одного пункта. Проверьте формат файла (скачайте шаблон).', skipped });
  }
  const info = {};
  infoRows.forEach(r => {
    const k = cell(r, 0).toLowerCase();
    if (k.startsWith('назван')) info.title = cell(r, 1);
    else if (k.startsWith('вступ')) info.intro = cell(r, 1);
    else if (k.startsWith('заверш')) info.outro = cell(r, 1);
  });
  res.json({ questions, skipped, title: info.title || '', intro: info.intro || '', outro: info.outro || '' });
});

// Общие задания (из кода) нельзя править на месте: при каждом запуске сервера они
// восстанавливаются. Копия принадлежит компании и редактируется как обычное задание.
app.post('/api/drawing-tasks/:id/copy', checkAuth, async (req, res) => {
  const data = db.load();
  const src = safeGet(data.drawingTasks, req.params.id);
  if (!src || (!src.shared && src.companyId !== req.companyId)) return res.status(404).json({ error: 'Задание не найдено' });
  const id = participantId();
  const copy = JSON.parse(JSON.stringify(src));
  copy.id = id;
  copy.companyId = req.companyId;
  copy.shared = false;
  copy.custom = true;
  copy.title = src.title.replace(/\s*\(копия\)$/, '') + ' (копия)';
  copy.createdAt = Date.now();
  copy.questions = copy.questions.map((q, qi) => ({ ...q, id: 'q' + qi + '_' + id }));
  await db.update((d) => { d.drawingTasks[id] = copy; });
  res.json(copy);
});

app.post('/api/drawing-tasks', checkAuth, async (req, res) => {
  const err = validateDrawingTaskPayload(req.body);
  if (err) return res.status(400).json({ error: err });
  const id = participantId();
  const task = {
    id,
    companyId: req.companyId,
    shared: false,
    title: req.body.title.trim(),
    intro: (req.body.intro || '').trim(),
    outro: (req.body.outro || '').trim().slice(0, 1500),
    questions: req.body.questions.map((q, qi) => cleanDrawingQuestion(q, 'q' + qi + '_' + id)),
    createdAt: Date.now(),
    custom: true
  };
  await db.update((d) => { d.drawingTasks[id] = task; });
  res.json(task);
});

app.put('/api/drawing-tasks/:id', checkAuth, async (req, res) => {
  const err = validateDrawingTaskPayload(req.body);
  if (err) return res.status(400).json({ error: err });
  const result = await db.update((d) => {
    const existing = safeGet(d.drawingTasks, req.params.id);
    if (!existing || existing.shared || existing.companyId !== req.companyId) return null;
    existing.title = req.body.title.trim();
    existing.intro = (req.body.intro || '').trim();
    existing.outro = (req.body.outro || '').trim().slice(0, 1500);
    existing.questions = req.body.questions.map((q, qi) => cleanDrawingQuestion(q, 'q' + qi + '_' + req.params.id));
    return existing;
  });
  if (!result) return res.status(404).json({ error: 'Задание не найдено' });
  res.json(result);
});

app.delete('/api/drawing-tasks/:id', checkAuth, async (req, res) => {
  await db.update((d) => {
    const task = safeGet(d.drawingTasks, req.params.id);
    if (task && !task.shared && task.companyId === req.companyId) {
      delete d.drawingTasks[req.params.id];
      Object.keys(d.sessions).forEach(code => {
        if (d.sessions[code].drawingTaskId === req.params.id && d.sessions[code].companyId === req.companyId) {
          delete d.sessions[code];
        }
      });
    }
  });
  res.json({ ok: true });
});

app.post('/api/drawing-sessions', checkAuth, async (req, res) => {
  const { drawingTaskId } = req.body;
  const data = db.load();
  const task = safeGet(data.drawingTasks, drawingTaskId);
  if (!task || (!task.shared && task.companyId !== req.companyId)) return res.status(404).json({ error: 'Задание не найдено' });
  let scheduledAt = null;
  if (req.body.scheduledAt) {
    const ts = parseInt(req.body.scheduledAt, 10);
    if (!isNaN(ts) && ts > Date.now()) scheduledAt = ts;
  }
  let code;
  do { code = nanoid(); } while (safeGet(data.sessions, code));
  const session = {
    code,
    companyId: req.companyId,
    type: 'drawing',
    drawingTaskId,
    testTitle: task.title,
    startedAt: Date.now(),
    scheduledAt,
    timeLimit: (Number.isInteger(parseInt(req.body.timeLimit, 10)) && parseInt(req.body.timeLimit, 10) > 0)
      ? Math.min(parseInt(req.body.timeLimit, 10), 600) : null,
    ended: false,
    participants: {},
    groupId: pickGroupId(req),
    remote: wantsRemote(req)
  };
  await db.update((d) => { d.sessions[code] = session; });
  const url = `${getBaseUrl(session)}/d/${code}`;
  const qrDataUrl = await QRCode.toDataURL(url, { width: 400, margin: 1 });
  res.json({ session, url, qrDataUrl });
});

app.post('/api/drawing-sessions/:code/start-now', checkAuth, async (req, res) => {
  const result = await db.update((d) => {
    const session = safeGet(d.sessions, req.params.code);
    if (!session || session.companyId !== req.companyId) return null;
    session.scheduledAt = null;
    return session;
  });
  if (!result) return res.status(404).json({ error: 'Сессия не найдена' });
  res.json({ ok: true });
});

// Для преподавателя — полная сессия с ответами участников (для проверки).
app.get('/api/drawing-sessions/:code', checkAuth, (req, res) => {
  const data = db.load();
  const session = safeGet(data.sessions, req.params.code);
  if (!session || session.companyId !== req.companyId || session.type !== 'drawing') {
    return res.status(404).json({ error: 'Сессия не найдена' });
  }
  const task = safeGet(data.drawingTasks, session.drawingTaskId);

  const answerKeys = Object.values(data.answerKeys)
    .filter(k => k.shared || k.companyId === req.companyId)
    .sort((a, b) => (a.number || 0) - (b.number || 0))
    .map(k => ({ id: k.id, title: k.title, number: k.number, name: k.name, questions: k.questions }));

  const matches = {};
  if (task) {
    Object.values(session.participants).forEach(p => {
      const m = matchAnswerKey(data, req.companyId, p.partInfo);
      matches[p.id] = m ? { keyId: m.key.id, keyTitle: m.key.title, confidence: m.confidence } : null;
    });
  }

  res.json({ session, task: task || null, answerKeys, matches });
});

// Публичный маршрут — вызывает страница ученика (/d/:code) до присоединения, без авторизации компании.
app.get('/api/drawing-sessions/:code/info', (req, res) => {
  const data = db.load();
  const session = safeGet(data.sessions, req.params.code);
  if (!session || session.type !== 'drawing') return res.status(404).json({ error: 'Сессия не найдена' });
  if (session.ended) return res.status(410).json({ error: 'Задание завершено' });
  const trialMsg = trialBlockedForCompany(data, session.companyId);
  if (trialMsg) return res.status(403).json({ error: 'TRIAL_ENDED', message: trialMsg });
  const task = safeGet(data.drawingTasks, session.drawingTaskId);
  res.json({
    testTitle: session.testTitle,
    intro: task ? task.intro : '',
    outro: task ? (task.outro || '') : '',
    timeLimit: session.timeLimit || null,
    questions: task ? task.questions.map(studentQuestionView) : [],
    scheduledAt: session.scheduledAt || null
  });
});

app.post('/api/drawing-sessions/:code/join', joinLimiter, async (req, res) => {
  let { name, partInfo } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Введите имя' });
  const data = db.load();
  const session = safeGet(data.sessions, req.params.code);
  if (!session || session.type !== 'drawing') return res.status(404).json({ error: 'Сессия не найдена' });
  if (session.ended) return res.status(410).json({ error: 'Задание завершено' });
  if (session.scheduledAt && Date.now() < session.scheduledAt) {
    return res.status(403).json({
      error: 'NOT_STARTED',
      message: `Задание ещё не началось. Начало запланировано на ${new Date(session.scheduledAt).toLocaleString('ru-RU')}.`,
      scheduledAt: session.scheduledAt
    });
  }
  const trialMsg = trialBlockedForCompany(data, session.companyId);
  if (trialMsg) return res.status(403).json({ error: 'TRIAL_ENDED', message: trialMsg });
  const roster = resolveRoster(data, session, name);
  if (roster) {
    if (!roster.ok) return res.status(400).json({ error: roster.message, code: 'NOT_IN_ROSTER', message: roster.message });
    name = roster.name; // каноническое написание из списка группы
    req.body.forceNew = false; // в списочной сессии «другого человека с таким же именем» не бывает
  }
  const task = safeGet(data.drawingTasks, session.drawingTaskId);
  if (!task) return res.status(404).json({ error: 'Задание не найдено' });
  const inProgress = findUnfinishedByName(session, name);
  if (inProgress && !req.body.forceNew) return nameInProgress(res, inProgress, !!roster);
  const pid = participantId();
  const joinedAt = Date.now();
  const participant = {
    id: pid,
    restarted: !!req.body.forceNew,
    name: name.trim().slice(0, 80),
    partInfo: (partInfo || '').trim().slice(0, 200),
    joinedAt,
    deadline: session.timeLimit ? joinedAt + session.timeLimit * 60 * 1000 : null,
    finished: false,
    answers: null,
    grades: null,
    gradeComment: '',
    graded: false
  };
  await db.update((d) => { d.sessions[req.params.code].participants[pid] = participant; });
  io.to('session:' + req.params.code).emit('participant:joined', participant);
  res.json({
    participantId: pid,
    testTitle: task.title,
    intro: task.intro,
    outro: task.outro || '',
    timeLimit: session.timeLimit || null,
    deadline: participant.deadline,
    serverNow: Date.now(),
    questions: task.questions.map(studentQuestionView)
  });
});

app.post('/api/drawing-sessions/:code/submit', async (req, res) => {
  const { participantId: pid, answers } = req.body;
  const data = db.load();
  const session = safeGet(data.sessions, req.params.code);
  if (!session || session.type !== 'drawing') return res.status(404).json({ error: 'Сессия не найдена' });
  const participant = safeGet(session.participants, pid);
  if (!participant) return res.status(404).json({ error: 'Участник не найден' });
  if (participant.finished) return res.status(400).json({ error: 'Бланк уже сдан' });
  // Время вышло определяет сервер (по своим часам), а не телефон ученика.
  const timeIsUp = !!(participant.deadline && Date.now() >= participant.deadline - 3000);
  const task = safeGet(data.drawingTasks, session.drawingTaskId);
  if (!task) return res.status(404).json({ error: 'Задание не найдено' });
  const safeAnswers = task.questions.map((q, i) => {
    const val = Array.isArray(answers) ? answers[i] : undefined;
    return typeof val === 'string' ? val.trim().slice(0, 2000) : '';
  });
  // Бланк принимается только полностью заполненным (проверка и на сервере — обойти её нельзя).
  const missing = safeAnswers.map((a, i) => (a ? null : i + 1)).filter(Boolean);
  // Пока время не вышло, бланк с пустыми графами не принимается; после окончания времени
  // принимается как есть (иначе ответы ученика просто пропали бы).
  if (missing.length > 0 && !timeIsUp) {
    return res.status(400).json({
      error: `Заполните все графы перед сдачей. Не заполнено: ${missing.length} (пункты ${missing.join(', ')}).`,
      missing
    });
  }
  const result = await db.update((d) => {
    const p = safeGet(d.sessions[req.params.code].participants, pid);
    p.finished = true;
    p.finishedAt = Date.now();
    p.durationSec = Math.round((p.finishedAt - p.joinedAt) / 1000);
    p.timedOut = timeIsUp;
    p.answers = safeAnswers;
    return p;
  });
  await incrementSubmissions(session.companyId);
  io.to('session:' + req.params.code).emit('participant:finished', result);
  res.json({ ok: true });
});

// Публичный маршрут — ученик проверяет свой результат по той же ссылке после проверки
// преподавателем. Правильные ответы отдаём только когда бланк уже проверен (graded),
// чтобы не спалить ключ одноклассникам, которые ещё заполняют тот же бланк.
app.get('/api/drawing-sessions/:code/result', (req, res) => {
  const { participantId: pid } = req.query;
  if (!pid) return res.status(400).json({ error: 'Не указан участник' });
  const data = db.load();
  const session = safeGet(data.sessions, req.params.code);
  if (!session || session.type !== 'drawing') return res.status(404).json({ error: 'Сессия не найдена' });
  const p = safeGet(session.participants, pid);
  if (!p) return res.status(404).json({ error: 'Участник не найден' });
  if (!p.finished) return res.json({ finished: false });
  if (!p.graded) return res.json({ finished: true, graded: false, timedOut: !!p.timedOut, durationSec: p.durationSec || null });

  const task = safeGet(data.drawingTasks, session.drawingTaskId);
  const match = task ? matchAnswerKey(data, session.companyId, p.partInfo) : null;
  const resolvedAnswers = task ? resolveKeyAnswers(task.questions, match ? match.key : null) : null;

  const items = (task ? task.questions : []).map((q, i) => ({
    text: q.text,
    given: (p.answers && p.answers[i]) || '',
    correct: p.grades ? p.grades[i] : null,
    correctAnswer: (resolvedAnswers && resolvedAnswers[i]) || q.correctAnswer || null
  }));
  const score = (p.grades || []).filter(g => g === true).length;
  res.json({
    finished: true,
    graded: true,
    timedOut: !!p.timedOut,
    durationSec: p.durationSec || null,
    score,
    total: items.length,
    gradeComment: p.gradeComment || '',
    items
  });
});

// Ручная проверка бланка преподавателем: массив true/false/null по каждому вопросу + общий комментарий.
app.post('/api/drawing-sessions/:code/grade', checkAuth, async (req, res) => {
  const { participantId: pid, grades, gradeComment } = req.body;
  const result = await db.update((d) => {
    const session = safeGet(d.sessions, req.params.code);
    if (!session || session.companyId !== req.companyId || session.type !== 'drawing') return null;
    const p = safeGet(session.participants, pid);
    if (!p) return null;
    p.grades = Array.isArray(grades) ? grades.map(g => (g === true ? true : g === false ? false : null)) : null;
    p.gradeComment = (gradeComment || '').trim().slice(0, 1000);
    p.graded = true;
    return p;
  });
  if (!result) return res.status(404).json({ error: 'Участник или сессия не найдены' });
  res.json({ ok: true });
});

app.post('/api/drawing-sessions/:code/end', checkAuth, async (req, res) => {
  await db.update((d) => {
    const s = safeGet(d.sessions, req.params.code);
    if (s && s.companyId === req.companyId) {
      s.ended = true;
    }
  });
  io.to('session:' + req.params.code).emit('session:ended');
  res.json({ ok: true });
});

app.get('/api/drawing-sessions/:code/export', checkAuth, (req, res) => {
  const data = db.load();
  const session = safeGet(data.sessions, req.params.code);
  if (!session || session.companyId !== req.companyId || session.type !== 'drawing') return res.status(404).send('Сессия не найдена');
  const task = safeGet(data.drawingTasks, session.drawingTaskId);
  const questions = task ? task.questions : [];
  const rows = Object.values(session.participants).map(p => {
    const row = {
      'Имя': p.name,
      'Деталь / задание №': p.partInfo || '',
      'Статус': p.finished ? 'Сдал' : 'В процессе',
      'Проверено': p.graded ? 'Да' : 'Нет',
      'Баллы': p.grades ? p.grades.filter(g => g === true).length : '—',
      'Всего пунктов': questions.length
    };
    questions.forEach((q, i) => {
      row[`Ответ: ${q.text}`] = p.answers ? (p.answers[i] || '') : '';
      if (q.correctAnswer) row[`Ключ: ${q.text}`] = q.correctAnswer;
      if (p.grades) row[`Оценка: ${q.text}`] = p.grades[i] === true ? 'Зачёт' : p.grades[i] === false ? 'Незачёт' : '—';
    });
    row['Комментарий проверяющего'] = p.gradeComment || '';
    return row;
  });
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, 'Результаты');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', `attachment; filename="drawing_results_${req.params.code}.xlsx"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

// ==================== ВОЗОБНОВЛЕНИЕ ПРОХОЖДЕНИЯ ====================
// Если ученик вышел (закрыл вкладку, села батарея, пропала связь), при повторном входе он
// продолжает с того же места: тот же участник, те же вопросы/вариант, сохранённые ответы и
// тот же срок сдачи (таймер НЕ перезапускается). Черновик ответов клиент шлёт на
// /api/progress; на диск/в Supabase он уходит пачкой раз в 15 секунд, чтобы десятки
// учеников не создавали очередь из полных записей базы.
const MAX_DRAFT_BYTES = 100 * 1024;
let draftFlushTimer = null;
function scheduleDraftFlush() {
  if (draftFlushTimer) return;
  draftFlushTimer = setTimeout(async () => {
    draftFlushTimer = null;
    try { await db.update(() => {}); } catch (e) { console.error('[progress] не удалось сохранить черновики:', e); }
  }, 15000);
}

function findUnfinishedByName(session, name) {
  const key = String(name || '').trim().toLowerCase();
  return Object.values(session.participants || {})
    .filter(p => !p.finished && String(p.name || '').trim().toLowerCase() === key)
    .sort((a, b) => (b.joinedAt || 0) - (a.joinedAt || 0))[0] || null;
}

// Ответ join, если участник с таким именем уже проходит эту сессию: вместо дубля
// предлагаем продолжить (клиент вызывает /api/resume по имени).
function nameInProgress(res, p, hasRoster) {
  return res.status(409).json({
    error: 'NAME_IN_PROGRESS',
    roster: !!hasRoster,
    message: `«${p.name}» уже проходит это задание. Если это вы — продолжите с того же места.` +
      (hasRoster ? ' Если не получается — сообщите преподавателю.' : ' Если это другой человек с таким же именем, войдите как новый участник.')
  });
}

app.post('/api/progress/:code', (req, res) => {
  const { participantId: pid, draft } = req.body;
  const data = db.load();
  const session = safeGet(data.sessions, req.params.code);
  if (!session) return res.status(404).json({ ok: false });
  const p = safeGet(session.participants, pid);
  if (!p || p.finished || session.ended) return res.json({ ok: false });
  let size = 0;
  try { size = JSON.stringify(draft === undefined ? null : draft).length; } catch (e) { return res.status(400).json({ ok: false }); }
  if (size > MAX_DRAFT_BYTES) return res.status(413).json({ ok: false, error: 'Слишком большой черновик' });
  p.draft = draft === undefined ? null : draft; // правим кэш в памяти напрямую; запись на диск — пачкой
  p.draftAt = Date.now();
  scheduleDraftFlush();
  res.json({ ok: true });
});

app.post('/api/resume/:code', joinLimiter, (req, res) => {
  const { participantId: pid, name } = req.body;
  const data = db.load();
  const session = safeGet(data.sessions, req.params.code);
  if (!session) return res.status(404).json({ error: 'NOT_FOUND', message: 'Сессия не найдена' });
  let p = pid ? safeGet(session.participants, pid) : null;
  if (!p && name) p = findUnfinishedByName(session, name);
  if (!p) return res.status(404).json({ error: 'NOT_FOUND', message: 'Участник не найден' });
  if (p.finished) return res.json({ finished: true, participantId: p.id });
  if (session.ended) return res.status(410).json({ error: 'Задание завершено' });
  const type = session.type || 'test';
  const base = { resumed: true, finished: false, type, participantId: p.id, name: p.name, joinedAt: p.joinedAt, draft: p.draft || null, serverNow: Date.now() };

  if (type === 'test') {
    const test = safeGet(data.tests, session.testId);
    if (!test) return res.status(404).json({ error: 'Тест не найден' });
    const byId = {}; test.questions.forEach(q => { byId[q.id] = q; });
    const mapping = p.optionShuffle || {};
    const order = (p.questionOrder && p.questionOrder.length ? p.questionOrder : test.questions.map(q => q.id)).filter(id => byId[id]);
    const questions = order.map(id => {
      const q = byId[id];
      const m = mapping[id] || q.options.map((_, i) => i);
      return { id: q.id, text: q.text, options: m.map(i => q.options[i]), multi: !!q.multi, image: q.image || null };
    });
    return res.json({ ...base, testTitle: test.title, timeLimit: session.timeLimit || null,
      deadline: session.timeLimit ? p.joinedAt + session.timeLimit * 60 * 1000 : null, questions });
  }
  if (type === 'lab') {
    const lab = safeGet(data.labs, session.labId);
    if (!lab) return res.status(404).json({ error: 'Тренажёр не найден' });
    return res.json({ ...base, testTitle: lab.title, cases: (p.caseAssignment || []).map(a => caseForClient(lab, a)) });
  }
  if (type === 'drawing') {
    const task = safeGet(data.drawingTasks, session.drawingTaskId);
    if (!task) return res.status(404).json({ error: 'Задание не найдено' });
    return res.json({ ...base, testTitle: task.title, intro: task.intro, outro: task.outro || '',
      timeLimit: session.timeLimit || null, deadline: p.deadline || null, partInfo: p.partInfo || '',
      questions: task.questions.map(studentQuestionView) });
  }
  if (type === 'tolerance') {
    const task = safeGet(data.toleranceTasks, session.toleranceTaskId);
    const variant = task ? task.variants.find(v => v.id === p.variantId) : null;
    if (!variant) return res.status(404).json({ error: 'Вариант не найден' });
    const labels = fieldLabels(variant.kind);
    const fieldsTable = variant.kind === 'hole' ? HOLE_FIELDS : SHAFT_FIELDS;
    return res.json({ ...base, testTitle: task.title, intro: task.intro, methodology: task.methodology || [],
      variant: { kind: variant.kind, typeName: labels.typeName, nominal: variant.nominal, field: variant.field }, labels,
      table: { ranges: TOLERANCE_RANGES, fieldNames: Object.keys(fieldsTable), rows: fieldsTable } });
  }
  res.status(400).json({ error: 'Неизвестный тип сессии' });
});

// ==================== СЕССИИ КОМПАНИИ (история и повторное открытие) ====================
// Панель преподавателя раньше получала участников только live по сокету — после
// обновления страницы или перезапуска сервера таблица оставалась пустой. Эти два маршрута
// позволяют подтянуть актуальное состояние с сервера и вернуться в любую прошлую сессию.

function sessionPathPrefix(type) {
  return type === 'lab' ? 'l' : type === 'drawing' ? 'd' : type === 'tolerance' ? 'k' : 's';
}

app.get('/api/my-sessions', checkAuth, (req, res) => {
  const data = db.load();
  const list = Object.values(data.sessions)
    .filter(s => s.companyId === req.companyId)
    .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
    .slice(0, 100)
    .map(s => {
      const parts = Object.values(s.participants || {});
      return {
        code: s.code,
        type: s.type || 'test',
        title: s.testTitle,
        startedAt: s.startedAt,
        ended: !!s.ended,
        participants: parts.length,
        finished: parts.filter(p => p.finished).length
      };
    });
  res.json(list);
});

app.get('/api/my-sessions/:code', checkAuth, async (req, res) => {
  const data = db.load();
  const session = safeGet(data.sessions, req.params.code);
  if (!session || session.companyId !== req.companyId) return res.status(404).json({ error: 'Сессия не найдена' });
  const url = `${getBaseUrl(session)}/${sessionPathPrefix(session.type)}/${session.code}`;
  let qrDataUrl = '';
  try { qrDataUrl = await QRCode.toDataURL(url, { width: 400, margin: 1 }); } catch (e) {}
  res.json({ session, url, qrDataUrl, serverNow: Date.now() });
});

// Удаление прошедших сессий (вместе с ответами участников). Только свои сессии компании.
app.post('/api/my-sessions/delete', checkAuth, async (req, res) => {
  const codes = Array.isArray(req.body.codes) ? req.body.codes.filter(c => typeof c === 'string').slice(0, 200) : [];
  let deleted = 0;
  await db.update((d) => {
    codes.forEach(code => {
      const s = safeGet(d.sessions, code);
      if (s && s.companyId === req.companyId) { delete d.sessions[code]; deleted++; }
    });
  });
  codes.forEach(code => io.to('session:' + code).emit('session:ended'));
  res.json({ ok: true, deleted });
});

// ==================== КВАЛИТЕТЫ (расчёт допусков, автопроверка) ====================
// В отличие от чертежей и тренажёров, здесь правильный ответ вычисляется по формуле
// (см. tolerance-content.js), поэтому проверка полностью автоматическая. Раздача
// вариантов — по очереди подключения (round-robin по индексу присоединения), а не
// случайно: session.nextVariantIndex увеличивается на 1 при каждом join.

const TOL_UM_EPS = 0.01;   // допуск сравнения в мкм (защита от погрешности округления)
const TOL_MM_EPS = 0.0006; // допуск сравнения в мм (~0.5 мкм)

function parseNum(v) {
  if (v === null || v === undefined || v === '') return null;
  // iOS/Android могут подставить типографский минус (−), короткое (–) или длинное (—) тире.
  const cleaned = String(v).replace(/[\u2212\u2013\u2014]/g, '-').replace(',', '.').replace(/\s/g, '');
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(cleaned)) return null;
  const n = parseFloat(cleaned);
  return isNaN(n) ? null : n;
}

function fieldLabels(kind) {
  return kind === 'hole'
    ? { devMax: 'ES', devMin: 'EI', limMax: 'Dmax', limMin: 'Dmin', typeName: 'Отверстие' }
    : { devMax: 'es', devMin: 'ei', limMax: 'dmax', limMin: 'dmin', typeName: 'Вал' };
}

app.get('/api/tolerance-tasks', checkAuth, (req, res) => {
  const data = db.load();
  const list = Object.values(data.toleranceTasks)
    .filter(t => t.shared || t.companyId === req.companyId)
    .map(t => ({ id: t.id, title: t.title, intro: t.intro, variantCount: t.variants.length, shared: !!t.shared }));
  res.json(list);
});

app.post('/api/tolerance-sessions', checkAuth, async (req, res) => {
  const { toleranceTaskId } = req.body;
  const data = db.load();
  const task = safeGet(data.toleranceTasks, toleranceTaskId);
  if (!task || (!task.shared && task.companyId !== req.companyId)) return res.status(404).json({ error: 'Задание не найдено' });
  let scheduledAt = null;
  if (req.body.scheduledAt) {
    const ts = parseInt(req.body.scheduledAt, 10);
    if (!isNaN(ts) && ts > Date.now()) scheduledAt = ts;
  }
  let code;
  do { code = nanoid(); } while (safeGet(data.sessions, code));
  const session = {
    code,
    companyId: req.companyId,
    type: 'tolerance',
    toleranceTaskId,
    testTitle: task.title,
    startedAt: Date.now(),
    scheduledAt,
    ended: false,
    nextVariantIndex: 0,
    participants: {},
    groupId: pickGroupId(req),
    remote: wantsRemote(req)
  };
  await db.update((d) => { d.sessions[code] = session; });
  const url = `${getBaseUrl(session)}/k/${code}`;
  const qrDataUrl = await QRCode.toDataURL(url, { width: 400, margin: 1 });
  res.json({ session, url, qrDataUrl });
});

app.post('/api/tolerance-sessions/:code/start-now', checkAuth, async (req, res) => {
  const result = await db.update((d) => {
    const session = safeGet(d.sessions, req.params.code);
    if (!session || session.companyId !== req.companyId) return null;
    session.scheduledAt = null;
    return session;
  });
  if (!result) return res.status(404).json({ error: 'Сессия не найдена' });
  res.json({ ok: true });
});

app.get('/api/tolerance-sessions/:code', checkAuth, (req, res) => {
  const data = db.load();
  const session = safeGet(data.sessions, req.params.code);
  if (!session || session.companyId !== req.companyId || session.type !== 'tolerance') {
    return res.status(404).json({ error: 'Сессия не найдена' });
  }
  const task = safeGet(data.toleranceTasks, session.toleranceTaskId);
  res.json({ session, task: task || null });
});

app.get('/api/tolerance-sessions/:code/info', (req, res) => {
  const data = db.load();
  const session = safeGet(data.sessions, req.params.code);
  if (!session || session.type !== 'tolerance') return res.status(404).json({ error: 'Сессия не найдена' });
  if (session.ended) return res.status(410).json({ error: 'Задание завершено' });
  const trialMsg = trialBlockedForCompany(data, session.companyId);
  if (trialMsg) return res.status(403).json({ error: 'TRIAL_ENDED', message: trialMsg });
  const task = safeGet(data.toleranceTasks, session.toleranceTaskId);
  res.json({
    testTitle: session.testTitle,
    intro: task ? task.intro : '',
    scheduledAt: session.scheduledAt || null
  });
});

app.post('/api/tolerance-sessions/:code/join', joinLimiter, async (req, res) => {
  let { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Введите имя' });
  const data = db.load();
  const session = safeGet(data.sessions, req.params.code);
  if (!session || session.type !== 'tolerance') return res.status(404).json({ error: 'Сессия не найдена' });
  if (session.ended) return res.status(410).json({ error: 'Задание завершено' });
  if (session.scheduledAt && Date.now() < session.scheduledAt) {
    return res.status(403).json({
      error: 'NOT_STARTED',
      message: `Задание ещё не началось. Начало запланировано на ${new Date(session.scheduledAt).toLocaleString('ru-RU')}.`,
      scheduledAt: session.scheduledAt
    });
  }
  const trialMsg = trialBlockedForCompany(data, session.companyId);
  if (trialMsg) return res.status(403).json({ error: 'TRIAL_ENDED', message: trialMsg });
  const roster = resolveRoster(data, session, name);
  if (roster) {
    if (!roster.ok) return res.status(400).json({ error: roster.message, code: 'NOT_IN_ROSTER', message: roster.message });
    name = roster.name; // каноническое написание из списка группы
    req.body.forceNew = false; // в списочной сессии «другого человека с таким же именем» не бывает
  }
  const task = safeGet(data.toleranceTasks, session.toleranceTaskId);
  if (!task || task.variants.length === 0) return res.status(404).json({ error: 'Задание не найдено' });

  const inProgress = findUnfinishedByName(session, name);
  if (inProgress && !req.body.forceNew) return nameInProgress(res, inProgress, !!roster);
  const pid = participantId();
  let variant;
  await db.update((d) => {
    const s = d.sessions[req.params.code];
    const idx = (s.nextVariantIndex || 0) % task.variants.length;
    variant = task.variants[idx];
    s.nextVariantIndex = idx + 1;
    s.participants[pid] = {
      id: pid,
    restarted: !!req.body.forceNew,
      name: name.trim().slice(0, 80),
      variantId: variant.id,
      joinedAt: Date.now(),
      finished: false,
      answers: null,
      correct: null,
      score: null,
      graded: false
    };
  });
  io.to('session:' + req.params.code).emit('participant:joined', session.participants[pid] || { id: pid, name: name.trim() });
  const labels = fieldLabels(variant.kind);
  const fieldsTable = variant.kind === 'hole' ? HOLE_FIELDS : SHAFT_FIELDS;
  res.json({
    participantId: pid,
    testTitle: task.title,
    intro: task.intro,
    methodology: task.methodology || [],
    variant: { kind: variant.kind, typeName: labels.typeName, nominal: variant.nominal, field: variant.field },
    labels,
    table: {
      ranges: TOLERANCE_RANGES,
      fieldNames: Object.keys(fieldsTable),
      rows: Object.keys(fieldsTable).reduce((acc, f) => { acc[f] = fieldsTable[f]; return acc; }, {}),
      highlightRow: toleranceRangeIndex(variant.nominal),
      highlightCol: variant.field
    }
  });
});

app.post('/api/tolerance-sessions/:code/submit', async (req, res) => {
  const { participantId: pid, values } = req.body;
  const data = db.load();
  const session = safeGet(data.sessions, req.params.code);
  if (!session || session.type !== 'tolerance') return res.status(404).json({ error: 'Сессия не найдена' });
  const participant = safeGet(session.participants, pid);
  if (!participant) return res.status(404).json({ error: 'Участник не найден' });
  if (participant.finished) return res.status(400).json({ error: 'Ответ уже сдан' });
  const task = safeGet(data.toleranceTasks, session.toleranceTaskId);
  const variant = task ? task.variants.find(v => v.id === participant.variantId) : null;
  if (!variant) return res.status(404).json({ error: 'Вариант не найден' });
  const correctAnswer = computeToleranceAnswer(variant);
  if (!correctAnswer) return res.status(500).json({ error: 'Не удалось вычислить эталонный ответ для этого варианта' });

  const given = {
    devMaxUm: parseNum(values && values.devMaxUm),
    devMinUm: parseNum(values && values.devMinUm),
    devMaxMm: parseNum(values && values.devMaxMm),
    devMinMm: parseNum(values && values.devMinMm),
    limMaxMm: parseNum(values && values.limMaxMm),
    limMinMm: parseNum(values && values.limMinMm)
  };
  const missingFields = Object.keys(given).filter(k => given[k] === null);
  if (missingFields.length > 0) {
    return res.status(400).json({
      error: 'Заполните все 6 граф числами перед сдачей (допустимы минус и запятая, например −16 или 0,021).',
      missing: missingFields
    });
  }
  const correct = {
    devMaxUm: given.devMaxUm !== null && Math.abs(given.devMaxUm - correctAnswer.devMaxUm) <= TOL_UM_EPS,
    devMinUm: given.devMinUm !== null && Math.abs(given.devMinUm - correctAnswer.devMinUm) <= TOL_UM_EPS,
    devMaxMm: given.devMaxMm !== null && Math.abs(given.devMaxMm - correctAnswer.devMaxMm) <= TOL_MM_EPS,
    devMinMm: given.devMinMm !== null && Math.abs(given.devMinMm - correctAnswer.devMinMm) <= TOL_MM_EPS,
    limMaxMm: given.limMaxMm !== null && Math.abs(given.limMaxMm - correctAnswer.limMaxMm) <= TOL_MM_EPS,
    limMinMm: given.limMinMm !== null && Math.abs(given.limMinMm - correctAnswer.limMinMm) <= TOL_MM_EPS
  };
  const score = Object.values(correct).filter(Boolean).length;

  await db.update((d) => {
    const p = safeGet(d.sessions[req.params.code].participants, pid);
    p.finished = true;
    p.finishedAt = Date.now();
    p.answers = given;
    p.correct = correct;
    p.score = score;
    p.graded = true; // автопроверка — сразу готово
  });
  await incrementSubmissions(session.companyId);
  io.to('session:' + req.params.code).emit('participant:finished', { id: pid, name: participant.name, finished: true, score, total: 6 });
  res.json({ ok: true, score, total: 6 });
});

app.get('/api/tolerance-sessions/:code/result', (req, res) => {
  const { participantId: pid } = req.query;
  if (!pid) return res.status(400).json({ error: 'Не указан участник' });
  const data = db.load();
  const session = safeGet(data.sessions, req.params.code);
  if (!session || session.type !== 'tolerance') return res.status(404).json({ error: 'Сессия не найдена' });
  const p = safeGet(session.participants, pid);
  if (!p) return res.status(404).json({ error: 'Участник не найден' });
  if (!p.finished) return res.json({ finished: false });

  const task = safeGet(data.toleranceTasks, session.toleranceTaskId);
  const variant = task ? task.variants.find(v => v.id === p.variantId) : null;
  const correctAnswer = variant ? computeToleranceAnswer(variant) : null;
  const labels = variant ? fieldLabels(variant.kind) : null;

  res.json({
    finished: true,
    graded: true,
    score: p.score,
    total: 6,
    variant: variant ? { kind: variant.kind, typeName: labels.typeName, nominal: variant.nominal, field: variant.field } : null,
    labels,
    given: p.answers,
    correct: p.correct,
    correctAnswer
  });
});

app.post('/api/tolerance-sessions/:code/end', checkAuth, async (req, res) => {
  await db.update((d) => {
    const s = safeGet(d.sessions, req.params.code);
    if (s && s.companyId === req.companyId) s.ended = true;
  });
  io.to('session:' + req.params.code).emit('session:ended');
  res.json({ ok: true });
});

app.get('/api/tolerance-sessions/:code/export', checkAuth, (req, res) => {
  const data = db.load();
  const session = safeGet(data.sessions, req.params.code);
  if (!session || session.companyId !== req.companyId || session.type !== 'tolerance') return res.status(404).send('Сессия не найдена');
  const task = safeGet(data.toleranceTasks, session.toleranceTaskId);
  const rows = Object.values(session.participants).map(p => {
    const variant = task ? task.variants.find(v => v.id === p.variantId) : null;
    const labels = variant ? fieldLabels(variant.kind) : {};
    const ca = variant ? computeToleranceAnswer(variant) : null;
    return {
      'Имя': p.name,
      'Вариант': variant ? `${labels.typeName} Ø${variant.nominal} ${variant.field}` : '—',
      'Статус': p.finished ? 'Сдал' : 'В процессе',
      'Балл': p.score !== null ? `${p.score}/6` : '—',
      [`${labels.devMax || 'ES'} дано (мкм)`]: p.answers ? p.answers.devMaxUm : '',
      [`${labels.devMax || 'ES'} верно (мкм)`]: ca ? ca.devMaxUm : '',
      [`${labels.devMin || 'EI'} дано (мкм)`]: p.answers ? p.answers.devMinUm : '',
      [`${labels.devMin || 'EI'} верно (мкм)`]: ca ? ca.devMinUm : '',
      [`${labels.limMax || 'Dmax'} дано (мм)`]: p.answers ? p.answers.limMaxMm : '',
      [`${labels.limMax || 'Dmax'} верно (мм)`]: ca ? ca.limMaxMm : '',
      [`${labels.limMin || 'Dmin'} дано (мм)`]: p.answers ? p.answers.limMinMm : '',
      [`${labels.limMin || 'Dmin'} верно (мм)`]: ca ? ca.limMinMm : ''
    };
  });
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, 'Результаты');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', `attachment; filename="tolerance_results_${req.params.code}.xlsx"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

app.get('/admin', (req, res) => {
  res.sendFile(publicFile('admin.html'));
});

io.on('connection', (socket) => {
  socket.on('teacher:watch', (code) => {
    if (typeof code === 'string') socket.join('session:' + code);
  });
  socket.on('teacher:unwatch', (code) => {
    if (typeof code === 'string') socket.leave('session:' + code);
  });

  // Студент сообщает, что вернулся после переключения вкладки/сворачивания приложения
  // во время прохождения теста. Ретранслируем преподавателю, наблюдающему за сессией.
  socket.on('student:tabswitch', (payload) => {
    if (!payload || typeof payload.code !== 'string' || typeof payload.participantId !== 'string') return;
    const awayMs = Math.max(0, parseInt(payload.awayMs, 10) || 0);
    io.to('session:' + payload.code).emit('participant:tabswitch', {
      participantId: payload.participantId,
      awayMs,
      isLong: !!payload.isLong
    });
  });
});

// ==================== АДМИН-ПАНЕЛЬ ====================

app.get('/api/admin/overview', checkAdmin, (req, res) => {
  const data = db.load();
  res.json({
    companies: Object.keys(data.companies).length,
    tests: Object.keys(data.tests).length,
    sessions: Object.keys(data.sessions).length,
    labs: Object.keys(data.labs).length,
    drawingTasks: Object.keys(data.drawingTasks).length
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
    Object.keys(d.drawingTasks).forEach(id => { if (d.drawingTasks[id].companyId === cid) delete d.drawingTasks[id]; });
  });
  res.json({ ok: true });
});

// Очистка кэша переводов (RU -> KK). Нужна на случай, если ранее (до исправления
// translateOne) в кэш попали «отравленные» записи — оригинальный русский текст,
// сохранённый как перевод из-за временной ошибки/лимита сервиса MyMemory. После очистки
// все тексты переведутся заново при следующем переключении на казахский язык.
app.post('/api/admin/clear-translations', checkAdmin, async (req, res) => {
  let count = 0;
  await db.update((d) => {
    count = Object.keys(d.translations || {}).length;
    d.translations = {};
  });
  res.json({ ok: true, cleared: count });
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

// Восстановление базы данных из файла, скачанного через «Скачать бэкап базы».
// ПОЛНОСТЬЮ заменяет текущие данные — всё, что появилось после создания бэкапа, будет
// потеряно. Собственный лимит на размер тела запроса (бэкап с изображениями в вопросах
// может быть заметно больше, чем стандартный лимит остальных маршрутов).
app.post('/api/admin/restore', checkAdmin, express.json({ limit: '25mb' }), async (req, res) => {
  const incoming = req.body;
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
    return res.status(400).json({ error: 'Файл не похож на корректный бэкап (ожидался JSON-объект)' });
  }
  const looksValid = ['companies', 'tests', 'sessions'].some(
    key => incoming[key] && typeof incoming[key] === 'object' && !Array.isArray(incoming[key])
  );
  if (!looksValid) {
    return res.status(400).json({ error: 'Файл не похож на бэкап этой платформы — не найдены ожидаемые разделы (companies/tests/sessions)' });
  }
  const restored = await db.restore(incoming);
  res.json({
    ok: true,
    companies: Object.keys(restored.companies).length,
    tests: Object.keys(restored.tests).length,
    sessions: Object.keys(restored.sessions).length,
    labs: Object.keys(restored.labs).length,
    drawingTasks: Object.keys(restored.drawingTasks).length
  });
});

async function seedLabs() {
  await db.update((d) => {
    if (!d.labs) d.labs = {};
    SEED_LABS.forEach(l => { d.labs[l.id] = { ...l, shared: true }; });
  });
  console.log(`[labs] Синхронизировано общих тренажёров: ${SEED_LABS.length}`);
}

async function seedDrawingTasks() {
  await db.update((d) => {
    if (!d.drawingTasks) d.drawingTasks = {};
    SEED_DRAWING_TASKS.forEach(t => { d.drawingTasks[t.id] = { ...t, shared: true }; });
  });
  console.log(`[drawing-tasks] Синхронизировано общих заданий: ${SEED_DRAWING_TASKS.length}`);
}

async function seedAnswerKeys() {
  await db.update((d) => {
    if (!d.answerKeys) d.answerKeys = {};
    SEED_ANSWER_KEYS.forEach(k => { d.answerKeys[k.id] = { ...k, shared: true }; });
  });
  console.log(`[answer-keys] Синхронизировано ключей ответов: ${SEED_ANSWER_KEYS.length}`);
}

async function seedToleranceTasks() {
  await db.update((d) => {
    if (!d.toleranceTasks) d.toleranceTasks = {};
    d.toleranceTasks[SEED_TOLERANCE_TASK.id] = { ...SEED_TOLERANCE_TASK, shared: true };
  });
  console.log(`[tolerance-tasks] Синхронизировано заданий по квалитетам: 1 (${SEED_TOLERANCE_TASK.variants.length} вариантов)`);
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

function listenOnFreePort() {
  // Локальный режим: если порт занят (например, запущена вторая копия) — берём следующий.
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const tryListen = (port) => {
      const onError = (e) => {
        server.removeListener('listening', onOk);
        if (e.code === 'EADDRINUSE' && LOCAL_MODE && attempts < 20) { attempts++; tryListen(port + 1); }
        else reject(e);
      };
      const onOk = () => { server.removeListener('error', onError); PORT = port; resolve(port); };
      server.once('error', onError);
      server.once('listening', onOk);
      server.listen(port, process.env.HOST || '0.0.0.0');
    };
    tryListen(PORT);
  });
}

function openInBrowser(url) {
  try {
    const { exec } = require('child_process');
    if (process.platform === 'win32') exec(`start "" "${url}"`);
    else if (process.platform === 'darwin') exec(`open "${url}"`);
    else exec(`xdg-open "${url}"`);
  } catch (e) { /* не критично: адрес выведен в консоль */ }
}

// Облако (Render): бесплатный сервис засыпает через 15 минут без запросов, а бесплатный проект
// Supabase — через неделю без обращений к базе. Поэтому сервер сам изредка обращается к себе
// и к базе. Отключить: переменная KEEP_ALIVE=0. Учтите: бесплатные 750 часов в месяц Render
// выдаёт на ВСЕ сервисы аккаунта, круглосуточно хватает только на один сервис.
function startKeepAlive() {
  if (LOCAL_MODE || process.env.KEEP_ALIVE === '0') return;
  const self = (process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
  if (self) {
    setInterval(() => {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 20000);
      fetch(self + '/health', { signal: ctrl.signal }).catch(() => {}).finally(() => clearTimeout(to));
    }, Number(process.env.KEEP_ALIVE_MS) || 9 * 60 * 1000).unref();
    console.log('[keep-alive] сервис будет сам обращаться к ' + self + '/health каждые 9 минут, чтобы не засыпать');
  }
  if (db.USE_SUPABASE) {
    setTimeout(() => db.touch(), Number(process.env.TOUCH_FIRST_MS) || 30 * 1000).unref();
    setInterval(() => db.touch(), Number(process.env.TOUCH_MS) || 12 * 3600 * 1000).unref();
    console.log('[keep-alive] проверочный запрос к Supabase — раз в 12 часов (чтобы проект не ушёл на паузу)');
  }
}

async function start() {
  const prepareData = async () => {
    await seedLabs();
    await seedDrawingTasks();
    await seedAnswerKeys();
    await seedToleranceTasks();
    await ensureCloudSecrets();
  };
  // Облако (Supabase): порт открываем СРАЗУ, а базу подключаем уже под работающим сервером —
  // пока она не готова, API отвечает 503, а /health показывает «база подключается». Так деплой
  // на Render не зависает, даже если Supabase отвечает медленно или проект на паузе.
  // Файловый режим: данные читаются мгновенно, поэтому сначала загрузка, затем приём запросов.
  const earlyListen = !LOCAL_MODE && db.USE_SUPABASE;
  if (earlyListen) {
    await listenOnFreePort();
    startKeepAlive();
    db.onReady(prepareData);
    db.initCache()
      .then(() => { if (db.isReady()) return prepareData(); })
      .catch((e) => console.error('[start] Ошибка подготовки данных:', e));
  } else {
    await db.initCache();
    await prepareData();
  }
  if (LOCAL_MODE) {
    // В локальной версии пробных ограничений нет: все учётные записи — без лимитов.
    await db.update((d) => { Object.values(d.companies).forEach(c => { c.plan = 'unlimited'; c.blocked = false; }); });
    process.title = 'Тестирование — локальный сервер';
  }
  if (!earlyListen) {
    await listenOnFreePort();
    startKeepAlive();
  }
  console.log('');
  if (LOCAL_MODE) {
    const lan = listNetworkCandidates().filter(c => c.kind !== 'remote');
    console.log('=========== Тестирование: ЛОКАЛЬНЫЙ РЕЖИМ ===========');
    console.log(`Панель преподавателя:  http://localhost:${PORT}`);
    console.log(`Адрес для студентов:   ${getBaseUrl()}`);
    if (!lan.length) console.log('ВНИМАНИЕ: компьютер не подключён к сети — студенты не смогут зайти. Подключитесь к Wi-Fi или включите «Мобильный хот-спот».');
    if (lan.length > 1) console.log('Другие адреса этого компьютера: ' + lan.map(c => `${c.ip} (${c.name})`).join('; ') + '  — выбрать нужный: http://localhost:' + PORT + '/network');
    console.log(`Данные:                ${db.DATA_DIR}`);
    console.log('Не закрывайте это окно, пока идёт занятие. Остановка — закрыть окно или Ctrl+C.');
    console.log('======================================================');
    if (localCfg.openBrowser !== false && !process.env.NO_BROWSER) openInBrowser(`http://localhost:${PORT}`);
  } else {
    console.log('=== Приложение для тестирования запущено ===');
    console.log(`Панель преподавателя: http://localhost:${PORT}`);
    console.log(`Админ-панель: ${getBaseUrl()}/admin`);
    console.log(`Публичный адрес (для QR): ${getBaseUrl()}`);
    console.log('==============================================');
  }
}

start().catch((e) => {
  console.error('[start] Не удалось запустить сервер:', e);
  if (LOCAL_MODE) { console.error('Нажмите Enter, чтобы закрыть окно…'); process.stdin.resume(); process.stdin.once('data', () => process.exit(1)); }
  else process.exit(1);
});
