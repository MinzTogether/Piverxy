// fs.init() with the app cache: what is read over the bridge at each launch, and what the server then sees.
const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const path = require('path');
const { IDBFactory } = require('fake-indexeddb');
const { createAppCache, ON_KEY } = require('../mobile/app-cache.js');

const HOUR = 60 * 60 * 1000;
const entry = (vpath, size, mtimeMs, isDir = false) => ({ vpath, isDir, size, mtimeMs });
const memStorage = (init = {}) => {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
};

// the data folder as the store lists it; readText counts the trips over the bridge
function makeStore(files) {
  const stub = {
    reads: [],
    async list() { return [entry('/data/lyrics', 0, Date.now() - HOUR, true), ...[...files].map(([v, f]) => entry(v, f.size, f.mtimeMs))]; },
    async readText(v) { stub.reads.push(v); const f = files.get(v); if (!f) throw new Error('unreadable'); return f.text; },
  };
  return stub;
}
const file = (text, ageMs = HOUR) => ({ text, size: Buffer.byteLength(text), mtimeMs: Date.now() - ageMs });

// one "launch": a fresh copy of shims/fs.js (the app process starts empty) over the same IndexedDB
function launch(stub, cache) {
  for (const k of Object.keys(require.cache)) if (/[\\/]mobile[\\/]shims[\\/]fs\.js$/.test(k)) delete require.cache[k];
  const orig = Module._load;
  Module._load = function (request, parent) {
    const from = (parent && parent.filename) || '';
    if (/shims[\\/]fs\.js$/.test(from)) {
      if (request === './store') return stub;
      if (request === '../app-cache') return { appCache: cache };
    }
    return orig.apply(this, arguments);
  };
  try { return require(path.join(__dirname, '../mobile/shims/fs.js')); } finally { Module._load = orig; }
}
const cacheOver = (idb, storage = memStorage()) => createAppCache({ indexedDB: idb, storage, loadTimeoutMs: 200, openTimeoutMs: 200 });

function library() {
  return new Map([
    ['/data/lyrics/a.lrc', file('[00:01.00] first line')],
    ['/data/lyrics/b.lrc', file('[00:02.00] second line')],
    ['/data/metadata.json', file('{"tracks":[1,2,3]}')],
    ['/data/tracks/song.mp3', { text: 'not text', size: 4_000_000, mtimeMs: Date.now() - HOUR }],
  ]);
}

test('start: the first launch reads every text file, the next one reads none of them', async () => {
  const idb = new IDBFactory();
  const files = library();

  const s1 = makeStore(files);
  const fs1 = launch(s1, cacheOver(idb));
  await fs1.init();
  await fs1._cacheSaved();
  assert.deepStrictEqual(s1.reads.sort(), ['/data/lyrics/a.lrc', '/data/lyrics/b.lrc', '/data/metadata.json']);
  assert.strictEqual(fs1.readFileSync('/data/lyrics/a.lrc', 'utf8'), '[00:01.00] first line');

  const s2 = makeStore(files);
  const fs2 = launch(s2, cacheOver(idb));
  await fs2.init();
  assert.deepStrictEqual(s2.reads, [], 'nothing went over the bridge');
  assert.strictEqual(fs2.readFileSync('/data/lyrics/a.lrc', 'utf8'), '[00:01.00] first line');
  assert.strictEqual(fs2.readFileSync('/data/lyrics/b.lrc', 'utf8'), '[00:02.00] second line');
  assert.strictEqual(fs2.readFileSync('/data/metadata.json', 'utf8'), '{"tracks":[1,2,3]}');
  assert.ok(fs2.existsSync('/data/tracks/song.mp3'), 'audio is still listed');
  assert.strictEqual(fs2.statSync('/data/tracks/song.mp3').size, 4_000_000);
});

test('start: a file that changed is read again and its new text is what the server gets', async () => {
  const idb = new IDBFactory();
  const files = library();
  const fs1 = launch(makeStore(files), cacheOver(idb));
  await fs1.init();
  await fs1._cacheSaved();

  files.set('/data/lyrics/a.lrc', file('[00:01.00] rewritten and longer'));        // other size and time
  files.set('/data/lyrics/b.lrc', { ...file('[00:02.00] second LINE'), size: files.get('/data/lyrics/b.lrc').size }); // same size, other time
  const s2 = makeStore(files);
  const fs2 = launch(s2, cacheOver(idb));
  await fs2.init();
  assert.deepStrictEqual(s2.reads.sort(), ['/data/lyrics/a.lrc', '/data/lyrics/b.lrc']);
  assert.strictEqual(fs2.readFileSync('/data/lyrics/a.lrc', 'utf8'), '[00:01.00] rewritten and longer');
  assert.strictEqual(fs2.readFileSync('/data/lyrics/b.lrc', 'utf8'), '[00:02.00] second LINE');
  assert.strictEqual(fs2.readFileSync('/data/metadata.json', 'utf8'), '{"tracks":[1,2,3]}');
  await fs2._cacheSaved();

  const s3 = makeStore(files);
  await launch(s3, cacheOver(idb)).init();
  assert.deepStrictEqual(s3.reads, [], 'and the new copies are remembered in turn');
});

test('start: a file touched in the last seconds is not remembered', async () => {
  const idb = new IDBFactory();
  const files = library();
  files.set('/data/metadata.json', file('{"fresh":true}', 300)); // written 0.3 s before the launch
  const fs1 = launch(makeStore(files), cacheOver(idb));
  await fs1.init();
  await fs1._cacheSaved();
  const s2 = makeStore(files);
  await launch(s2, cacheOver(idb)).init();
  assert.deepStrictEqual(s2.reads, ['/data/metadata.json']);
});

test('start: a file that is gone is forgotten, one that cannot be read is not remembered', async () => {
  const idb = new IDBFactory();
  const files = library();
  const fs1 = launch(makeStore(files), cacheOver(idb));
  await fs1.init();
  await fs1._cacheSaved();
  files.delete('/data/lyrics/b.lrc');
  const fs2 = launch(makeStore(files), cacheOver(idb));
  await fs2.init();
  await fs2._cacheSaved();
  assert.ok(!(await cacheOver(idb).loadTexts()).has('/data/lyrics/b.lrc'));

  const broken = new Map([...library(), ['/data/lyrics/c.lrc', file('[00:03.00] third')]]);
  const sb = makeStore(broken);
  const realRead = sb.readText;
  sb.readText = async (v) => { if (v === '/data/lyrics/c.lrc') throw new Error('EIO'); return realRead(v); };
  const fsb = launch(sb, cacheOver(idb));
  await fsb.init(); // must not fail
  await fsb._cacheSaved();
  assert.ok(!(await cacheOver(idb).loadTexts()).has('/data/lyrics/c.lrc'));
});

test('start: with the app cache switched off every file is read, every launch', async () => {
  const idb = new IDBFactory();
  const off = memStorage({ [ON_KEY]: '0' });
  const files = library();
  for (let i = 0; i < 2; i++) {
    const s = makeStore(files);
    const f = launch(s, cacheOver(idb, off));
    await f.init();
    await f._cacheSaved();
    assert.strictEqual(s.reads.length, 3);
    assert.strictEqual(f.readFileSync('/data/lyrics/a.lrc', 'utf8'), '[00:01.00] first line');
  }
  assert.strictEqual((await cacheOver(idb).loadTexts()).size, 0, 'and nothing was kept');
});

test('start: a broken IndexedDB changes nothing for the app', async () => {
  const files = library();
  const broken = createAppCache({ indexedDB: { open() { throw new Error('no storage'); } }, storage: memStorage(), loadTimeoutMs: 50, openTimeoutMs: 50 });
  const s = makeStore(files);
  const f = launch(s, broken);
  await f.init();
  await f._cacheSaved();
  assert.strictEqual(s.reads.length, 3);
  assert.strictEqual(f.readFileSync('/data/metadata.json', 'utf8'), '{"tracks":[1,2,3]}');
});

test('start: the launch writes one line about itself to the log', async () => {
  const lines = [];
  globalThis.MurielLog = { add: (level, msg) => lines.push([level, msg]) };
  try {
    const idb = new IDBFactory();
    const files = library();
    const f1 = launch(makeStore(files), cacheOver(idb));
    await f1.init();
    await f1._cacheSaved();
    const f2 = launch(makeStore(files), cacheOver(idb));
    await f2.init();
  } finally { delete globalThis.MurielLog; }
  assert.strictEqual(lines.length, 2);
  assert.match(lines[0][1], /3 text files, 0 from the app cache, 3 read/);
  assert.match(lines[1][1], /3 text files, 3 from the app cache, 0 read/);
});
