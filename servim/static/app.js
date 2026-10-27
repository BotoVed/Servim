/* WhisperX · таблица задач.
   Только реальные ответы сервиса (проверено probe_shape.py):
     GET    /health                 -> {status,model,paused,queue,busy,formats,vram,...}
     GET    /v1/models              -> {data:[{id,downloaded,...}]}
     GET    /jobs?limit=N           -> {count,jobs:[{id,name,type,duration,status,progress,stage,
                                        finished,options,summary:{segments,speakers,language,speed,...}}]}
     GET    /jobs/{id}              -> + result{segments,speaker_names,...} + speakers:[{label,raw,name}]
     POST   /jobs (multipart,start=false) -> {job_id,status:"plan"}
     POST   /jobs/{id}/stop         -> {action}
     DELETE /jobs/{id}              -> 204
     POST   /queue/start|/queue/pause, GET /queue
*/
'use strict';

// база относительно документа: работает и с localhost, и за прокси с путём
const EP0 = location.pathname.replace(/[^/]*$/, '');
const CFG_KEY = 'servim.cfg';
const cfg = () => { try { return JSON.parse(localStorage.getItem(CFG_KEY) || '{}'); } catch (e) { return {}; } };
let EP = EP0;                       // подменяется настройкой «адрес сервера»
const authHeaders = () => { const c = cfg(); const h = {};
  if (c.key) h.Authorization = 'Bearer ' + c.key; return h; };
const _q = (s, r) => r.querySelector(s);
const _nowhere = () => { const e = document.createElement('i'); e.dataset.nowhere = '1'; return e; };
const _lack = new Set();
/* Если узла нет в разметке — возвращаем пустышку, а не null: иначе одно пропущенное
   id обрывало wire()/render() и страница зависала на «загрузка…» без единой ошибки. */
const $ = (s, r = document) => {
  const el = _q(s, r);
  if (el) return el;
  if (r === document && !_lack.has(s)) {
    _lack.add(s);
    console.warn('нет элемента ' + s + ' — страница старше, чем скрипт');
    try { toast('на странице нет ' + s + ' — обнови вкладку (Ctrl+Shift+R)'); } catch (e) {}
  }
  return _nowhere();
};
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const LS = 'wx.ui.v3';
const UI_VER = '1.7.1';   // синхронно с ?v= в index.html
const FMT_DEFAULT = ['json', 'txt', 'srt', 'vtt', 'tsv', 'md', 'keywords', 'summary'];
const dlUrl = (id, f) => `${EP}jobs/${id}/result?format=${f}`;
const fmts = () => (S.formats && S.formats.length) ? S.formats : FMT_DEFAULT;
const ICON = {
  plan: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 3h12M6 21h12M8 3v4l4 4 4-4V3M8 21v-4l4-4 4 4v4"/></svg>',
  queued: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/></svg>',
  loading: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 3v4M12 17v4M3 12h4M17 12h4"/></svg>',
  running: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15l13-7.5z"/></svg>',
  done: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v13M5.5 11.5 12 18l6.5-6.5"/></svg>',
  error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 7v6M12 17h.01"/><circle cx="12" cy="12" r="9"/></svg>',
  dl: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>'
};
const EXPORT = ['srt', 'vtt', 'txt', 'tsv', 'md', 'stxt', 'json'];
const LABEL = { plan: 'запланировано', queued: 'в очереди', loading: 'загрузка модели',
  running: 'в обработке', done: 'готово', error: 'ошибка' };

const S = {
  picked: new Set(),          // отмеченные чекбоксами задачи
  jobs: [], health: {}, queue: { paused: false }, sel: null, pinned: null, hover: null, openId: null,
  details: new Map(), timer: null, formats: EXPORT
};

/* ------------------------------------------------------------------- утилиты */
async function api(path, opt) {
  const r = await fetch(path, opt);
  if (!r.ok) {
    let msg = r.status + ' ' + r.statusText;
    try {
      const j = await r.json();
      msg = j?.detail?.error?.message || (typeof j?.detail === 'string' ? j.detail : msg);
    } catch (e) { /* не JSON — оставляем код */ }
    throw new Error(msg);
  }
  return r.status === 204 ? null : r.json();
}
let toast_t = null;
function toast(msg) {
  let el = $('#toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; el.className = 'toast'; document.body.appendChild(el); }
  el.textContent = msg; el.classList.add('on');
  clearTimeout(toast_t); toast_t = setTimeout(() => el.classList.remove('on'), 3200);
}
const plural = (n, a, b, c) => { const m = n % 100, k = n % 10; return (m > 4 && m < 21) ? c : (k === 1 ? a : (k > 1 && k < 5 ? b : c)); };
function fmtDur(d) {
  if (d == null) return '—';
  d = Math.round(d);
  if (d < 100) return (Math.round(d * 10) / 10) + ' с';
  const h = Math.floor(d / 3600), m = Math.floor(d % 3600 / 60), s = d % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
/* имя файла: не больше 50 знаков целиком, расширение (уже проверенное) — целиком и без обрезки */
function shortName(name, max = 50) {
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 && name.length - dot <= 6 ? name.slice(dot) : '';
  const base = dot > 0 ? name.slice(0, dot) : name;
  if (name.length <= max) return esc(base) + (ext ? '<em>' + esc(ext) + '</em>' : '');
  const keep = Math.max(8, max - 1 - ext.length);
  return esc(base.slice(0, keep) + '…') + (ext ? '<em>' + esc(ext) + '</em>' : '');
}
const fmtMB = (b) => b == null ? '' : (b / 1048576).toFixed(1) + ' МБ';

/* --------------------------------------------------------------------- загрузка */
async function loadHealth() {
  S.health = await api(EP + 'health');
  S.formats = (S.health.formats || []).filter(f => EXPORT.includes(f));
  const ok = S.health.status === 'ready';
  const lamp = $('#lamp');
  lamp.className = S.health.busy ? 'busy' : (ok ? 'ok' : (S.health.error ? 'bad' : ''));
  const _v = $('#vcopy'); if (_v) _v.textContent = 'UI ' + UI_VER + (S.health.version ? ' · сервер v' + S.health.version : '');
}
async function loadModels() {
  const m = await api(EP + 'v1/models');
  const sel = $('#model');
  const saved = store().model;
  sel.innerHTML = (m.data || []).map(x => `<option value="${esc(x.id)}">${esc(x.id)}</option>`).join('');
  if (saved && [...sel.options].some(o => o.value === saved)) sel.value = saved;
  mirror();
}
async function loadJobs() {
  const d = await api(EP + 'jobs?limit=60');
  S.jobs = d.jobs || [];
  render();
}
async function loadQueue() {
  try { S.queue = await api(EP + 'queue'); } catch (e) { S.queue = { paused: false }; }
}
async function detail(id) {
  if (S.details.has(id)) return S.details.get(id);
  const j = await api(EP + 'jobs/' + id);
  S.details.set(id, j);
  return j;
}

/* ------------------------------------------------------------------ отрисовка */
function isLive(j) { return ['queued', 'running', 'loading'].includes(j.status); }
function render() {
  const tb = $('#tb');
  if (!S.jobs.length) {
    tb.innerHTML = '<tr><td colspan="6" class="empty">пусто — нажми «Добавить» или перетащи файлы на таблицу</td></tr>';
    S.picked.clear();
  } else {
    tb.innerHTML = S.jobs.map(j => {
      const s = j.summary || {};
      const pct = j.status === 'done' ? 100 : (j.status === 'running' ? (j.progress || 0) : 0);
      const info = j.status === 'done'
        ? (j.note ? `<span class="note">${esc(String(j.note).slice(0, 90))}</span>` : '')
        : j.status === 'running' ? `${Math.round(j.progress || 0)}% · ${esc(j.stage || '')}`
        : j.status === 'error' ? `<span style="color:var(--err)">${esc(String(j.error || 'ошибка').slice(0, 80))}</span>`
        : j.status === 'plan' ? (S.queue.paused ? '<span class="paused">пауза — нажми «Старт»</span>' : 'ждёт очереди')
        : j.status === 'queued' ? 'в очереди' : '';
      // скачивание — пилюлями под именем файла; пока результата нет — плейсхолдер тем же стилем
      const F = fmts();
      const GLYPH = { json: '{}', txt: 'A', srt: 'CC', vtt: 'CC', tsv: '#', md: 'M',
        stxt: 'S', keywords: 'K', summary: '\u00b6', audio: '\u266B' };
      const TIP = { json: 'полный JSON', txt: 'текст без разметки', srt: 'субтитры SRT',
        vtt: 'субтитры WebVTT', tsv: 'таблица TSV', md: 'Markdown', stxt: 'Super TXT',
        keywords: 'ключевые слова', summary: 'выжимка' };
      const dls = (S.formats && S.formats.length ? S.formats : ['stxt', 'md', 'vtt', 'srt', 'txt', 'json', 'tsv', 'diarized_json'])
        .filter(f => EXPORT.includes(f));
      const pill = (f, hide) => `<a class="dl${hide ? ' dlx' : ''}" href="${dlUrl(j.id, f)}" data-tip="скачать .${f}">${f}</a>`;
      const res = j.status === 'done'
        ? `<div class="dls">${dls.map(f => pill(f, 0)).join('')}</div>`
        : `<div class="dls"><span class="dl ph" data-tip="${j.status === 'error' ? 'ошибка обработки — запусти заново'
            : isLive(j) ? 'появится, когда закончится обработка' : 'запусти обработку — и здесь появятся файлы'}">…</span></div>`;
      return `<tr data-id="${j.id}" tabindex="0" class="${j.status === 'running' ? 'running' : ''} ${S.sel === j.id ? 'sel' : ''} ${S.picked.has(j.id) ? 'pick' : ''}">
        <td class="c-st"><label class="ck" title="отметить"><input type="checkbox" data-ck="${j.id}" ${S.picked.has(j.id) ? 'checked' : ''} tabindex="-1" aria-label="отметить ${esc(j.name)}"></label>
          <span class="st ${j.status}" ${j.status === 'done' ? 'data-open="1"' : ''}
            title="${j.status === 'done' ? 'открыть результат' : (LABEL[j.status] || j.status)}">${ICON[j.status] || ICON.plan}</span></td>
        <td class="c-file">
          <div class="file" style="--p:${pct}%" title="${esc(j.name)}"><i></i><span>${shortName(j.name)}</span></div>
          <div class="rowmeta">
            ${info ? `<div class="sub">${info}</div>` : ''}
            <div class="meta"><span class="dur">${fmtDur(j.duration ?? s.duration)}</span><span class="pill ${j.type || ''}">${esc(j.type || '?')}</span></div>
          </div>
          ${res}
        </td>
        <td class="c-spk"><span class="spk-n ${s.speakers ? '' : 'zero'}">${s.speakers || '—'}</span></td>
      </tr>`;
    }).join('');
  }

  const nd = $('#n_diarize');
  if (nd) { const k = S.jobs.filter(j => (j.summary || {}).speakers).length;
            nd.textContent = k ? k : ''; }
  const n = S.jobs.length, run = S.jobs.filter(isLive).length;
  const plan = S.jobs.filter(j => j.status === 'plan').length, ready = S.jobs.filter(j => j.status === 'done').length;
  $('#cnt').textContent = `${n} · ${plural(n, 'задача', 'задачи', 'задач')}`;
  // «Старт» нужен, пока есть незапущенные задачи или очередь на паузе; «Стоп» — пока что-то
  // идёт или ждёт своей очереди.
  $('#ndel').textContent = S.picked.size ? S.picked.size : '';
  $('#del').disabled = !S.picked.size;
  $('#selpall').disabled = !n;
  $('#selnone').disabled = !S.picked.size;
  const all = $('#all');
  if (all) { all.checked = n > 0 && S.picked.size >= n; all.disabled = !n;
             all.indeterminate = S.picked.size > 0 && S.picked.size < n; }
  const ed = $('#edit');
  ed.disabled = !(S.sel && (S.jobs.find(j => j.id === S.sel) || {}).status === 'done');
  ed.dataset.tip = ed.disabled ? 'сначала выбери готовую задачу (клик по строке)' : 'открыть результат выбранной задачи';
  const inFlight = (S.queue.queued || []).length;
  $('#start').disabled = !(plan > 0 || inFlight > 0);
  $('#stop').disabled = !(S.health.busy || inFlight > 0);
  $('#lamp').className = S.health.busy ? 'busy' : (S.health.status === 'ready' ? 'ok' : (S.health.error ? 'bad' : ''));
  if (S.openId) show(S.openId);
}

function openRes() { $('#mask').hidden = false; }
function hideRes() { $('#mask').hidden = true; }

/* свой диалог подтверждения: window.confirm в части браузеров и встроенных окон молча
   возвращает false — жмёшь «Удалить» и ничего не происходит */
function ask(text, yes = 'Удалить') {
  return new Promise((resolve) => {
    const m = $('#askmask'), b = $('#askyes'), n = $('#askno');
    $('#askx').textContent = text;
    $('#askt').textContent = yes === 'Удалить' ? 'Удалить?' : yes;
    m.hidden = false;
    const close = (v) => { m.hidden = true; b.onclick = n.onclick = null; resolve(v); };
    b.onclick = () => close(true); n.onclick = () => close(false);
  });
}

async function show(id) {
  const j = await detail(id);
  if (S.openId !== id) return;                     // пока ждали ответ, открыли другую строку
  const done = j.status === 'done' && !!((j.result || {}).segments || []).length;
  openRes();
  if (!done) { $('#rm').textContent = ''; $('#spk').innerHTML = ''; $('#fmt').innerHTML = '';
    $('#segs').innerHTML = `<p class="none">${esc(LABEL[j.status] || j.status)}</p>`; return; }
  const r = j.result;
  $('#rt').textContent = 'Результат · ' + (j.name.length > 54 ? j.name.slice(0, 54) + '…' : j.name);
  $('#rm').textContent = `${r.segments.length} сегм. · ${r.num_speakers || (j.speakers || []).length || 1} спик. · ${fmtDur(r.audio_duration || j.duration)}` +
    (r.language ? ` · ${r.language}` : '');

  const raw2 = {};
  (j.speakers || []).forEach(s => { raw2[s.raw] = s; });
  const COL = ['rgba(34,224,208,.18)', 'rgba(52,211,153,.18)', 'rgba(167,139,250,.18)',
    'rgba(232,121,249,.18)', 'rgba(251,191,36,.18)', 'rgba(94,234,212,.18)'];
  const FG = ['#5eead4', '#7ee2a0', '#d8b4fe', '#f9a8d4', '#fcd34d', '#7dd3fc'];
  const who = (raw) => { const s = raw2[raw]; return s ? (s.name || s.label) : (raw || '—'); };

  const FMT = (S.formats && S.formats.length) ? S.formats
    : ['srt', 'vtt', 'stxt', 'ass', 'json', 'verbose_json', 'diarized_json', 'text', 'txt', 'tsv', 'md'];
  $('#fmt').innerHTML = fmts().map(f => `<option value="${f}">.${f}</option>`).join('');
  $('#fmt').value = localStorage.getItem(LS + '.fmt') || 'srt';
  $('#dl').onclick = () => {
    localStorage.setItem(LS + '.fmt', $('#fmt').value);
    location.href = dlUrl(id, $('#fmt') ? $('#fmt').value : 'srt');
  };
  $('#segs').innerHTML = r.segments.map(s => {
    const k = Math.max(0, Object.keys(raw2).indexOf(s.speaker)) % COL.length;
    const words = (s.words || []).slice(0, 400)
      .map(w => `<b title="${w.start?.toFixed?.(2) ?? ''}–${w.end?.toFixed?.(2) ?? ''}">${esc(w.word)}</b>`).join(' ');
    return `<div class="seg"><div>
        <span class="tag" style="background:${COL[k]};color:${FG[k]}">${esc(who(s.speaker))}</span>
        <div class="meta">${(s.start ?? 0).toFixed(2)}–${(s.end ?? 0).toFixed(2)} с</div></div>
      <div><div class="tx">${esc((s.text || '').trim())}</div>${words ? `<div class="meta" style="margin-top:4px">${words}</div>` : ''}</div></div>`;
  }).join('');

  // именованные спикеры: правится здесь и сразу уходит на сервер
  const spk = (j.speakers || []).map(s =>
    `<span class="chip"><b style="color:${FG[Math.max(0, (j.speakers || []).indexOf(s)) % FG.length]}">${esc(s.label)}</b>
      <input data-raw="${esc(s.raw)}" value="${esc(s.name || '')}" placeholder="${esc(s.raw)}" aria-label="имя спикера ${esc(s.label)}"></span>`).join('');
  $('#spk').innerHTML = spk + (spk ? ' <button id="spksave">сохранить имена</button>' : '');
  const save = $('#spksave');
  if (save) save.onclick = async () => {
    const map = {};
    $$('#spk input').forEach(i => { const v = i.value.trim(); if (v) map[i.dataset.raw] = v; });
    try {
      await api(EP + `/jobs/${id}/speakers`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(map) });
      S.details.delete(id); toast('имена сохранены — они попадут в srt/vtt/tsv/md');
      await show(id);
    } catch (e) { toast('не сохранить: ' + e.message); }
  };
}

/* ------------------------------------------------------------------- действия */
async function addFiles(files) {
  const list = [...files].filter(f => f && f.size);
  if (!list.length) return;
  const f = store();
  let added = 0;
  for (const file of list) {
    const fd = new FormData();
    fd.append('file', file, file.name);
    fd.append('model', $('#model').value || 'whisper-1');
    if ($('#lang').value) fd.append('language', $('#lang').value);
    fd.append('diarize', String(f.diarize));
    fd.append('vad_filter', String(f.vad_filter));
    fd.append('word_timestamps', String(f.word_timestamps));
    fd.append('max_speakers', ($('#maxs').value.match(/\d+/) || [8])[0]);
    fd.append('start', 'false');               // в очередь, не сразу: решает кнопка «Старт»
    try { await api(EP + 'jobs', { method: 'POST', body: fd }); added++; }
    catch (e) { toast(`${file.name}: ${e.message}`); }
  }
  S.details.clear();
  await loadJobs();
  toast(`в очереди ${added} ${plural(added, 'файл', 'файла', 'файлов')} — нажми «Старт»`);
}
async function del(ids) {
  const arr = (Array.isArray(ids) ? ids : [ids]).filter(Boolean);
  if (!arr.length) return;
  const names = arr.map(id => (S.jobs.find(x => x.id === id) || {}).name).filter(Boolean);
  const q = arr.length === 1 ? `Задача «${names[0] || ''}» и все её файлы будут удалены.`
    : `Будет удалено задач: ${arr.length} — вместе с файлами результатов.`;
  if (!await ask(q)) return;                                // удаление — только с подтверждением
  let r;
  try {
    r = await api(EP + 'jobs?ids=' + arr.join(','), { method: 'DELETE' });
  } catch (e) { return toast('не вышло: ' + e.message); }
  if (!r || !r.count) return toast('сервер не удалил ни одной задачи');
  arr.forEach(id => { S.picked.delete(id); S.details.delete(id);
    if (S.sel === id) S.sel = null;
    if (S.openId === id) { S.openId = null; hideRes(); } });
  await loadJobs();
  toast(r.count === 1 ? 'задача удалена' : `удалено: ${r.count}`);
}

async function startQueue() {
  // отмеченные уходят в очередь первыми
  const sel = [...S.picked].length ? '?selected=' + [...S.picked].join(',') : '';
  await api(EP + 'queue/start' + sel, { method: 'POST' });
  await Promise.all([loadJobs(), loadQueue()]); render();  // не ждём первого тика
  await loadQueue(); render(); poll();
}
async function stopAll() {
  const r = await api(EP + 'queue/pause?pause_current=true', { method: 'POST' });
  await loadQueue(); render();
  toast(r && r.stopped ? 'очередь на паузе, текущая задача остановлена' : 'очередь на паузе');
}

/* ------------------------------------------------------------------- состояния */
function store() {
  const d = JSON.parse(localStorage.getItem(LS) || '{}');
  return { diarize: d.diarize ?? true, vad_filter: d.vad_filter ?? true,
    word_timestamps: d.word_timestamps ?? true, model: d.model };
}
function saveStore() {
  const d = {};
  $$('[data-flag]').forEach(b => d[b.dataset.flag] = b.getAttribute('aria-pressed') === 'true');
  d.model = $('#model').value;
  localStorage.setItem(LS, JSON.stringify(d));
}
function restore() {
  const d = store();
  $$('[data-flag]').forEach(b => b.setAttribute('aria-pressed', String(!!d[b.dataset.flag])));
}
/* мобильные зеркала убраны: модель/язык/спикеры живут в окне настроек */
function mirror() {}

/* --------------------------------------------------------------------- поллинг */
let UI_STAMP = null;
async function checkUi() {          // вкладка обязана сама обновиться после деплоя
  try {
    const h = await (await fetch(`${EP}health`)).json();
    if (UI_STAMP === null) { UI_STAMP = h.ui_stamp ?? 0; return; }
    if (h.ui_stamp && h.ui_stamp !== UI_STAMP) location.reload();
  } catch { /* сервер ещё не поднялся */ }
}

function poll() {
  // Таймер НЕ самоубивается: раньше он гасился на первом же тике, пока задача ещё
  // не перешла в running, — и страница молчала до перезагрузки (F5).
  clearInterval(S.timer);
  S.timer = setInterval(async () => {
    if ((S.ck = (S.ck || 0) + 1) % 10 === 0) checkUi();   // раз в ~25 с: не устарела ли вкладка
    if (document.hidden) return;          // в фоновой вкладке не крутим, вернёмся на focus/visibility
    await loadJobs();
    await loadHealth();
    await loadQueue();
    render();
  }, 1600);
}

/* ---------------------------------------------------------------------- события */
function wire() {
  $('#add').onclick = () => $('#f').click();
  $('#f').onchange = (e) => { addFiles(e.target.files); e.target.value = ''; };
  $('#start').onclick = () => startQueue().catch(e => toast(e.message));
  $('#stop').onclick = () => stopAll().catch(e => toast(e.message));
  $$('[data-flag]').forEach(b => b.onclick = () => {
    b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true'));
    saveStore();
  });
  $('#model').onchange = saveStore;
  $('#rclose').onclick = () => { S.openId = null; hideRes(); };
  $('#mask').onclick = (e) => { if (e.target.id === 'mask') { S.openId = null; hideRes(); } };

  $('#del').onclick = () => del([...S.picked]).catch(e => toast('не вышло: ' + e.message));
  $('#selpall').onclick = () => { S.picked = new Set(S.jobs.map(j => j.id)); render(); };
  $('#selnone').onclick = () => { S.picked.clear(); render(); };
  $('#all').onchange = (e) => { S.picked = e.target.checked ? new Set(S.jobs.map(j => j.id)) : new Set(); render(); };

  $('#tb').addEventListener('change', (e) => {
    const c = e.target.closest('[data-ck]'); if (!c) return;
    e.stopPropagation();
    c.checked ? S.picked.add(c.dataset.ck) : S.picked.delete(c.dataset.ck);
    render();
  });
  $('#tb').addEventListener('click', (e) => {
    if (e.target.closest('[data-ck]')) return;      // чекбокс не выделяет строку
    const tr = e.target.closest('tr'); if (!tr || !tr.dataset.id) return;
    S.sel = tr.dataset.id; render();               // одинарный клик — только выделение
  });
  const openRow = (tr) => { S.sel = S.openId = tr.dataset.id; render(); show(S.openId); };

  const reload = () => { loadHealth().then(() => loadJobs()).catch(() => {}); };
  $('#edit').onclick = () => {
    const j = S.jobs.find(x => x.id === S.sel);
    if (!j) return toast('сначала выбери задачу — клик по строке');
    if (j.status !== 'done') return toast('результата ещё нет — запусти обработку');
    S.openId = j.id; render(); show(j.id);
  };
  $('#tb').addEventListener('dblclick' , (e) => {   // двойной по НАЗВАНИЮ — открыть результат
    const tr = e.target.closest('tr'); if (!tr || !tr.dataset.id) return;
    if (!e.target.closest('.file')) return;         // по пилюлям и прочему — не открываем
    openRow(tr);
  });
  $('#tb').addEventListener('click', (e) => {      // кнопка в колонке «Результат» — то же
    const tr = e.target.closest('tr'); if (!tr || !tr.dataset.id) return;
    if (!e.target.closest('[data-open]')) return;
    e.stopPropagation(); openRow(tr);
  });
  $('#tb').addEventListener('keydown', (e) => {
    const tr = e.target.closest('tr'); if (!tr) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); S.sel = S.openId = tr.dataset.id; render(); show(S.openId); }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Delete' && S.sel && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) del(S.sel);
    if (e.key === 'Escape') { if (!$('#askmask').hidden) return; S.openId = null; hideRes(); }
  });

  window.openCfg = function openCfg(why) {
    const sheet = $('#cfg'); if (!sheet) return;
    sheet.hidden = false;
    const w = $('#cfgwhy');
    if (w) w.textContent = why ? '⚠ ' + why + '. Адрес сервера — первой строкой; значения хранятся только в этом браузере.'
      : 'Адрес применяется сразу, остальное — когда сервер начнёт их требовать. Значения хранятся только в этом браузере.';
    const f = $('#c_url'); if (f && why) f.focus();
  };
  (function settings() {
    const sheet = $('#cfg'); if (!sheet) return;
    const fields = { url: $('#c_url'), key: $('#c_key'), user: $('#c_user'), tok: $('#c_tok') };
    const show = () => { const c = cfg(); Object.keys(fields).forEach(k => { if (fields[k]) fields[k].value = c[k] || ''; }); };
    const save = () => { const c = {}; Object.keys(fields).forEach(k => { if (fields[k] && fields[k].value) c[k] = fields[k].value.trim(); });
      localStorage.setItem(CFG_KEY, JSON.stringify(c));
      const u = (c.url || '').trim().replace(/\/+$/, ''); EP = u ? u + '/' : EP0;
      saveStore();   // модель/язык/спикеры помнятся между визитами
      $$('#cfg select').forEach(sel => sel.onchange = save); };
    Object.values(fields).forEach(el => el && el.addEventListener('change', save));
    $('#gear').onclick = () => { show(); if (sheet.hidden) openCfg(); else sheet.hidden = true; };
    $('#c_ok').onclick = () => { save(); sheet.hidden = true; reload(); };
    $('#c_reset').onclick = () => { fields.url.value = ''; save(); reload(); };
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') sheet.hidden = true; });
    show();
    const u = (cfg().url || '').trim().replace(/\/+$/, '');
    if (u) EP = u + '/';
  })();

  const tw = $('#tw');
  ['dragenter', 'dragover'].forEach(ev => tw.addEventListener(ev, (e) => { e.preventDefault(); tw.classList.add('drop'); }));
  ['dragleave', 'drop'].forEach(ev => tw.addEventListener(ev, (e) => { e.preventDefault(); tw.classList.remove('drop'); }));
  tw.addEventListener('drop', (e) => addFiles(e.dataTransfer.files));

  // долгое нажатие на телефоне = удалить
  let lp = null;
  $('#tb').addEventListener('touchstart', (e) => {
    const tr = e.target.closest('tr'); if (!tr || !tr.dataset.id) return;
    lp = setTimeout(() => { S.sel = S.openId = tr.dataset.id; render(); show(S.openId); }, 600);
  }, { passive: true });
  ['touchend', 'touchmove', 'touchcancel'].forEach(ev =>
    $('#tb').addEventListener(ev, () => clearTimeout(lp), { passive: true }));
}

/* ------------------------------------------------------------------------- старт */
(async function boot() {
  restore(); wire();
  try {
    await Promise.all([loadHealth(), loadModels(), loadQueue()]);
    await loadJobs();
    if (matchMedia('(hover:none)').matches) $('#mh').style.display = '';
    if (S.jobs.some(isLive) || S.health.busy) poll(); else render();
  } catch (e) {
    $('#tb').innerHTML = `<tr><td colspan="4" class="empty">сервис недоступен: ${esc(e.message)}`
      + `<br><button class="tbtn" id="cfgopen">открыть настройки</button> — проверь адрес сервера</td></tr>`;
    const b = $('#cfgopen'); if (b) b.onclick = () => openCfg('сервер не отвечает — проверь адрес');
    openCfg('сервер не отвечает: ' + e.message);   // пустой экран без объяснений — худший вариант
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { Promise.all([loadJobs(), loadQueue()]).then(render); poll(); } });
window.addEventListener('focus', () => Promise.all([loadJobs(), loadQueue()]).then(render));
})();
