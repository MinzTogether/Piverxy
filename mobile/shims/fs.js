// Node `fs` for the iOS build. server.js mixes sync and async calls, so every file lives in an
// in-memory index (text files keep their contents; audio/images only size + mtime) and writes go
// through to the store in the background. init() must finish before server.js is required.
const path = require('path');
const store = require('./store');
const { appCache } = require('../app-cache');

const TEXT_EXT = /\.(json|lrc|txt)$/i;
// A text file changed in the last few seconds (or listed without a real time) is not remembered by the app cache:
// it may still be written to, and size + time would then not tell the copies apart.
const SETTLE_MS = 2000;
let cacheSaved = Promise.resolve(); // the app cache's last background save (tests wait on it)
const note = (msg) => { try { if (globalThis.PiverxyLog) globalThis.PiverxyLog.add('info', msg); } catch (_) {} };
const nodes = new Map(); // vpath -> { isDir, size, mtimeMs, text? }
let chain = Promise.resolve();
// a failed write (storage full) used to look saved until the next launch: log it and tell the app
const persist = (fn) => {
  chain = chain.then(fn).catch((e) => {
    console.warn('[fs] persist failed', e);
    try { window.dispatchEvent(new CustomEvent('piverxy:storage-error', { detail: String((e && e.message) || e) })); } catch (_) {}
  });
  return chain;
};

const norm = (p) => path.resolve('/', String(p).replace(/\\/g, '/'));
const err = (code, p) => Object.assign(new Error(`${code}: ${p}`), { code, path: p });

function ensureParents(p) {
  let dir = path.dirname(p);
  while (dir && dir !== '/' && !nodes.has(dir)) {
    nodes.set(dir, { isDir: true, size: 0, mtimeMs: Date.now() });
    dir = path.dirname(dir);
  }
}

function makeStat(n) {
  return {
    size: n.size, mtimeMs: n.mtimeMs, mtime: new Date(n.mtimeMs), atimeMs: n.mtimeMs, ctimeMs: n.mtimeMs,
    isFile: () => !n.isDir, isDirectory: () => n.isDir,
  };
}

function childrenOf(dir) {
  const prefix = dir === '/' ? '/' : dir + '/';
  const out = [];
  for (const [p, n] of nodes) {
    if (p.startsWith(prefix) && !p.slice(prefix.length).includes('/') && p !== dir) out.push([path.basename(p), n]);
  }
  return out;
}

function toText(data, enc) {
  if (typeof data === 'string') return data;
  if (data instanceof Uint8Array) return new TextDecoder().decode(data);
  return String(data);
}

function bytesOf(data) {
  if (typeof data === 'string') return new TextEncoder().encode(data);
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

function writeSyncImpl(p, data) {
  p = norm(p);
  ensureParents(p);
  const isText = TEXT_EXT.test(p) || typeof data === 'string';
  const bytes = bytesOf(data);
  nodes.set(p, { isDir: false, size: bytes.length, mtimeMs: Date.now(), text: isText ? toText(data) : undefined });
  return persist(() => (isText ? store.writeText(p, toText(data)) : store.writeBytes(p, bytes)));
}

function removeTree(p) {
  for (const k of [...nodes.keys()]) if (k === p || k.startsWith(p + '/')) nodes.delete(k);
}

const fs = {
  constants: { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 },

  async init() {
    const t0 = Date.now();
    const cachedPromise = appCache.loadTexts();
    const entries = await store.list();
    const listed = Date.now();
    nodes.set('/data', { isDir: true, size: 0, mtimeMs: Date.now() });
    for (const e of entries) nodes.set(e.vpath, { isDir: e.isDir, size: e.size, mtimeMs: e.mtimeMs });
    const texts = entries.filter((e) => !e.isDir && TEXT_EXT.test(e.vpath));
    // App cache: a text file whose size and time are what they were when it was last read is not read over the
    // bridge again (one call per file, every launch, and lyrics pile up with use). Anything else is read as before.
    const cached = await cachedPromise;
    const misses = [];
    for (const e of texts) {
      const hit = cached.get(e.vpath);
      if (hit && hit.size === e.size && hit.mtimeMs === e.mtimeMs) nodes.get(e.vpath).text = hit.text;
      else misses.push(e);
    }
    const fresh = [];
    await Promise.all(misses.map(async (e) => {
      try {
        const text = await store.readText(e.vpath);
        nodes.get(e.vpath).text = text;
        if (typeof text === 'string' && e.mtimeMs <= t0 - SETTLE_MS) fresh.push({ p: e.vpath, size: e.size, mtimeMs: e.mtimeMs, text });
      } catch (x) {}
    }));
    // remembered in the background: the start never waits for it
    cacheSaved = appCache.saveTexts(fresh, new Set(texts.map((e) => e.vpath))).catch(() => false);
    note(`start: ${entries.length} entries listed in ${listed - t0} ms; ${texts.length} text files, ${texts.length - misses.length} from the app cache, ${misses.length} read; ready in ${Date.now() - t0} ms`);
  },
  _cacheSaved: () => cacheSaved,

  // Called by the stream bridge after a native download lands on disk.
  _register(p, size) {
    p = norm(p);
    ensureParents(p);
    nodes.set(p, { isDir: false, size, mtimeMs: Date.now() });
  },
  _flush: () => chain,
  // A picked file (File/Blob) straight to disk, in pieces: never read into memory whole (store.writeBlob).
  // Resolves once it's written; if that failed, the file isn't there.
  _writeBlob(p, blob) {
    p = norm(p);
    ensureParents(p);
    nodes.set(p, { isDir: false, size: blob.size, mtimeMs: Date.now() });
    return persist(() => store.writeBlob(p, blob).catch((e) => { nodes.delete(p); throw e; }));
  },

  existsSync: (p) => nodes.has(norm(p)),
  accessSync: (p) => { if (!nodes.has(norm(p))) throw err('ENOENT', p); },
  chmodSync: () => {},

  mkdirSync(p) {
    p = norm(p);
    if (nodes.has(p)) return;
    ensureParents(p);
    nodes.set(p, { isDir: true, size: 0, mtimeMs: Date.now() });
    persist(() => store.mkdir(p));
  },
  mkdtempSync(prefix) {
    const p = norm(prefix + Math.random().toString(36).slice(2, 8));
    fs.mkdirSync(p);
    return p;
  },

  readFileSync(p, enc) {
    const n = nodes.get(norm(p));
    if (!n || n.isDir) throw err('ENOENT', p);
    if (n.text === undefined) throw err('EIO', p + ' (binary file not held in memory)');
    return n.text;
  },
  writeFileSync: (p, data) => { writeSyncImpl(p, data); },

  statSync(p) {
    const n = nodes.get(norm(p));
    if (!n) throw err('ENOENT', p);
    return makeStat(n);
  },
  readdirSync(p, opts) {
    p = norm(p);
    if (!nodes.has(p)) throw err('ENOENT', p);
    const kids = childrenOf(p);
    if (opts && opts.withFileTypes) return kids.map(([name, n]) => ({ name, isFile: () => !n.isDir, isDirectory: () => n.isDir }));
    return kids.map(([name]) => name);
  },
  unlinkSync(p) {
    p = norm(p);
    if (!nodes.has(p)) throw err('ENOENT', p);
    nodes.delete(p);
    persist(() => store.remove(p, false));
  },
  rmSync(p) {
    p = norm(p);
    const n = nodes.get(p);
    if (!n) return;
    removeTree(p);
    persist(() => store.remove(p, n.isDir));
  },
  renameSync(a, b) {
    a = norm(a); b = norm(b);
    const n = nodes.get(a);
    if (!n) throw err('ENOENT', a);
    nodes.delete(a);
    ensureParents(b);
    nodes.set(b, { ...n, mtimeMs: Date.now() });
    persist(() => store.rename(a, b));
  },
  copyFileSync(a, b) {
    a = norm(a); b = norm(b);
    const n = nodes.get(a);
    if (!n) throw err('ENOENT', a);
    ensureParents(b);
    nodes.set(b, { ...n, mtimeMs: Date.now() });
    persist(() => store.copy(a, b));
  },

  // Audio/thumbnail routes pipe a file into the response; the fake response turns that into a file URL.
  createReadStream(p, opts) {
    const vpath = norm(p);
    return { __vpath: vpath, on() { return this; }, pipe(dest) { if (dest.__pipeFile) dest.__pipeFile(vpath); return dest; } };
  },
  createWriteStream() {
    throw err('ENOTSUP', 'createWriteStream');
  },
};

fs.promises = {
  stat: async (p) => fs.statSync(p),
  readdir: async (p, opts) => fs.readdirSync(p, opts),
  readFile: async (p, enc) => fs.readFileSync(p, enc),
  writeFile: async (p, data) => { await writeSyncImpl(p, data); },
  unlink: async (p) => fs.unlinkSync(p),
  rename: async (a, b) => fs.renameSync(a, b),
  copyFile: async (a, b) => fs.copyFileSync(a, b),
  mkdir: async (p) => fs.mkdirSync(p),
  rmdir: async (p) => fs.rmSync(p),
  rm: async (p) => fs.rmSync(p),
  utimes: async (p) => { const n = nodes.get(norm(p)); if (n) n.mtimeMs = Date.now(); },
};

module.exports = fs;
