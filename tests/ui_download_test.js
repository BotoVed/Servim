const fs = require('fs');
const path = require('path');
const A = process.argv[2];
const DIR = A && !A.endsWith('.js') && !A.endsWith('.css') ? A : '/tmp/servim/servim/static';
const ARG = (f) => path.join(DIR, f);
const src = fs.readFileSync(ARG('app.js'), 'utf8');
const css = fs.readFileSync(ARG('app.css'), 'utf8');

const fail = [];
const ok = (c, m) => { console.log((c ? '  OK   ' : '  ПАДЕНИЕ ') + m); if (!c) fail.push(m); };
const n = (re) => (src.match(re) || []).length;

/* Скачивание: один билдер пути, он относительный и ведёт на маршрут, который реально
   есть в openapi.json (GET /jobs/{id}/result?format=). */
ok(n(/const dlUrl = \(id, f\) => `\$\{EP\}jobs\/\$\{id\}\/result\?format=\$\{f\}`;/g) === 1,
   'dlUrl = `${EP}jobs/{id}/result?format=` — один билдер пути');
ok(!/download\?fmt=zip/.test(src), 'zip-архивов больше нет — скачивание только пилюлями');
ok(n(/href="\/jobs\//g) === 0, 'абсолютных href="/jobs/…" нет (иначе ломается за прокси)');
ok(n(/\$\{DL\}/g) === 0, 'необъявленной переменной ${DL} больше нет');

/* Все запросы — через относительную базу EP (каталог текущей страницы) */
ok(src.includes("const EP0 = location.pathname.replace(/\\/{2,}/g, '/').replace(/[^/]*$/, '')") && /let EP = EP0/.test(src),
   'база = каталог страницы (EP0, двойные слэши свёрнуты), перекрывается настройкой «адрес сервера»');
ok(n(/api\('/g) === 0 && n(/api\(EP \+/g) >= 10,
   `все вызовы API через EP: через EP ${n(/api\(EP \+/g)}, абсолютных ${n(/api\('\/[a-z]/g)}`);
/* Хинты: один плавающий тултип (JS, .jtip), не перехватывает мышь, появляется
   после секунды удержания; не CSS:hover — тултип не должен обрезаться overflow */
ok(/\.jtip\{[^}]*pointer-events:none/.test(css), 'тултип плавающий (.jtip), не перехватывает мышь');
ok(/tip\.className = 'jtip'/.test(src) && /, 1000\)/.test(src), 'хинт появляется после 1 с удержания');

/* скачивание — пилюлями; плейсхолдер той же класс-схемы; подпись — в data-tip */
ok(/const pill = \(f, hide\) =>/.test(src), 'пилюля собирается одной функцией');
ok(/class="dl ph"/.test(src), 'плейсхолдер без результата — та же пилюля (.dl.ph)');
ok(/data-tip="скачать \.\$\{f\}"/.test(src), 'подпись пилюли — в data-tip');

console.log(fail.length ? `\nПАДЕНИЙ: ${fail.length}` : '\nвсе проверки пройдены');
process.exit(fail.length ? 1 : 0);
