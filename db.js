const fs = require('fs');
const path = require('path');

// Локальный режим: программа упакована в .exe (process.pkg) или запущена с LOCAL_MODE=1.
// Тогда данные лежат в папке data РЯДОМ с программой (внутри .exe писать нельзя), а облачная
// база Supabase не используется вообще — всё хранится в файле на компьютере преподавателя.
const IS_PKG = !!process.pkg;
const LOCAL_MODE = IS_PKG || process.env.LOCAL_MODE === '1';
const APP_DIR = IS_PKG ? path.dirname(process.execPath) : __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(APP_DIR, 'data');
const FILE_PATH = path.join(DATA_DIR, 'db.json');
const ROW_KEY = 'db';

// ==================== ПОСТОЯННОЕ ХРАНИЛИЩЕ (Supabase Postgres) ====================
// Если заданы переменные окружения SUPABASE_URL / SUPABASE_SERVICE_KEY — данные
// сохраняются во внешней бесплатной базе Supabase (не стираются при простое/
// передеплое на бесплатном тарифе Render). Если переменные не заданы — используется
// только локальный файл (подходит для локальной разработки, но на Render такие
// данные стираются при каждом перезапуске сервиса).
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const USE_SUPABASE = !LOCAL_MODE && !!(SUPABASE_URL && SUPABASE_SERVICE_KEY);

let supabase = null;
if (USE_SUPABASE) {
  const { createClient } = require('@supabase/supabase-js');
  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false }
  });
  console.log('[db] Хранилище: Supabase Postgres (данные переживут перезапуск и передеплой)');
} else if (LOCAL_MODE) {
  console.log('[db] Локальный режим: данные хранятся в файле ' + path.join(DATA_DIR, 'db.json'));
} else {
  console.warn('[db] ВНИМАНИЕ: SUPABASE_URL/SUPABASE_SERVICE_KEY не заданы — используется только локальный файл data/db.json. На бесплатном тарифе Render эти данные стираются при простое/передеплое сервиса! Задайте переменные окружения, чтобы включить постоянное хранилище.');
}

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Кэш в памяти. Все синхронные чтения (load) идут отсюда — без сетевых обращений,
// поэтому переписывать многочисленные вызовы db.load() по всему server.js не нужно.
let cache = null;

function defaultData() {
  return { companies: {}, tests: {}, sessions: {}, labs: {}, drawingTasks: {}, answerKeys: {}, toleranceTasks: {}, translations: {} };
}

// Гарантирует, что во всех ожидаемых ключах лежат объекты, а не undefined —
// защита от падения всего процесса при частично повреждённом/устаревшем файле базы.
function normalize(data) {
  const d = data && typeof data === 'object' ? data : {};
  if (!d.companies || typeof d.companies !== 'object') d.companies = {};
  if (!d.tests || typeof d.tests !== 'object') d.tests = {};
  if (!d.sessions || typeof d.sessions !== 'object') d.sessions = {};
  if (!d.labs || typeof d.labs !== 'object') d.labs = {};
  if (!d.drawingTasks || typeof d.drawingTasks !== 'object') d.drawingTasks = {};
  if (!d.answerKeys || typeof d.answerKeys !== 'object') d.answerKeys = {};
  if (!d.toleranceTasks || typeof d.toleranceTasks !== 'object') d.toleranceTasks = {};
  if (!d.translations || typeof d.translations !== 'object') d.translations = {};
  return d;
}

// ==================== БЕЗОПАСНАЯ РАБОТА С ЛОКАЛЬНЫМ ФАЙЛОМ ====================
// 1) Запись атомарная: сначала во временный файл, затем rename. Если питание/процесс
//    оборвутся посреди записи, рабочий db.json останется целым (старой версии).
// 2) Ротация копий: не чаще раза в BACKUP_EVERY_MS в data/backups/ кладётся копия
//    текущего db.json, хранится последних BACKUP_KEEP штук.
// 3) При повреждении db.json сервер сам берёт самую свежую рабочую копию, а битый
//    файл не удаляет, а переименовывает в db.corrupt-<время>.json (для разбора).
// 4) Запись на диск откладывается на FILE_WRITE_DELAY_MS и склеивается: десятки
//    сдач подряд дают одну запись, а не десятки полных перезаписей базы.
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const BACKUP_KEEP = 10;
const BACKUP_EVERY_MS = 5 * 60 * 1000;
const FILE_WRITE_DELAY_MS = 1000;

function tryReadJson(file) {
  try {
    return { ok: true, data: normalize(JSON.parse(fs.readFileSync(file, 'utf8'))) };
  } catch (e) {
    return { ok: false, error: e };
  }
}

function listBackups() {
  try {
    return fs.readdirSync(BACKUP_DIR)
      .filter(f => /^db-.*\.json$/.test(f))
      .sort() // имя содержит время ГГГГММДД-ЧЧММСС → сортировка по имени = по времени
      .reverse()
      .map(f => path.join(BACKUP_DIR, f));
  } catch (e) {
    return [];
  }
}

function loadFromFile() {
  if (!fs.existsSync(FILE_PATH)) {
    // Основного файла нет (например, удалили вручную) — пробуем копии.
    for (const b of listBackups()) {
      const r = tryReadJson(b);
      if (r.ok) {
        console.warn('[db] db.json не найден — восстановлено из копии ' + path.basename(b));
        return r.data;
      }
    }
    return null;
  }
  const main = tryReadJson(FILE_PATH);
  if (main.ok) return main.data;

  console.error('[db] ОШИБКА: db.json повреждён:', main.error && main.error.message);
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.renameSync(FILE_PATH, path.join(DATA_DIR, 'db.corrupt-' + stamp + '.json'));
  } catch (e) { /* не критично */ }
  for (const b of listBackups()) {
    const r = tryReadJson(b);
    if (r.ok) {
      console.warn('[db] Восстановлено из резервной копии ' + path.basename(b) + ' (последние минуты работы могли не войти в копию)');
      return r.data;
    }
  }
  console.error('[db] Рабочих копий нет — запуск с пустой базой. Повреждённый файл сохранён как db.corrupt-*.json в папке data.');
  return null;
}

function rotateBackupIfNeeded() {
  try {
    if (!fs.existsSync(FILE_PATH)) return;
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const existing = listBackups();
    if (existing.length) {
      const age = Date.now() - fs.statSync(existing[0]).mtimeMs;
      if (age < BACKUP_EVERY_MS) return;
    }
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    fs.copyFileSync(FILE_PATH, path.join(BACKUP_DIR, 'db-' + stamp + '.json'));
    listBackups().slice(BACKUP_KEEP).forEach(f => { try { fs.unlinkSync(f); } catch (e) {} });
  } catch (e) {
    console.error('[db] Не удалось сделать резервную копию:', e);
  }
}

let fileWriteTimer = null;
let filePending = null;

function flushFileSync() {
  if (fileWriteTimer) { clearTimeout(fileWriteTimer); fileWriteTimer = null; }
  if (!filePending) return;
  const data = filePending;
  filePending = null;
  try {
    rotateBackupIfNeeded();
    const tmp = FILE_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, FILE_PATH);
  } catch (e) {
    console.error('[db] Ошибка записи локального файла:', e);
  }
}

function saveToFile(data) {
  filePending = data;
  if (!fileWriteTimer) fileWriteTimer = setTimeout(flushFileSync, FILE_WRITE_DELAY_MS);
}

// При штатном завершении (Ctrl+C, остановка службы, process.exit) дописываем отложенное.
process.on('exit', flushFileSync);
['SIGINT', 'SIGTERM'].forEach(sig => process.on(sig, () => { module.exports.finalFlush().finally(() => process.exit(0)); }));

// ==================== НАДЁЖНОЕ СОХРАНЕНИЕ В SUPABASE ====================
// Принципы (облачный режим):
//  1) База считается «готовой» только после успешной загрузки из Supabase. Пока она не готова,
//     запись в Supabase ЗАПРЕЩЕНА — иначе пустой кэш затёр бы настоящие данные.
//  2) Если Supabase не отвечает при старте, сервер НЕ подменяет данные пустой базой: он ждёт и
//     переподключается в фоне; API отвечает 503 («повторите позже»), студенческая страница
//     сама повторяет отправку ответов.
//  3) Неудачная запись повторяется (несколько попыток подряд + фоновая досылка последнего
//     состояния каждые 15 секунд), а при остановке сервера (деплой/перезапуск Render) последнее
//     состояние дописывается.
let supabaseReady = !USE_SUPABASE;
let supabaseDirty = false;
let lastSupabaseError = null;
let reconnectTimer = null;
const readyCallbacks = [];
let flushTimer = null;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function upsertOnce(data) {
  const { error } = await supabase
    .from('app_data')
    .upsert({ key: ROW_KEY, value: data, updated_at: new Date().toISOString() });
  if (error) throw error;
}

async function persistToSupabase(data) {
  if (!USE_SUPABASE) return;
  if (!supabaseReady) return; // никогда не пишем, пока не загрузили настоящие данные
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await upsertOnce(data);
      supabaseDirty = false;
      lastSupabaseError = null;
      return;
    } catch (e) {
      lastErr = e;
      if (attempt < 3) await sleep(400 * attempt);
    }
  }
  supabaseDirty = true;
  lastSupabaseError = (lastErr && lastErr.message) || String(lastErr);
  console.error('[db] Не удалось сохранить в Supabase (будет повтор в фоне):', lastSupabaseError);
  ensureFlusher();
}

// Фоновая досылка последнего состояния, пока Supabase не вернётся.
function ensureFlusher() {
  if (flushTimer || !USE_SUPABASE) return;
  flushTimer = setInterval(async () => {
    if (!supabaseDirty || !supabaseReady || !cache) { if (!supabaseDirty) { clearInterval(flushTimer); flushTimer = null; } return; }
    try {
      await upsertOnce(cache);
      supabaseDirty = false; lastSupabaseError = null;
      console.log('[db] Отложенное сохранение в Supabase выполнено');
      clearInterval(flushTimer); flushTimer = null;
    } catch (e) {
      lastSupabaseError = (e && e.message) || String(e);
    }
  }, 15000);
}

async function connectSupabase() {
  const { data, error } = await supabase
    .from('app_data')
    .select('value')
    .eq('key', ROW_KEY)
    .maybeSingle();
  if (error) throw error;
  if (data && data.value) {
    cache = normalize(data.value);
    console.log('[db] Данные загружены из Supabase');
  } else {
    // В Supabase пока пусто — одноразово переносим локальный файл, если он есть
    // (полезно при первом включении Supabase на уже работающем проекте).
    const fileData = loadFromFile();
    cache = fileData || defaultData();
    await upsertOnce(cache);
    console.log(fileData
      ? '[db] Supabase был пуст — перенесены данные из локального файла (одноразовая миграция)'
      : '[db] Инициализирована пустая база в Supabase');
  }
  supabaseReady = true;
  lastSupabaseError = null;
}

function startReconnectLoop() {
  if (reconnectTimer) return;
  reconnectTimer = setInterval(async () => {
    try {
      await connectSupabase();
      clearInterval(reconnectTimer); reconnectTimer = null;
      console.log('[db] Подключение к Supabase восстановлено — сервер принимает запросы');
      for (const fn of readyCallbacks.splice(0)) { try { await fn(); } catch (err) { console.error('[db] Ошибка при начальной подготовке данных:', err); } }
    } catch (e) {
      lastSupabaseError = (e && e.message) || String(e);
    }
  }, 10000);
}

// Вызывается один раз при старте сервера (см. await db.initCache() в server.js).
async function initCache() {
  if (!USE_SUPABASE) {
    cache = loadFromFile() || defaultData();
    return true;
  }
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      await connectSupabase();
      return true;
    } catch (e) {
      lastSupabaseError = (e && e.message) || String(e);
      console.error(`[db] Supabase недоступен (попытка ${attempt}/4): ${lastSupabaseError}`);
      if (attempt < 4) await sleep(2000 * attempt);
    }
  }
  console.error('[db] Supabase не отвечает. Сервер запущен в режиме ожидания: изменения НЕ принимаются, пока база не подключится — данные не будут затёрты. Проверьте SUPABASE_URL / SUPABASE_SERVICE_KEY и что проект Supabase не на паузе (Dashboard → Resume project).');
  cache = defaultData();
  startReconnectLoop();
  return false;
}

function isReady() { return supabaseReady; }

// Выполнить действие после (позднего) подключения к базе, если на старте её не было.
function onReady(fn) { readyCallbacks.push(fn); }

function status() {
  return {
    storage: USE_SUPABASE ? 'supabase' : 'file',
    ready: supabaseReady,
    unsavedChanges: supabaseDirty,
    lastError: lastSupabaseError
  };
}

// Лёгкий запрос, чтобы бесплатный проект Supabase не ушёл на паузу из-за бездействия.
async function touch() {
  if (!USE_SUPABASE || !supabaseReady) return false;
  try {
    const { error } = await supabase.from('app_data').select('key').eq('key', ROW_KEY).limit(1);
    if (error) throw error;
    return true;
  } catch (e) {
    console.error('[db] Проверочный запрос к Supabase не удался:', (e && e.message) || e);
    return false;
  }
}

// Синхронное чтение — используется во всех маршрутах server.js без изменений.
function load() {
  if (!cache) cache = defaultData(); // защита на случай вызова до initCache()
  return normalize(cache);
}

class DbUnavailableError extends Error {
  constructor() { super('База данных ещё не подключена'); this.code = 'DB_UNAVAILABLE'; }
}

// Обновляет кэш в памяти мгновенно, затем сохраняет и локально, и в Supabase (если настроен).
async function save(data) {
  if (USE_SUPABASE && !supabaseReady) throw new DbUnavailableError();
  cache = data;
  saveToFile(data);
  await persistToSupabase(data);
}

// Все изменения идут через единую очередь: следующая запись начинается только после
// того, как предыдущая полностью завершилась (включая обращение к Supabase). Без этого
// при параллельных запросах (например, когда много студентов сдают тест одновременно)
// более быстрый поздний запрос мог "долететь" до Supabase раньше более раннего —
// и его результат перезаписывался устаревшими данными, теряя часть обновлений.
let writeQueue = Promise.resolve();

async function update(callback) {
  if (USE_SUPABASE && !supabaseReady) throw new DbUnavailableError();
  const run = writeQueue.then(async () => {
    const data = load();
    const result = callback(data);
    await save(data);
    return result;
  });
  // Даже если эта запись провалится, очередь не должна встать намертво для следующих.
  writeQueue = run.catch(() => {});
  return run;
}

// Полностью заменяет базу данных содержимым бэкапа (тот самый файл из «Скачать бэкап
// базы» в админке). Идёт через ту же очередь записи, что и update() — иначе восстановление
// могло бы столкнуться с параллельной обычной записью и результат оказался бы гонкой.
async function restore(newData) {
  if (USE_SUPABASE && !supabaseReady) throw new DbUnavailableError();
  const run = writeQueue.then(async () => {
    const normalized = normalize(newData);
    // секреты сервера (meta) принадлежат этому серверу, а не файлу бэкапа
    if (cache && cache.meta) normalized.meta = cache.meta;
    await save(normalized);
    return normalized;
  });
  writeQueue = run.catch(() => {});
  return run;
}

// При остановке (деплой/перезапуск на Render присылает SIGTERM) дописываем отложенное в Supabase.
async function finalFlush() {
  flushFileSync();
  if (USE_SUPABASE && supabaseReady && supabaseDirty && cache) {
    try { await Promise.race([upsertOnce(cache), sleep(8000)]); } catch (e) { /* уже ничего не сделать */ }
  }
}

module.exports = { load, save, update, restore, initCache, isReady, onReady, status, touch, finalFlush, flush: flushFileSync, DATA_DIR, APP_DIR, LOCAL_MODE, USE_SUPABASE, DbUnavailableError };
