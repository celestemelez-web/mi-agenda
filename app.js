import { WEEK_START } from './config.js';
import * as store from './store.js';
import * as g from './google.js';

const VIEWS = { day: 'Día', week: 'Semana', month: 'Mes', diary: 'Diario' };

// ---------- utilidades ----------

const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const lsGet = k => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };

const pad = n => String(n).padStart(2, '0');
const dkey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fromKey = k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const today = () => startOfDay(new Date());
const sameDay = (a, b) => dkey(a) === dkey(b);
const startOfWeek = d => addDays(startOfDay(d), -((d.getDay() - WEEK_START + 7) % 7));
const hm = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const hms = d => `${hm(d)}:${pad(d.getSeconds())}`;
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const fmt = opts => new Intl.DateTimeFormat('es-AR', opts);
const fLong = fmt({ weekday: 'long', day: 'numeric', month: 'long' });
const fLongYear = fmt({ weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const fMonthYear = fmt({ month: 'long', year: 'numeric' });
const fMonthName = fmt({ month: 'long' });
const fMonShort = fmt({ month: 'short' });
const fWeekday = fmt({ weekday: 'short' });
const fShort = d => `${d.getDate()}/${d.getMonth() + 1}`;

// ---------- estado ----------

const state = {
  view: VIEWS[lsGet('agenda.view')] ? lsGet('agenda.view') : 'day',
  cursor: today(),
  events: [],
  eventsKey: '',
  eventsAt: 0,
  loading: false,
  editing: null, // id de la nota que se está editando
  query: '',     // búsqueda en la vista Diario
};
let loadSeq = 0;
let lastToday = dkey(today());

function monthGrid(d) {
  const first = new Date(d.getFullYear(), d.getMonth(), 1);
  const start = startOfWeek(first);
  const offset = (first.getDay() - WEEK_START + 7) % 7;
  const daysInMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  return { start, weeks: Math.ceil((offset + daysInMonth) / 7) };
}

function viewRange() {
  if (state.view === 'day') return [state.cursor, addDays(state.cursor, 1)];
  if (state.view === 'week') { const s = startOfWeek(state.cursor); return [s, addDays(s, 7)]; }
  const { start, weeks } = monthGrid(state.cursor);
  return [start, addDays(start, weeks * 7)];
}

function eventsOn(day) {
  const end = addDays(day, 1);
  return state.events.filter(e => e.start < end && (e.end > day || +e.start === +e.end && e.start >= day));
}

// ---------- render ----------

const app = $('#app');
app.innerHTML = '<div id="r-head"></div><div id="r-banner"></div><main id="r-main"></main>';
let skeleton = '';
const cache = {};

function render() {
  patch('r-head', headerHTML());
  patch('r-banner', bannerHTML());
  if (skeleton !== state.view) {
    skeleton = state.view;
    for (const k of Object.keys(cache)) if (k !== 'r-head' && k !== 'r-banner') delete cache[k];
    const main = $('#r-main');
    main.className = `view-${state.view} animating`;
    setTimeout(() => main.classList.remove('animating'), 800);
    main.innerHTML = state.view === 'day'
      ? `<div id="r-hero"></div><div class="day-layout">
          <div class="col"><div id="r-events" class="slot-events"></div><div id="r-tasks" class="slot-tasks"></div></div>
          <div class="col"><div id="r-diary" class="slot-diary"></div></div>
        </div>`
      : state.view === 'diary'
        ? `<div class="diary-view">
            <div class="search-bar"><span aria-hidden="true">🔍</span>
              <input id="q" data-keep="1" data-input="query" type="search" value="${esc(state.query)}" placeholder="Buscar en todas mis notas…" aria-label="Buscar en el diario" autocomplete="off">
              <button class="btn small" data-action="export-txt" title="Descargar todo el diario como archivo de texto">⬇ Descargar diario</button>
            </div>
            <div id="r-results"></div>
          </div>`
        : '<div id="r-view"></div>';
  }
  if (state.view === 'day') {
    const k = dkey(state.cursor);
    patch('r-hero', heroHTML(k));
    patch('r-events', eventsCard());
    patch('r-tasks', tasksCard(k));
    patch('r-diary', diaryCard(k));
  } else if (state.view === 'diary') {
    patch('r-results', diaryResults());
  } else {
    patch('r-view', state.view === 'week' ? weekView() : monthView());
  }
  document.title = `${periodLabel()} · Mi agenda`;
}

// Reemplaza el contenido de una zona solo si cambió, sin perder el foco de lo que estás escribiendo.
function patch(id, html) {
  const el = document.getElementById(id);
  if (!el || cache[id] === html) return;
  const active = document.activeElement;
  const inside = active && el.contains(active);
  if (inside && active.dataset.keep) return; // no pisar lo que se está escribiendo
  const focus = inside && active.id ? { id: active.id, s: active.selectionStart, e: active.selectionEnd } : null;
  el.innerHTML = html;
  cache[id] = html;
  if (focus) {
    const n = document.getElementById(focus.id);
    if (n) {
      n.focus({ preventScroll: true });
      try { n.setSelectionRange(focus.s, focus.e); } catch {}
    }
  }
  el.querySelectorAll('textarea.autosize').forEach(autosize);
}

function autosize(t) {
  t.style.height = 'auto';
  t.style.height = `${Math.max(t.scrollHeight, 180)}px`;
}

function periodLabel() {
  const c = state.cursor;
  if (state.view === 'diary') return 'Mi diario';
  if (state.view === 'day') return cap((c.getFullYear() === new Date().getFullYear() ? fLong : fLongYear).format(c));
  if (state.view === 'week') {
    const s = startOfWeek(c);
    const e = addDays(s, 6);
    return s.getMonth() === e.getMonth()
      ? `${s.getDate()} – ${e.getDate()} de ${fMonthName.format(e)}`
      : `${s.getDate()} ${fMonShort.format(s)} – ${e.getDate()} ${fMonShort.format(e)}`;
  }
  return cap(fMonthYear.format(c));
}

function isCurrentPeriod() {
  const [a, b] = state.view === 'month'
    ? [new Date(state.cursor.getFullYear(), state.cursor.getMonth(), 1), new Date(state.cursor.getFullYear(), state.cursor.getMonth() + 1, 1)]
    : viewRange();
  const t = today();
  return t >= a && t < b;
}

function headerHTML() {
  return `<header class="top">
    <div class="brand"><span class="logo" aria-hidden="true">✦</span><span class="brand-name">Mi agenda</span></div>
    <nav class="nav" aria-label="Fechas">
      ${state.view === 'diary' ? '' : `<button class="icon-btn" data-action="prev" title="Anterior (←)" aria-label="Anterior">‹</button>
      <button class="btn ghost small ${isCurrentPeriod() ? 'is-current' : ''}" data-action="today" title="Ir a hoy (T)">Hoy</button>
      <button class="icon-btn" data-action="next" title="Siguiente (→)" aria-label="Siguiente">›</button>`}
      <h1 class="date-label">${esc(periodLabel())}</h1>
    </nav>
    <div class="tools">
      <div class="seg" role="group" aria-label="Vista">${Object.entries(VIEWS).map(([v, n]) =>
        `<button class="${state.view === v ? 'on' : ''}" data-action="view" data-view="${v}" aria-pressed="${state.view === v}">${n}</button>`).join('')}</div>
      ${syncHTML()}
      <button class="icon-btn" data-action="settings" title="Cuentas y ajustes" aria-label="Cuentas y ajustes">⚙</button>
    </div>
  </header>`;
}

function syncHTML() {
  const map = {
    local: ['Guardado en este dispositivo', 'idle'],
    syncing: ['Sincronizando…', 'busy'],
    ok: ['Guardado en Drive', 'ok'],
    error: ['No se pudo sincronizar', 'bad'],
    expired: ['Reconectá para sincronizar', 'bad'],
  };
  const [txt, cls] = map[store.syncInfo.state] || map.local;
  return `<span class="sync ${cls}" title="${txt}"><span class="sdot"></span><span class="sync-txt">${txt}</span></span>`;
}

function bannerHTML() {
  if (!g.isConfigured()) return '';
  const expired = g.getAccounts().filter(a => !g.isValid(a));
  if (!expired.length) return '';
  return `<div class="banner">
    <span>Google pide renovar el permiso cada hora. Tocá para reconectar:</span>
    ${expired.map(a => `<button class="btn small" data-action="reconnect" data-email="${esc(a.email)}" style="--c:${a.color}"><span class="dot"></span>${esc(a.email)}</button>`).join('')}
  </div>`;
}

// ----- vista Día -----

function heroHTML(k) {
  const d = store.getDay(k);
  const pending = d.tasks.filter(t => !t.movedTo && !t.done).length;
  const notes = d.entries.length;
  const evCount = eventsOn(state.cursor).length;
  const hr = new Date().getHours();
  const isToday = sameDay(state.cursor, new Date());
  const greet = !isToday
    ? (state.cursor < today() ? 'Mirando atrás' : 'Para planear')
    : hr < 6 ? 'Buenas noches' : hr < 13 ? 'Buen día' : hr < 20 ? 'Buenas tardes' : 'Buenas noches';
  const connected = g.getAccounts().some(g.isValid);
  const stats = [
    connected ? `<span class="stat s-ev"><b>${evCount}</b> ${evCount === 1 ? 'evento' : 'eventos'}</span>` : '',
    `<span class="stat s-task"><b>${pending}</b> ${pending === 1 ? 'tarea pendiente' : 'tareas pendientes'}</span>`,
    `<span class="stat s-note"><b>${notes}</b> ${notes === 1 ? 'nota' : 'notas'}</span>`,
  ].join('');
  return `<section class="hero">
    <div><p class="greet">${greet}</p><p class="hero-sub">${isToday ? 'Así viene tu día' : esc(cap(fLong.format(state.cursor)))}</p></div>
    <div class="stats">${stats}</div>
  </section>`;
}

function eventsCard() {
  const day = state.cursor;
  const evs = eventsOn(day);
  const canCreate = g.writableCalendars().length > 0;
  let body;
  if (!g.isConfigured()) {
    body = `<div class="empty"><div class="empty-ic">🗓️</div><p><b>Todavía no conectaste Google Calendar</b></p>
      <p class="muted small">Seguí los pasos del archivo <b>GUIA.md</b>. Es gratis y se hace una sola vez.</p></div>`;
  } else if (!g.getAccounts().length) {
    body = `<div class="empty"><div class="empty-ic">🗓️</div><p>Conectá tus cuentas de Google para ver todos tus calendarios juntos.</p>
      <button class="btn primary" data-action="add-account">Conectar cuenta de Google</button></div>`;
  } else if (!evs.length) {
    body = `<div class="empty muted"><div class="empty-ic">${state.loading ? '⏳' : '✨'}</div>${state.loading ? 'Cargando eventos…' : 'Nada agendado. Día libre'}</div>`;
  } else {
    const allDay = evs.filter(e => e.allDay);
    const timed = evs.filter(e => !e.allDay);
    const now = new Date();
    let nowPlaced = !sameDay(day, now);
    let rows = '';
    for (const e of timed) {
      if (!nowPlaced && e.start > now) { rows += nowLine(now); nowPlaced = true; }
      rows += eventRow(e, day);
    }
    if (!nowPlaced && timed.length) rows += nowLine(now);
    body = `${allDay.length ? `<div class="allday">${allDay.map(e =>
        `<button class="chip" data-action="open-event" data-key="${esc(e.key)}" style="--c:${esc(e.color)}">${esc(e.title)}</button>`).join('')}</div>` : ''}
      <div class="ev-list">${rows}</div>`;
  }
  return `<section class="card card-events">
    <div class="card-h"><h2><span class="ic">📅</span>Agenda</h2>${state.loading ? '<span class="spinner" aria-label="Cargando"></span>' : ''}
      ${canCreate ? `<button class="btn small" data-action="new-event" data-date="${dkey(day)}" title="Nuevo evento (N)">+ Evento</button>` : ''}</div>
    ${body}
  </section>`;
}

const nowLine = now => `<div class="now-line" aria-label="Ahora"><span>${hm(now)}</span></div>`;

function eventRow(e, day) {
  const startsToday = e.start >= day;
  const endsToday = e.end <= addDays(day, 1);
  const meta = [e.location, e.calName].filter(Boolean).join(' · ');
  return `<button class="ev ${e.end < new Date() ? 'past' : ''}" data-action="open-event" data-key="${esc(e.key)}" style="--c:${esc(e.color)}">
    <span class="ev-time">${startsToday ? hm(e.start) : '…'}<small>${endsToday ? hm(e.end) : '…'}</small></span>
    <span class="ev-bar"></span>
    <span class="ev-body"><span class="ev-title">${esc(e.title)}</span>${meta ? `<span class="ev-meta">${esc(meta)}</span>` : ''}</span>
  </button>`;
}

function tasksCard(k) {
  const d = store.getDay(k);
  const active = d.tasks.filter(t => !t.movedTo);
  const done = active.filter(t => t.done).length;
  const items = d.tasks.map(t => t.movedTo
    ? `<li class="task moved"><span class="moved-text">${esc(t.text)}</span><span class="tag" title="Pasó a otro día">→ ${fShort(fromKey(t.movedTo))}</span></li>`
    : `<li class="task ${t.done ? 'done' : ''}">
        <input type="checkbox" data-change="toggle-task" data-id="${t.id}" ${t.done ? 'checked' : ''} aria-label="Marcar como hecha">
        <input class="task-text" id="task-${t.id}" data-change="task-text" data-id="${t.id}" value="${esc(t.text)}" aria-label="Tarea">
        ${t.from ? `<span class="tag" title="Pendiente desde el ${fShort(fromKey(t.from))}">↩ ${fShort(fromKey(t.from))}</span>` : ''}
        <button class="x" data-action="del-task" data-id="${t.id}" aria-label="Borrar tarea">×</button>
      </li>`).join('');
  return `<section class="card card-tasks">
    <div class="card-h"><h2><span class="ic">✅</span>Tareas</h2>${active.length ? `<span class="count">${done}/${active.length}</span>` : ''}</div>
    ${active.length ? `<div class="progress"><span style="width:${Math.round((done / active.length) * 100)}%"></span></div>` : ''}
    ${items ? `<ul class="tasks">${items}</ul>` : '<p class="hint">Nada pendiente. Escribí tu primera tarea acá abajo 👇</p>'}
    <form class="add-row" data-form="add-task" autocomplete="off">
      <input id="new-task" name="text" placeholder="Agregar tarea y apretar Enter…" aria-label="Nueva tarea">
    </form>
  </section>`;
}

// ----- Diario: notas con fecha y hora exactas -----

const fEntryDate = fmt({ weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const draftKey = k => `agenda.draft.${k}`;

function stampHTML(e) {
  const c = new Date(e.createdAt);
  const edited = e.updatedAt - e.createdAt > 1500
    ? ` <span class="edited" title="Editada el ${esc(fEntryDate.format(new Date(e.updatedAt)))} a las ${hms(new Date(e.updatedAt))}">· editada ${hm(new Date(e.updatedAt))}</span>` : '';
  return `<time class="stamp" datetime="${c.toISOString()}" title="${esc(cap(fEntryDate.format(c)))} a las ${hms(c)}">
    <span class="stamp-time">${hms(c)}</span><span class="stamp-date">${esc(cap(fEntryDate.format(c)))}</span>${edited}</time>`;
}

function entryHTML(e, day, showOpen = false) {
  if (state.editing === e.id) {
    return `<article class="entry editing">
      ${stampHTML(e)}
      <textarea id="edit-${e.id}" class="entry-edit" data-keep="1" rows="4" aria-label="Editar nota">${esc(e.text)}</textarea>
      <div class="entry-actions">
        <button class="btn small primary" data-action="save-entry" data-day="${day}" data-id="${e.id}">Guardar cambios</button>
        <button class="btn small ghost" data-action="cancel-edit">Cancelar</button>
      </div>
    </article>`;
  }
  return `<article class="entry">
    <div class="entry-top">${stampHTML(e)}
      <span class="entry-btns">
        ${showOpen ? `<button class="btn small ghost" data-action="goto" data-date="${day}">Abrir día</button>` : ''}
        <button class="btn small ghost" data-action="edit-entry" data-id="${e.id}" data-day="${day}">Editar</button>
        <button class="x" data-action="del-entry" data-day="${day}" data-id="${e.id}" aria-label="Borrar nota" title="Borrar nota">×</button>
      </span>
    </div>
    <p class="entry-text">${esc(e.text)}</p>
  </article>`;
}

function diaryCard(k) {
  const list = [...store.getDay(k).entries].sort((a, b) => b.createdAt - a.createdAt);
  return `<section class="card card-diary">
    <div class="card-h"><h2><span class="ic">📓</span>Diario</h2><span class="count">${list.length} ${list.length === 1 ? 'nota' : 'notas'}</span></div>
    <form class="composer" data-form="add-entry" data-day="${k}">
      <textarea id="composer" name="text" data-keep="1" data-input="draft" data-day="${k}" rows="4"
        placeholder="¿Qué querés anotar? Ideas, lo que pasó, cosas para recordar…" aria-label="Nueva nota">${esc(lsGet(draftKey(k)) || '')}</textarea>
      <div class="composer-bar">
        <span class="muted small">Se guarda con la fecha y hora exactas · Ctrl+Enter</span>
        <button class="btn primary small" type="submit">Guardar nota</button>
      </div>
    </form>
    <div class="entries">${list.map(e => entryHTML(e, k)).join('') ||
      '<p class="hint">Todavía no hay notas este día. Lo que escribas arriba queda guardado con su hora.</p>'}</div>
  </section>`;
}

// ----- vista Diario: todas las notas, con buscador -----

function matchesQuery(e, q) {
  if (!q) return true;
  const c = new Date(e.createdAt);
  const hay = `${e.text} ${fEntryDate.format(c)} ${e.day} ${hm(c)}`.toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every(w => hay.includes(w));
}

function diaryResults() {
  const all = store.allEntries();
  const list = all.filter(e => matchesQuery(e, state.query.trim()));
  if (!all.length) {
    return `<div class="card empty"><div class="empty-ic">📓</div><p><b>Tu diario está vacío</b></p>
      <p class="muted small">Las notas que escribas en la vista Día aparecen acá, ordenadas por fecha y hora.</p></div>`;
  }
  if (!list.length) return `<div class="card empty"><div class="empty-ic">🔍</div><p>No encontré notas con “${esc(state.query)}”.</p></div>`;
  const groups = [];
  for (const e of list) {
    const g0 = groups[groups.length - 1];
    if (g0 && g0.day === e.day) g0.items.push(e); else groups.push({ day: e.day, items: [e] });
  }
  return `<p class="muted small results-count">${list.length} ${list.length === 1 ? 'nota' : 'notas'}${state.query.trim() ? ' encontradas' : ' en total'}</p>
    ${groups.map(gr => `<section class="day-group">
      <h3 class="day-head">${esc(cap(fEntryDate.format(fromKey(gr.day))))}</h3>
      <div class="card entries">${gr.items.map(e => entryHTML(e, gr.day, true)).join('')}</div>
    </section>`).join('')}`;
}

function exportDiaryTxt() {
  const all = [...store.allEntries()].reverse();
  if (!all.length) return toast('Todavía no hay notas para descargar.', true);
  let out = 'MI DIARIO\r\n\r\n';
  let last = '';
  for (const e of all) {
    if (e.day !== last) { out += `\r\n=== ${cap(fEntryDate.format(fromKey(e.day)))} ===\r\n`; last = e.day; }
    const c = new Date(e.createdAt);
    out += `\r\n[${hms(c)}] ${e.text.replace(/\r?\n/g, '\r\n')}\r\n`;
  }
  const blob = new Blob(['﻿' + out], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `mi-diario-${dkey(today())}.txt`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ----- vista Semana -----

function weekView() {
  const s = startOfWeek(state.cursor);
  const t = today();
  return `<div class="week">${[0, 1, 2, 3, 4, 5, 6].map(i => {
    const d = addDays(s, i);
    const k = dkey(d);
    const day = store.getDay(k);
    const evs = eventsOn(d);
    const act = day.tasks.filter(x => !x.movedTo);
    return `<section class="wday ${sameDay(d, t) ? 'is-today' : ''} ${d < t ? 'is-past' : ''}">
      <button class="wday-h" data-action="goto" data-date="${k}" title="Abrir este día">
        <span class="wd">${esc(cap(fWeekday.format(d)))}</span><span class="dn">${d.getDate()}</span>
        ${day.entries.length ? `<span class="note-count" title="Notas de este día">✎ ${day.entries.length}</span>` : ''}
      </button>
      <div class="wday-evs">${evs.map(e =>
        `<button class="pill" data-action="open-event" data-key="${esc(e.key)}" style="--c:${esc(e.color)}">${e.allDay ? '' : `<b>${hm(e.start)}</b> `}${esc(e.title)}</button>`).join('')}</div>
      ${act.length ? `<div class="wday-tasks">${act.slice(0, 5).map(x =>
        `<div class="mini-task ${x.done ? 'done' : ''}">${x.done ? '☑' : '☐'} ${esc(x.text)}</div>`).join('')}
        ${act.length > 5 ? `<div class="muted small">+${act.length - 5} más</div>` : ''}</div>` : ''}
      ${day.entries.slice(-2).map(e => `<p class="wday-note" data-action="goto" data-date="${k}"><b>${hm(new Date(e.createdAt))}</b> ${esc(e.text.slice(0, 120))}</p>`).join('')}
      <button class="add-mini" data-action="goto" data-date="${k}">Abrir día</button>
    </section>`;
  }).join('')}</div>`;
}

// ----- vista Mes -----

function monthView() {
  const { start, weeks } = monthGrid(state.cursor);
  const m = state.cursor.getMonth();
  const t = today();
  const heads = [0, 1, 2, 3, 4, 5, 6].map(i => `<div class="mhead">${esc(cap(fWeekday.format(addDays(start, i))).replace('.', ''))}</div>`).join('');
  let cells = '';
  for (let i = 0; i < weeks * 7; i++) {
    const d = addDays(start, i);
    const k = dkey(d);
    const day = store.getDay(k);
    const evs = eventsOn(d);
    const act = day.tasks.filter(x => !x.movedTo);
    const done = act.filter(x => x.done).length;
    cells += `<button class="mcell ${d.getMonth() !== m ? 'out' : ''} ${sameDay(d, t) ? 'is-today' : ''}" data-action="goto" data-date="${k}" aria-label="${esc(fLong.format(d))}">
      <span class="mtop"><span class="mnum">${d.getDate()}</span>${day.entries.length ? `<span class="mmood" title="Notas de este día">✎ ${day.entries.length}</span>` : ''}</span>
      <span class="mevs">${evs.slice(0, 3).map(e => `<span class="mpill" style="--c:${esc(e.color)}">${esc(e.title)}</span>`).join('')}
        ${evs.length > 3 ? `<span class="more">+${evs.length - 3}</span>` : ''}</span>
      <span class="mfoot">${act.length ? `<span class="mtasks" title="Tareas hechas">✓ ${done}/${act.length}</span>` : ''}</span>
    </button>`;
  }
  return `<div class="month">${heads}${cells}</div>`;
}

// ---------- eventos de Google ----------

async function loadEvents(force = false) {
  if (state.view === 'diary') return;
  if (!g.isConfigured() || !g.getAccounts().some(g.isValid)) {
    if (state.loading) { state.loading = false; render(); }
    return;
  }
  const [a, b] = viewRange();
  const key = `${dkey(a)}_${dkey(b)}_${g.signature()}`;
  if (!force && key === state.eventsKey && Date.now() - state.eventsAt < 120_000) return;
  const seq = ++loadSeq;
  state.loading = true;
  render();
  const { events, errors } = await g.fetchEvents(a, b);
  if (seq !== loadSeq) return;
  Object.assign(state, { events, eventsKey: key, eventsAt: Date.now(), loading: false });
  const other = errors.filter(e => e.status !== 401);
  if (other.length) toast(`No pude leer algunos calendarios: ${other[0].message}`, true);
  render();
}

function openEvent(ev, dateKey) {
  const cals = g.writableCalendars();
  if (!ev && !cals.length) {
    toast(g.getAccounts().length ? 'Reconectá tu cuenta de Google para crear eventos.' : 'Primero conectá una cuenta de Google.', true);
    return;
  }
  const ro = !!ev && !ev.canEdit;
  let sd, st, ed, et;
  if (ev) {
    sd = dkey(ev.start);
    ed = dkey(ev.allDay ? addDays(ev.end, -1) : ev.end);
    st = ev.allDay ? '09:00' : hm(ev.start);
    et = ev.allDay ? '10:00' : hm(ev.end);
  } else {
    const base = dateKey ? fromKey(dateKey) : state.cursor;
    const h = sameDay(base, new Date()) ? Math.min(new Date().getHours() + 1, 23) : 9;
    sd = ed = dkey(base);
    st = `${pad(h)}:00`;
    et = h < 23 ? `${pad(h + 1)}:00` : '23:59';
  }
  let calOptions;
  if (ev) {
    calOptions = `<option>${esc(ev.calName)} (${esc(ev.email)})</option>`;
  } else {
    const last = lsGet('agenda.lastCal');
    const groups = {};
    cals.forEach((c, i) => {
      (groups[c.email] ||= []).push(`<option value="${i}" ${`${c.email}|${c.cal.id}` === last ? 'selected' : ''}>${esc(c.cal.name)}</option>`);
    });
    calOptions = Object.entries(groups).map(([email, o]) => `<optgroup label="${esc(email)}">${o.join('')}</optgroup>`).join('');
  }
  const dis = ro ? 'disabled' : '';
  const title = ev && ev.title !== '(sin título)' ? ev.title : '';
  const dlg = openDialog(`
    <form class="form ${ev?.allDay ? 'is-allday' : ''}" novalidate>
      <h3>${ev ? (ro ? 'Evento' : 'Editar evento') : 'Nuevo evento'}</h3>
      <input class="title-in" name="title" placeholder="Título del evento" value="${esc(title)}" ${dis} autocomplete="off" aria-label="Título">
      <label class="chk-row"><input type="checkbox" name="allDay" ${ev?.allDay ? 'checked' : ''} ${dis}> Todo el día</label>
      <div class="row"><label>Desde<input type="date" name="sd" value="${sd}" ${dis}></label><label class="t">Hora<input type="time" name="st" value="${st}" ${dis}></label></div>
      <div class="row"><label>Hasta<input type="date" name="ed" value="${ed}" ${dis}></label><label class="t">Hora<input type="time" name="et" value="${et}" ${dis}></label></div>
      <label>Calendario<select name="cal" ${ev ? 'disabled' : ''}>${calOptions}</select></label>
      <label>Lugar<input name="location" value="${esc(ev?.location || '')}" ${dis} autocomplete="off"></label>
      <label>Descripción<textarea name="description" rows="3" ${dis}>${esc(ev?.description || '')}</textarea></label>
      ${ro ? '<p class="muted small">Este calendario es de solo lectura.</p>' : ''}
      ${ev?.recurring && !ro ? '<p class="muted small">Es un evento repetido: los cambios se aplican solo a este día.</p>' : ''}
      <p class="err" role="alert"></p>
      <div class="dlg-actions">
        ${ev?.link ? `<a class="link" href="${esc(ev.link)}" target="_blank" rel="noopener">Abrir en Google Calendar ↗</a>` : ''}
        <span class="spacer"></span>
        ${ev && !ro ? '<button type="button" class="btn danger" data-role="delete">Eliminar</button>' : ''}
        <button type="button" class="btn ghost" data-dlg="cancel">${ro ? 'Cerrar' : 'Cancelar'}</button>
        ${ro ? '' : '<button type="submit" class="btn primary">Guardar</button>'}
      </div>
    </form>`);
  const form = $('form', dlg);
  const f = form.elements;
  const errEl = $('.err', dlg);
  const fail = msg => { errEl.textContent = msg; };
  const busy = on => dlg.querySelectorAll('.dlg-actions button').forEach(b => { b.disabled = on; });

  f.allDay.addEventListener('change', () => form.classList.toggle('is-allday', f.allDay.checked));
  f.sd.addEventListener('change', () => { if (f.ed.value < f.sd.value) f.ed.value = f.sd.value; });
  f.st.addEventListener('change', () => {
    if (f.sd.value === f.ed.value && f.et.value <= f.st.value) {
      const [h, m] = f.st.value.split(':').map(Number);
      f.et.value = h < 23 ? `${pad(h + 1)}:${pad(m)}` : '23:59';
    }
  });
  if (!ev) f.title.focus();

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const allDay = f.allDay.checked;
    const t = f.title.value.trim();
    if (!t) return fail('Poné un título.');
    if (!f.sd.value || !f.ed.value || (!allDay && (!f.st.value || !f.et.value))) return fail('Completá las fechas y horas.');
    if (allDay ? f.ed.value < f.sd.value : `${f.ed.value}T${f.et.value}` <= `${f.sd.value}T${f.st.value}`) {
      return fail('El final tiene que ser después del inicio.');
    }
    const target = ev ? { email: ev.email, calId: ev.calId } : { email: cals[f.cal.value].email, calId: cals[f.cal.value].cal.id };
    busy(true);
    try {
      await g.saveEvent({
        ...target, eventId: ev?.id, title: t, allDay,
        startDate: f.sd.value, startTime: f.st.value, endDate: f.ed.value, endTime: f.et.value,
        location: f.location.value.trim(), description: f.description.value,
      });
      if (!ev) lsSet('agenda.lastCal', `${target.email}|${target.calId}`);
      dlg.close();
      toast(ev ? 'Evento actualizado' : 'Evento creado');
      loadEvents(true);
    } catch (err) {
      fail(err.message);
      busy(false);
      render();
    }
  });

  $('[data-role=delete]', dlg)?.addEventListener('click', async () => {
    if (!confirm(`¿Eliminar "${ev.title}" de Google Calendar?`)) return;
    busy(true);
    try {
      await g.deleteEvent({ email: ev.email, calId: ev.calId, eventId: ev.id });
      dlg.close();
      toast('Evento eliminado');
      loadEvents(true);
    } catch (err) {
      fail(err.message);
      busy(false);
    }
  });
}

// ---------- ajustes ----------

let settingsDlg = null;

function openSettings() {
  settingsDlg = openDialog('<div class="settings"></div>');
  settingsDlg.addEventListener('close', () => { settingsDlg = null; });
  refreshSettings();
}

function refreshSettings() {
  if (!settingsDlg) return;
  const scroll = settingsDlg.scrollTop;
  $('.settings', settingsDlg).innerHTML = settingsHTML();
  settingsDlg.scrollTop = scroll;
}

function accountHTML(a) {
  const hidden = a.hidden || [];
  return `<div class="acc" style="--c:${a.color}">
    <div class="acc-h"><span class="dot"></span><b>${esc(a.email)}</b>${a.isMain ? '<span class="tag">📝 Notas acá</span>' : ''}
      <span class="spacer"></span>
      ${g.isValid(a) ? '<span class="small ok-text">● Conectada</span>' : `<button class="btn small" data-action="reconnect" data-email="${esc(a.email)}">Reconectar</button>`}</div>
    <div class="cals">${(a.calendars || []).map(c => `<label class="cal">
      <input type="checkbox" data-change="toggle-cal" data-email="${esc(a.email)}" data-cal="${esc(c.id)}" ${hidden.includes(c.id) ? '' : 'checked'}>
      <span class="cdot" style="background:${esc(c.color)}"></span><span>${esc(c.name)}${c.role === 'reader' ? ' <span class="muted small">(solo lectura)</span>' : ''}</span></label>`).join('')}</div>
    <div class="acc-actions">
      ${a.isMain ? '' : `<button class="btn small ghost" data-action="make-main" data-email="${esc(a.email)}">Guardar mis notas en esta cuenta</button>`}
      <button class="btn small ghost" data-action="remove-account" data-email="${esc(a.email)}">Quitar</button>
    </div>
  </div>`;
}

function settingsHTML() {
  const accs = g.getAccounts();
  const main = g.mainAccount();
  const google = !g.isConfigured()
    ? `<div class="notice"><p><b>Falta un paso para conectar Google.</b> Seguí la guía <b>GUIA.md</b> y pegá tu ID de cliente en <code>config.js</code>.</p>
        <p class="small muted">Dirección de esta agenda (la vas a necesitar en Google Cloud): <code>${esc(location.origin)}</code></p></div>`
    : `${accs.map(accountHTML).join('') || '<p class="muted">Todavía no conectaste ninguna cuenta.</p>'}
      <button class="btn primary" data-action="add-account">+ Agregar cuenta de Google</button>
      <p class="muted small">${main
        ? `Tu diario y tus tareas se guardan en el Google Drive de <b>${esc(main.email)}</b>, en una carpeta oculta que solo usa esta app.`
        : 'Tus notas se guardan solo en este dispositivo. Elegí una cuenta para guardarlas en Drive y verlas también desde el celular.'}</p>`;
  return `<h3>Ajustes</h3>
    <h4>Cuentas de Google</h4>
    ${google}
    <h4>Copia de seguridad</h4>
    <div class="acc-actions">
      <button class="btn small" data-action="export-txt">Descargar diario (.txt)</button>
      <button class="btn small" data-action="export">Descargar copia completa</button>
      <label class="btn small ghost">Restaurar copia<input type="file" accept="application/json,.json" data-change="import" hidden></label>
    </div>
    <div class="dlg-actions">
      <span class="muted small keys">Atajos: ← → moverte · T hoy · D/S/M/J vistas · N nuevo evento</span>
      <span class="spacer"></span>
      <button class="btn" data-dlg="cancel">Listo</button>
    </div>`;
}

function exportBackup() {
  const blob = new Blob([store.exportJSON()], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `mi-agenda-${dkey(today())}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function importBackup(input) {
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  try {
    const obj = JSON.parse(await file.text());
    if (!obj || typeof obj.days !== 'object') throw new Error();
    if (!confirm('Los días que estén en la copia van a reemplazar a los actuales. ¿Seguir?')) return;
    store.importData(obj);
    render();
    refreshSettings();
    toast('Copia restaurada');
  } catch {
    toast('Ese archivo no parece una copia de Mi agenda.', true);
  }
}

// ---------- diálogos y avisos ----------

function openDialog(html) {
  const dlg = document.createElement('dialog');
  dlg.className = 'dlg';
  dlg.innerHTML = `<div class="dlg-in">${html}</div>`;
  document.body.append(dlg);
  dlg.addEventListener('close', () => dlg.remove());
  dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
  dlg.showModal();
  return dlg;
}

function toast(msg, bad = false) {
  const el = document.createElement('div');
  el.className = `toast${bad ? ' bad' : ''}`;
  el.setAttribute('role', 'status');
  el.textContent = msg;
  ($('dialog[open]') || document.body).append(el);
  setTimeout(() => el.classList.add('out'), bad ? 6500 : 3500);
  setTimeout(() => el.remove(), bad ? 7000 : 4000);
}

// ---------- acciones ----------

const dayKey = () => dkey(state.cursor);

function move(n) {
  if (state.view === 'diary') return;
  const c = state.cursor;
  if (state.view === 'day') state.cursor = addDays(c, n);
  else if (state.view === 'week') state.cursor = addDays(c, 7 * n);
  else state.cursor = new Date(c.getFullYear(), c.getMonth() + n, 1);
  go();
}

function setView(v) {
  state.view = v;
  lsSet('agenda.view', v);
  go();
}

function go() {
  render();
  loadEvents();
  window.scrollTo({ top: 0 });
}

async function withGoogle(promise, okMsg) {
  try {
    await promise;
    toast(okMsg);
  } catch (err) {
    toast(err.message || String(err), true);
  }
  afterAccountsChange();
}

function afterAccountsChange() {
  state.eventsKey = '';
  render();
  refreshSettings();
  loadEvents(true);
  store.syncNow();
}

document.addEventListener('click', e => {
  const closer = e.target.closest('[data-dlg="cancel"]');
  if (closer) { closer.closest('dialog')?.close(); return; }
  const t = e.target.closest('[data-action]');
  if (!t || t.disabled) return;
  const d = t.dataset;
  switch (d.action) {
    case 'prev': return move(-1);
    case 'next': return move(1);
    case 'today': state.cursor = today(); return go();
    case 'view': return setView(d.view);
    case 'goto': state.cursor = fromKey(d.date); return setView('day');
    case 'settings': return openSettings();
    case 'new-event': return openEvent(null, d.date);
    case 'open-event': {
      const ev = state.events.find(x => x.key === d.key);
      if (ev) openEvent(ev);
      return;
    }
    case 'del-task':
      store.updateDay(dayKey(), day => { day.tasks = day.tasks.filter(x => x.id !== d.id); });
      return render();
    case 'edit-entry':
      state.editing = d.id;
      render();
      {
        const ta = document.getElementById(`edit-${d.id}`);
        if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
      }
      return;
    case 'cancel-edit':
      state.editing = null;
      document.activeElement?.blur();
      return render();
    case 'save-entry': {
      const text = document.getElementById(`edit-${d.id}`)?.value.trim();
      if (!text) return toast('La nota no puede quedar vacía. Para borrarla usá la ×.', true);
      store.editEntry(d.day, d.id, text);
      state.editing = null;
      document.activeElement?.blur();
      render();
      return toast('Cambios guardados');
    }
    case 'del-entry':
      if (!confirm('¿Borrar esta nota? No se puede deshacer.')) return;
      store.deleteEntry(d.day, d.id);
      return render();
    // Estas llaman a Google en el mismo clic para que el navegador no bloquee la ventana.
    case 'add-account': return withGoogle(g.addAccount(), 'Cuenta conectada');
    case 'reconnect': return withGoogle(g.reconnect(d.email), 'Cuenta reconectada');
    case 'make-main': return withGoogle(g.makeMain(d.email), 'Tus notas ahora se guardan en esta cuenta');
    case 'remove-account':
      if (confirm(`¿Quitar ${d.email} de la agenda? (No se borra nada de tu cuenta de Google)`)) {
        g.removeAccount(d.email);
        afterAccountsChange();
      }
      return;
    case 'export': return exportBackup();
    case 'export-txt': return exportDiaryTxt();
  }
});

document.addEventListener('change', e => {
  const t = e.target;
  const id = t.dataset.id;
  switch (t.dataset.change) {
    case 'toggle-task':
      store.updateDay(dayKey(), day => { const x = day.tasks.find(x => x.id === id); if (x) x.done = t.checked; });
      return render();
    case 'task-text': {
      const v = t.value.trim();
      store.updateDay(dayKey(), day => {
        if (v) { const x = day.tasks.find(x => x.id === id); if (x) x.text = v; }
        else day.tasks = day.tasks.filter(x => x.id !== id);
      });
      return render();
    }
    case 'toggle-cal':
      g.setCalendarVisible(t.dataset.email, t.dataset.cal, t.checked);
      state.eventsKey = '';
      render();
      return loadEvents(true);
    case 'import': return importBackup(t);
  }
});

document.addEventListener('input', e => {
  const t = e.target;
  if (t.dataset.input === 'draft') {
    // El borrador queda guardado aunque cierres la pestaña antes de apretar "Guardar nota".
    if (t.value) lsSet(draftKey(t.dataset.day), t.value);
    else try { localStorage.removeItem(draftKey(t.dataset.day)); } catch {}
  } else if (t.dataset.input === 'query') {
    state.query = t.value;
    render();
  }
});

document.addEventListener('submit', e => {
  const f = e.target;
  const kind = f.dataset.form;
  if (!kind) return;
  e.preventDefault();
  if (kind === 'add-task') {
    const v = f.elements.text.value.trim();
    if (!v) return;
    store.updateDay(dayKey(), day => { day.tasks.push({ id: store.newId(), text: v, done: false }); });
    f.elements.text.value = '';
    render();
  } else if (kind === 'add-entry') {
    const text = f.elements.text.value.trim();
    if (!text) return;
    const k = f.dataset.day;
    store.addEntry(k, text);
    try { localStorage.removeItem(draftKey(k)); } catch {}
    document.activeElement?.blur();
    render();
    $('#composer')?.focus();
    toast('Nota guardada');
  }
});

document.addEventListener('keydown', e => {
  const t = e.target;
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    if (t.id === 'composer') { e.preventDefault(); t.form.requestSubmit(); return; }
    if (t.classList?.contains('entry-edit')) { e.preventDefault(); t.closest('.entry')?.querySelector('[data-action=save-entry]')?.click(); return; }
  }
  if (e.key === 'Escape' && t.classList?.contains('entry-edit')) { state.editing = null; t.blur(); render(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey || $('dialog[open]')) return;
  if (e.target.closest?.('input, textarea, select, [contenteditable]')) return;
  const k = e.key.toLowerCase();
  if (e.key === 'ArrowLeft') move(-1);
  else if (e.key === 'ArrowRight') move(1);
  else if (k === 't') { state.cursor = today(); go(); }
  else if (k === 'd') setView('day');
  else if (k === 's') setView('week');
  else if (k === 'm') setView('month');
  else if (k === 'j') setView('diary');
  else if (k === 'n') { e.preventDefault(); openEvent(null, dayKey()); }
});

// ---------- arranque ----------

store.setDriveAuth({
  getToken: () => { const m = g.mainAccount(); return g.isValid(m) ? m.token : null; },
  getEmail: () => g.mainAccount()?.email || null,
  onExpired: () => { const m = g.mainAccount(); if (m) g.markExpired(m.email); render(); },
});

store.subscribe(kind => {
  if (kind === 'data') { store.migrateTasks(dkey(today())); refreshSettings(); }
  render();
});

store.migrateTasks(lastToday);
render();
loadEvents();
store.syncNow();

setInterval(() => {
  const k = dkey(today());
  if (k !== lastToday) {
    if (dkey(state.cursor) === lastToday) state.cursor = today();
    lastToday = k;
    store.migrateTasks(k);
  }
  render();
  if (!document.hidden && Date.now() - state.eventsAt > 5 * 60_000) loadEvents(true);
}, 60_000);

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (store.hasPendingSync()) store.syncNow();
  } else {
    store.syncNow();
    render();
    loadEvents(Date.now() - state.eventsAt > 60_000);
  }
});
