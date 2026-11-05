'use strict';

// mobile/shims/store.js: files reach the phone's storage in pieces. One big FLAC used to cross the native
// bridge as a single base64 string (several copies of it at once), which crashed the app.
const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const path = require('path');
const crypto = require('crypto');

function setup({ failAt = -1 } = {}) {
  const disk = new Map();
  const calls = [];
  const Filesystem = {
    async writeFile({ path: p, data }) { calls.push(['write', p, data.length]); disk.set(p, Buffer.from(data, 'base64')); },
    async appendFile({ path: p, data }) {
      calls.push(['append', p, data.length]);
      if (calls.length - 1 === failAt) throw new Error('No space left on device');
      disk.set(p, Buffer.concat([disk.get(p), Buffer.from(data, 'base64')]));
    },
    async deleteFile({ path: p }) { calls.push(['delete', p]); disk.delete(p); },
  };
  const fakes = {
    '@capacitor/filesystem': { Filesystem, Directory: { Data: 'DATA', Documents: 'DOCUMENTS' }, Encoding: { UTF8: 'utf8' } },
    '@capacitor/core': { Capacitor: { getPlatform: () => 'android', isNativePlatform: () => true } },
  };
  const origLoad = Module._load;
  Module._load = function (request, ...rest) { return fakes[request] || origLoad.call(this, request, ...rest); };
  const file = path.join(__dirname, '../mobile/shims/store.js');
  delete require.cache[file];
  try { return { store: require(file), disk, calls }; } finally { Module._load = origLoad; }
}

const flacLike = (n) => crypto.randomBytes(n); // incompressible, like real audio
const MB = 1024 * 1024;

test('a 40 MB file goes over in small pieces and arrives byte for byte', async () => {
  const { store, disk, calls } = setup();
  const bytes = flacLike(40 * MB + 12345);
  await store.writeBlob('/data/library/local_abc.flac', new Blob([bytes]));
  const biggest = Math.max(...calls.map((c) => c[2]));
  assert.ok(biggest <= 1.05 * MB, `largest piece was ${biggest} base64 chars`);
  assert.strictEqual(calls[0][0], 'write');
  assert.ok(calls.slice(1).every((c) => c[0] === 'append'));
  assert.ok(disk.get('Muriel/library/local_abc.flac').equals(bytes));
});

test('byte arrays are written in pieces too, small ones in one go', async () => {
  const { store, disk, calls } = setup();
  const big = flacLike(3 * MB);
  await store.writeBytes('/data/tracks/x.m4a', big);
  assert.ok(disk.get('Muriel/tracks/x.m4a').equals(big));
  assert.ok(calls.length > 1);
  calls.length = 0;
  const small = flacLike(5000);
  await store.writeBytes('/data/thumbnails/t.jpg', small);
  assert.deepStrictEqual(calls.map((c) => c[0]), ['write']);
  assert.ok(disk.get('Muriel/thumbnails/t.jpg').equals(small));
  calls.length = 0;
  await store.writeBytes('/data/empty.bin', new Uint8Array(0));
  assert.deepStrictEqual(calls.map((c) => c[0]), ['write']);
  assert.strictEqual(disk.get('Muriel/empty.bin').length, 0);
});

test('a write that fails half-way leaves no half file behind', async () => {
  const { store, disk, calls } = setup({ failAt: 3 });
  await assert.rejects(store.writeBlob('/data/library/local_x.flac', new Blob([flacLike(5 * MB)])), /No space/);
  assert.strictEqual(disk.has('Muriel/library/local_x.flac'), false);
  assert.strictEqual(calls[calls.length - 1][0], 'delete');
});

// ---- Android: downloads go to Music/Muriel, where people (and their music apps) find them ----

// a small in-memory phone: "DIRECTORY:path" -> { dir } or { size }
function phone({ platform = 'android', perm = 'granted', answer = 'granted', hold = false, files = [], refuse = () => false } = {}) {
  const disk = new Map();
  const scans = [];
  const asked = [];
  let answerQuestion = () => {};
  const question = hold ? new Promise((r) => { answerQuestion = r; }) : null;
  const key = (directory, p) => `${directory}:${p}`;
  const parentOf = (p) => p.split('/').slice(0, -1).join('/');
  const addDir = (directory, p) => { for (let d = p; d && !disk.has(key(directory, d)); d = parentOf(d)) disk.set(key(directory, d), { dir: true }); };
  const put = (directory, p, size) => { addDir(directory, parentOf(p)); disk.set(key(directory, p), { size }); };
  for (const [directory, p, size = 100] of files) put(directory, p, size);
  const must = (directory, p) => { const e = disk.get(key(directory, p)); if (!e) throw new Error(`no such file: ${directory}:${p}`); return e; };
  const Filesystem = {
    async mkdir({ path: p, directory, recursive }) {
      if (disk.has(key(directory, p))) throw new Error('Directory exists');
      if (!recursive && !disk.has(key(directory, parentOf(p)))) throw new Error('Parent directory missing');
      for (let d = parentOf(p); d; d = parentOf(d)) if (disk.has(key(directory, d)) && !disk.get(key(directory, d)).dir) throw new Error('Not a directory');
      addDir(directory, p);
    },
    async stat({ path: p, directory }) { const e = must(directory, p); return { type: e.dir ? 'directory' : 'file', size: e.size || 0 }; },
    async readdir({ path: p, directory }) {
      must(directory, p);
      const prefix = key(directory, p) + '/';
      const out = [];
      for (const [k, e] of disk) if (k.startsWith(prefix) && !k.slice(prefix.length).includes('/')) out.push({ name: k.slice(prefix.length), type: e.dir ? 'directory' : 'file', size: e.size || 0, mtime: 1 });
      return { files: out };
    },
    async copy({ from, directory, to, toDirectory }) {
      const e = must(directory, from);
      // like the real plugin: the folder has to be there, and Android may refuse the file
      if (!disk.has(key(toDirectory, parentOf(to)))) throw new Error('Parent directory of the destination missing');
      if (refuse(toDirectory, to)) throw new Error('Operation not permitted');
      disk.set(key(toDirectory, to), { ...e });
      return { uri: `file:///${toDirectory}/${to}` };
    },
    async rename(o) { await Filesystem.copy(o); disk.delete(key(o.directory, o.from)); },
    async deleteFile({ path: p, directory }) { must(directory, p); disk.delete(key(directory, p)); },
    async writeFile({ path: p, directory, data }) { put(directory, p, data.length); },
    async getUri({ path: p, directory }) { return { uri: `file:///${directory}/${p}` }; },
    async checkPermissions() { return { publicStorage: perm }; },
    async requestPermissions() { asked.push(1); await question; perm = answer; return { publicStorage: answer }; },
  };
  const Capacitor = {
    getPlatform: () => platform, isNativePlatform: () => true, convertFileSrc: (u) => `app:${u}`,
    Plugins: { MurielMedia: { scanFile: async ({ path: p }) => { scans.push(p); } } },
  };
  const fakes = {
    '@capacitor/filesystem': { Filesystem, Directory: { Data: 'DATA', Documents: 'DOCUMENTS', ExternalStorage: 'EXTERNAL_STORAGE' }, Encoding: { UTF8: 'utf8' } },
    '@capacitor/core': { Capacitor },
  };
  const origLoad = Module._load;
  Module._load = function (request, ...rest) { return fakes[request] || origLoad.call(this, request, ...rest); };
  const file = path.join(__dirname, '../mobile/shims/store.js');
  delete require.cache[file];
  try { return { store: require(file), disk, scans, asked, answerQuestion: () => answerQuestion() }; } finally { Module._load = origLoad; }
}

const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); };
const OLD = ['DATA', 'Muriel/Downloads/Old Artist - Old Song.m4a', 4000];
const CACHED = ['DATA', 'Muriel/tracks/abc123.webm', 5000];

test('Android: a downloaded song lands in Music/Muriel (Opus as .mka) and music apps are told', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { store, disk, scans, asked } = phone({ files: [CACHED, ['EXTERNAL_STORAGE', 'Music/Muriel/Someone - Earlier.mka', 300]] });
  const listed = (await store.list()).map((e) => e.vpath);
  assert.strictEqual(store.downloadsFolder(), 'Music/Muriel');
  assert.ok(listed.includes('/data/Downloads/Someone - Earlier.webm'), 'songs already in Music/Muriel are known to the app');
  assert.ok(listed.includes('/data/tracks/abc123.webm'));

  await store.copy('/data/tracks/abc123.webm', '/data/Downloads/Artist - Song.webm');
  assert.ok(disk.has('EXTERNAL_STORAGE:Music/Muriel/Artist - Song.mka'));
  assert.ok(!disk.has('DATA:Muriel/Downloads/Artist - Song.webm'));
  assert.ok(disk.has('DATA:Muriel/tracks/abc123.webm'), 'the cache stays private');
  await settle();
  assert.deepStrictEqual(scans, ['file:///EXTERNAL_STORAGE/Music/Muriel/Artist - Song.mka']);
  assert.strictEqual(await store.fileUrl('/data/Downloads/Artist - Song.webm'), 'app:file:///EXTERNAL_STORAGE/Music/Muriel/Artist - Song.mka');
  assert.strictEqual(await store.fileUrl('/data/Downloads/Someone - Earlier.webm'), 'app:file:///EXTERNAL_STORAGE/Music/Muriel/Someone - Earlier.mka');
  assert.strictEqual(await store.fileUrl('/data/tracks/abc123.webm'), 'app:file:///DATA/Muriel/tracks/abc123.webm');
  assert.strictEqual(asked.length, 0, 'Android 11+ never asks');
});

test('Android: songs downloaded before move from private storage to Music/Muriel once', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const PLAYED = ['DATA', 'Muriel/Downloads/Old Artist - Played.m4a', 4000];
  const { store, disk, scans } = phone({ files: [OLD, PLAYED, CACHED] });
  const listed = await store.list();
  assert.ok(listed.some((e) => e.vpath === '/data/Downloads/Old Artist - Old Song.m4a'));
  // played before the move: the app holds on to its file URL, so this one stays put until the next launch
  assert.strictEqual(await store.fileUrl('/data/Downloads/Old Artist - Played.m4a'), 'app:file:///DATA/Muriel/Downloads/Old Artist - Played.m4a');
  t.mock.timers.tick(10000);
  await settle();
  assert.ok(disk.has('EXTERNAL_STORAGE:Music/Muriel/Old Artist - Old Song.m4a'));
  assert.ok(!disk.has('DATA:Muriel/Downloads/Old Artist - Old Song.m4a'));
  assert.ok(disk.has('DATA:Muriel/tracks/abc123.webm'));
  assert.strictEqual(await store.fileUrl('/data/Downloads/Old Artist - Old Song.m4a'), 'app:file:///EXTERNAL_STORAGE/Music/Muriel/Old Artist - Old Song.m4a');
  assert.deepStrictEqual(scans, ['file:///EXTERNAL_STORAGE/Music/Muriel/Old Artist - Old Song.m4a']);
  assert.ok(disk.has('DATA:Muriel/Downloads/Old Artist - Played.m4a'));
  assert.strictEqual(await store.fileUrl('/data/Downloads/Old Artist - Played.m4a'), 'app:file:///DATA/Muriel/Downloads/Old Artist - Played.m4a');
});

test('Android: a private copy left behind by an earlier move is deleted, the public one wins', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { store, disk } = phone({ files: [OLD, ['EXTERNAL_STORAGE', 'Music/Muriel/Old Artist - Old Song.m4a', 4000]] });
  await store.list();
  assert.strictEqual(await store.fileUrl('/data/Downloads/Old Artist - Old Song.m4a'), 'app:file:///EXTERNAL_STORAGE/Music/Muriel/Old Artist - Old Song.m4a');
  t.mock.timers.tick(10000);
  await settle();
  assert.ok(!disk.has('DATA:Muriel/Downloads/Old Artist - Old Song.m4a'));
  assert.ok(disk.has('EXTERNAL_STORAGE:Music/Muriel/Old Artist - Old Song.m4a'));
});

test('Android: a song the public folder refuses is kept in the app instead of being lost', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { store, disk } = phone({ files: [CACHED], refuse: (dir) => dir === 'EXTERNAL_STORAGE' });
  await store.list();
  await store.copy('/data/tracks/abc123.webm', '/data/Downloads/Artist - Song.webm');
  assert.ok(disk.has('DATA:Muriel/Downloads/Artist - Song.webm'));
  assert.strictEqual(await store.fileUrl('/data/Downloads/Artist - Song.webm'), 'app:file:///DATA/Muriel/Downloads/Artist - Song.webm');
});

test('Android: Music not usable, Documents/Muriel instead', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { store, disk } = phone({ files: [CACHED, ['EXTERNAL_STORAGE', 'Music', 1]] }); // a file called Music: no folder there
  await store.list();
  assert.strictEqual(store.downloadsFolder(), 'Documents/Muriel');
  await store.copy('/data/tracks/abc123.webm', '/data/Downloads/Artist - Song.webm');
  assert.ok(disk.has('EXTERNAL_STORAGE:Documents/Muriel/Artist - Song.mka'));
});

test('Android 10 and older: no question at launch, one when the first song is saved (not waited for)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { store, disk, asked, answerQuestion } = phone({ perm: 'prompt', answer: 'granted', hold: true, files: [CACHED] });
  await store.list();
  assert.strictEqual(asked.length, 0);
  assert.ok(![...disk.keys()].some((k) => k.startsWith('EXTERNAL_STORAGE:')), 'shared storage untouched before the permission');
  assert.strictEqual(store.downloadsFolder(), 'Music/Muriel');
  // the question is still open (Muriel in the background, say): saving doesn't wait for it
  await store.copy('/data/tracks/abc123.webm', '/data/Downloads/A - One.webm');
  await store.copy('/data/tracks/abc123.webm', '/data/Downloads/A - Two.webm');
  assert.strictEqual(asked.length, 1);
  assert.ok(disk.has('DATA:Muriel/Downloads/A - One.webm'));
  answerQuestion();
  await settle();
  assert.strictEqual(store.downloadsFolder(), 'Music/Muriel');
  t.mock.timers.tick(10000);
  await settle();
  assert.ok(disk.has('EXTERNAL_STORAGE:Music/Muriel/A - One.mka'));
  assert.ok(disk.has('EXTERNAL_STORAGE:Music/Muriel/A - Two.mka'));
  assert.ok(!disk.has('DATA:Muriel/Downloads/A - One.webm'));
  await store.copy('/data/tracks/abc123.webm', '/data/Downloads/A - Three.webm');
  assert.ok(disk.has('EXTERNAL_STORAGE:Music/Muriel/A - Three.mka'), 'from now on straight to Music/Muriel');
});

test('Android 10 and older, permission refused: downloads stay in the app as before, asked once', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { store, disk, asked } = phone({ perm: 'prompt', answer: 'denied', files: [CACHED, OLD] });
  await store.list();
  await store.copy('/data/tracks/abc123.webm', '/data/Downloads/A - One.webm');
  await store.copy('/data/tracks/abc123.webm', '/data/Downloads/A - Two.webm');
  assert.strictEqual(asked.length, 1);
  assert.strictEqual(store.downloadsFolder(), null);
  assert.ok(disk.has('DATA:Muriel/Downloads/A - One.webm'));
  assert.ok(disk.has('DATA:Muriel/Downloads/A - Two.webm'));
  assert.ok(disk.has('DATA:Muriel/Downloads/Old Artist - Old Song.m4a'));
});

test('iPhone: downloads stay in Documents/Muriel/Downloads, nothing is asked or renamed', async () => {
  const { store, disk, asked, scans } = phone({ platform: 'ios', files: [['DOCUMENTS', 'Muriel/tracks/abc123.webm', 5000]] });
  disk.set('DOCUMENTS:Muriel/Downloads', { dir: true });
  const listed = (await store.list()).map((e) => e.vpath);
  assert.ok(listed.includes('/data/tracks/abc123.webm'));
  await store.copy('/data/tracks/abc123.webm', '/data/Downloads/Artist - Song.webm');
  assert.ok(disk.has('DOCUMENTS:Muriel/Downloads/Artist - Song.webm'));
  assert.ok(![...disk.keys()].some((k) => k.startsWith('EXTERNAL_STORAGE:')));
  assert.strictEqual(asked.length, 0);
  assert.deepStrictEqual(scans, []);
  assert.strictEqual(store.downloadsFolder(), null);
});
