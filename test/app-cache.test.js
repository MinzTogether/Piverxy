const test = require('node:test');
const assert = require('node:assert');
const { IDBFactory } = require('fake-indexeddb');
const { createAppCache, ON_KEY, MAX_BLOBS } = require('../mobile/app-cache.js');

const memStorage = (init = {}) => {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
};
const make = (extra = {}) => createAppCache({ indexedDB: new IDBFactory(), storage: memStorage(), ...extra });
const rec = (p, text, mtimeMs = 1000) => ({ p, size: text.length, mtimeMs, text });

test('app cache: saved text files come back with their size and time', async () => {
  const c = make();
  assert.strictEqual((await c.loadTexts()).size, 0);
  assert.strictEqual(await c.saveTexts([rec('/data/lyrics/a.lrc', '[00:01] hello', 5), rec('/data/metadata.json', '{"a":1}', 9)], new Set(['/data/lyrics/a.lrc', '/data/metadata.json'])), true);
  const got = await c.loadTexts();
  assert.strictEqual(got.size, 2);
  assert.deepStrictEqual(got.get('/data/lyrics/a.lrc'), rec('/data/lyrics/a.lrc', '[00:01] hello', 5));
});

test('app cache: files that are gone are dropped, the rest and later additions stay', async () => {
  const c = make();
  await c.saveTexts([rec('/a.lrc', 'one'), rec('/b.lrc', 'two')], new Set(['/a.lrc', '/b.lrc']));
  await c.saveTexts([rec('/c.lrc', 'three')], new Set(['/a.lrc', '/c.lrc'])); // /b.lrc was deleted on disk
  assert.deepStrictEqual([...(await c.loadTexts()).keys()].sort(), ['/a.lrc', '/c.lrc']);
});

test('app cache: a changed file replaces its old copy', async () => {
  const c = make();
  await c.saveTexts([rec('/a.lrc', 'old', 1)], new Set(['/a.lrc']));
  await c.saveTexts([rec('/a.lrc', 'newer text', 2)], new Set(['/a.lrc']));
  const got = (await c.loadTexts()).get('/a.lrc');
  assert.strictEqual(got.text, 'newer text');
  assert.strictEqual(got.mtimeMs, 2);
});

test('app cache: a file over the size cap is not kept', async () => {
  const c = make();
  await c.saveTexts([rec('/huge.json', 'x'.repeat(8 * 1024 * 1024 + 1)), rec('/ok.json', '{}')], new Set(['/huge.json', '/ok.json']));
  assert.deepStrictEqual([...(await c.loadTexts()).keys()], ['/ok.json']);
});

test('app cache: switched off, nothing is read, kept or handed out; switching off clears it', async () => {
  const storage = memStorage();
  const c = createAppCache({ indexedDB: new IDBFactory(), storage });
  await c.saveTexts([rec('/a.lrc', 'one')], new Set(['/a.lrc']));
  assert.strictEqual((await c.loadTexts()).size, 1);
  assert.ok(c.youtubeCache());
  assert.strictEqual(await c.setOn(false), false);
  assert.strictEqual(storage.getItem(ON_KEY), '0');
  assert.strictEqual((await c.loadTexts()).size, 0);
  assert.strictEqual(await c.saveTexts([rec('/b.lrc', 'two')], new Set(['/b.lrc'])), false);
  assert.strictEqual(c.youtubeCache(), null);
  assert.strictEqual(await c.setOn(true), true);
  assert.strictEqual((await c.loadTexts()).size, 0, 'what was cleared stays cleared');
});

test('app cache: the YouTube player cache returns the exact bytes it was given', async () => {
  const c = make();
  const yc = c.youtubeCache();
  assert.strictEqual(await yc.get('abcd1234'), undefined);
  const whole = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  await yc.set('p1', whole.buffer);
  assert.deepStrictEqual([...new Uint8Array(await yc.get('p1'))], [1, 2, 3, 4, 5, 6, 7, 8]);
  // a view over part of a larger buffer: only the viewed bytes are kept
  await yc.set('p2', new Uint8Array(whole.buffer, 2, 3));
  const back = await yc.get('p2');
  assert.ok(back instanceof ArrayBuffer);
  assert.deepStrictEqual([...new Uint8Array(back)], [3, 4, 5]);
  await yc.remove('p1');
  assert.strictEqual(await yc.get('p1'), undefined);
  assert.strictEqual(await yc.get('p2') !== undefined, true);
});

test('app cache: only the newest few YouTube players are kept', async () => {
  let t = 1000;
  const c = make({ now: () => (t += 10) });
  const yc = c.youtubeCache();
  for (let i = 1; i <= MAX_BLOBS + 2; i++) await yc.set(`pl${i}`, new Uint8Array([i]).buffer);
  const kept = [];
  for (let i = 1; i <= MAX_BLOBS + 2; i++) if (await yc.get(`pl${i}`)) kept.push(i);
  assert.deepStrictEqual(kept, [3, 4, 5]);
});

test('app cache: stats count what is stored and clear() empties it', async () => {
  const c = make();
  await c.saveTexts([rec('/a.lrc', 'abcd'), rec('/b.lrc', 'xy')], new Set(['/a.lrc', '/b.lrc']));
  await c.youtubeCache().set('pl', new Uint8Array(100).buffer);
  const s = await c.stats();
  assert.deepStrictEqual([s.on, s.available, s.files, s.fileBytes, s.blobs, s.blobBytes, s.bytes], [true, true, 2, 6, 1, 100, 106]);
  assert.strictEqual(await c.clear(), true);
  const after = await c.stats();
  assert.deepStrictEqual([after.files, after.blobs, after.bytes], [0, 0, 0]);
});

test('app cache: without IndexedDB everything quietly reads as empty', async () => {
  const c = createAppCache({ indexedDB: null, storage: memStorage() });
  assert.strictEqual((await c.loadTexts()).size, 0);
  assert.strictEqual(await c.saveTexts([rec('/a', 'x')], new Set(['/a'])), false);
  assert.strictEqual(c.youtubeCache(), null);
  const s = await c.stats();
  assert.deepStrictEqual([s.available, s.bytes], [false, 0]);
  assert.strictEqual(await c.clear(), false);
});

test('app cache: a store that throws, errors or never answers never breaks the caller', async () => {
  const throwing = { open() { throw new Error('boom'); } };
  const erroring = { open() { const r = {}; setTimeout(() => r.onerror && r.onerror(), 0); return r; } };
  const silent = { open() { return {}; } };
  for (const [name, idb] of [['throws', throwing], ['errors', erroring], ['silent', silent]]) {
    const c = createAppCache({ indexedDB: idb, storage: memStorage(), openTimeoutMs: 40, loadTimeoutMs: 40 });
    assert.strictEqual((await c.loadTexts()).size, 0, name);
    assert.strictEqual(await c.saveTexts([rec('/a', 'x')], new Set(['/a'])), false, name);
    const yc = c.youtubeCache();
    assert.strictEqual(await yc.get('k'), undefined, name);
    await yc.set('k', new ArrayBuffer(4)); // must not throw
    await yc.remove('k');
    assert.strictEqual((await c.stats()).bytes, 0, name);
  }
});

test('app cache: a storage that cannot be read leaves the cache on', () => {
  const broken = { getItem() { throw new Error('denied'); }, setItem() {}, removeItem() {} };
  assert.strictEqual(createAppCache({ indexedDB: null, storage: broken }).isOn(), true);
});

test('app cache: a YouTube player kept by one youtubei.js version is not handed to another', async () => {
  const idb = new IDBFactory();
  const storage = memStorage();
  const v18 = createAppCache({ indexedDB: idb, storage }).youtubeCache('18.1.0');
  await v18.set('abcd1234', new Uint8Array([9, 9]).buffer);
  assert.deepStrictEqual([...new Uint8Array(await v18.get('abcd1234'))], [9, 9]);
  const v19 = createAppCache({ indexedDB: idb, storage }).youtubeCache('19.0.0');
  assert.strictEqual(await v19.get('abcd1234'), undefined);
  await v18.remove('abcd1234');
  assert.strictEqual(await v18.get('abcd1234'), undefined);
});
