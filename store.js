// Datos de la agenda (notas, tareas, hábitos, ánimo).
// Se guardan siempre en este navegador y, si hay una cuenta principal conectada,
// se sincronizan con un archivo oculto (appDataFolder) en su Google Drive.

const LS_DATA = 'agenda.data.v1';
const LS_FILES = 'agenda.driveFiles.v1';
const DRIVE_FILE_NAME = 'mi-agenda-datos.json';
const DRIVE = 'https://www.googleapis.com/drive/v3';
const DRIVE_UP = 'https://www.googleapis.com/upload/drive/v3';

const DEFAULT_HABITS = [
  { id: 'agua', emoji: '💧', name: 'Agua' },
  { id: 'ejercicio', emoji: '🏃', name: 'Ejercicio' },
  { id: 'lectura', emoji: '📖', name: 'Lectura' },
  { id: 'descanso', emoji: '😴', name: 'Dormir bien' },
];

const emptyData = () => ({ version: 1, days: {}, habits: DEFAULT_HABITS, habitsUpdatedAt: 0 });
const emptyDay = () => ({ note: '', tasks: [], habits: {}, mood: null, updatedAt: 0 });

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

export function getDay(key) {
  const d = data.days[key];
  return d ? { ...emptyDay(), ...d } : emptyDay();
}

export function updateDay(key, fn) {
  const d = structuredClone(getDay(key));
  fn(d);
  d.updatedAt = Date.now();
  data.days[key] = d;
  changed();
}

export const getHabits = () => data.habits;

export function setHabits(list) {
  data.habits = list;
  data.habitsUpdatedAt = Date.now();
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
      moved.push({ id: t.id, text: t.text, done: false, from: t.from || k });
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
  for (const [k, d] of Object.entries(obj.days || {})) data.days[k] = { ...emptyDay(), ...d, updatedAt: now };
  if (Array.isArray(obj.habits)) { data.habits = obj.habits; data.habitsUpdatedAt = now; }
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
  const lh = data.habitsUpdatedAt || 0;
  const rh = remote.habitsUpdatedAt || 0;
  if (rh > lh && Array.isArray(remote.habits)) {
    data.habits = remote.habits;
    data.habitsUpdatedAt = rh;
    localChanged = true;
  } else if (lh > rh) remoteStale = true;
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
