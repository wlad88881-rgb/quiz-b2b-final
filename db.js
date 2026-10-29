const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
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
const USE_SUPABASE = !!(SUPABASE_URL && SUPABASE_SERVICE_KEY);

let supabase = null;
if (USE_SUPABASE) {
  const { createClient } = require('@supabase/supabase-js');
  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false }
  });
  console.log('[db] Хранилище: Supabase Postgres (данные переживут перезапуск и передеплой)');
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
['SIGINT', 'SIGTERM'].forEach(sig => process.on(sig, () => { flushFileSync(); process.exit(0); }));

async function persistToSupabase(data) {
  if (!USE_SUPABASE) return;
  try {
    const { error } = await supabase
      .from('app_data')
      .upsert({ key: ROW_KEY, value: data, updated_at: new Date().toISOString() });
    if (error) throw error;
  } catch (e) {
    console.error('[db] Ошибка сохранения в Supabase:', e);
  }
}

// Вызывается один раз при старте сервера (см. await db.initCache() в server.js).
// Загружает данные из Supabase (если настроен) либо из локального файла в кэш памяти.
async function initCache() {
  if (USE_SUPABASE) {
    try {
      const { data, error } = await supabase
        .from('app_data')
        .select('value')
        .eq('key', ROW_KEY)
        .maybeSingle();
      if (error) throw error;
      if (data && data.value) {
        cache = normalize(data.value);
        console.log('[db] Данные загружены из Supabase');
        return true;
      }
      // В Supabase пока пусто — одноразово переносим локальный файл, если он есть
      // (полезно при первом включении Supabase на уже работающем проекте).
      const fileData = loadFromFile();
      if (fileData) {
        cache = fileData;
        await persistToSupabase(cache);
        console.log('[db] Supabase был пуст — перенесены данные из локального файла (одноразовая миграция)');
      } else {
        cache = defaultData();
        await persistToSupabase(cache);
        console.log('[db] Инициализирована пустая база в Supabase');
      }
    } catch (e) {
      console.error('[db] Не удалось подключиться к Supabase, временно используется локальный файл:', e);
      cache = loadFromFile() || defaultData();
    }
  } else {
    cache = loadFromFile() || defaultData();
  }
  return true;
}

// Синхронное чтение — используется во всех маршрутах server.js без изменений.
function load() {
  if (!cache) cache = defaultData(); // защита на случай вызова до initCache()
  return normalize(cache);
}

// Обновляет кэш в памяти мгновенно, затем сохраняет и локально, и в Supabase (если настроен).
async function save(data) {
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
  const run = writeQueue.then(async () => {
    const normalized = normalize(newData);
    await save(normalized);
    return normalized;
  });
  writeQueue = run.catch(() => {});
  return run;
}

module.exports = { load, save, update, restore, initCache, flush: flushFileSync, DATA_DIR };
