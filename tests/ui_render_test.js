const fs = require('fs');
const path = require('path');
const A = process.argv[2];
const DIR = A && !A.endsWith('.js') && !A.endsWith('.css') ? A : '/tmp/servim/servim/static';
const ARG = (f) => path.join(DIR, f);
const vm = require('vm');
const src = fs.readFileSync(ARG('app.js'), 'utf8');

const mkEnv = () => {
  const els = {};
  const mk = (tag) => ({ tagName: tag, innerHTML: '', textContent: '', hidden: false, value: '',
    disabled: false, className: '', dataset: {}, files: [], checked: false, children: [],
    style: { setProperty() {} },
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, append(...a) { this.children.push(...a); },
    querySelector: () => mk('div'), querySelectorAll: () => [], closest: () => null,
    focus() {}, setPointerCapture() {}, releasePointerCapture() {} });
  const $ = (s) => (els[s] ||= mk(s.includes('table') ? 'table' : 'div'));
  const ctx = { console, setTimeout, clearTimeout, Date, Math, JSON, parseInt, parseFloat,
    encodeURIComponent, NodeFilter: { FILTER_SHOW_TREE_WALKER: 1 }, els,
    document: { body: mk('body'), createElement: mk, addEventListener() {}, hidden: false,
      querySelector: $, querySelectorAll: () => [] },
    localStorage: { getItem: () => null, setItem() {} },
    navigator: { onLine: true }, location: { href: "", pathname: "/ui/index.html" },
    fetch: () => Promise.reject(new Error('сеть в этом тесте не нужна')) };
  ctx.window = ctx;
  vm.createContext(ctx);
  return { ctx, els };
};

const fail = [];
const ok = (c, m) => { console.log((c ? '  OK   ' : '  ПАДЕНИЕ ') + m); if (!c) fail.push(m); };

// — готовая задача
let { ctx, els } = mkEnv();
vm.runInContext(src + `\n;S.jobs=[{id:'t1',name:'Встреча.m4a',type:'m4a',duration:120,status:'done',
  progress:100,speakers:2,summary:{spkrs:2,segs:30}}];render();`, ctx, { filename: 'app.js' });
const t1 = els['#tb'].innerHTML;
ok(t1.split('<td').length - 1 === 3, 'готовая: 3 ячейки (отметка+имя, тип/длительность внутри имени, спикеры)');
ok(/class="dls"/.test(t1), 'готовая: под именем есть ряд пилюль скачивания');
ok(!/data-k="kdl"/.test(t1), 'готовая: прежней кнопки с меню выбора формата нет');
ok(/class="dl" href="[^"]*format=stxt"[^>]*data-tip="скачать \.stxt"/.test(t1), 'готовая: пилюля — ссылка с data-tip');
ok(!/спикеров|сегм\./.test(t1), 'готовая: старой подписи «N спикеров · M сегм.» нет');

// — запланированная задача (результата ещё нет)
({ ctx, els } = mkEnv());
vm.runInContext(src + "\n;S.jobs=[{id:'t2',name:'черновик.wav',type:'wav',status:'plan'}];render();",
  ctx, { filename: 'app.js' });
const t2 = els['#tb'].innerHTML;
ok(/class="dl ph"/.test(t2), 'плановая: плейсхолдер в стиле пилюль');
ok(!/result\?format=/.test(t2), 'plan: битых ссылок на скачивание нет');

// — ошибка
({ ctx, els } = mkEnv());
vm.runInContext(src + "\n;S.jobs=[{id:'t3',name:'битый.mp3',type:'mp3',status:'error',error:'нет аудио'}];render();",
  ctx, { filename: 'app.js' });
ok(/class="dl ph"/.test(els['#tb'].innerHTML), 'ошибка: тоже есть плейсхолдер (строка не «пустая»)');

console.log(fail.length ? `\nПАДЕНИЙ: ${fail.length}` : '\nвсе проверки пройдены');
process.exit(fail.length ? 1 : 0);
