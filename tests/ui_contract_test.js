/* контракт разметки: каждый $('#id'), к которому обращается app.js, обязан быть
   либо в index.html, либо создаваться самим скриптом. Иначе страница молча умирает. */
const fs = require('fs');
const D = process.argv[2] || '/tmp/servim/servim/static';
const js = fs.readFileSync(D + '/app.js', 'utf8');
const html = fs.readFileSync(D + '/index.html', 'utf8');
const created = new Set([...js.matchAll(/\b[a-zA-Z_$][\w$]*\.id\s*=\s*'([a-z0-9_-]+)'/g)].map(m => m[1]));
const inline = new Set([...js.matchAll(/id=["']?\\?["']?([a-z0-9_]+)["']/gi)].map(m => m[1]));
const used = new Set([...js.matchAll(/\$\(['"]#([A-Za-z0-9_-]+)['"]/g)].map(m => m[1]));
const inHtml = new Set([...html.matchAll(/id="([A-Za-z0-9_-]+)"/g)].map(m => m[1]));
/* узлы, которые скрипт сам вставляет в innerHTML при рендере */
const rendered = new Set([...js.matchAll(/id="\\?"?([a-z0-9_]+)/gi)].map(m => m[1]));
const missing = [...used].filter(i => !inHtml.has(i) && !created.has(i) && !rendered.has(i) && !inline.has(i));
console.log('используется id: ' + used.size + '| в разметке: ' + inHtml.size + '| нет ни там ни там: ' + missing.join(', '));
/* мобильные зеркалa обязаны ссылаться на существующие селекты */
const mirrors = [...html.matchAll(/data-mirror="([a-z0-9_]+)"/g)].map(m => m[1]);
const badMirr = mirrors.filter(m => !inHtml.has(m));
/* версии должны совпадать: иначе браузер держит старый кэш */
const ver = (js.match(/UI_VER = '([^']+)'/) || [])[1];
const qv = [...new Set([...html.matchAll(/\?v=([0-9.]+)/g)].map(m => m[1]))];
const fail = [];
const ok = (c, m) => { console.log((c ? '  OK   ' : '  ПАДЕНИЕ ') + m); if (!c) fail.push(m); };
ok(!missing.length, 'все id из app.js есть в разметке' + (missing.length ? ' — нет: ' + missing.join(', ') : ''));
ok(!badMirr.length, 'мобильные зеркала ссылаются на существующие селекты');
ok(qv.length === 1 && qv[0] === ver, `версия одна и та же: UI_VER=${ver}, в index.html ${qv.join('/')}`);
ok(/id="model"/.test(html) && /id="lang"/.test(html) && /id="maxs"/.test(html) && /id="cnt"/.test(html),
  'панель параметров на месте (модель/язык/спикеры/счётчик)');
ok(/data-flag="diarize"/.test(html) && /data-flag="vad_filter"/.test(html) && /data-flag="word_timestamps"/.test(html),
  'переключатели параметров есть');
ok(/id="add"[\s\S]{0,400}?<\/svg>\s*<span class="tl">[а-яё]+<\/span>/.test(html), 'кнопка загрузки подписана словами');
const css = fs.readFileSync(D + '/app.css', 'utf8');
ok(/\.tools \.tbtn\.tgl\[aria-pressed="true"\]/.test(css), 'у переключателей есть зелёное состояние');
ok(/\.tools select\{/.test(css), 'селекты панели описаны в CSS');
console.log(fail.length ? '\nФАЙЛОВ: ' + fail.length : '\nконтракт в порядке');
process.exit(fail.length ? 1 : 0);
