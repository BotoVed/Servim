/* Контракт разметки v1.6.0. Каждый $('#id') обязан существовать в разметке или
   создаваться скриптом — иначе страница молча умирает (так и было в 1.3/1.5).
   Плюс проверки самих требований юзера к сборке. */
const fs = require('fs');
const path = require('path');
const D = process.argv[2] || '/tmp/servim/servim/static';
const js = fs.readFileSync(path.join(D, 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(D, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(D, 'app.css'), 'utf8');

const fail = [];
const ok = (c, m, extra) => { console.log((c ? '  OK   ' : '  ПАДЕНИЕ ') + m + (c || !extra ? '' : ' — ' + extra)); if (!c) fail.push(m); };

/* --- блоки, с которыми работаем --- */
const head = html.slice(0, html.indexOf('</header>'));
const tools = html.slice(html.indexOf('class="tools"'), html.indexOf('class="tw"'));
const foot = html.slice(html.indexOf('class="tip"'));

/* 1. id-контракт */
const created = new Set([...js.matchAll(/\b[a-zA-Z_$][\w$]*\.id\s*=\s*['"]([a-z0-9_-]+)['"]/g)].map(m => m[1]));
const rendered = new Set([...js.matchAll(/id=\\?["']([a-z0-9_-]+)/gi)].map(m => m[1]));
const used = new Set([...js.matchAll(/\$\(['"]#([A-Za-z0-9_-]+)['"]/g)].map(m => m[1]));
const inHtml = new Set([...html.matchAll(/id="([A-Za-z0-9_-]+)"/g)].map(m => m[1]));
const missing = [...used].filter(i => !inHtml.has(i) && !created.has(i) && !rendered.has(i));
ok(!missing.length, 'все id из app.js есть в разметке или создаются скриптом', missing.join(', '));

/* 2. версии */
const ver = (js.match(/UI_VER = '([^']+)'/) || [])[1];
const qv = [...new Set([...html.matchAll(/\?v=([0-9.]+)/g)].map(m => m[1]))];
ok(qv.length === 1 && qv[0] === ver, 'версия одна и та же: UI_VER=' + ver + ', index.html=' + qv.join('/'));

/* 3. панель инструментов: действия + карандаш + пиктограммы-переключатели, без селектов */
ok(!/<select/.test(tools), 'в панели инструментов нет выпадающих списков');
['start', 'stop', 'edit'].forEach(id => ok(new RegExp('id="' + id + '"').test(tools), 'в панели есть кнопка #' + id));
ok(tools.indexOf('id="stop"') < tools.indexOf('id="edit"') && tools.indexOf('id="edit"') < tools.indexOf('data-flag="diarize"'),
  'карандаш стоит между «стоп» и переключателями');
const tgl = [...tools.matchAll(/<button class="tbtn tgl"[\s\S]*?<\/button>/g)].map(m => m[0]);
ok(tgl.length === 3, 'переключателей ровно три', tgl.length);
ok(tgl.every(b => /<svg/.test(b) && /data-tip=/.test(b) && !/>[а-яё]/.test(b.split('<svg')[0] + '>')),
  'переключатели — пиктограммы с подсказкой, без текста');
ok(/\.tools \.tbtn\.tgl\[aria-pressed="true"\]/.test(css), 'включённый переключатель подсвечен зелёным');
ok(/data-flag="diarize"[\s\S]{0,400}data-flag="vad_filter"[\s\S]{0,400}data-flag="word_timestamps"/.test(html),
  'все три флага передаются как раньше');

/* 4. настройки: модель / язык / спикеры — внутри окна под шестерёнкой */
ok(/id="cfg"[\s\S]*id="model"[\s\S]*id="lang"[\s\S]*id="maxs"/.test(head), 'модель/язык/спикеры — в окне настроек');
ok(/\.sheet select,\.sheet input\{width:100%\}/.test(css), 'поля настроек растянуты на всю ширину');
ok(/saveStore\(\);/.test(js.split('const save = () =>')[1] || ''), 'смена модели/языка сохраняется');

/* 5. таблица: колонок «Тип»/«Длит.» нет, всё в ячейке с именем */
ok(!/<th class="c-type"|<th class="c-dur"/.test(html), 'колонок «Тип» и «Длит.» в шапке нет');
ok(/class="rowmeta"[\s\S]{0,300}class="meta"[\s\S]{0,200}class="pill/.test(js),
  'длительность и тип рисуются в ячейке имени');
ok(js.indexOf('class="dur"') < js.indexOf('class="pill'), 'длительность левее типа');
ok(/\.meta\{[^}]*margin-left:auto/.test(css), 'длительность и тип прижаты к правому краю');
const empty = (js.match(/class="empty"[^<]*/) || [''])[0];
ok(/colspan="4"/.test(js), 'заглушки строк пересчитаны под 4 колонки');

/* 6. пилюли: все сразу, «…» нет */
ok(!/data-k="dlmore"|class="dl more"/.test(js), 'кнопки «…» у пилюль нет');
ok(/dls\.map\(f => pill\(f, 0\)\)\.join\(''\)/.test(js), 'пилюли рисуются все сразу');
ok(/\.dlx\{display:inline-flex\}/.test(css) && /\.dl\.more\{display:none\}/.test(css), 'лишних состояний пилюль в CSS нет');

/* 7. открытие результата */
ok(/closest\('\.file'\)/.test(js), 'двойной клик работает по названию файла');
ok(/\$\('#edit'\)\.onclick/.test(js), 'карандаш открывает результат выбранной задачи');
ok(/data-open/.test(js), 'иконка статуса у готовой задачи тоже открывает');

/* 8. подвал и высота */
ok(/id="cnt"/.test(foot.slice(0, 500)), 'счётчик задач — в подвале таблицы');
ok(!/аудио не храним/.test(html), 'подписи «аудио не храним» нет');
ok(/\.tw\{height:auto;min-height:240px;max-height:none;flex:1 1 auto\}/.test(css), 'таблица растягивается');
ok(/\.wrap\{display:flex;flex-direction:column;min-height:calc\(100vh/.test(css), 'карточка занимает высоту экрана');
ok(/html,body\{height:100%\}/.test(css), 'html/body заданы в 100%');


/* 9. v1.7.1: длительность и тип — одной строкой; подсказки без вложенных тегов */
ok(/<div class="meta"><span class="dur">[\s\S]{0,140}?<span class="pill /.test(js)
     && !/<span class="pill[\s\S]{0,140}?<\/div>[\s\S]{0,80}?<span class="dur/.test(js),
  'длительность и тип на одной строке (один <div class="meta">, без </div> между ними)');
const tips = [...html.matchAll(/data-tip="([^"]*)"/g)].map(m => m[1]);
ok(tips.length >= 10 && !tips.some(t => /[<>]/.test(t)), 'подсказки кнопок — чистый текст без тегов (' + tips.length + ' шт.)');
ok(/\.tbtn\[data-tip\]::after\{[\s\S]{0,320}?transition-delay:1s/.test(css), 'у кнопок панели подсказка через 1 с');
ok(/\.dl\[data-tip\][^{]*\{[^}]*transition-delay:1s/.test(css), 'у пилюль подсказка через 1 с');

console.log(fail.length ? '\nФАЙЛОВ: ' + fail.length + '\n - ' + fail.join('\n - ') : '\nконтракт в порядке');
process.exit(fail.length ? 1 : 0);
