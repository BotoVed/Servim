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
const EP0 = location.pathname.replace(/\/{2,}/g, '/').replace(/[^/]*$/, '');   // страница с // в адресе не должна ломать запросы
const CFG_KEY = 'servim.cfg';
const cfg = () => { try { return JSON.parse(localStorage.getItem(CFG_KEY) || '{}'); } catch (e) { return {}; } };
const EP = EP0;                     // адрес сервера = адрес этой страницы (поле адреса упразднено)
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

/* плавающий тултип: один на страницу; текст — из data-tip; показ после 1 с удержания */
const tip = document.createElement('div'); tip.className = 'jtip'; tip.hidden = true;
document.body.appendChild(tip);
let hoverEl = null, tipEl = null, tipT = 0;
const tipShow = (el) => { tipEl = el; tip.textContent = el.getAttribute('data-tip'); tip.hidden = false;
  const r = el.getBoundingClientRect(), tr = tip.getBoundingClientRect();
  tip.style.left = Math.max(8, Math.min(r.left + r.width / 2 - tr.width / 2,
    (window.innerWidth || 800) - tr.width - 8)) + 'px';
  let y = r.top - tr.height - 8;            // сначала пробуем над кнопкой
  if (y < 8) y = r.bottom + 8;              // сверху нет места — рисуем под
  tip.style.top = y + 'px'; };
const tipHide = () => { tipEl = null; hoverEl = null; tip.hidden = true; clearTimeout(tipT); };
document.addEventListener('pointerover', (e) => {
  const t = e.target && e.target.closest && e.target.closest('[data-tip]');
  if (!t || e.pointerType === 'touch' || hoverEl === t) return;
  hoverEl = t; clearTimeout(tipT);
  tipT = setTimeout(() => { if (hoverEl === t) tipShow(t); }, 1000);
}, true);
document.addEventListener('pointerout', (e) => {
  const t = e.target && e.target.closest && e.target.closest('[data-tip]');
  if (!t || (e.relatedTarget && t.contains(e.relatedTarget))) return;
  tipHide();
}, true);
document.addEventListener('scroll', tipHide, true);

const DRAFT = {};   // черновики имён спикеров: `${id}|${raw}` -> значение
const LS = 'wx.ui.v3';
const UI_VER = '2.2.5';   // синхронно с ?v= в index.html
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
  details: new Map(), timer: null, formats: EXPORT, uFilter: ''   // фильтр по пользователю (админ)
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
    if (r.status === 401 && !(opt && opt.quiet401)) authNeeded();   // сесси кончилась — просим вход
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

/* ------------------------------------------- пользователи: вход, профиль, админ */
S.user = null;
S.adUsers = [];

function authNeeded() {
  showLogin(S.health.users_ready ? 'login' : 'setup');
}

function showLogin(mode) {
  const m = $('#loginmask'); if (!m) return;
  const setup = mode !== 'login';
  m.hidden = false;
  $('#lt').textContent = setup ? 'Создай первого администратора' : 'Вход';
  $('#lx').textContent = setup
    ? 'Первый запуск: создаём админа. У каждого пользователя свои настройки и своя история.'
    : 'Свой профиль: у каждого пользователя свои настройки и своя история.';
  $('#lpass2f').hidden = !setup;
  $('#lok').textContent = setup ? 'создать и войти' : 'войти';
  $('#lerr').textContent = '';
  const n = $('#lname'); if (n) n.focus();
}

async function doLogin() {
  const setup = !S.health.users_ready;
  const name = $('#lname').value.trim(), pw = $('#lpass').value;
  const err = $('#lerr');
  err.textContent = '';
  if (!name) { err.textContent = 'введи имя'; return; }
  if (setup && pw !== $('#lpass2').value) { err.textContent = 'пароли не совпадают'; return; }
  try {
    const r = await fetch(EP + (setup ? 'setup' : 'login'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, password: pw }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((d && d.detail && d.detail.error && d.detail.error.message) || (r.status + ' ' + r.statusText));
    location.reload();                       // свежая загрузка уже под сессией
  } catch (e) { err.textContent = e.message; }
}

function fillProfile(u) {
  S.user = u;
  const who = $('#who'), un = $('#uname');
  if (who) { who.hidden = false; un.textContent = u.name; }
  const p = $('#prof');
  if (p) {
    p.hidden = false;
    $('#prof_who').innerHTML = `Вы вошли как <b>${esc(u.name)}</b>${u.role === 'admin' ? ' · админ' : ''}`;
    $('#p_key').value = u.key || '';
  }
  const ub = $('#users');
  if (ub) ub.hidden = u.role !== 'admin';
}

function applyServerSettings(st) {
  if (!st || typeof st !== 'object') return;
  try {
    if (st.cfg && typeof st.cfg === 'object') {
      const c = { ...st.cfg }; delete c.url;   // старое поле адреса игнорируем — теперь адрес всегда этой страницы
      localStorage.setItem(CFG_KEY, JSON.stringify({ ...cfg(), ...c }));
    }
    if (st.ui && typeof st.ui === 'object') {
      const cur = JSON.parse(localStorage.getItem(LS) || '{}');
      localStorage.setItem(LS, JSON.stringify({ ...cur, ...st.ui }));
    }
  } catch (e) { /* настройки не критичны, не роняем загрузку */ }
}

function pushUserSettings() {
  if (!S.user) return;
  const ui = (() => { try { return JSON.parse(localStorage.getItem(LS) || '{}'); } catch (e) { return {}; } })();
  api(EP + 'me/settings', { method: 'PUT', quiet401: true,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cfg: cfg(), ui }) }).catch(() => {});
}

async function adminOpen() {
  const m = $('#adminmask'); if (!m) return;
  m.hidden = false;
  await adminReload().catch(e => toast('не вышло: ' + e.message));
  try {
    const s = await api(EP + 'admin/settings', { quiet401: true });
    $('#s_url').value = (s && s.url) || ''; $('#s_port').value = (s && s.port) || '';
  } catch (e) { /* не админ — поля останутся пустыми */ }
}

S.adSel = null;                     // выделенный пользователь в панели «Пользователи»

function adSelRow() { return (S.adUsers || []).find(u => u.id === S.adSel) || null; }

function adBar() {                  // пиктограммы-кнопки активны только при выделенной строке
  const u = adSelRow(), self = u && u.id === (S.user || {}).id;
  const del = $('#addel');
  if (del) { del.disabled = !u || !!self; del.dataset.tip = self ? 'Себя не удалить' : 'Удалить пользователя и его настройки'; }
  const k = $('#adkey'); if (k) k.disabled = !u;
  const p = $('#adpw'); if (p) p.disabled = !u;
}

async function adminReload() {
  const d = await api(EP + 'admin/users');
  S.adUsers = d.users || [];
  if (S.adSel && !S.adUsers.some(u => u.id === S.adSel)) S.adSel = null;
  $('#adtb').innerHTML = S.adUsers.map(u => `<tr data-uid="${esc(u.id)}"${u.id === S.adSel ? ' class="sel"' : ''}>
    <td>${esc(u.name)}${S.user && u.id === S.user.id ? ' <span class="you">это ты</span>' : ''}</td>
    <td><span class="role ${u.role}">${u.role === 'admin' ? 'админ' : 'пользователь'}</span></td>
    <td>${u.created ? new Date(u.created * 1000).toLocaleDateString() : ''}</td></tr>`).join('')
    || '<tr><td colspan="3" class="empty">пусто</td></tr>';
  fillUFilter();
  adBar();
}

/* фильтр заданий по пользователю — выпадающий список в тулбаре, только для админа */
function fillUFilter() {
  const sel = $('#ufilt'); if (!sel) return;
  const users = S.adUsers || [];
  sel.innerHTML = '<option value="">все пользователи</option>' + users.map(u =>
    `<option value="${esc(u.name)}"${u.name === S.uFilter ? ' selected' : ''}>${esc(u.name)}${S.user && u.id === S.user.id ? ' (это ты)' : ''}</option>`).join('');
  if (S.uFilter && !users.some(u => u.name === S.uFilter)) { S.uFilter = ''; sel.value = ''; render(); }
}

async function loadUFilter() {
  try { const d = await api(EP + 'admin/users'); S.adUsers = d.users || []; fillUFilter(); }
  catch (e) { /* не админ или сеть — виджет скрыт */ }
}

function openAdd() {
  const m = $('#addmask'); if (!m) return;
  m.hidden = false;
  $('#adname').value = ''; $('#adpass').value = ''; $('#adrole').value = 'user';
  $('#aderr').textContent = '';
  $('#adname').focus();
}

async function adminAdd() {
  const name = $('#adname').value.trim(), pw = $('#adpass').value, err = $('#aderr');
  err.textContent = '';
  if (!name) { err.textContent = 'введи имя'; return; }
  if (pw.length < 4) { err.textContent = 'пароль — минимум 4 символа'; return; }
  try {
    await api(EP + 'admin/users', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, password: pw, role: $('#adrole').value }) });
    $('#addmask').hidden = true;
    toast('пользователь добавлен'); await adminReload();
  } catch (e) { err.textContent = e.message; }
}

function openPw() {
  const u = adSelRow(); if (!u) return;
  $('#pwx').textContent = `пользователь: ${u.name}`;
  $('#pwpw').value = ''; $('#pwerr').textContent = '';
  $('#pwmask').hidden = false; $('#pwpw').focus();
}

async function pwSave() {
  const u = adSelRow(); if (!u) return;
  const v = $('#pwpw').value;
  if (v.length < 4) { $('#pwerr').textContent = 'пароль — минимум 4 символа'; return; }
  try {
    await api(EP + 'admin/users/' + encodeURIComponent(u.id), { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: v }) });
    $('#pwmask').hidden = true;
    toast('пароль задан: ' + u.name); await adminReload();
  } catch (e) { $('#pwerr').textContent = e.message; }
}

function openKey() {
  const u = adSelRow(); if (!u) return;
  $('#keyx').textContent = `ключ пользователя ${u.name} · клиенты: Authorization: Bearer <ключ>`;
  $('#keyval').value = u.key || '';
  $('#keymask').hidden = false;
  const inp = $('#keyval'); if (inp) inp.select();
}

async function keyCopy() {
  const v = $('#keyval').value;
  try { await navigator.clipboard.writeText(v); toast('API-ключ скопирован'); }
  catch (e) { toast(v); }
}

async function adminDel() {
  const u = adSelRow(); if (!u) return;
  if (u.id === (S.user || {}).id) { toast('себя не удалить'); return; }
  if (!await ask(`Пользователь «${u.name}» будет удалён вместе со своими настройками и ключом.`, 'Удалить')) return;
  try {
    await api(EP + 'admin/users/' + encodeURIComponent(u.id), { method: 'DELETE' });
    S.adSel = null; toast('пользователь удалён'); await adminReload();
  } catch (e) { toast('не вышло: ' + e.message); }
}

async function adminSaveSys() {
  const body = { url: $('#s_url').value.trim() };
  const port = $('#s_port').value.trim();
  if (port) body.port = parseInt(port, 10);
  try {
    await api(EP + 'admin/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body) });
    toast('сохранено; порт и хост применятся при перезапуске сервиса');
  } catch (e) { toast('не вышло: ' + e.message); }
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
  const list = S.uFilter ? S.jobs.filter(j => (j.owner || '') === S.uFilter) : S.jobs;
  if (!S.jobs.length) {
    tb.innerHTML = '<tr><td colspan="2" class="empty">пусто — нажми «Добавить» или перетащи файлы на таблицу</td></tr>';
    S.picked.clear();
  } else if (!list.length) {
    tb.innerHTML = '<tr><td colspan="2" class="empty">у этого пользователя задач нет</td></tr>';
  } else {
    tb.innerHTML = list.map(j => {
      const s = j.summary || {};
      const pct = j.status === 'done' ? 100 : (j.status === 'running' ? (j.progress || 0) : 0);
      const stat = j.status === 'done'
        ? ''
        : j.status === 'running' ? `<span class="st-tx">${Math.round(j.progress || 0)}% · ${esc(j.stage || '')}</span>`
        : j.status === 'error' ? `<span class="st-tx bad">${esc(String(j.error || 'ошибка').slice(0, 80))}</span>`
        : j.status === 'plan' ? (S.queue.paused ? '<span class="st-tx">пауза — нажми «Старт»</span>' : '<span class="st-tx">ждёт очереди</span>')
        : j.status === 'queued' ? '<span class="st-tx">в очереди</span>' : '';
      // предупреждение о результате (файл пропал, 0 сегментов и т.п.) — отдельной строкой под метой
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
      return `<tr data-id="${j.id}" data-owner="${esc(j.owner || '')}" tabindex="0" class="${j.status === 'running' ? 'running' : ''} ${S.sel === j.id ? 'sel' : ''} ${S.picked.has(j.id) ? 'pick' : ''}">
        <td class="c-st"><label class="ck" title="отметить"><input type="checkbox" data-ck="${j.id}" ${S.picked.has(j.id) ? 'checked' : ''} tabindex="-1" aria-label="отметить ${esc(j.name)}"></label>
          <span class="st ${j.status}" ${j.status === 'done' ? 'data-open="1"' : ''}
            title="${j.status === 'done' ? 'открыть результат' : (LABEL[j.status] || j.status)}">${ICON[j.status] || ICON.plan}</span></td>
        <td class="c-file">
          <div class="file" style="--p:${pct}%" title="${esc(j.name)}"><i></i><span>${shortName(j.name)}</span></div>
          <div class="rowmeta">
            ${res}
            <div class="meta"><span class="pill ${j.type || ''}">${esc(j.type || '?')}</span><span class="dur">${fmtDur(j.duration ?? s.duration)}</span><span class="spk">${s.speakers ? `${s.speakers} ${plural(s.speakers, 'спикер', 'спикера', 'спикеров')}` : '—'}</span>${stat}</div>
            ${(j.status === 'done' && j.note) ? `<div class="sub"><span class="note">${esc(String(j.note).slice(0, 90))}</span></div>` : ''}
          </div>
        </td>
      </tr>`;
    }).join('');
  }

  const nd = $('#n_diarize');
  if (nd) { const k = S.jobs.filter(j => (j.summary || {}).speakers).length;
            nd.textContent = k ? k : ''; }
  const n = list.length, run = list.filter(isLive).length;
  const plan = list.filter(j => j.status === 'plan').length, ready = list.filter(j => j.status === 'done').length;
  $('#cnt').textContent = `${n} ${plural(n, 'задача', 'задачи', 'задач')}`;
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
  // модалку не перестраиваем, пока фокус внутри неё: каждые ~1.6 с её
  // пересоздание сносило фокус и набранный текст в полях имён спикеров
  if (S.openId) {
    const ae = document.activeElement;
    if (!(ae && ae.closest && ae.closest('#mask'))) show(S.openId);
  }
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
    m.style.zIndex = 90;                          // поверх любых открытых масок (напр. панели админа)
    m.hidden = false;
    const close = (v) => { m.hidden = true; m.style.zIndex = ''; b.onclick = n.onclick = null; resolve(v); };
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
  const _segs = $('#segs'), _st = _segs.scrollTop;   // позиция скролла переживает перерисовку
  _segs.innerHTML = r.segments.map(s => {
    const k = Math.max(0, Object.keys(raw2).indexOf(s.speaker)) % COL.length;
    const words = (s.words || []).slice(0, 400)
      .map(w => `<b title="${w.start?.toFixed?.(2) ?? ''}–${w.end?.toFixed?.(2) ?? ''}">${esc(w.word)}</b>`).join(' ');
    return `<div class="seg"><div>
        <span class="tag" style="background:${COL[k]};color:${FG[k]}">${esc(who(s.speaker))}</span>
        <div class="meta">${(s.start ?? 0).toFixed(2)}–${(s.end ?? 0).toFixed(2)} с</div></div>
      <div><div class="tx">${esc((s.text || '').trim())}</div>${words ? `<div class="wts">${words}</div>` : ''}</div></div>`;
  }).join('');
  _segs.scrollTop = _st;

  // именованные спикеры: правится здесь и сразу уходит на сервер
  const draftVal = (s) => DRAFT[`${id}|${s.raw}`] ?? (s.name || '');
  const spk = (j.speakers || []).map(s =>
    `<span class="chip"><b style="color:${FG[Math.max(0, (j.speakers || []).indexOf(s)) % FG.length]}">${esc(s.label)}</b>
      <input data-raw="${esc(s.raw)}" value="${esc(draftVal(s))}" placeholder="${esc(s.raw)}" aria-label="имя спикера ${esc(s.label)}"></span>`).join('');
  $('#spk').innerHTML = spk + (spk ? ' <button id="spksave">сохранить имена</button>' : '');
  const save = $('#spksave');
  if (save) save.onclick = async () => {
    const map = {};
    $$('#spk input').forEach(i => { const v = i.value.trim(); if (v) map[i.dataset.raw] = v; });
    try {
      await api(EP + `/jobs/${id}/speakers`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(map) });
      S.details.delete(id);
      Object.keys(DRAFT).forEach(k => { if (k.startsWith(id + '|')) delete DRAFT[k]; });
      toast('имена сохранены — они попадут в srt/vtt/tsv/md');
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
  pushUserSettings();                      // настройки пользователя — тоже на сервер
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
  // черновик имён спикеров: пишем каждое нажатие, чтобы перерисовка не стирала набранное
  $('#spk').addEventListener('input', (e) => {
    const i = e.target; if (!i || !i.dataset || !i.dataset.raw) return;
    if (S.openId) DRAFT[`${S.openId}|${i.dataset.raw}`] = i.value;
  });

  $('#del').onclick = () => del([...S.picked]).catch(e => toast('не вышло: ' + e.message));
  $('#selpall').onclick = () => { S.picked = new Set(S.jobs.map(j => j.id)); render(); };
  $('#selnone').onclick = () => { S.picked.clear(); render(); };
  $('#all').onchange = (e) => { S.picked = e.target.checked ? new Set(S.jobs.map(j => j.id)) : new Set(); render(); };
  $('#ufilt').onchange = (e) => { S.uFilter = e.target.value; S.sel = null; render(); };

  $('#tb').addEventListener('change', (e) => {
    const c = e.target.closest('[data-ck]'); if (!c) return;
    e.stopPropagation();
    c.checked ? S.picked.add(c.dataset.ck) : S.picked.delete(c.dataset.ck);
    render();
  });
  $('#tb').addEventListener('click', (e) => {
    if (e.target.closest('[data-ck]')) return;      // чекбокс не выделяет строку
    const tr = e.target.closest('tr'); if (!tr || !tr.dataset.id) return;
    const now = Date.now();
    if (S.lastClick && S.lastClick.id === tr.dataset.id && now - S.lastClick.t < 500) {
      S.lastClick = null; openRow(tr); return;      // второй клик по той же строке — открыть
    }
    S.lastClick = { id: tr.dataset.id, t: now };
    S.sel = tr.dataset.id; render();               // одинарный клик — только выделение
  });
  const openRow = (tr) => { S.sel = S.openId = tr.dataset.id; render(); show(S.openId); };
  // физический двойной клик ловим сами: после первого клика render() заменяет строки,
  // и браузерный dblclick приходит уже на #tb без .file — и не открывает модалку

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
    if (e.key === 'Escape') {
      for (const id of ['addmask', 'pwmask', 'keymask']) {
        const m = $('#' + id);
        if (m && !m.hidden) { m.hidden = true; return; }
      }
      const adm = $('#adminmask');
      if (adm && !adm.hidden) { adm.hidden = true; return; }
      if (!$('#askmask').hidden) return; S.openId = null; hideRes();
    }
  });

  window.openCfg = function openCfg() {
    const sheet = $('#cfg'); if (!sheet) return;
    sheet.hidden = false;
  };
  (function settings() {
    const sheet = $('#cfg'); if (!sheet) return;
    $$('#cfg select').forEach(sel => sel.onchange = saveStore);   // модель/язык/спикеры помнятся между визитами и на сервере
    $('#gear').onclick = () => { if (sheet.hidden) openCfg(); else sheet.hidden = true; };
    $('#c_ok').onclick = () => { sheet.hidden = true; };
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') sheet.hidden = true; });
  })();

  (function authui() {
    const lok = $('#lok');
    if (lok) {
      lok.onclick = () => doLogin();
      $('#lname').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#lpass').focus(); });
      ['lpass', 'lpass2'].forEach(id => $('#' + id).addEventListener('keydown',
        (e) => { if (e.key === 'Enter') doLogin(); }));
    }
    const who = $('#who');
    if (who) who.onclick = () => openCfg();
    const ub = $('#users');
    if (ub) ub.onclick = () => adminOpen().catch(e => toast('не вышло: ' + e.message));
    $('#adtb').addEventListener('click', (e) => {
      const tr = e.target.closest('tr[data-uid]'); if (!tr) return;
      S.adSel = tr.dataset.uid === S.adSel ? null : tr.dataset.uid;      // повторный клик — снять выделение
      $$('#adtb tr').forEach(r => r.classList.toggle('sel', r.dataset.uid === S.adSel));
      adBar();
    });
    const aa = $('#adadd'); if (aa) aa.onclick = () => openAdd();
    const ak = $('#adkey'); if (ak) ak.onclick = () => openKey();
    const ap = $('#adpw'); if (ap) ap.onclick = () => openPw();
    const ax = $('#addel'); if (ax) ax.onclick = () => adminDel();
    const ao = $('#adok'); if (ao) ao.onclick = () => adminAdd();
    const ac_ = $('#adcancel'); if (ac_) ac_.onclick = () => { $('#addmask').hidden = true; };
    ['adname', 'adpass'].forEach(id => { const el = $('#' + id);
      if (el) el.addEventListener('keydown', (e) => { if (e.key === 'Enter') adminAdd(); }); });
    const pwo = $('#pwok'); if (pwo) pwo.onclick = () => pwSave();
    const pwc = $('#pwcancel'); if (pwc) pwc.onclick = () => { $('#pwmask').hidden = true; };
    const pwpw = $('#pwpw');
    if (pwpw) pwpw.addEventListener('keydown', (e) => { if (e.key === 'Enter') pwSave(); });
    const kcp = $('#keycopy'); if (kcp) kcp.onclick = () => keyCopy();
    const kcl = $('#keyclose'); if (kcl) kcl.onclick = () => { $('#keymask').hidden = true; };
    const sc = $('#adclose');
    if (sc) sc.onclick = () => { $('#adminmask').hidden = true; };
    const ss = $('#s_save');
    if (ss) ss.onclick = () => adminSaveSys();
    const po = $('#p_out');
    if (po) po.onclick = async () => {
      try { await fetch(EP + 'logout', { method: 'POST' }); } catch (e) { /* выходим как есть */ }
      location.reload();
    };
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
    await loadHealth();
  } catch (e) {
    $('#tb').innerHTML = `<tr><td colspan="2" class="empty">сервис недоступен: ${esc(e.message)}`
      + `<br>адрес сервера — адрес этой страницы; снаружи (через прокси) войди на прокси и перезагрузи страницу.`
      + `<br><button class="tbtn" id="retry">повторить</button></td></tr>`;
    const b = $('#retry'); if (b) b.onclick = () => location.reload();
    return;
  }
  // авторизация: setup при первом запуске, вход — после него
  if (!S.health.users_ready) { showLogin('setup'); return; }
  let me = null;
  try { me = await api(EP + 'me', { quiet401: true }); } catch (e) { me = null; }
  if (!me || !me.user) { showLogin('login'); return; }
  applyServerSettings(me.settings);
  fillProfile(me.user);
  if (me.user.role === 'admin') { $('#ufiltw').hidden = false; loadUFilter(); }
  restore();                    // флаги/модель могли приехать с сервера
  try {
    await Promise.all([loadModels(), loadQueue()]);
    await loadJobs();
    if (matchMedia('(hover:none)').matches) $('#mh').style.display = '';
    if (S.jobs.some(isLive) || S.health.busy) poll(); else render();
  } catch (e) {
    $('#tb').innerHTML = `<tr><td colspan="2" class="empty">сервис недоступен: ${esc(e.message)}`
      + `<br>адрес сервера — адрес этой страницы; снаружи (через прокси) войди на прокси и перезагрузи страницу.`
      + `<br><button class="tbtn" id="retry">повторить</button></td></tr>`;
    const b = $('#retry'); if (b) b.onclick = () => location.reload();
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { Promise.all([loadJobs(), loadQueue()]).then(render); poll(); } });
window.addEventListener('focus', () => Promise.all([loadJobs(), loadQueue()]).then(render));
})();
