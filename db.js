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
  return { companies: {}, tests: {}, sessions: {}, labs: {}, translations: {} };
}

// Гарантирует, что во всех ожидаемых ключах лежат объекты, а не undefined —
// защита от падения всего процесса при частично повреждённом/устаревшем файле базы.
function normalize(data) {
  const d = data && typeof data === 'object' ? data : {};
  if (!d.companies || typeof d.companies !== 'object') d.companies = {};
  if (!d.tests || typeof d.tests !== 'object') d.tests = {};
  if (!d.sessions || typeof d.sessions !== 'object') d.sessions = {};
  if (!d.labs || typeof d.labs !== 'object') d.labs = {};
  if (!d.translations || typeof d.translations !== 'object') d.translations = {};
  return d;
}

function loadFromFile() {
  try {
    if (!fs.existsSync(FILE_PATH)) return null;
    const raw = fs.readFileSync(FILE_PATH, 'utf8');
    return normalize(JSON.parse(raw));
  } catch (e) {
    console.error('[db] Ошибка чтения локального файла:', e);
    return null;
  }
}

function saveToFile(data) {
  try {
    fs.writeFileSync(FILE_PATH, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('[db] Ошибка записи локального файла:', e);
  }
}

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

async function update(callback) {
  const data = load();
  const result = callback(data);
  await save(data);
  return result;
}

module.exports = { load, save, update, initCache };
