'use strict';

// The Android storage shim (mobile/shims/store.js): which folder downloads go to, moving them to another one, and the
// folders next to the download folder. It runs here against an in-memory stand-in for Capacitor's Filesystem plugin
// that behaves the way Android 11+ does for the parts that matter (Music/ only takes audio files).

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');

const APP = 'io.github.murielmod';
const ROOTS = {
  DATA: `/data/user/0/${APP}/files`,
  EXTERNAL_STORAGE: '/storage/emulated/0',
  EXTERNAL: `/storage/emulated/0/Android/data/${APP}/files`,
  DOCUMENTS: `/data/user/0/${APP}/documents`,
};
const Directory = { Data: 'DATA', Documents: 'DOCUMENTS', External: 'EXTERNAL', ExternalStorage: 'EXTERNAL_STORAGE', Cache: 'CACHE' };
const AUDIO = /\.(mp3|m4a|flac|opus|wav|ogg|aac|mka)$/i;

let files; // abs path -> bytes (string)
let dirs;  // abs dir paths
let denied; // abs dir prefixes that refuse writes
let ls;
let appId = APP; // the package name the app reports; a rebuilt app may have another

const abs = ({ path: p, directory }) => path.posix.join(ROOTS[directory], p || '');
function mkdirs(dir) { for (let d = dir; d.length > 1; d = path.posix.dirname(d)) dirs.add(d); }
function checkWrite(file) {
  if (denied.some((d) => file.startsWith(d + '/'))) throw new Error('EACCES');
  // Android 11+: the app may only create media files in Music/
  if (file.startsWith(`${ROOTS.EXTERNAL_STORAGE}/Music/`) && !AUDIO.test(file)) throw new Error('EPERM');
}

const Filesystem = {
  async checkPermissions() { return { publicStorage: 'granted' }; },
  async requestPermissions() { return { publicStorage: 'granted' }; },
  async mkdir({ path: p, directory, recursive }) {
    const d = abs({ path: p, directory });
    if (dirs.has(d)) throw new Error('exists');
    if (!recursive && !dirs.has(path.posix.dirname(d))) throw new Error('no parent');
    if (denied.some((x) => d.startsWith(x))) throw new Error('EACCES');
    mkdirs(d);
  },
  async stat(o) {
    const a = abs(o);
    if (dirs.has(a)) return { type: 'directory', size: 0 };
    if (files.has(a)) return { type: 'file', size: files.get(a).length };
    throw new Error('does not exist');
  },
  async readdir(o) {
    const a = abs(o);
    if (!dirs.has(a)) throw new Error('does not exist');
    const out = [];
    for (const d of dirs) if (path.posix.dirname(d) === a && d !== a) out.push({ name: path.posix.basename(d), type: 'directory', size: 0, mtime: 1 });
    for (const [f, b] of files) if (path.posix.dirname(f) === a) out.push({ name: path.posix.basename(f), type: 'file', size: b.length, mtime: 1 });
    return { files: out };
  },
  async writeFile(o) {
    const a = abs(o);
    checkWrite(a);
    if (!o.recursive && !dirs.has(path.posix.dirname(a))) throw new Error('no parent');
    mkdirs(path.posix.dirname(a));
    files.set(a, String(o.data));
  },
  async appendFile(o) { const a = abs(o); files.set(a, (files.get(a) || '') + String(o.data)); },
  async deleteFile(o) { const a = abs(o); if (!files.has(a)) throw new Error('does not exist'); files.delete(a); },
  async rmdir(o) { const a = abs(o); for (const f of [...files.keys()]) if (f.startsWith(a + '/')) files.delete(f); dirs.delete(a); },
  async copy({ from, directory, to, toDirectory }) {
    const a = abs({ path: from, directory });
    const b = abs({ path: to, directory: toDirectory });
    if (!files.has(a)) throw new Error('does not exist');
    checkWrite(b);
    if (!dirs.has(path.posix.dirname(b))) throw new Error('no parent');
    files.set(b, files.get(a));
  },
  async rename(o) { await Filesystem.copy(o); files.delete(abs({ path: o.from, directory: o.directory })); },
  async getUri(o) { return { uri: `file://${abs(o)}` }; },
};

const realLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === '@capacitor/filesystem') return { Filesystem, Directory, Encoding: { UTF8: 'utf8' } };
  if (request === '@capacitor/app') return { App: { getInfo: async () => ({ id: appId }) } };
  if (request === '@capacitor/core') return { Capacitor: { getPlatform: () => 'android', isNativePlatform: () => true, Plugins: {}, convertFileSrc: (u) => u } };
  return realLoad.call(this, request, ...rest);
};

const storeId = require.resolve('../mobile/shims/store.js');
// a fresh copy of the shim, the way a new launch of the app has one (its state is module-level)
const launch = () => { delete require.cache[storeId]; return require(storeId); };
const put = (dir, rel, content = 'x') => { const a = path.posix.join(ROOTS[dir], rel); mkdirs(path.posix.dirname(a)); files.set(a, content); };
const has = (dir, rel) => files.has(path.posix.join(ROOTS[dir], rel));

beforeEach(() => {
  appId = APP;
  files = new Map();
  dirs = new Set();
  denied = [];
  for (const r of Object.values(ROOTS)) mkdirs(r);
  ls = new Map();
  global.localStorage = { getItem: (k) => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)), removeItem: (k) => ls.delete(k) };
  // what a phone with some songs looks like
  put('EXTERNAL_STORAGE', 'Music/Muriel Mod/Artist - Song.mp3', 'AAAA');
  put('EXTERNAL_STORAGE', 'Music/Muriel Mod/Artist - Opus.mka', 'BBBB');
  put('EXTERNAL_STORAGE', 'Music/Album One/01 First.mp3');
  put('EXTERNAL_STORAGE', 'Music/Album One/Disc 2/02 Second.flac');
  put('EXTERNAL_STORAGE', 'Music/loose song.mp3');
  put('EXTERNAL_STORAGE', 'Music/notes.txt');
  put('EXTERNAL_STORAGE', 'Music/Android/hidden.mp3');
  put('EXTERNAL', 'music/mine.mp3');
});

test('the default download folder is Music/Muriel Mod, and what was downloaded shows up as /data/Downloads', async () => {
  const store = launch();
  const entries = await store.list();
  const vpaths = entries.map((e) => e.vpath).sort();
  assert.ok(vpaths.includes('/data/Downloads/Artist - Song.mp3'));
  assert.ok(vpaths.includes('/data/Downloads/Artist - Opus.webm'), 'an .mka in Music/ is the .webm song inside the app');
  assert.equal(store.downloadsFolder(), 'Music/Muriel Mod');
  assert.equal(store.isCustomDownloadDir(), false);
});

test('folders next to the download folder: one group per folder, loose songs apart, no download folder, no junk', async () => {
  const store = launch();
  await store.list();
  const found = await store.scanLinked();
  assert.equal(found.parent, '/storage/emulated/0/Music');
  const byFolder = Object.fromEntries(found.groups.map((g) => [g.folder, g.files.map((f) => f.vpath).sort()]));
  assert.deepEqual(Object.keys(byFolder).sort(), ['', 'Album One']);
  assert.deepEqual(byFolder[''], ['/data/LocalMusic/loose song.mp3']);
  assert.deepEqual(byFolder['Album One'], ['/data/LocalMusic/Album One/01 First.mp3', '/data/LocalMusic/Album One/Disc 2/02 Second.flac']);
  assert.equal(found.groups.find((g) => g.folder === 'Album One').files[0].name, '01 First');
});

test('a launch after a scan puts the linked songs back in the file index, and they open from where they are', async () => {
  let store = launch();
  await store.list();
  await store.scanLinked();
  store = launch();
  const vpaths = (await store.list()).map((e) => e.vpath);
  assert.ok(vpaths.includes('/data/LocalMusic/Album One/01 First.mp3'));
  assert.ok(vpaths.includes('/data/LocalMusic/loose song.mp3'));
  assert.equal(await store.fileUrl('/data/LocalMusic/Album One/01 First.mp3'), `file://${ROOTS.EXTERNAL_STORAGE}/Music/Album One/01 First.mp3`);
});

test('Muriel never deletes a linked song', async () => {
  const store = launch();
  await store.list();
  await store.scanLinked();
  await store.remove('/data/LocalMusic/loose song.mp3', false);
  assert.equal(has('EXTERNAL_STORAGE', 'Music/loose song.mp3'), true);
});

test('choosing the app folder moves the songs there (.mka back to .webm), and the old copies go', async () => {
  const store = launch();
  await store.list();
  const target = `Android/data/${APP}/files/download`;
  const res = await store.setDownloadDir(`/storage/emulated/0/${target}`, { move: true });
  assert.equal(res.ok, true);
  assert.equal(res.dir, target);
  assert.equal(res.moved, 2);
  assert.equal(res.failed, 0);
  assert.equal(has('EXTERNAL', 'download/Artist - Song.mp3'), true);
  assert.equal(has('EXTERNAL', 'download/Artist - Opus.webm'), true);
  assert.equal(has('EXTERNAL_STORAGE', 'Music/Muriel Mod/Artist - Song.mp3'), false);
  assert.equal(has('EXTERNAL_STORAGE', 'Music/Muriel Mod/Artist - Opus.mka'), false);

  const next = launch(); // the restart
  const vpaths = (await next.list()).map((e) => e.vpath);
  assert.ok(vpaths.includes('/data/Downloads/Artist - Song.mp3'));
  assert.ok(vpaths.includes('/data/Downloads/Artist - Opus.webm'));
  assert.equal(next.downloadsFolder(), target);
  assert.equal(next.isCustomDownloadDir(), true);
  // a new download lands in the new folder
  await next.writeText('/data/Downloads/New - One.mp3', 'zzz');
  assert.equal(has('EXTERNAL', 'download/New - One.mp3'), true);
});

test('with the app folder as download folder, its neighbours are the ones that become playlists', async () => {
  let store = launch();
  await store.list();
  await store.setDownloadDir(`Android/data/${APP}/files/download`, { move: false });
  store = launch();
  await store.list();
  const found = await store.scanLinked();
  assert.equal(found.parent, `/storage/emulated/0/Android/data/${APP}/files/`);
  assert.deepEqual(found.groups.map((g) => g.folder), ['music']);
  assert.equal(await store.fileUrl('/data/LocalMusic/music/mine.mp3'), `file://${ROOTS.EXTERNAL}/music/mine.mp3`);
});

test('without moving, the songs stay in the old folder', async () => {
  const store = launch();
  await store.list();
  const res = await store.setDownloadDir('Download/Muriel songs', { move: false });
  assert.equal(res.ok, true);
  assert.equal(res.moved, 0);
  assert.equal(has('EXTERNAL_STORAGE', 'Music/Muriel Mod/Artist - Song.mp3'), true);
  assert.equal(has('EXTERNAL_STORAGE', 'Download/Muriel songs/.muriel-write-test.mp3'), false, 'the test file is cleaned up');
});

test('folders Muriel cannot use are refused with nothing saved', async () => {
  const store = launch();
  await store.list();
  for (const bad of ['', 'Music', '../Music/x', 'Music/../../x', 'Pictures/Muriel', 'Music/.hidden', 'Music/a:b', `Android/data/${APP}/files`, 'Android/data/other.app/files/download', '/sdcard/Music/x']) {
    const res = await store.setDownloadDir(bad);
    assert.equal(res.ok, false, bad);
  }
  assert.equal(store.isCustomDownloadDir(), false);
  denied.push(`${ROOTS.EXTERNAL_STORAGE}/Documents/Locked`);
  const locked = await store.setDownloadDir('Documents/Locked');
  assert.equal(locked.ok, false);
  assert.match(locked.error, /can't save songs/);
  assert.equal(store.isCustomDownloadDir(), false);
});

test('a typed path is read the way the sheet shows it (full path, odd slashes, any capitals in the first folder)', async () => {
  const store = launch();
  assert.equal(store.showDownloadDir('/storage/emulated/0/music//My songs/'), 'Music/My songs');
  assert.equal(store.showDownloadDir('Download\\Muriel'), 'Download/Muriel');
  assert.equal(store.downloadChoices().find((c) => c.text === 'Music/Muriel Mod').full, '/storage/emulated/0/Music/Muriel Mod');
  assert.equal(store.showDownloadDir('Music'), null);
});

test('reset puts the songs back in Music/Muriel Mod and forgets the choice', async () => {
  let store = launch();
  await store.list();
  await store.setDownloadDir(`Android/data/${APP}/files/download`, { move: true });
  store = launch();
  await store.list();
  const res = await store.resetDownloadDir({ move: true });
  assert.equal(res.ok, true);
  assert.equal(res.moved, 2);
  assert.equal(has('EXTERNAL_STORAGE', 'Music/Muriel Mod/Artist - Song.mp3'), true);
  assert.equal(has('EXTERNAL_STORAGE', 'Music/Muriel Mod/Artist - Opus.mka'), true, 'a WebM song is an .mka in Music/');
  assert.equal(has('EXTERNAL', 'download/Artist - Song.mp3'), false);
  assert.equal(launch().isCustomDownloadDir(), false);
});

test('a chosen folder that stops working falls back to Music/Muriel Mod instead of losing the downloads', async () => {
  let store = launch();
  await store.list();
  await store.setDownloadDir('Download/Muriel songs', { move: false });
  // the folder disappears (storage cleaned, SD card out)
  for (const d of [...dirs]) if (d.startsWith(`${ROOTS.EXTERNAL_STORAGE}/Download/Muriel songs`)) dirs.delete(d);
  denied.push(`${ROOTS.EXTERNAL_STORAGE}/Download/Muriel songs`);
  store = launch();
  await store.list();
  assert.equal(store.downloadsFolder(), 'Music/Muriel Mod');
});

test('a rebuilt app with another package name gets its own app folder (not the original app\'s)', async () => {
  appId = 'com.example.mymuriel';
  const own = `/storage/emulated/0/Android/data/${appId}/files`;
  ROOTS.EXTERNAL = own; // where the plugin puts Directory.External for that package
  try {
    mkdirs(own);
    const store = launch();
    await store.list();
    const choice = store.downloadChoices().find((c) => c.label === 'App folder');
    assert.equal(choice.text, `Android/data/${appId}/files/download`);
    const res = await store.setDownloadDir(choice.full, { move: false });
    assert.equal(res.ok, true);
    assert.equal(store.showDownloadDir(`Android/data/${APP}/files/download`), null, "another app's folder is refused");
    const next = launch();
    await next.list();
    assert.equal(next.downloadsFolder(), `Android/data/${appId}/files/download`);
  } finally {
    ROOTS.EXTERNAL = `/storage/emulated/0/Android/data/${APP}/files`;
  }
});
