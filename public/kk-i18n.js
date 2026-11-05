/* RU ⇄ KZ для страниц «Квалитеты» и «Чертежи».
   1) Словарь готовых переводов (ниже) — точные тексты интерфейса и заданий.
   2) Всё, чего нет в словаре (ответы-эталоны, свои задания преподавателя, сообщения сервера),
      переводится на лету через /api/translate (сервер кэширует перевод).
   Выбор языка запоминается в браузере. */
(function () {
  'use strict';
  var LS_LANG = 'extraPageLang';
  var LS_AUTO = 'extraAutoKk';
  var lang = 'ru';
  try { lang = localStorage.getItem(LS_LANG) === 'kk' ? 'kk' : 'ru'; } catch (e) {}

  var DICT = {
    // ---- общее ----
    'Загрузка...': 'Жүктелуде...',
    'Не получилось': 'Орындалмады',
    'Ф.И.О.': 'Аты-жөні',
    'Фамилия Имя': 'Тегі Аты',
    'Введите Ф.И.О.': 'Аты-жөніңізді енгізіңіз.',
    'Ошибка': 'Қате',
    'Ошибка загрузки.': 'Жүктеу қатесі.',
    'Задание завершено преподавателем.': 'Тапсырманы оқытушы аяқтады.',
    'Доступ временно недоступен.': 'Қолжетімділік уақытша жабық.',
    'Сессия не найдена. Проверьте код или QR-код.': 'Сессия табылмады. Код немесе QR-кодты тексеріңіз.',
    'Не удалось подключиться. Проверьте интернет-соединение.': 'Қосылу мүмкін болмады. Интернет байланысын тексеріңіз.',
    'Не удалось подключиться. Обновите страницу.': 'Қосылу мүмкін болмады. Бетті жаңартыңыз.',
    'Не удалось подключиться. Попробуйте обновить страницу.': 'Қосылу мүмкін болмады. Бетті жаңартып көріңіз.',
    'Не удалось продолжить. Обновите страницу и попробуйте ещё раз.': 'Жалғастыру мүмкін болмады. Бетті жаңартып, қайталап көріңіз.',
    'Не удалось получить результат.': 'Нәтижені алу мүмкін болмады.',
    'Ваш ответ': 'Сіздің жауабыңыз',
    '(пусто)': '(бос)',
    // ---- квалитеты ----
    'Задание по квалитетам': 'Квалитеттер бойынша тапсырма',
    'Получить вариант': 'Нұсқаны алу',
    'Все 6 граф обязательны. Знак минус вводится кнопкой': 'Барлық 6 бағанды толтыру міндетті. Минус белгісі',
    'справа от поля (на iPhone на цифровой клавиатуре минуса нет). Дробную часть можно писать через запятую.': 'түймесімен (өрістің оң жағында) енгізіледі (iPhone-да сандық пернетақтада минус жоқ). Бөлшек бөлігін үтір арқылы жазуға болады.',
    '📐 Показать таблицу допусков': '📐 Рұқсат кестесін көрсету',
    '📐 Скрыть таблицу допусков': '📐 Рұқсат кестесін жасыру',
    'Сменить знак': 'Таңбаны ауыстыру',
    '2. Переведите в мм': '2. Миллиметрге аударыңыз',
    '3. Рассчитайте предельные размеры (мм)': '3. Шектік өлшемдерді есептеңіз (мм)',
    'Сдать ответ': 'Жауапты тапсыру',
    'Как выполнять:': 'Қалай орындау керек:',
    'Размеры, мм': 'Өлшемдер, мм',
    'Не удалось отправить ответ. Попробуйте ещё раз.': 'Жауап жіберілмеді. Қайталап көріңіз.',
    'Правильно': 'Дұрыс жауап',
    '✓ Верно': '✓ Дұрыс',
    '✕ Неверно': '✕ Бұрыс',
    'Отверстие': 'Тесік',
    'Вал': 'Білік',
    'Расчёт предельных отклонений и размеров (квалитеты)': 'Шектік ауытқулар мен өлшемдерді есептеу (квалитеттер)',
    'По таблице допусков ГОСТ 25347-82 определите отклонения и рассчитайте предельные размеры для вашего варианта.': 'ГОСТ 25347-82 рұқсат кестесі бойынша ауытқуларды анықтап, өз нұсқаңыз үшін шектік өлшемдерді есептеңіз.',
    'Найдите в левом столбце таблицы строку, в которую попадает ваш номинальный размер.': 'Кестенің сол жақ бағанынан сіздің номиналды өлшеміңіз түсетін жолды табыңыз.',
    'Найдите в верхней строке столбца заданное поле допуска (буква и квалитет).': 'Жоғарғы жолдан берілген рұқсат өрісінің бағанын табыңыз (әріп және квалитет).',
    'На пересечении строки и столбца найдите значения отклонений в микрометрах (мкм).': 'Жол мен баған қиылысынан ауытқу мәндерін микрометрмен (мкм) табыңыз.',
    'Переведите микрометры в миллиметры (разделите на 1000) и рассчитайте предельные размеры: Dmax = Dном + ES (или es), Dmin = Dном + EI (или ei).': 'Микрометрді миллиметрге айналдырыңыз (1000-ға бөліңіз) және шектік өлшемдерді есептеңіз: Dmax = Dном + ES (немесе es), Dmin = Dном + EI (немесе ei).',
    // ---- чертежи ----
    'Задание по чертежу': 'Сызба бойынша тапсырма',
    'Номер задания / деталь для анализа': 'Тапсырма нөмірі / талдауға арналған бөлшек',
    'например: чертёж №14, вал-шестерня': 'мысалы: №14 сызба, білік-тісті дөңгелек',
    'Начать': 'Бастау',
    'Сдать бланк': 'Бланкіні тапсыру',
    'Обновить': 'Жаңарту',
    'Заполните бланк по чертежу.': 'Бланкіні сызба бойынша толтырыңыз.',
    'Заполните это поле (если нечего писать — поставьте «нет» или «—»)': 'Бұл өрісті толтырыңыз (жазатыны болмаса — «жоқ» немесе «—» қойыңыз)',
    '⏱ Время вышло': '⏱ Уақыт біткен',
    'Время вышло — бланк отправляется автоматически…': 'Уақыт біткен — бланк автоматты түрде жіберілуде…',
    'Не удалось отправить бланк. Попробуйте ещё раз.': 'Бланкі жіберілмеді. Қайталап көріңіз.',
    'Бланк сдан.': 'Бланкі тапсырылды.',
    '⏱ Время вышло — бланк отправлен автоматически.': '⏱ Уақыт біткен — бланк автоматты түрде жіберілді.',
    'Преподаватель ещё не проверил бланк. Загляните позже по этой же ссылке.': 'Оқытушы бланкіні әлі тексерген жоқ. Кейінірек осы сілтеме арқылы қайта кіріңіз.',
    'Правильный ответ': 'Дұрыс жауап',
    '✓ Зачёт': '✓ Қабылданды',
    '✕ Незачёт': '✕ Қабылданбады',
    'Чтение чертежа — практическое задание': 'Сызбаны оқу — практикалық тапсырма',
    'Возьмите указанный чертёж детали и заполните бланк по пунктам ниже.': 'Көрсетілген бөлшек сызбасын алып, бланкіні төмендегі тармақтар бойынша толтырыңыз.',
    'Название детали': 'Бөлшектің атауы',
    'Обозначение (номер) чертежа': 'Сызбаның белгіленуі (нөмірі)',
    'Материал и стандарт (марка, ГОСТ)': 'Материал және стандарт (маркасы, ГОСТ)',
    'Вид заготовки (прокат, поковка, отливка, штамповка и т.п.)': 'Дайындама түрі (илем, соғылма, құйма, штамптама және т.б.)',
    'Масса детали и масштаб изображения': 'Бөлшектің массасы және кескін масштабы',
    'Габаритные размеры (длина × ширина/высота — наибольшие)': 'Габаритті өлшемдер (ұзындығы × ені/биіктігі — ең үлкендері)',
    'Самый точный размер, поле допуска и величина допуска': 'Ең дәл өлшем, рұқсат өрісі және рұқсат шамасы',
    'Наименьшая шероховатость поверхности и её расположение': 'Беттің ең аз кедір-бұдырлығы және оның орналасуы',
    'Допуски формы и расположения поверхностей (если указаны)': 'Беттердің пішіні мен орналасуының рұқсаттары (көрсетілген болса)',
    'Термическая / химико-термическая обработка': 'Термиялық / химиялық-термиялық өңдеу',
    'Количество отверстий, их диаметры и глубины': 'Тесіктер саны, олардың диаметрлері мен тереңдіктері',
    'Фаски, скругления, уклоны (перечислить размеры)': 'Жиектеме (фаска), дөңгелектеулер, еңіс (өлшемдерін санаңыз)',
    'Разрезы и сечения — для чего служат': 'Қималар мен қиықтар — не үшін қызмет етеді',
    'Количество видов на чертеже': 'Сызбадағы көріністер саны',
    'Параметры зубчатого венца (модуль, z, Ø вершин/впадин) — если есть': 'Тісті тәждің параметрлері (модуль, z, төбелері/ойықтарының Ø) — болса',
    'Резьбовые элементы: обозначение и количество': 'Бұранда элементтері: белгіленуі және саны',
    'Шпоночный паз: размеры и место расположения': 'Сыналы ойық (шпонка ойығы): өлшемдері және орналасқан жері',
    'Основные технические требования (кратко)': 'Негізгі техникалық талаптар (қысқаша)'
  };

  // Дополнительный словарь страницы (например, kk-dict-trainers.js), подключается ДО этого файла.
  if (window.KK_DICT_EXTRA) Object.keys(window.KK_DICT_EXTRA).forEach(function (k) { DICT[k] = window.KK_DICT_EXTRA[k]; });

  // Падежные окончания для границ интервалов (3, 6, 10, 18, 30, 50, 80, 120)
  var ABL = { 3: 'тен', 6: 'дан', 10: 'нан', 18: 'ден', 30: 'дан', 50: 'ден', 80: 'нен', 120: 'дан' };
  var DAT = { 3: 'ке', 6: 'ға', 10: 'ға', 18: 'ге', 30: 'ға', 50: 'ге', 80: 'ге', 120: 'ға' };
  function fromTo(a, b, over) {
    var A = ABL[a], B = DAT[b];
    if (!A || !B) return a + ' – ' + b;
    return a + '-' + A + (over ? ' жоғары ' : ' ') + b + '-' + B + ' дейін';
  }

  var PATTERNS = [
    [/^От (\d+) до (\d+)$/, function (m) { return fromTo(+m[1], +m[2], false); }],
    [/^Свыше (\d+) до (\d+)$/, function (m) { return fromTo(+m[1], +m[2], true); }],
    [/^1\. Определите по таблице (\S+) и (\S+) \(в мкм\)$/, function (m) { return '1. Кестеден ' + m[1] + ' және ' + m[2] + ' анықтаңыз (мкм-мен)'; }],
    [/^Результат: (.+)$/, function (m) { return 'Нәтиже: ' + m[1]; }],
    [/^Проверено: (.+)$/, function (m) { return 'Тексерілді: ' + m[1]; }],
    [/^Заполнено: (\d+) из (\d+)$/, function (m) { return 'Толтырылды: ' + m[1] + ' / ' + m[2]; }],
    [/^Заполните все графы числами перед сдачей\. Не заполнено или неверно: (\d+) из (\d+)\.$/, function (m) { return 'Тапсырар алдында барлық бағандарды сандармен толтырыңыз. Толтырылмаған немесе қате: ' + m[1] + ' / ' + m[2] + '.'; }],
    [/^Заполните все графы перед сдачей\. Не заполнено: (\d+) \(пункты (.+)\)\.$/, function (m) { return 'Тапсырар алдында барлық бағандарды толтырыңыз. Толтырылмаған: ' + m[1] + ' (тармақтар ' + m[2] + ').'; }],
    [/^⏱ Осталось (.+)$/, function (m) { return '⏱ Қалды ' + m[1]; }],
    [/^⏱ Время: (.+)$/, function (m) { return '⏱ Уақыт: ' + m[1]; }],
    [/^Время выполнения: (.+)\.$/, function (m) { return 'Орындау уақыты: ' + m[1] + '.'; }],
    [/^Схема к пункту (\d+)$/, function (m) { return 'Тармаққа арналған сұлба ' + m[1]; }],
    [/^⏱ Лимит времени: (\d+) мин\. Отсчёт начнётся сразу после нажатия «Начать»\. По окончании времени бланк отправится автоматически в том виде, в каком он заполнен\.$/, function (m) { return '⏱ Уақыт шектеуі: ' + m[1] + ' мин. Санақ «Бастау» түймесі басылған бойда басталады. Уақыт біткенде бланк толтырылған күйінде автоматты түрде жіберіледі.'; }],
    [/^⏰ Задание начнётся (.+)\. Страница обновится автоматически\.$/, function (m) { return '⏰ Тапсырма ' + m[1] + ' басталады. Бет автоматты түрде жаңарады.'; }]
  ];

  if (window.KK_PATTERNS_EXTRA) PATTERNS = PATTERNS.concat(window.KK_PATTERNS_EXTRA);

  var AUTO = {};
  try { AUTO = JSON.parse(localStorage.getItem(LS_AUTO) || '{}') || {}; } catch (e) { AUTO = {}; }
  function saveAuto() {
    try {
      var keys = Object.keys(AUTO);
      if (keys.length > 1500) { keys.slice(0, keys.length - 1500).forEach(function (k) { delete AUTO[k]; }); }
      localStorage.setItem(LS_AUTO, JSON.stringify(AUTO));
    } catch (e) {}
  }

  function needsTranslation(core) {
    var s = core.replace(/мкм|мм|мин/g, '');
    return /[А-Яа-яЁё]{2,}/.test(s);
  }

  window.KK_I18N = { lookup: lookup, dict: DICT };

  function T(x) { var r = lookup(String(x).trim()); return (r === null || r === '') ? x : r; }

  // вернёт перевод, '' (ничего переводить не надо) или null (нужен автоперевод)
  function lookup(core) {
    var S = window.__kkSession;
    if (S) {
      var nk = core.replace(/\s+/g, ' ');
      if (Object.prototype.hasOwnProperty.call(S, nk)) return S[nk];
    }
    if (Object.prototype.hasOwnProperty.call(DICT, core)) return DICT[core];
    for (var i = 0; i < PATTERNS.length; i++) {
      var m = core.match(PATTERNS[i][0]);
      if (m) return PATTERNS[i][1](m, T);
    }
    if (Object.prototype.hasOwnProperty.call(AUTO, core)) return AUTO[core];
    if (!needsTranslation(core)) return '';
    return null;
  }

  // ---------- состояние ----------
  var textInfo = new Map();   // Text -> {src,out}
  var attrInfo = new Map();   // Element -> { attr: {src,out} }
  var queue = new Map();      // src -> [ {node} | {el,attr} ]
  var flushTimer = null;
  var inFlight = {};
  var failedOnce = false;

  function split(text) {
    var m = text.match(/^(\s*)([\s\S]*?)(\s*)$/);
    return { lead: m[1], core: m[2], trail: m[3] };
  }

  function enqueue(src, target) {
    if (!queue.has(src)) queue.set(src, []);
    queue.get(src).push(target);
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, 300);
  }

  function flush() {
    var texts = [];
    queue.forEach(function (_, src) { if (!inFlight[src] && !Object.prototype.hasOwnProperty.call(AUTO, src)) texts.push(src); });
    if (!texts.length) return;
    texts.forEach(function (t) { inFlight[t] = true; });
    var chunks = [];
    for (var i = 0; i < texts.length; i += 100) chunks.push(texts.slice(i, i + 100));
    chunks.reduce(function (p, chunk) {
      return p.then(function () {
        return fetch('/api/translate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ texts: chunk, target: 'kk' })
        }).then(function (r) {
          return r.json().then(function (d) { if (!r.ok || !Array.isArray(d.translations)) throw new Error(d.error || r.status); return d; });
        }).then(function (d) {
          chunk.forEach(function (src, i) {
            var tr = d.translations[i];
            if (tr && tr !== src) AUTO[src] = tr;
            delete inFlight[src];
          });
          saveAuto();
          chunk.forEach(function (src) {
            var targets = queue.get(src) || [];
            queue.delete(src);
            targets.forEach(function (t) { t.node ? applyText(t.node) : applyAttr(t.el, t.attr); });
          });
        }).catch(function (e) {
          console.warn('[kk-i18n] автоперевод недоступен', e);
          chunk.forEach(function (src) { delete inFlight[src]; queue.delete(src); });
          if (!failedOnce) { failedOnce = true; toast('Аударма қазір қолжетімсіз, орыс тіліндегі мәтін көрсетілді.'); }
        });
      });
    }, Promise.resolve());
  }

  function toast(msg) {
    var el = document.createElement('div');
    el.setAttribute('data-no-i18n', '1');
    el.textContent = msg;
    el.style.cssText = 'position:fixed;left:12px;right:12px;bottom:16px;z-index:100000;background:#fff8ec;border-left:3px solid #F07C00;border-radius:10px;padding:12px 14px;font:14px system-ui,sans-serif;color:#2C3E50;box-shadow:0 4px 16px rgba(0,0,0,.15)';
    document.body.appendChild(el);
    setTimeout(function () { el.remove(); }, 6000);
  }

  // ---------- применение ----------
  function skipEl(el) {
    for (var n = el; n && n.nodeType === 1; n = n.parentNode) {
      var tag = n.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'TEXTAREA' || tag === 'NOSCRIPT' || tag === 'CODE') return true;
      if (n.hasAttribute && n.hasAttribute('data-no-i18n')) return true;
    }
    return false;
  }

  function applyText(node) {
    if (!node.parentNode || skipEl(node.parentNode)) return;
    var info = textInfo.get(node);
    var cur = node.nodeValue;
    var src = (info && cur === info.out) ? info.src : cur;
    if (lang !== 'kk') {
      if (info && cur === info.out && info.out !== info.src) node.nodeValue = info.src;
      textInfo.set(node, { src: src, out: src });
      return;
    }
    var p = split(src);
    if (!p.core) { textInfo.set(node, { src: src, out: src }); return; }
    var tr = lookup(p.core);
    var out = src;
    if (tr === null) enqueue(p.core, { node: node });
    else if (tr !== '') out = p.lead + tr + p.trail;
    if (node.nodeValue !== out) node.nodeValue = out;
    textInfo.set(node, { src: src, out: out });
  }

  var ATTRS = ['placeholder', 'title', 'aria-label', 'alt'];
  function applyAttr(el, attr) {
    if (!el.hasAttribute || !el.hasAttribute(attr) || skipEl(el)) return;
    var map = attrInfo.get(el); if (!map) { map = {}; attrInfo.set(el, map); }
    var info = map[attr], cur = el.getAttribute(attr);
    var src = (info && cur === info.out) ? info.src : cur;
    if (lang !== 'kk') {
      if (info && cur === info.out && info.out !== info.src) el.setAttribute(attr, info.src);
      map[attr] = { src: src, out: src };
      return;
    }
    var p = split(src);
    var out = src;
    if (p.core) {
      var tr = lookup(p.core);
      if (tr === null) enqueue(p.core, { el: el, attr: attr });
      else if (tr !== '') out = p.lead + tr + p.trail;
    }
    if (cur !== out) el.setAttribute(attr, out);
    map[attr] = { src: src, out: out };
  }

  function walk(root) {
    if (!root) return;
    if (root.nodeType === 3) { applyText(root); return; }
    if (root.nodeType !== 1 || skipEl(root)) return;
    ATTRS.forEach(function (a) { if (root.hasAttribute(a)) applyAttr(root, a); });
    var tw = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, null);
    var n;
    while ((n = tw.nextNode())) {
      if (n.nodeType === 3) applyText(n);
      else ATTRS.forEach(function (a) { if (n.hasAttribute(a)) applyAttr(n, a); });
    }
  }

  var origTitle = null;
  function applyTitle() {
    if (origTitle === null) origTitle = document.title;
    if (lang === 'kk') {
      var tr = lookup(origTitle.trim());
      document.title = (tr && tr !== '') ? tr : origTitle;
    } else document.title = origTitle;
  }

  function applyAll() {
    document.documentElement.setAttribute('lang', lang === 'kk' ? 'kk' : 'ru');
    applyTitle();
    walk(document.body);
    textInfo.forEach(function (_, n) { if (!n.isConnected) textInfo.delete(n); });
  }

  var observer = new MutationObserver(function (records) {
    records.forEach(function (r) {
      if (r.type === 'childList') r.addedNodes.forEach(walk);
      else if (r.type === 'characterData') applyText(r.target);
      else if (r.type === 'attributes') applyAttr(r.target, r.attributeName);
    });
  });

  // ---------- переключатель ----------
  function buildToggle() {
    var box = document.createElement('div');
    box.id = 'kk-lang-toggle';
    box.setAttribute('data-no-i18n', '1');
    box.style.cssText = 'position:fixed;top:10px;right:10px;z-index:99999;display:flex;gap:0;border:1px solid #d9d9d9;border-radius:999px;overflow:hidden;background:#fff;box-shadow:0 2px 8px rgba(0,0,0,.12);font:600 13px system-ui,sans-serif';
    ['ru', 'kk'].forEach(function (code) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = code === 'ru' ? 'RU' : 'KZ';
      b.dataset.code = code;
      b.style.cssText = 'border:0;padding:7px 12px;cursor:pointer;background:transparent;color:#2C3E50';
      b.onclick = function () { setLang(code); };
      box.appendChild(b);
    });
    document.body.appendChild(box);
    paintToggle();
  }
  function paintToggle() {
    var box = document.getElementById('kk-lang-toggle'); if (!box) return;
    box.querySelectorAll('button').forEach(function (b) {
      var on = b.dataset.code === lang;
      b.style.background = on ? '#F07C00' : 'transparent';
      b.style.color = on ? '#fff' : '#2C3E50';
    });
  }
  function setLang(code) {
    lang = code === 'kk' ? 'kk' : 'ru';
    try { localStorage.setItem(LS_LANG, lang); } catch (e) {}
    paintToggle();
    applyAll();
  }

  // Перевод, загруженный преподавателем, пришёл с сервера (wake.js) — перерисовываем страницу.
  if (window.addEventListener) window.addEventListener('kkdict', function () { if (document.body) { try { applyAll(); } catch (e) {} } });

  function init() {
    buildToggle();
    applyAll();
    observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
