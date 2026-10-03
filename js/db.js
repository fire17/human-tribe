// On-device storage. IndexedDB first; if it is blocked (private window, disabled site data)
// we fall back to memory and the UI says so loudly — nothing ever goes to a server.

const DB_NAME = 'human-tribe';
const DB_VERSION = 1;
const STORES = ['people', 'shelters', 'meta'];

let idb = null;
let mem = null;
export let mode = 'unknown'; // 'idb' | 'memory'

function req(r) {
  return new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
}

export async function open() {
  try {
    if (!('indexedDB' in globalThis) || !globalThis.indexedDB) throw new Error('no indexedDB');
    idb = await new Promise((resolve, reject) => {
      const r = indexedDB.open(DB_NAME, DB_VERSION);
      r.onupgradeneeded = () => {
        const db = r.result;
        for (const s of STORES) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: 'id' });
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.onblocked = () => reject(new Error('blocked'));
    });
    // A probe write proves the store actually persists (some private modes open then throw).
    await put('meta', { id: '_probe', at: Date.now() });
    mode = 'idb';
  } catch (e) {
    console.warn('IndexedDB unavailable, using memory', e);
    idb = null;
    mem = Object.fromEntries(STORES.map(s => [s, new Map()]));
    mode = 'memory';
  }
  return mode;
}

function tx(store, rw = 'readonly') {
  return idb.transaction(store, rw).objectStore(store);
}

export async function getAll(store) {
  try {
    if (idb) return await req(tx(store).getAll());
    return [...mem[store].values()].map(clone);
  } catch (e) { console.error('getAll', store, e); return []; }
}
export async function get(store, id) {
  try {
    if (idb) return (await req(tx(store).get(id))) || null;
    return mem[store].has(id) ? clone(mem[store].get(id)) : null;
  } catch (e) { console.error('get', store, e); return null; }
}
export async function put(store, obj) {
  if (idb) {
    const t = idb.transaction(store, 'readwrite');
    t.objectStore(store).put(obj);
    await new Promise((resolve, reject) => { t.oncomplete = resolve; t.onerror = () => reject(t.error); t.onabort = () => reject(t.error); });
    return;
  }
  mem[store].set(obj.id, clone(obj));
}
export async function putMany(store, list) {
  if (!list.length) return;
  if (idb) {
    const t = idb.transaction(store, 'readwrite');
    const os = t.objectStore(store);
    for (const o of list) os.put(o);
    await new Promise((resolve, reject) => { t.oncomplete = resolve; t.onerror = () => reject(t.error); t.onabort = () => reject(t.error); });
    return;
  }
  for (const o of list) mem[store].set(o.id, clone(o));
}
export async function del(store, id) {
  if (idb) {
    const t = idb.transaction(store, 'readwrite');
    t.objectStore(store).delete(id);
    await new Promise((resolve, reject) => { t.oncomplete = resolve; t.onerror = () => reject(t.error); });
    return;
  }
  mem[store].delete(id);
}
export async function clearAll() {
  if (idb) {
    const t = idb.transaction(STORES, 'readwrite');
    for (const s of STORES) t.objectStore(s).clear();
    await new Promise((resolve, reject) => { t.oncomplete = resolve; t.onerror = () => reject(t.error); });
    return;
  }
  for (const s of STORES) mem[s].clear();
}

// Replace people + shelters in ONE transaction: if any put fails (quota, bad record, tab killed),
// the whole thing rolls back and the phone keeps what it had. Meta (rounds, backup date) is kept.
export async function replaceAll(people, shelters) {
  if (idb) {
    const t = idb.transaction(['people', 'shelters'], 'readwrite');
    const done = new Promise((resolve, reject) => { t.oncomplete = resolve; t.onerror = () => reject(t.error); t.onabort = () => reject(t.error || new Error('aborted')); });
    try {
      const ps = t.objectStore('people'), ss = t.objectStore('shelters');
      ps.clear(); ss.clear();
      for (const o of people) ps.put(o);
      for (const o of shelters) ss.put(o);
    } catch (e) { try { t.abort(); } catch { /* already finished */ } await done.catch(() => {}); throw e; }
    await done;
    return;
  }
  const np = new Map(people.map(o => [o.id, clone(o)])), ns = new Map(shelters.map(o => [o.id, clone(o)]));
  mem.people = np; mem.shelters = ns;
}

export async function getMeta(key, fallback = null) {
  const r = await get('meta', key);
  return r ? r.value : fallback;
}
export async function setMeta(key, value) {
  try { await put('meta', { id: key, value }); } catch (e) { console.error('setMeta', e); }
}

function clone(o) { return JSON.parse(JSON.stringify(o)); }
