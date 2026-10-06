// Conexión con Google: varias cuentas, sus calendarios y eventos.
// Usa Google Identity Services desde el navegador (sin servidor). Cada permiso dura 1 hora;
// después hay que tocar "Reconectar" (Google no permite renovarlo solo sin un servidor pago).

import { GOOGLE_CLIENT_ID } from './config.js';

const LS_ACCOUNTS = 'agenda.accounts.v1';
const CAL_API = 'https://www.googleapis.com/calendar/v3';
const SCOPE_CAL = 'https://www.googleapis.com/auth/calendar';
const SCOPE_DRIVE = 'https://www.googleapis.com/auth/drive.appdata';
const PALETTE = ['#3b6cf6', '#e8710a', '#0b8043', '#d50000', '#8e24aa', '#039be5', '#c2185b'];
const EVENT_COLORS = {
  1: '#7986cb', 2: '#33b679', 3: '#8e24aa', 4: '#e67c73', 5: '#f6bf26', 6: '#f4511e',
  7: '#039be5', 8: '#616161', 9: '#3f51b5', 10: '#0b8043', 11: '#d50000',
};

let accounts = load();

function load() {
  try { return JSON.parse(localStorage.getItem(LS_ACCOUNTS)) || []; } catch { return []; }
}
function save() {
  try { localStorage.setItem(LS_ACCOUNTS, JSON.stringify(accounts)); } catch {}
}

export const isConfigured = () => /\.apps\.googleusercontent\.com$/.test(GOOGLE_CLIENT_ID.trim());
export const getAccounts = () => accounts;
export const mainAccount = () => accounts.find(a => a.isMain) || null;
export const isValid = a => !!a?.token && a.expiresAt > Date.now();
const findAccount = email => accounts.find(a => a.email === email);

export function markExpired(email) {
  const a = findAccount(email);
  if (a) { a.expiresAt = 0; save(); }
}

export const signature = () =>
  accounts.map(a => `${a.email}:${isValid(a) ? 1 : 0}:${(a.hidden || []).join(',')}`).join('|');

// Tiene que llamarse directo desde un clic (si no, el navegador bloquea la ventana de Google).
function requestToken({ scope, hint, prompt }) {
  return new Promise((resolve, reject) => {
    const oauth2 = window.google?.accounts?.oauth2;
    if (!oauth2) return reject(new Error('Google todavía no terminó de cargar. Probá de nuevo en unos segundos.'));
    const config = {
      client_id: GOOGLE_CLIENT_ID.trim(),
      scope,
      prompt,
      callback: resp => (resp.error ? reject(new Error(resp.error_description || resp.error)) : resolve(resp)),
      error_callback: err => reject(new Error(
        err.type === 'popup_closed' ? 'Se cerró la ventana de Google antes de terminar.'
        : err.type === 'popup_failed_to_open' ? 'El navegador bloqueó la ventana de Google. Permití las ventanas emergentes para este sitio.'
        : err.message || 'No se pudo conectar con Google.')),
    };
    if (hint) config.login_hint = hint;
    oauth2.initTokenClient(config).requestAccessToken();
  });
}

const granted = (resp, scope) => window.google.accounts.oauth2.hasGrantedAllScopes(resp, scope);

function applyToken(acc, resp) {
  acc.token = resp.access_token;
  acc.expiresAt = Date.now() + (Number(resp.expires_in) || 3600) * 1000 - 60_000;
}

async function api(token, url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
  });
  if (!res.ok) {
    let msg = '';
    try { msg = (await res.json()).error?.message || ''; } catch {}
    const e = new Error(msg || `Google respondió con error ${res.status}`);
    e.status = res.status;
    throw e;
  }
  return res.status === 204 ? null : res.json();
}

async function accApi(acc, url, opts) {
  try {
    return await api(acc.token, url, opts);
  } catch (e) {
    if (e.status === 401) markExpired(acc.email);
    throw e;
  }
}

async function fetchCalendars(token) {
  const res = await api(token, `${CAL_API}/users/me/calendarList?minAccessRole=reader`);
  return (res.items || []).map(c => ({
    id: c.id,
    name: c.summaryOverride || c.summary || c.id,
    color: c.backgroundColor || '#888888',
    role: c.accessRole,
    primary: !!c.primary,
    selected: !!c.selected || !!c.primary,
  }));
}

export async function addAccount() {
  const firstMain = !mainAccount();
  const resp = await requestToken({ scope: firstMain ? `${SCOPE_CAL} ${SCOPE_DRIVE}` : SCOPE_CAL, prompt: 'select_account' });
  if (!granted(resp, SCOPE_CAL)) throw new Error('Hace falta el permiso de Google Calendar. Volvé a intentarlo y marcá esa casilla.');
  const tmp = {};
  applyToken(tmp, resp);
  const cals = await fetchCalendars(tmp.token);
  const email = cals.find(c => c.primary)?.id;
  if (!email) throw new Error('No encontré el calendario principal de esa cuenta.');
  let acc = findAccount(email);
  if (!acc) {
    acc = { email, color: PALETTE[accounts.length % PALETTE.length], isMain: false, hidden: cals.filter(c => !c.selected).map(c => c.id) };
    accounts.push(acc);
  }
  Object.assign(acc, tmp, { calendars: cals });
  if (firstMain && granted(resp, SCOPE_DRIVE)) {
    accounts.forEach(a => { a.isMain = a === acc; });
  }
  save();
  return acc;
}

export async function reconnect(email) {
  const acc = findAccount(email);
  if (!acc) return;
  const resp = await requestToken({ scope: acc.isMain ? `${SCOPE_CAL} ${SCOPE_DRIVE}` : SCOPE_CAL, hint: email, prompt: '' });
  const cals = await fetchCalendars(resp.access_token);
  if (cals.find(c => c.primary)?.id !== email) throw new Error(`Elegiste otra cuenta. Volvé a intentarlo con ${email}.`);
  applyToken(acc, resp);
  const known = new Set((acc.calendars || []).map(c => c.id));
  acc.hidden = [...(acc.hidden || []), ...cals.filter(c => !known.has(c.id) && !c.selected).map(c => c.id)];
  acc.calendars = cals;
  save();
}

export async function makeMain(email) {
  const acc = findAccount(email);
  if (!acc) return;
  const resp = await requestToken({ scope: `${SCOPE_CAL} ${SCOPE_DRIVE}`, hint: email, prompt: '' });
  if (!granted(resp, SCOPE_DRIVE)) throw new Error('Hace falta el permiso de Google Drive para guardar tus notas ahí.');
  applyToken(acc, resp);
  accounts.forEach(a => { a.isMain = a === acc; });
  save();
}

export function removeAccount(email) {
  accounts = accounts.filter(a => a.email !== email);
  save();
}

export function setCalendarVisible(email, calId, visible) {
  const acc = findAccount(email);
  if (!acc) return;
  const hidden = new Set(acc.hidden || []);
  if (visible) hidden.delete(calId); else hidden.add(calId);
  acc.hidden = [...hidden];
  save();
}

export function writableCalendars() {
  const out = [];
  const ordered = [...accounts].sort((a, b) => Number(b.isMain) - Number(a.isMain));
  for (const acc of ordered) {
    if (!isValid(acc)) continue;
    for (const cal of acc.calendars || []) {
      if ((cal.role === 'owner' || cal.role === 'writer') && !(acc.hidden || []).includes(cal.id)) out.push({ email: acc.email, cal });
    }
  }
  return out;
}

const parseDate = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };

function toEvent(ev, acc, cal) {
  const allDay = !!ev.start?.date;
  const start = allDay ? parseDate(ev.start.date) : new Date(ev.start.dateTime);
  const end = allDay ? parseDate(ev.end?.date || ev.start.date) : new Date(ev.end?.dateTime || ev.start.dateTime);
  return {
    key: `${acc.email}|${cal.id}|${ev.id}`,
    id: ev.id,
    uid: ev.iCalUID || ev.id,
    email: acc.email,
    calId: cal.id,
    calName: cal.name,
    color: EVENT_COLORS[ev.colorId] || cal.color,
    title: ev.summary || '(sin título)',
    start, end, allDay,
    location: ev.location || '',
    description: ev.description || '',
    link: ev.htmlLink || '',
    canEdit: cal.role === 'owner' || cal.role === 'writer',
    recurring: !!ev.recurringEventId,
  };
}

async function listEvents(acc, cal, start, end) {
  const out = [];
  let pageToken;
  do {
    const p = new URLSearchParams({
      timeMin: start.toISOString(), timeMax: end.toISOString(),
      singleEvents: 'true', orderBy: 'startTime', maxResults: '250',
    });
    if (pageToken) p.set('pageToken', pageToken);
    const res = await accApi(acc, `${CAL_API}/calendars/${encodeURIComponent(cal.id)}/events?${p}`);
    for (const ev of res.items || []) {
      if (ev.status === 'cancelled') continue;
      if (ev.attendees?.find(a => a.self)?.responseStatus === 'declined') continue;
      out.push(toEvent(ev, acc, cal));
    }
    pageToken = res.nextPageToken;
  } while (pageToken);
  return out;
}

// Trae los eventos de todas las cuentas conectadas. Si el mismo evento aparece en
// varias cuentas (ej: una invitación), se muestra una sola vez, preferentemente la editable.
export async function fetchEvents(start, end) {
  const jobs = [];
  for (const acc of accounts) {
    if (!isValid(acc)) continue;
    for (const cal of acc.calendars || []) {
      if (!(acc.hidden || []).includes(cal.id)) jobs.push(listEvents(acc, cal, start, end));
    }
  }
  const results = await Promise.allSettled(jobs);
  const byUid = new Map();
  const errors = [];
  for (const r of results) {
    if (r.status === 'rejected') { errors.push(r.reason); continue; }
    for (const ev of r.value) {
      const k = `${ev.uid}|${+ev.start}`;
      const prev = byUid.get(k);
      if (!prev || (!prev.canEdit && ev.canEdit)) byUid.set(k, ev);
    }
  }
  const events = [...byUid.values()].sort((a, b) =>
    Number(b.allDay) - Number(a.allDay) || a.start - b.start || a.title.localeCompare(b.title));
  return { events, errors };
}

function nextDay(key) {
  const d = parseDate(key);
  d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export async function saveEvent({ email, calId, eventId, title, allDay, startDate, startTime, endDate, endTime, location, description }) {
  const acc = findAccount(email);
  if (!isValid(acc)) throw new Error('La conexión con esa cuenta expiró. Reconectala y probá de nuevo.');
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const body = { summary: title, location, description };
  if (allDay) {
    body.start = { date: startDate };
    body.end = { date: nextDay(endDate) };
    if (eventId) { body.start.dateTime = null; body.end.dateTime = null; }
  } else {
    body.start = { dateTime: `${startDate}T${startTime}:00`, timeZone };
    body.end = { dateTime: `${endDate}T${endTime}:00`, timeZone };
    if (eventId) { body.start.date = null; body.end.date = null; }
  }
  const base = `${CAL_API}/calendars/${encodeURIComponent(calId)}/events`;
  return eventId
    ? accApi(acc, `${base}/${encodeURIComponent(eventId)}`, { method: 'PATCH', body: JSON.stringify(body) })
    : accApi(acc, base, { method: 'POST', body: JSON.stringify(body) });
}

export async function deleteEvent({ email, calId, eventId }) {
  const acc = findAccount(email);
  if (!isValid(acc)) throw new Error('La conexión con esa cuenta expiró. Reconectala y probá de nuevo.');
  await accApi(acc, `${CAL_API}/calendars/${encodeURIComponent(calId)}/events/${encodeURIComponent(eventId)}`, { method: 'DELETE' });
}
