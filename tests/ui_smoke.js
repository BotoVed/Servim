// Смоук-прогон UI-логики в стабе DOM: ловит runtime-ошибки (undefined/null, опечатки),
// которые не видит node --check. Фикстуры — реальные ответы сервиса.
const fs = require('fs'), vm = require('vm'), path = require('path');

const FX = (n, alt) => JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures', ((alt && process.env[alt]) || n) + '.json'), 'utf8'));
const els = new Map();

class El {
  constructor(sel) {
    this.sel = sel; this._html = ''; this.textContent = ''; this.value = '';
    this.className = ''; this.hidden = false; this.disabled = false; this.style = {};
    this.dataset = {}; this.attrs = {}; this.children = []; this.listeners = {};
    this.classList = { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false };
  }
  set innerHTML(v) { this._html = String(v); }
  get innerHTML() { return this._html; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
  removeEventListener() {}
  appendChild(c) { this.children.push(c); return c; }
  closest() { return null; }
  querySelectorAll() { return []; }
  dispatchEvent() { return true; }
  focus() {}
  get options() { return [...this.children]; }
  onchange = null; onclick = null;
}
const q = (sel) => { if (!els.has(sel)) els.set(sel, new El(sel)); return els.get(sel); };

const flagSel = ['diarize', 'vad_filter', 'word_timestamps'].map(f => {
  const e = new El('[data-flag]'); e.dataset.flag = f; e.setAttribute('aria-pressed', 'true'); return e;
});

const document = {
  querySelector: (s) => q(s),
  querySelectorAll: (s) => (s.includes('data-flag') ? flagSel : []),
  createElement: (t) => new El('<' + t + '>'),
  addEventListener() {}, hidden: false,
  activeElement: { tagName: 'BODY' },
  body: new El('body'),
};

const routes = {
  '/health': Object.assign({}, FX('health', 'FX_HEALTH'), { users_ready: true }),
  '/me': { user: { id: 'u1', name: 'Тест', role: 'admin', key: 'sk-0000' }, settings: null },
  '/v1/models': FX('models', 'FX_MODELS'), '/queue': FX('queue', 'FX_QUEUE'),
  '/jobs?limit=60': FX('jobs', 'FX_JOBS'),
};
let calls = [];
async function fakeFetch(p, opt) {
  calls.push((opt && opt.method || 'GET') + ' ' + p);
  let body = routes[p];
  if (body === undefined) {
    if (/^\/jobs\/[0-9a-f-]+$/.test(p)) body = FX('job_done', 'FX_JOB');
    else if (p === '/jobs' && opt && opt.method === 'POST') body = { job_id: 'new-' + Date.now(), status: 'plan' };
    else if (/\/stop$/.test(p) || /\/queue\/(start|pause)/.test(p)) body = { ok: true, stopped: null };
    else if (p.startsWith('/jobs?ids=') ) body = { deleted: p.split('=')[1].split(','), count: p.split('=')[1].split(',').length };
    else if (/\/speakers$/.test(p)) body = { ok: true };
    else return { ok: false, status: 404, async json() { return { detail: 'нет' }; } };
  }
  return { ok: true, status: 200, async json() { return body; } };
}

const store = {};
const ctx = {
  document, fetch: fakeFetch, console,
  localStorage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => store[k] = v, removeItem: (k) => delete store[k] },
  matchMedia: () => ({ matches: false }), setInterval: () => 0, clearInterval: () => {},
  setTimeout: () => 0, clearTimeout: () => {}, confirm: () => true,
  FormData: class { append() {} }, Event: class { constructor() {} },
  Math, JSON, String, Number, Array, Object, Error, Promise, Date, RegExp, parseInt, parseFloat, isNaN, encodeURIComponent,
};
ctx.globalThis = ctx;
ctx.window = { addEventListener: () => {}, location: { href: '/' } };
ctx.navigator = { userAgent: 'node' };
ctx.location = { href: '/', pathname: '/index.html' };
vm.createContext(ctx);

const A = process.argv[2];
const DIR = A && !A.endsWith('.js') ? A : '/tmp/servim/servim/static';
const ARG = (f) => require('path').join(DIR, f);
const js = fs.readFileSync(ARG('app.js'), 'utf8');   // исходник — для строковых проверок разметки
(async () => {
  vm.runInContext(js, ctx, { filename: 'app.js' });
  await new Promise(r => setTimeout(r, 120));

  const S2 = (expr) => vm.runInContext(expr, ctx);
  const jobs = FX('jobs', 'FX_JOBS').jobs;
  const done = jobs.find(j => j.status === 'done');
  const run = () => vm.runInContext('(() => { return null })()', ctx);

  const tb = q('#tb').innerHTML;
  const check = (name, cond, extra = '') =>
    console.log((cond ? 'OK   ' : 'ФАЙЛ ') + name + (cond ? '' : '  ' + extra));

  check('таблица отрисована', tb.includes('c-file') && tb.includes('class="pill'), tb.slice(0, 120));
  check('строк == задач', (tb.match(/data-id=/g) || []).length === jobs.length,
    (tb.match(/data-id=/g) || []).length + ' vs ' + jobs.length);
  check('тип — пилюля у каждой задачи', (tb.match(/class="pill /g) || []).length === jobs.length);
  check('длительность', /\d+(\.\d)? с|\d+:\d\d/.test(tb));
  check('спикеры в строке (мета)', tb.includes('class="spk"'));
  // ссылка на скачивание — только у готовых; у готовой — под именем файла
  {
    const ready = jobs.filter(j => j.status === 'done').length;
    const rows = tb.split('<tr').slice(1);
    const withLinks = rows.filter(r => r.includes('result?format=')).length;
    check('ссылки на скачивание есть ровно у готовых (' + ready + ')', withLinks === ready, 'есть ' + withLinks);
    check('мёртвого маршрута /download?fmt= в строках нет', !tb.includes('/download?fmt='));
  }
  check('нет undefined/NaN', !tb.includes('undefined') && !tb.includes('NaN'), /undefined|NaN/.exec(tb)?.[0]);

  // фильтр по пользователю (админ)
  {
    const owners = [...new Set(jobs.map(j => j.owner || ''))];
    check('в фикстуре есть owner у задач', owners.length >= 2, JSON.stringify(owners));
    const o = owners[0];
    vm.runInContext(`S.uFilter = ${JSON.stringify(o)}; render();`, ctx);
    const fo = [...q('#tb').innerHTML.matchAll(/data-owner="([^"]*)"/g)].map(m => m[1]);
    check('фильтр по юзеру: все строки его', fo.length > 0 && fo.every(x => x === o), JSON.stringify(fo));
    vm.runInContext(`S.uFilter = ''; render();`, ctx);
    const all = (q('#tb').innerHTML.match(/data-id=/g) || []).length;
    check('фильтр снят: все строки вернулись', all === jobs.length, String(all));
  }
  check('нет битовой маски статусов', !/&[a-z];/.test(tb), (tb.match(/&[a-z];/g) || []).slice(0, 3).join());

  // очередь загрузки: индикатор в тулбаре + модалка с прогрессом и «убрать»
  {
    vm.runInContext('renderUpl()', ctx);
    check('кнопка «загрузки» скрыта при пустой очереди, в модалке — «очередь пуста»',
      q('#uplb').hidden === true && q('#upllist').innerHTML.includes('очередь пуста'));
    vm.runInContext(`S.upl.push({ name: 'тест.wav', size: 123456, pct: 42, status: 'loading', err: '', x: null, p: Promise.resolve() }); renderUpl();`, ctx);
    const ul = q('#upllist').innerHTML;
    check('кнопка видна, счётчик активных — 1', q('#uplb').hidden === false && q('#uplb .tl').textContent.includes('· 1'), q('#uplb .tl').textContent);
    check('в модалке: файл с прогрессом 42% и статусом «загрузка 42%»',
      /--p:42%/.test(ul) && ul.includes('загрузка 42%'), ul.slice(0, 160));
    check('размер файла виден (КБ/МБ)', /\d+(\.\d+)? (КБ|МБ|Б|ГБ)/.test(ul));
    check('крестик «убрать» есть у строки', ul.includes('class="uplx"'));
    vm.runInContext(`S.upl[0].status = 'done'; renderUpl();`, ctx);
    check('готово — статус меняется, счётчик сбрасывается',
      q('#upllist').innerHTML.includes('готово') && q('#uplb .tl').textContent === 'загрузки',
      q('#uplb .tl').textContent);
    vm.runInContext(`S.upl.push({ name: 'брак.wav', size: 10, pct: 0, status: 'error', err: 'сеть', x: null, p: Promise.resolve() }); renderUpl();`, ctx);
    check('ошибка загрузки видна', q('#upllist').innerHTML.includes('upli bad') && q('#upllist').innerHTML.includes('ошибка: сеть'));
    vm.runInContext('uplOpen(false); S.upl = []; renderUpl();', ctx);
    check('очередь пуста: кнопка скрыта', q('#uplb').hidden === true);
  }

  // спиннер долгих операций
  {
    vm.runInContext(`busy(true, 'тест…')`, ctx);
    check('спиннер включается с текстом', q('#spinmask').hidden === false && q('#spintx').textContent === 'тест…');
    vm.runInContext('busy(false)', ctx);
    check('спиннер выключается', q('#spinmask').hidden === true);
    check('в show() спиннер рисуется в модалке до загрузки',
      js.includes('segload') && js.includes('загружаю результат…'));
  }
  check('строки в порядке очереди (Свежие сверху)', (() => {
    const ids = [...tb.matchAll(/data-id="([^"]+)"/g)].map(m => m[1]);
    const rank = { running: 0, queued: 1, plan: 2, done: 3, error: 3, cancelled: 3 };
    const byId = Object.fromEntries(jobs.map(j => [j.id, j.status]));
    const r = ids.map(i => rank[byId[i] || 'done'] ?? 9);
    return r.every((v, i) => i === 0 || r[i - 1] <= v);
  })(), 'порядок строк не совпадает с порядком очереди');
  check('отмеченная строка подсвечена', (() => {
    vm.runInContext('S.picked = new Set([S.jobs[0].id]); render();', ctx);
    const on = q('#tb').innerHTML.includes('pick');
    vm.runInContext('S.picked.clear(); render();', ctx);
    return on;
  })());
  check('имена не длиннее ~56 знаков', [...tb.matchAll(/<span>([^<]{60,})<\/span>/g)].length === 0);
  check('версия UI показана в панели настроек', (q('#vcopy').textContent || '').includes('UI'), q('#vcopy').textContent);
  check('пилюли скачивания у готовой задачи', q('#tb').innerHTML.includes('class="dl"'));

  // панель результата
  vm.runInContext(`S.openId = ${JSON.stringify(done.id)}; show(S.openId)`, ctx);
  await new Promise(r => setTimeout(r, 150));
  const segs = q('#segs').innerHTML;
  check('модалка результата открыта', q('#mask').hidden === false);
  const want = ((FX('job_done', 'FX_JOB').result || {}).segments || []).length;
  check('сегментов отрисовано столько же, сколько в ответе',
    (segs.match(/class="seg"/g) || []).length === want && want > 0,
    `${(segs.match(/class="seg"/g) || []).length} vs ${want}`);
  check('метка спикера', /class="tag"/.test(segs));
  check('таймкоды', /\d+\.\d\d–\d+\.\d\d с/.test(segs), segs.slice(0, 160));
  // блока по словам в модалке нет (v2.2.6: дублировал текст); слова остаются в json/srt
  check('блока по словам в модалке нет', !segs.includes('class="wts"') && !/\bwords\b/.test(segs), segs.slice(0, 160));
  check('чипы имён спикеров', q('#spk').innerHTML.includes('data-raw='));
  check('кнопка сохранения имён', q('#spk').innerHTML.includes('spksave') || q('#spk').innerHTML.includes('сохранить'));
  check('скачивание — селект + одна кнопка', q('#fmt').innerHTML.includes('<option') &&
        typeof q('#dl').onclick === 'function', q('#fmt').innerHTML.slice(0, 40));
  check('мёртвого /download?fmt= нигде нет', !q('#tb').innerHTML.includes('/download?fmt='));
  check('форматов в списке >= 7 и есть srt', (q('#fmt').innerHTML.match(/<option/g) || []).length >= 7
    && q('#fmt').innerHTML.includes('value="srt"'), String((q('#fmt').innerHTML.match(/<option/g) || []).length));

  // очередь/жизненный цикл
  vm.runInContext('startQueue()', ctx); await new Promise(r => setTimeout(r, 60));
  vm.runInContext('stopAll()', ctx); await new Promise(r => setTimeout(r, 60));
  vm.runInContext(`del(${JSON.stringify(done.id)})`, ctx); await new Promise(r => setTimeout(r, 80));
  check('пауза отправлена', calls.some(c => c.includes('queue/pause')), calls.join(' | '));
  check('старт очереди отправлен', calls.some(c => c.includes('queue/start')));

  // -------------------------------------- отметка, пакетное удаление, приоритет
  vm.runInContext('S.picked = new Set([S.jobs[0].id]); render();', ctx);
  check('«Удалить» активна при отметке', q('#del').disabled === false);
  vm.runInContext(`S.openId = null; hideRes(); render();`, ctx);
  check('счётчик на кнопке', String(q('#ndel').textContent) === '1', String(q('#ndel').textContent));
  vm.runInContext('document.querySelector("#selnone").onclick()', ctx);
  check('«Снять выделение» глушит кнопку', q('#del').disabled === true);
  check('отметка сброшена', S2('S.picked.size') === 0);
  vm.runInContext('document.querySelector("#selpall").onclick()', ctx);
  check('«Выделить все» = все строки', S2('S.picked.size') === jobs.length, String(S2('S.picked.size')));
  check('чекбокс «выделить все» отмечен', q('#all').checked === true);
  vm.runInContext('S.picked.clear(); render();', ctx);
  check('«Удалить» недоступна без отметки', q('#del').disabled === true);

  const delP = vm.runInContext(`del(["${done.id}"])`, ctx);
  await new Promise(r => setTimeout(r, 40));
  check('диалог показан, а не confirm()', q('#askmask').hidden === false &&
        String(q('#askx').textContent).includes('Задача'), q('#askx').textContent);
  q('#askyes').onclick();                            // «Удалить»
  await delP; await new Promise(r => setTimeout(r, 120));
  check('диалог закрыт после ответа', q('#askmask').hidden === true);
  check('DELETE — один запрос со списком id',
    calls.some(c => c.startsWith('DELETE /jobs?ids=')), calls.slice(-3).join(' | '));
  calls = [];
  vm.runInContext(`startQueue()`, ctx); await new Promise(r => setTimeout(r, 80));
  vm.runInContext('S.picked = new Set([S.jobs[0].id]);', ctx);
  await vm.runInContext(`startQueue()`, ctx); await new Promise(r => setTimeout(r, 80));
  check('отмеченные уходят в ?selected=', calls.some(c => c.includes('queue/start?selected=')),
    calls.filter(c => c.includes('queue/start')).join(' | '));
  // ----------------------- клики: одинарный только выделяет, двойной открывает модалку
  vm.runInContext(`S.openId = null; S.sel = ${JSON.stringify(done.id)}; render();`, ctx);
  check('выделение без модалки', q('#mask').hidden === true);
  vm.runInContext(`S.openId = ${JSON.stringify(done.id)}; show(S.openId);`, ctx);
  await new Promise(r => setTimeout(r, 150));
  check('двойной клик открывает модалку', q('#mask').hidden === false);
  // ------- «▶» в колонке статуса у готовой задачи = открыть результат (просил юзер)
  vm.runInContext(`render();`, ctx); await new Promise(r => setTimeout(r, 40));
  const rows = q('#tb').innerHTML;
  check('▶ готовой задачи помечена открывать результат', /class="st done" data-open="1"/.test(rows));
  check('у плановой задачи ▶ результат не открывает', !/class="st (plan|queued|running)"[^>]*data-open/.test(rows));
  check('у готовой задачи ▶ подписана «открыть результат»', /data-open="1"[\s\S]{0,40}title="открыть результат"/.test(rows));
  vm.runInContext(`$('#rclose').onclick();`, ctx);
  check('«закрыть» гасит модалку и состояние',
    q('#mask').hidden === true && vm.runInContext('S.openId', ctx) === null);

  // ------------- состояние панели: «Старт»/«Стоп» должны отвечать на экране
  vm.runInContext(`
    S.queue = { paused: true, busy: null, queued: [], planned: ['x1','x2'] };
    S.health = { busy: null, paused: true, loaded: 'x', vram_reserved_gib: 43.4, model: 'large-v3',
                 vad_filter: true, word_timestamps: true, formats: ['srt'] };
    S.jobs = [{ id:'x1', status:'plan', progress:0, name:'а.ogg', type:'ogg' }];
    render();
    globalThis.ROW_HTML = document.querySelector('#tb').innerHTML;`, ctx);
  check('есть план → «Старт» активен', q('#start').disabled === false);
  check('ничего не идёт → «Стоп» глух', q('#stop').disabled === true);
  vm.runInContext(`
    S.queue = { paused: false, busy: 'x1', queued: ['x2'], planned: [] };
    S.health = Object.assign({}, S.health, { busy: 'x1', paused: false }); render();`, ctx);
  check('что-то идёт → «Стоп» активен', q('#stop').disabled === false);
  {
    const html = String(vm.runInContext('ROW_HTML', ctx));
    const cell = (html.match(/<span class="st plan"[^>]*>([\s\S]{0,400}?)<\/span>/) || [])[1] || '';
    check('у плановой задачи есть статус-иконка', /svg|\S/.test(cell), html.slice(0, 220));
  }
  vm.runInContext(`
    S.queue = { paused: true, busy: null, queued: [], planned: [] };
    S.health = Object.assign({}, S.health, { busy: null });
    S.jobs = []; render();`, ctx);
  check('пусто → обе кнопки глухи', q('#start').disabled === true && q('#stop').disabled === true);


  // ——— скачивание под именем файла и без подписи «N спикеров · M сегм.» ———
  {
    const doneRow = Object.assign({}, done || {}, { id: 'job-done', name: 'job-done.wav', status: 'done', note: null });
    vm.runInContext("S.picked.clear(); S.sel = null; S.jobs = [__doneRow]; render();", Object.assign(ctx, { __doneRow: doneRow }));
    const rowHtml = q("#tb").innerHTML;
    const nLinks = (rowHtml.match(/<a class="dl[ "]/g) || []).length;
    const nf = vm.runInContext('S.formats.length', ctx);
    check('под именем файла — пилюли на все ' + nf + ' форматов (есть ' + nLinks + ')', nLinks === nf && nf > 0);
    check('пилюли ведут на этот же джоб', rowHtml.includes('/jobs/job-done/result?format='));
    check('ссылок на несуществующий /download нет', !rowHtml.includes('/download?fmt='));
    check('пилюли идут после имени файла', rowHtml.indexOf('job-done.wav') < rowHtml.indexOf('result?format='));
    check('ряд пилюль ровно один', (rowHtml.match(/class="dls"/g) || []).length === 1);
  }

})().catch(e => { console.log('ИСКЛЮЧЕНИЕ:', e && e.stack || e); process.exit(1); });
