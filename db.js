const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const FILE_PATH = path.join(DATA_DIR, 'db.json');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

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

function load() {
  try {
    if (!fs.existsSync(FILE_PATH)) {
      const data = defaultData();
      fs.writeFileSync(FILE_PATH, JSON.stringify(data, null, 2));
      return data;
    }
    const raw = fs.readFileSync(FILE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return normalize(parsed);
  } catch (e) {
    console.error('[db] Ошибка загрузки, используется структура по умолчанию:', e);
    return defaultData();
  }
}

function save(data) {
  try {
    fs.writeFileSync(FILE_PATH, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('[db] Ошибка сохранения:', e);
  }
}

async function update(callback) {
  const data = load();
  const result = callback(data);
  save(data);
  return result;
}

async function initCache() {
  load();
  return true;
}

module.exports = { load, save, update, initCache };
