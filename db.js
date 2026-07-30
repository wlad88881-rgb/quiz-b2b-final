const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const FILE_PATH = path.join(DATA_DIR, 'db.json');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function load() {
  try {
    if (!fs.existsSync(FILE_PATH)) {
      const defaultData = {
        companies: {},
        tests: {},
        sessions: {},
        labs: {}
      };
      fs.writeFileSync(FILE_PATH, JSON.stringify(defaultData, null, 2));
      return defaultData;
    }
    const raw = fs.readFileSync(FILE_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    console.error('[db] Ошибка загрузки:', e);
    return {};
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
