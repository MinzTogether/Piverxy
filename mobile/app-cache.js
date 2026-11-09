// App cache for the phone build: things the app would otherwise rebuild on every launch, kept in IndexedDB (the
// WebView's own storage, no trips over the Capacitor bridge) so the next launch starts faster.
//   texts  the contents of the data folder's small text files (lyrics, metadata, ...), used only when the file's
//          size and time are still what they were, so fs.init() can skip reading the ones that did not change
//   blobs  what youtubei.js keeps between launches: the YouTube player script it has analysed (~2.5 MB to fetch
//          and take apart on every cold start otherwise)
// It is only ever an accelerator. Nothing here throws: a missing, failed, slow or switched-off store reads as
// "nothing cached" and the caller then does exactly what it did before the cache existed. Settings > Storage can
// switch it off (this device, key muriel_app_cache = '0') and clear it.
const DB_NAME = 'muriel-app-cache';
const DB_VERSION = 1;
const TEXTS = 'texts'; // keyPath p: { p, size, mtimeMs, text }
const BLOBS = 'blobs'; // keyPath k: { k, v: ArrayBuffer, at }
const ON_KEY = 'muriel_app_cache';
const OPEN_TIMEOUT_MS = 4000;
const LOAD_TIMEOUT_MS = 2500;
const MAX_FILE_CHARS = 8 * 1024 * 1024; // a bigger text file is read from disk each time
const MAX_BATCH_CHARS = 64 * 1024 * 1024; // safety valve; the store never holds more than the files that exist
const MAX_BLOBS = 3; // YouTube changes its player every week or two: keep the newest few

function withTimeout(promise, ms, fallback) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(fallback), ms);
    Promise.resolve(promise).then((v) => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(fallback); });
  });
}

// ArrayBuffer, typed array or DataView -> an ArrayBuffer of exactly those bytes (a view may cover part of its buffer)
function toArrayBuffer(v) {
  if (v instanceof ArrayBuffer) return v.slice(0);
  if (ArrayBuffer.isView(v)) return v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength);
  return null;
}

function createAppCache(deps = {}) {
  const idb = 'indexedDB' in deps ? deps.indexedDB : (typeof indexedDB !== 'undefined' ? indexedDB : null);
  const getStorage = () => {
    if ('storage' in deps) return deps.storage;
    try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch (e) { return null; }
  };
  const now = deps.now || Date.now;
  const openTimeoutMs = deps.openTimeoutMs || OPEN_TIMEOUT_MS;
  const loadTimeoutMs = deps.loadTimeoutMs || LOAD_TIMEOUT_MS;

  const isOn = () => {
    try { const s = getStorage(); return !s || s.getItem(ON_KEY) !== '0'; } catch (e) { return true; }
  };

  let dbPromise = null;
  function openDb() {
    if (!idb) return Promise.resolve(null);
    if (!dbPromise) {
      dbPromise = new Promise((resolve) => {
        let settled = false;
        let timer = null;
        const done = (db) => {
          if (settled) { if (db) { try { db.close(); } catch (e) {} } return; }
          settled = true;
          clearTimeout(timer);
          resolve(db || null);
        };
        timer = setTimeout(() => done(null), openTimeoutMs);
        try {
          const req = idb.open(DB_NAME, DB_VERSION);
          req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(TEXTS)) db.createObjectStore(TEXTS, { keyPath: 'p' });
            if (!db.objectStoreNames.contains(BLOBS)) db.createObjectStore(BLOBS, { keyPath: 'k' });
          };
          req.onsuccess = () => {
            const db = req.result;
            db.onversionchange = () => { try { db.close(); } catch (e) {} dbPromise = null; };
            done(db);
          };
          req.onerror = () => done(null);
          req.onblocked = () => done(null);
        } catch (e) { done(null); }
      });
    }
    return dbPromise;
  }

  // One transaction. work(tx) may return the request whose result the caller wants. Resolves { ok, value }; never rejects.
  function run(db, names, mode, work) {
    return new Promise((resolve) => {
      let tx = null;
      let req = null;
      try {
        tx = db.transaction(names, mode);
        tx.oncomplete = () => resolve({ ok: true, value: req ? req.result : undefined });
        tx.onerror = () => resolve({ ok: false });
        tx.onabort = () => resolve({ ok: false });
        req = work(tx) || null;
      } catch (e) {
        try { if (tx) tx.abort(); } catch (_) {}
        resolve({ ok: false });
      }
    });
  }

  // ---- text files (fs.init) ----
  // Map of vpath -> { size, mtimeMs, text }. The caller checks size and time against the real file.
  async function loadTexts() {
    const out = new Map();
    try {
      if (!isOn()) return out;
      const db = await withTimeout(openDb(), loadTimeoutMs, null);
      if (!db) return out;
      const r = await withTimeout(run(db, TEXTS, 'readonly', (tx) => tx.objectStore(TEXTS).getAll()), loadTimeoutMs, { ok: false });
      if (r.ok && Array.isArray(r.value)) {
        for (const rec of r.value) if (rec && typeof rec.p === 'string' && typeof rec.text === 'string') out.set(rec.p, rec);
      }
    } catch (e) {}
    return out;
  }

  // records: the files read this launch ({ p, size, mtimeMs, text }); present: every text file that exists now,
  // so what was deleted since is dropped from the store too.
  async function saveTexts(records, present) {
    try {
      if (!isOn()) return false;
      const db = await openDb();
      if (!db) return false;
      let budget = MAX_BATCH_CHARS;
      const keep = [];
      for (const rec of records || []) {
        const n = rec && typeof rec.text === 'string' ? rec.text.length : -1;
        if (n < 0 || n > MAX_FILE_CHARS || n > budget) continue;
        budget -= n;
        keep.push({ p: rec.p, size: rec.size, mtimeMs: rec.mtimeMs, text: rec.text });
      }
      if (!keep.length && !present) return true;
      const r = await run(db, TEXTS, 'readwrite', (tx) => {
        const s = tx.objectStore(TEXTS);
        if (present) {
          const keys = s.getAllKeys();
          keys.onsuccess = () => { for (const k of keys.result) if (!present.has(k)) s.delete(k); };
        }
        for (const rec of keep) s.put(rec);
      });
      return r.ok;
    } catch (e) { return false; }
  }

  // ---- youtubei.js cache (the interface it expects: cache_dir, get, set, remove) ----
  // namespace: the youtubei.js version. Its entries are only read back by the same version, so an app update that
  // brings a fixed one never inherits what the old one made of a player.
  function youtubeCache(namespace = '') {
    if (!idb || !isOn()) return null;
    const id = (key) => (namespace ? `${namespace}:` : '') + String(key);
    return {
      cache_dir: DB_NAME,
      async get(key) {
        try {
          if (!isOn()) return undefined;
          const db = await openDb();
          if (!db) return undefined;
          const r = await run(db, BLOBS, 'readonly', (tx) => tx.objectStore(BLOBS).get(id(key)));
          const buf = r.ok && r.value ? toArrayBuffer(r.value.v) : null;
          return buf || undefined;
        } catch (e) { return undefined; }
      },
      async set(key, value) {
        try {
          if (!isOn()) return;
          const buf = toArrayBuffer(value);
          const db = await openDb();
          if (!buf || !db) return;
          const put = await run(db, BLOBS, 'readwrite', (tx) => { tx.objectStore(BLOBS).put({ k: id(key), v: buf, at: now() }); });
          if (!put.ok) return;
          await run(db, BLOBS, 'readwrite', (tx) => {
            const s = tx.objectStore(BLOBS);
            const all = s.getAll();
            all.onsuccess = () => {
              const rows = (all.result || []).sort((a, b) => (b.at || 0) - (a.at || 0));
              for (const row of rows.slice(MAX_BLOBS)) s.delete(row.k);
            };
          });
        } catch (e) {}
      },
      async remove(key) {
        try {
          const db = await openDb();
          if (db) await run(db, BLOBS, 'readwrite', (tx) => { tx.objectStore(BLOBS).delete(id(key)); });
        } catch (e) {}
      },
    };
  }

  // ---- Settings ----
  async function stats() {
    const out = { on: isOn(), available: !!idb, files: 0, fileBytes: 0, blobs: 0, blobBytes: 0, bytes: 0 };
    try {
      const db = await withTimeout(openDb(), loadTimeoutMs, null);
      if (db) {
        const t = await run(db, TEXTS, 'readonly', (tx) => tx.objectStore(TEXTS).getAll());
        if (t.ok) for (const rec of t.value || []) { out.files++; out.fileBytes += String((rec && rec.text) || '').length; }
        const b = await run(db, BLOBS, 'readonly', (tx) => tx.objectStore(BLOBS).getAll());
        if (b.ok) for (const rec of b.value || []) { out.blobs++; out.blobBytes += (rec && rec.v && rec.v.byteLength) || 0; }
      }
    } catch (e) {}
    out.bytes = out.fileBytes + out.blobBytes;
    return out;
  }

  async function clear() {
    try {
      const db = await openDb();
      if (!db) return false;
      const r = await run(db, [TEXTS, BLOBS], 'readwrite', (tx) => { tx.objectStore(TEXTS).clear(); tx.objectStore(BLOBS).clear(); });
      return r.ok;
    } catch (e) { return false; }
  }

  async function setOn(on) {
    try { const s = getStorage(); if (s) s.setItem(ON_KEY, on ? '1' : '0'); } catch (e) {}
    if (!on) await clear(); // off means nothing is kept
    return isOn();
  }

  return { isOn, setOn, loadTexts, saveTexts, youtubeCache, stats, clear };
}

module.exports = { createAppCache, appCache: createAppCache(), ON_KEY, DB_NAME, MAX_BLOBS };
