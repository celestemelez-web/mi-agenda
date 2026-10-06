// Datos de la agenda (diario de notas y tareas).
// Se guardan siempre en este navegador y, si hay una cuenta principal conectada,
// se sincronizan con un archivo oculto (appDataFolder) en su Google Drive.

const LS_DATA = 'agenda.data.v1';
const LS_FILES = 'agenda.driveFiles.v1';
const DRIVE_FILE_NAME = 'mi-agenda-datos.json';
const DRIVE = 'https://www.googleapis.com/drive/v3';
const DRIVE_UP = 'https://www.googleapis.com/upload/drive/v3';

// Cada día tiene `entries` (las notas del diario, con la fecha y hora exacta en que se escribieron)
// y `tasks`. Los campos viejos (note, habits, mood) se ignoran o se convierten al cargar.
const emptyData = () => ({ version: 1, days: {} });
const emptyDay = () => ({ entries: [], tasks: [], updatedAt: 0 });

let data = loadLocal();
const listeners = new Set();

// Estado de sincronización: local | syncing | ok | error | expired
export const syncInfo = { state: 'local', at: 0 };

function loadLocal() {
  try {
    const raw = localStorage.getItem(LS_DATA);
    if (raw) return { ...emptyData(), ...JSON.parse(raw) };
  } catch {}
  return emptyData();
}

function saveLocal() {
  try { localStorage.setItem(LS_DATA, JSON.stringify(data)); } catch {}
}

function emit(kind) { for (const fn of listeners) fn(kind); }
export function subscribe(fn) { listeners.add(fn); }

export const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// Devuelve el día normalizado. Si venía con una nota única de la versión anterior,
// la convierte en una entrada del diario (con la última hora en que se editó ese día).
export function getDay(key) {
  const raw = data.days[key];
  if (!raw) return emptyDay();
  const d = { ...emptyDay(), ...raw };
  d.entries = Array.isArray(raw.entries) ? raw.entries : [];
  if (typeof raw.note === 'string' && raw.note.trim()) {
    const at = raw.updatedAt || new Date(`${key}T12:00:00`).getTime();
    d.entries = [{ id: `legacy-${key}`, text: raw.note.trim(), createdAt: at, updatedAt: at }, ...d.entries];
  }
  delete d.note;
  delete d.habits;
  delete d.mood;
  return d;
}

// Todas las notas de todos los días, de la más nueva a la más vieja.
export function allEntries() {
  const out = [];
  for (const key of Object.keys(data.days)) {
    for (const e of getDay(key).entries) out.push({ ...e, day: key });
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

export function addEntry(key, text) {
  const now = Date.now();
  const entry = { id: newId(), text, createdAt: now, updatedAt: now };
  updateDay(key, d => { d.entries.push(entry); });
  return entry;
}

export function editEntry(key, id, text) {
  updateDay(key, d => {
    const e = d.entries.find(x => x.id === id);
    if (e && e.text !== text) { e.text = text; e.updatedAt = Date.now(); }
  });
}

export function deleteEntry(key, id) {
  updateDay(key, d => { d.entries = d.entries.filter(x => x.id !== id); });
}

export function updateDay(key, fn) {
  const d = structuredClone(getDay(key));
  fn(d);
  d.updatedAt = Date.now();
  data.days[key] = d;
  changed();
}

function changed() {
  saveLocal();
  queueSync();
}

// Las tareas sin terminar de días anteriores pasan a hoy (quedan tachadas en el día original).
export function migrateTasks(todayKey) {
  const moved = [];
  const now = Date.now();
  for (const [k, d] of Object.entries(data.days)) {
    if (k >= todayKey || !d.tasks?.some(t => !t.done && !t.movedTo)) continue;
    const nd = structuredClone(d);
    for (const t of nd.tasks) {
      if (t.done || t.movedTo) continue;
      t.movedTo = todayKey;
      moved.push({ id: t.id, text: t.text, done: false, from: t.from || k, createdAt: t.createdAt });
    }
    nd.updatedAt = now;
    data.days[k] = nd;
  }
  if (!moved.length) return;
  const td = structuredClone(getDay(todayKey));
  const fresh = moved.filter(t => !td.tasks.some(x => x.id === t.id));
  fresh.sort((a, b) => a.from.localeCompare(b.from));
  td.tasks = [...fresh, ...td.tasks];
  td.updatedAt = now;
  data.days[todayKey] = td;
  changed();
}

export const exportJSON = () => JSON.stringify(data, null, 2);

export function importData(obj) {
  const now = Date.now();
  for (const [k, d] of Object.entries(obj.days || {})) {
    data.days[k] = { ...emptyDay(), ...d };
    data.days[k] = { ...getDay(k), updatedAt: now };
  }
  changed();
}

// ---------- Sincronización con Google Drive ----------

let auth = null; // { getToken, getEmail, onExpired }
let fileIds = {};
try { fileIds = JSON.parse(localStorage.getItem(LS_FILES)) || {}; } catch {}
let timer = null;
let running = false;
let again = false;

export function setDriveAuth(a) { auth = a; }

function setState(s) {
  if (syncInfo.state === s) return;
  syncInfo.state = s;
  emit('sync');
}

function queueSync(delay = 1500) {
  clearTimeout(timer);
  timer = setTimeout(syncNow, delay);
}

export const hasPendingSync = () => timer !== null;

export async function syncNow() {
  clearTimeout(timer);
  timer = null;
  const token = auth?.getToken();
  const email = auth?.getEmail();
  if (!token) { setState(email ? 'expired' : 'local'); return; }
  if (running) { again = true; return; }
  running = true;
  setState('syncing');
  try {
    const { id, remote } = await readRemote(token, email);
    const { localChanged, remoteStale } = merge(remote);
    let fid = id;
    if (!fid || remoteStale) fid = await writeRemote(token, fid);
    if (fileIds[email] !== fid) {
      fileIds[email] = fid;
      try { localStorage.setItem(LS_FILES, JSON.stringify(fileIds)); } catch {}
    }
    if (localChanged) { saveLocal(); emit('data'); }
    syncInfo.at = Date.now();
    setState('ok');
  } catch (e) {
    if (e.status === 401) { auth.onExpired?.(); setState('expired'); }
    else { console.error('Error al sincronizar con Drive', e); setState('error'); }
  } finally {
    running = false;
    if (again) { again = false; queueSync(300); }
  }
}

// Se queda con la versión más nueva de cada día (y de la lista de hábitos).
function merge(remote) {
  let localChanged = false;
  let remoteStale = false;
  if (!remote?.days) return { localChanged, remoteStale: true };
  const keys = new Set([...Object.keys(data.days), ...Object.keys(remote.days)]);
  for (const k of keys) {
    const lt = data.days[k]?.updatedAt || 0;
    const rt = remote.days[k]?.updatedAt || 0;
    if (rt > lt) { data.days[k] = remote.days[k]; localChanged = true; }
    else if (lt > rt) remoteStale = true;
  }
  return { localChanged, remoteStale };
}

async function driveFetch(token, url, opts = {}) {
  const res = await fetch(url, { ...opts, headers: { Authorization: `Bearer ${token}`, ...(opts.headers || {}) } });
  if (!res.ok) {
    const e = new Error(`Drive respondió ${res.status}`);
    e.status = res.status;
    throw e;
  }
  return res;
}

async function readRemote(token, email) {
  let id = fileIds[email];
  if (id) {
    try {
      return { id, remote: await (await driveFetch(token, `${DRIVE}/files/${id}?alt=media`)).json() };
    } catch (e) {
      if (e.status !== 404) throw e;
    }
  }
  const q = encodeURIComponent(`name='${DRIVE_FILE_NAME}'`);
  const list = await (await driveFetch(token, `${DRIVE}/files?spaces=appDataFolder&q=${q}&fields=files(id)`)).json();
  id = list.files?.[0]?.id;
  if (!id) return { id: null, remote: null };
  return { id, remote: await (await driveFetch(token, `${DRIVE}/files/${id}?alt=media`)).json() };
}

async function writeRemote(token, id) {
  const body = JSON.stringify(data);
  if (id) {
    await driveFetch(token, `${DRIVE_UP}/files/${id}?uploadType=media`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body,
    });
    return id;
  }
  const b = 'agenda' + Math.random().toString(36).slice(2);
  const meta = JSON.stringify({ name: DRIVE_FILE_NAME, parents: ['appDataFolder'] });
  const multipart =
    `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n` +
    `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${body}\r\n--${b}--`;
  const res = await driveFetch(token, `${DRIVE_UP}/files?uploadType=multipart&fields=id`, {
    method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${b}` }, body: multipart,
  });
  return (await res.json()).id;
}
