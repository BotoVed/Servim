/* v1.3.0: пилюли скачивания, пиктограммная панель, заголовок, панель настроек */
const fs = require('fs');
const vm = require('vm');
const DIR = process.argv[2] || '/tmp/wx2/ui';
const src = fs.readFileSync(DIR + '/app.js', 'utf8');
const html = fs.readFileSync(DIR + '/index.html', 'utf8');
const css = fs.readFileSync(DIR + '/app.css', 'utf8');

const mkEnv = (store) => {
  const els = {};
  const mk = (tag) => ({ tagName: tag, innerHTML: '', textContent: '', hidden: false, value: '',
    disabled: false, className: '', dataset: {}, files: [], checked: false, children: [],
    style: { setProperty() {} },
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, append(...a) { this.children.push(...a); },
    querySelector: () => mk('div'), querySelectorAll: () => [], closest: () => null,
    focus() {}, setPointerCapture() {}, releasePointerCapture() {} });
  const $ = (s) => (els[s] ||= mk(s.includes('table') ? 'table' : 'div'));
  const mem = store || {};
  const ctx = { console, setTimeout, clearTimeout, Date, Math, JSON, parseInt, parseFloat,
    encodeURIComponent, NodeFilter: { FILTER_SHOW_TREE_WALKER: 1 }, els,
    document: { body: mk('body'), createElement: mk, addEventListener() {}, hidden: false,
      querySelector: $, querySelectorAll: () => [] },
    localStorage: { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); } },
    navigator: { onLine: true }, location: { href: '', pathname: '/ui/index.html' },
    fetch: () => Promise.reject(new Error('сеть в этом тесте не нужна')) };
  ctx.window = ctx;
  vm.createContext(ctx);
  return { ctx, els };
};

const fail = [];
const ok = (c, m) => { console.log((c ? '  OK   ' : '  ПАДЕНИЕ ') + m); if (!c) fail.push(m); };

/* ---------- строка готовой задачи: пилюли ---------- */
let { ctx, els } = mkEnv();
vm.runInContext(src + `\nS.formats=['stxt','md','vtt','srt','txt','json','tsv','diarized_json'];
S.jobs=[{id:'t1',name:'Встреча.m4a',type:'m4a',duration:120,status:'done',progress:100,
  speakers:2,summary:{spkrs:2,segs:30}}];render();`, ctx, { filename: 'app.js' });
const t1 = els['#tb'].innerHTML;
ok(/class="dls"/.test(t1), 'под именем файла есть ряд пилюль (.dls)');
['stxt', 'md', 'vtt'].forEach(f =>
  ok(new RegExp('class="dl" href="[^"]*format=' + f + '"[^>]*>' + f + '</a>').test(t1),
    'видимая пилюля .' + f + ' (первыми тремя)'));
ok((t1.match(/class="dl "/g) || []).length + (t1.match(/class="dl"/g) || []).length === 3, 'первые 3 формата — видимыми пилюлями, остальные — под «…»');
ok(/dlmore|class="dl more"/.test(t1), 'пилюля «…» есть и открывает остальные форматы');
ok(!/data-k="kdl"|pickmask/.test(t1), 'кнопки с меню выбора формата больше нет');
ok(t1.indexOf('class="dl"') > t1.indexOf('class="file"'), 'пилюли идут ПОСЛЕ имени файла (в той же ячейке)');
ok(/href="[^"]*jobs\/t1\/result\?format=stxt"/.test(t1), 'пилюля ведёт на /jobs/{id}/result?format=');
ok(!/download\?fmt=zip|fmt=zip/.test(t1), 'zip в строке не предлагается');

/* ---------- строка неготовой задачи ---------- */
({ ctx, els } = mkEnv());
vm.runInContext(src + `\nS.formats=['stxt','md','vtt','srt'];
S.jobs=[{id:'t2',name:'Черновик.wav',type:'wav',duration:60,status:'plan',progress:0}];render();`,
  ctx, { filename: 'app.js' });
const t2 = els['#tb'].innerHTML;
ok(/class="dl ph"/.test(t2), 'плановая: приглушённая заглушка вместо пилюль');
ok(!/href="[^"]*format=/.test(t2), 'плановая: скачивать нечего, ссылок нет');

/* ---------- шапка и панель в index.html ---------- */
ok(/<title>Servim<\/title>/.test(html) && /<h1>Servim<\/h1>/.test(html), 'название — Servim (title и h1)');
ok(!/WhisperX/.test(html), 'старого названия WhisperX в разметке нет');
ok(!/<h2/.test(html), 'заголовка таблицы (h2 «Задачи…») нет');
ok(!/id="hmodel"|id="hdiar"|id="hq"/.test(html), 'служебных строк справа в шапке нет');
ok(/id="gear"/.test(html), 'в шапке есть шестерёнка');
['c_url', 'c_key', 'c_user', 'c_tok'].forEach(id =>
  ok(html.includes('id="' + id + '"'), 'в панели настроек есть поле ' + id));
ok(!/id="dlall"/.test(html), 'кнопки «Скачать всё» (zip) в панели нет');

/* кнопки панели: только пиктограммы + data-tip */
const tools = html.slice(html.indexOf('class="tools"'), html.indexOf('class="tw"'));
const btns = tools.match(/<button[\s\S]*?<\/button>/g) || [];
ok(btns.length >= 5, 'в панели ' + btns.length + ' кнопок');
ok(btns.every(b => /data-tip="/.test(b)), 'у каждой кнопки панели есть data-tip');
const icobtns = btns.filter(b => !/class="tbtn (tgl|pri lbl)"/.test(b));
ok(icobtns.every(b => /<svg/.test(b)), 'у каждой кнопки-действия есть пиктограмма (без '
  + icobtns.length + ' штук)');
ok(btns.filter(b => /class="tbtn tgl|class="tbtn pri lbl"/.test(b)).every(b => /data-tip=/.test(b)),
  'текстовые переключатели и кнопка «файлы» тоже с подсказкой');
ok(!/<button[^>]*class="tbtn [^"]*"[^>]*>[^<]*[А-Яа-я]/.test(tools.replace(/<svg[\s\S]*?<\/svg>/g, '')),
  'у кнопок-действий текста вне подписи-подсказки нет');

/* ---------- CSS ---------- */
ok(/\.dlx\{display:none\}/.test(css), 'лишние пилюли по умолчанию скрыты');
ok(/@media \(min-width:900px\)\{\.dlx\{display:inline-flex\}\.dl\.more\{display:none\}/.test(css)
  || /@media \(min-width:900px\)[\s\S]{0,120}\.dlx\{display:inline-flex\}/.test(css),
  'на широком экране все пилюли в ряд, «…» прячется');
ok(/\.tw\{--rows:9/.test(css) && /height:clamp\(300px,72vh/.test(css), 'таблица выше (9 строк / 72vh)');
ok(/header\{position:sticky/.test(css), 'заголовок страницы приклеен к верху');
ok(/transition-delay:1s/.test(css), 'тултипы всплывают через секунду');

/* ---------- панель настроек работает ---------- */
ok(src.includes("CFG_KEY = 'servim.cfg'") && src.includes('authHeaders'),
  'адрес/key читаются из настроек (servim.cfg) и уходят в Authorization');
ok(/EP = u \? u \+ '\/' : EP0/.test(src) || src.includes('EP = u + '),
  'настроенный адрес сервера подменяет базу запросов');

console.log(fail.length ? '\nПАДЕНИЙ: ' + fail.length + '\n - ' + fail.join('\n - ') : '\nвсе проверки пройдены');
process.exit(fail.length ? 1 : 0);
