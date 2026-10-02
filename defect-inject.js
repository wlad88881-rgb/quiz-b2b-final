// Добавляет вкладку «Акты дефектации» в панель преподавателя «на лету»:
// сервер читает public/index.html и вставляет кнопку вкладки, её содержимое (iframe)
// и переключение в switchTab. Сам файл index.html не меняется. Если разметка панели
// когда-нибудь изменится и маркеры не найдутся — страница отдаётся как есть.
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'public', 'index.html');

const TAB_BTN = `<button class="tab-btn" id="tab-btn-defect" onclick="switchTab('defect')">🛠 Акты дефектации</button>\n      `;
const TAB_PANEL = `<div id="tab-defect" class="hidden">
        <div class="muted" style="margin-bottom:10px; font-size:13.5px;">Новый формат тренажёров: бланк «Акт дефектации», выгрузка/загрузка через Excel, схемы узлов. <a href="/defect-admin.html" target="_blank" style="color:var(--orange);">Открыть в отдельном окне</a></div>
        <iframe id="defect-frame" style="width:100%; height:78vh; border:1px solid var(--border); border-radius:12px; background:#eef1f5;"></iframe>
      </div>
      `;
const SWITCH_LINE = `document.getElementById('tab-defect').classList.toggle('hidden', tab !== 'defect');
    if (tab === 'defect') loadDefectFrame();
    `;
const EXTRA_SCRIPT = `<script>
  function loadDefectFrame() {
    var f = document.getElementById('defect-frame');
    if (f && !f.getAttribute('src')) f.setAttribute('src', '/defect-admin.html');
  }
</script>
`;

function inject(html) {
  const m1 = `<button class="tab-btn" id="tab-btn-stats"`;
  const m2 = `<div id="tab-stats" class="hidden">`;
  const m3 = `document.getElementById('tab-stats').classList.toggle('hidden', tab !== 'stats');`;
  if (!html.includes(m1) || !html.includes(m2) || !html.includes(m3) || html.includes('tab-btn-defect')) return null;
  html = html.replace(m1, TAB_BTN + m1);
  html = html.replace(m2, TAB_PANEL + m2);
  html = html.replace(m3, SWITCH_LINE + m3);
  return html.replace('</body>', EXTRA_SCRIPT + '</body>');
}

let cache = { mtime: 0, html: null };
module.exports = function defectInject(req, res, next) {
  try {
    const st = fs.statSync(FILE);
    if (st.mtimeMs !== cache.mtime) {
      cache = { mtime: st.mtimeMs, html: inject(fs.readFileSync(FILE, 'utf8')) };
      if (!cache.html) console.warn('[defect] Не удалось вставить вкладку в index.html (изменилась разметка) — отдаётся как есть');
    }
    if (!cache.html) return next();
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(cache.html);
  } catch (e) { next(); }
};
