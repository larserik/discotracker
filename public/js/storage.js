// Local autosave in IndexedDB so work survives a reload, signed in or not.
const DB = 'discotracker';
const STORE = 'kv';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => { db.close(); resolve(req?.result); };
    t.onerror = () => { db.close(); reject(t.error); };
  });
}

export async function idbGet(key) {
  try { return await tx('readonly', (s) => s.get(key)); } catch { return undefined; }
}
export async function idbSet(key, value) {
  try { await tx('readwrite', (s) => s.put(value, key)); } catch (e) { console.warn('autosave failed', e); }
}

export const local = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  remove(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

// ---------------------------------------------------------------------------
// Drafts: songs in progress kept in this browser ("My songs → On this device").
// 'drafts' holds the list of metadata, 'draft:<id>' the song data.

export function newDraftId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export async function listDrafts() {
  const list = (await idbGet('drafts')) || [];
  return list.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getDraft(id) {
  return idbGet('draft:' + id);
}

/** draft = { id, title, data(Uint8Array XM), format, channelPan, serverSong, updatedAt } */
export async function putDraft(draft) {
  await idbSet('draft:' + draft.id, draft);
  const list = ((await idbGet('drafts')) || []).filter((d) => d.id !== draft.id);
  list.push({ id: draft.id, title: draft.title, format: draft.format, size: draft.data.length, serverSong: draft.serverSong || null, updatedAt: draft.updatedAt });
  await idbSet('drafts', list);
}

export async function deleteDraft(id) {
  try { await tx('readwrite', (s) => s.delete('draft:' + id)); } catch { /* ignore */ }
  const list = ((await idbGet('drafts')) || []).filter((d) => d.id !== id);
  await idbSet('drafts', list);
}
