'use strict';

// The Android storage shim (mobile/shims/store.js): which folder downloads go to, moving them to another one, and the
// folders next to the download folder. It runs here against an in-memory stand-in for Capacitor's Filesystem plugin
// that behaves the way Android 11+ does for the parts that matter (Music/ only takes audio files).

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');

const APP = 'io.github.piverxy';
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
let copyHook;   // runs when a copy starts
let afterCopy;  // runs once the copy has been written
let readFail;   // folders (exact paths) the plugin refuses to list
let overwrites; // copies that landed on a file that was already there
let foreign;    // files somebody else put there (a file manager, a computer): hidden from the app without the permission
let audioGranted; // "music and audio" permission
let canAsk;       // false once refused for good
let answer;       // what the person says to the dialog
let denials;
let asked;        // allowAudioAccess calls
let opened;       // times the app's page in Settings was opened
let deleteFails;  // path endings whose deletion fails (the file stays)
let deleted;      // every file the app asked to delete
let compared;     // sameFile calls (MediaControlsPlugin.sameFile: are two files the same bytes?)
let compareFails; // the plugin cannot read the files to compare them

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
    if (foreign.has(a) && !audioGranted) throw new Error('does not exist');
    if (dirs.has(a)) return { type: 'directory', size: 0 };
    if (files.has(a)) return { type: 'file', size: files.get(a).length };
    throw new Error('does not exist');
  },
  async readdir(o) {
    const a = abs(o);
    if (readFail.includes(a)) throw new Error('EACCES');
    if (!dirs.has(a)) throw new Error('does not exist');
    const out = [];
    for (const d of dirs) if (path.posix.dirname(d) === a && d !== a) out.push({ name: path.posix.basename(d), type: 'directory', size: 0, mtime: 1 });
    for (const [f, b] of files) if (path.posix.dirname(f) === a && !(foreign.has(f) && !audioGranted)) out.push({ name: path.posix.basename(f), type: 'file', size: b.length, mtime: 1 });
    return { files: out };
  },
  async writeFile(o) {
    const a = abs(o);
    checkWrite(a);
    if (!o.recursive && !dirs.has(path.posix.dirname(a))) throw new Error('no parent');
    mkdirs(path.posix.dirname(a));
    foreign.delete(a);
    files.set(a, String(o.data));
  },
  async appendFile(o) { const a = abs(o); files.set(a, (files.get(a) || '') + String(o.data)); },
  async deleteFile(o) {
    const a = abs(o);
    deleted.push(a);
    if (deleteFails.some((end) => a.endsWith(end))) throw new Error('EACCES');
    if (!files.has(a)) throw new Error('does not exist');
    files.delete(a);
  },
  async rmdir(o) { const a = abs(o); for (const f of [...files.keys()]) if (f.startsWith(a + '/')) files.delete(f); dirs.delete(a); },
  async copy({ from, directory, to, toDirectory }) {
    if (copyHook) await copyHook({ from, to });
    const a = abs({ path: from, directory });
    const b = abs({ path: to, directory: toDirectory });
    if (!files.has(a)) throw new Error('does not exist');
    checkWrite(b);
    if (!dirs.has(path.posix.dirname(b))) throw new Error('no parent');
    if (files.has(b)) overwrites++;
    foreign.delete(b);
    files.set(b, files.get(a));
    if (afterCopy) await afterCopy({ from, to });
  },
  async rename(o) { await Filesystem.copy(o); files.delete(abs({ path: o.from, directory: o.directory })); },
  async getUri(o) { return { uri: `file://${abs(o)}` }; },
};

const capacitor = { getPlatform: () => 'android', isNativePlatform: () => true, Plugins: {}, convertFileSrc: (u) => u };
const realLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === '@capacitor/filesystem') return { Filesystem, Directory, Encoding: { UTF8: 'utf8' } };
  if (request === '@capacitor/app') return { App: { getInfo: async () => ({ id: appId }) } };
  if (request === '@capacitor/core') return { Capacitor: capacitor };
  if (request === '@capacitor/share') return { Share: {} };
  return realLoad.call(this, request, ...rest);
};

const storeId = require.resolve('../mobile/shims/store.js');
// a fresh copy of the shim, the way a new launch of the app has one (its state is module-level)
const launch = () => { delete require.cache[storeId]; return require(storeId); };
const put = (dir, rel, content = 'x') => {
  const a = path.posix.join(ROOTS[dir], rel);
  mkdirs(path.posix.dirname(a));
  files.set(a, content);
  if (dir === 'EXTERNAL_STORAGE') foreign.add(a); // not made by the app
};
const has = (dir, rel) => files.has(path.posix.join(ROOTS[dir], rel));

beforeEach(() => {
  appId = APP;
  copyHook = null;
  afterCopy = null;
  readFail = [];
  overwrites = 0;
  foreign = new Set();
  audioGranted = true;
  canAsk = true;
  answer = 'allow';
  denials = 0;
  asked = [];
  opened = 0;
  deleteFails = [];
  deleted = [];
  compared = [];
  compareFails = false;
  // the native side (MediaControlsPlugin.audioAccess / allowAudioAccess / sameFile)
  capacitor.Plugins.PiverxyMedia = {
    // the plugin reads both files and compares every byte; it rejects when one can't be read
    sameFile: async ({ a, b }) => {
      compared.push({ a, b });
      if (compareFails) throw new Error('could not compare the files');
      const pa = a.replace('file://', '');
      const pb = b.replace('file://', '');
      if (!files.has(pa) || !files.has(pb)) throw new Error('not a file');
      return { same: files.get(pa) === files.get(pb) };
    },
    audioAccess: async () => ({ granted: audioGranted, canAsk: audioGranted ? false : canAsk }),
    // MediaControlsPlugin.openAppSettings: the app's page in Android Settings
    openAppSettings: async () => { opened++; return { granted: audioGranted, canAsk: audioGranted ? false : canAsk }; },
    allowAudioAccess: async ({ settings } = {}) => {
      asked.push({ settings: !!settings });
      if (!audioGranted && canAsk) {
        if (answer === 'allow') audioGranted = true;
        else if (++denials >= 2) canAsk = false;
      } else if (!audioGranted && settings) opened++;
      return { granted: audioGranted, canAsk: audioGranted ? false : canAsk };
    },
  };
  files = new Map();
  dirs = new Set();
  denied = [];
  for (const r of Object.values(ROOTS)) mkdirs(r);
  ls = new Map();
  global.localStorage = { getItem: (k) => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)), removeItem: (k) => ls.delete(k) };
  // what a phone with some songs looks like
  put('EXTERNAL_STORAGE', 'Music/Piverxy/Artist - Song.mp3', 'AAAA');
  put('EXTERNAL_STORAGE', 'Music/Piverxy/Artist - Opus.mka', 'BBBB');
  put('EXTERNAL_STORAGE', 'Music/Album One/01 First.mp3');
  put('EXTERNAL_STORAGE', 'Music/Album One/Disc 2/02 Second.flac');
  put('EXTERNAL_STORAGE', 'Music/loose song.mp3');
  put('EXTERNAL_STORAGE', 'Music/notes.txt');
  put('EXTERNAL_STORAGE', 'Music/Android/hidden.mp3');
  put('EXTERNAL', 'music/mine.mp3');
});

test('the default download folder is Music/Piverxy, and what was downloaded shows up as /data/Downloads', async () => {
  const store = launch();
  const entries = await store.list();
  const vpaths = entries.map((e) => e.vpath).sort();
  assert.ok(vpaths.includes('/data/Downloads/Artist - Song.mp3'));
  assert.ok(vpaths.includes('/data/Downloads/Artist - Opus.webm'), 'an .mka in Music/ is the .webm song inside the app');
  assert.equal(store.downloadsFolder(), 'Music/Piverxy');
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

test('Piverxy never deletes a linked song', async () => {
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
  assert.equal(has('EXTERNAL_STORAGE', 'Music/Piverxy/Artist - Song.mp3'), false);
  assert.equal(has('EXTERNAL_STORAGE', 'Music/Piverxy/Artist - Opus.mka'), false);

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
  const res = await store.setDownloadDir('Download/Piverxy songs', { move: false });
  assert.equal(res.ok, true);
  assert.equal(res.moved, 0);
  assert.equal(has('EXTERNAL_STORAGE', 'Music/Piverxy/Artist - Song.mp3'), true);
  assert.equal(has('EXTERNAL_STORAGE', 'Download/Piverxy songs/.piverxy-write-test.mp3'), false, 'the test file is cleaned up');
});

test('folders Piverxy cannot use are refused with nothing saved', async () => {
  const store = launch();
  await store.list();
  for (const bad of ['', 'Music', '../Music/x', 'Music/../../x', 'Pictures/Piverxy', 'Music/.hidden', 'Music/a:b', `Android/data/${APP}/files`, 'Android/data/other.app/files/download', '/sdcard/Music/x']) {
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
  assert.equal(store.showDownloadDir('Download\\Piverxy'), 'Download/Piverxy');
  assert.equal(store.downloadChoices().find((c) => c.text === 'Music/Piverxy').full, '/storage/emulated/0/Music/Piverxy');
  assert.equal(store.showDownloadDir('Music'), null);
});

test('reset puts the songs back in Music/Piverxy and forgets the choice', async () => {
  let store = launch();
  await store.list();
  await store.setDownloadDir(`Android/data/${APP}/files/download`, { move: true });
  store = launch();
  await store.list();
  const res = await store.resetDownloadDir({ move: true });
  assert.equal(res.ok, true);
  assert.equal(res.moved, 2);
  assert.equal(has('EXTERNAL_STORAGE', 'Music/Piverxy/Artist - Song.mp3'), true);
  assert.equal(has('EXTERNAL_STORAGE', 'Music/Piverxy/Artist - Opus.mka'), true, 'a WebM song is an .mka in Music/');
  assert.equal(has('EXTERNAL', 'download/Artist - Song.mp3'), false);
  assert.equal(launch().isCustomDownloadDir(), false);
});

test('a chosen folder that stops working falls back to Music/Piverxy instead of losing the downloads', async () => {
  let store = launch();
  await store.list();
  await store.setDownloadDir('Download/Piverxy songs', { move: false });
  // the folder disappears (storage cleaned, SD card out)
  for (const d of [...dirs]) if (d.startsWith(`${ROOTS.EXTERNAL_STORAGE}/Download/Piverxy songs`)) dirs.delete(d);
  denied.push(`${ROOTS.EXTERNAL_STORAGE}/Download/Piverxy songs`);
  store = launch();
  await store.list();
  assert.equal(store.downloadsFolder(), 'Music/Piverxy');
});

test('a rebuilt app with another package name gets its own app folder (not the original app\'s)', async () => {
  appId = 'com.example.mypiverxy';
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

// ---- a move that is cut short, and files that are already there ----
const THIRD = 'Artist - Third.mp3';
const APPFOLDER = `Android/data/${APP}/files/download`;
const where = (url) => url.replace('file://', '');
const journal = () => JSON.parse(ls.get('piverxy_download_move') || 'null');

// the app is killed during the second song: a copy that never finishes stands for a process that is gone
async function killedMove(stage) {
  put('EXTERNAL_STORAGE', `Music/Piverxy/${THIRD}`, 'CCCC');
  const store = launch();
  await store.list();
  let n = 0;
  const gone = () => new Promise(() => {});
  if (stage === 'before-copy') copyHook = async () => { if (++n === 2) await gone(); };
  else afterCopy = async () => { if (++n === 2) await gone(); };
  store.setDownloadDir(APPFOLDER, { move: true }); // never settles
  await new Promise((r) => setTimeout(r, 50));
  copyHook = null;
  afterCopy = null;
}

for (const stage of ['before-copy', 'after-copy']) {
  test(`app closed in the middle of a move (${stage} of the second song): no song disappears, the next launch finishes it`, async () => {
    await killedMove(stage);
    assert.ok(journal(), 'the journal is there');

    const next = launch(); // the restart
    const vpaths = (await next.list()).map((e) => e.vpath);
    const songs = ['/data/Downloads/Artist - Song.mp3', '/data/Downloads/Artist - Opus.webm', `/data/Downloads/${THIRD}`];
    for (const v of songs) {
      assert.ok(vpaths.includes(v), `${v} is still listed`);
      assert.equal(files.has(where(await next.fileUrl(v))), true, `${v} opens from where it is`);
    }
    assert.equal(next.downloadsFolder(), APPFOLDER, 'new songs go to the folder that was chosen');

    await next.resumeMove();
    for (const [dir, rel] of [['EXTERNAL', 'download/Artist - Song.mp3'], ['EXTERNAL', 'download/Artist - Opus.webm'], ['EXTERNAL', `download/${THIRD}`]]) assert.equal(has(dir, rel), true, rel);
    for (const rel of ['Artist - Song.mp3', 'Artist - Opus.mka', THIRD]) assert.equal(has('EXTERNAL_STORAGE', `Music/Piverxy/${rel}`), false, rel);
    assert.equal([...files.keys()].some((f) => f.includes('.piverxy-part-')), false, 'no half song is left');
    assert.equal(journal(), null, 'finished: the journal is gone');
    assert.equal(overwrites, 0);
    assert.equal(files.get(`${ROOTS.EXTERNAL}/download/Artist - Song.mp3`), 'AAAA');
  });
}

test('a different file with the same name in the new folder is left alone, together with its song', async () => {
  put('EXTERNAL', 'download/Artist - Song.mp3', 'SOMETHING ELSE ENTIRELY'); // not the same file
  put('EXTERNAL', 'download/Artist - Opus.webm', 'BBBB'); // the same song: an earlier move was cut short after the copy
  const store = launch();
  await store.list();
  const res = await store.setDownloadDir(APPFOLDER, { move: true });
  assert.equal(res.ok, true);
  assert.equal(res.conflicts, 1);
  assert.equal(res.moved, 1);
  assert.equal(res.failed, 0);
  assert.equal(files.get(`${ROOTS.EXTERNAL}/download/Artist - Song.mp3`), 'SOMETHING ELSE ENTIRELY', 'the file that was there is untouched');
  assert.equal(has('EXTERNAL_STORAGE', 'Music/Piverxy/Artist - Song.mp3'), true, 'and so is the song that could not go');
  assert.equal(has('EXTERNAL_STORAGE', 'Music/Piverxy/Artist - Opus.mka'), false, 'the copy that was already there counts as moved');
  assert.equal(overwrites, 0, 'nothing is ever copied onto an existing file, so what the plugin does then does not matter');
  // PIV-STORE-003: a conflict is not "done". The journal stays, so the song is not forgotten, however often the app starts.
  assert.ok(journal(), 'the journal stays while a conflict is open');
  assert.equal(journal().last.conflicts, 1);
});

// ---- PIV-STORE-001 (P0): the same name and the same size are not proof that it is the same song ----
test('RT-01: same name, same size, other bytes: nothing is deleted or replaced, it is a conflict', async () => {
  put('EXTERNAL', 'download/Artist - Song.mp3', 'BBBB'); // the old Song.mp3 is 'AAAA': 4 bytes as well
  const store = launch();
  await store.list();
  const res = await store.setDownloadDir(APPFOLDER, { move: true });
  assert.equal(res.conflicts, 1);
  assert.equal(res.moved, 1, 'the other song (Opus) has no namesake and moves');
  assert.equal(files.get(`${ROOTS.EXTERNAL}/download/Artist - Song.mp3`), 'BBBB', 'the file in the new folder is not replaced');
  assert.equal(files.get(`${ROOTS.EXTERNAL_STORAGE}/Music/Piverxy/Artist - Song.mp3`), 'AAAA', 'the song in the old folder is still there');
  assert.equal(compared.length, 1, 'the bytes were compared; the size alone was not trusted');
  assert.equal(deleted.some((f) => f.endsWith('Music/Piverxy/Artist - Song.mp3')), false, 'no delete was even tried on it');
  assert.equal(overwrites, 0);
  assert.equal(journal().last.conflicts, 1);
});

test('RT-01: when the bytes cannot be compared the song is not guessed at: both files stay', async () => {
  put('EXTERNAL', 'download/Artist - Song.mp3', 'AAAA'); // in fact the same bytes, but nobody can tell here
  compareFails = true; // an older build of the plugin, or a file that can't be read
  const store = launch();
  await store.list();
  const res = await store.setDownloadDir(APPFOLDER, { move: true });
  assert.equal(res.conflicts, 1);
  assert.equal(has('EXTERNAL_STORAGE', 'Music/Piverxy/Artist - Song.mp3'), true);
  assert.equal(has('EXTERNAL', 'download/Artist - Song.mp3'), true);
  assert.equal(deleted.some((f) => f.endsWith('Music/Piverxy/Artist - Song.mp3')), false);
  assert.ok(journal());
  // with no plugin at all (an old build) it is the same
  delete capacitor.Plugins.PiverxyMedia.sameFile;
  const next = launch();
  await next.list();
  const again = await next.resumeMove();
  assert.equal(again.conflicts, 1);
  assert.equal(has('EXTERNAL_STORAGE', 'Music/Piverxy/Artist - Song.mp3'), true);
});

test('RT-02: the same bytes in the new folder after a move that was cut short: it finishes, no third copy appears', async () => {
  put('EXTERNAL', 'download/Artist - Song.mp3', 'AAAA'); // copied, then the app was closed before the old copy was deleted
  const store = launch();
  await store.list();
  const res = await store.setDownloadDir(APPFOLDER, { move: true });
  assert.equal(res.moved, 2);
  assert.equal(res.conflicts, 0);
  assert.equal(has('EXTERNAL_STORAGE', 'Music/Piverxy/Artist - Song.mp3'), false, 'the old copy is gone');
  assert.equal([...files.keys()].filter((f) => /Artist - Song/.test(f)).length, 1, 'one copy, not two or three');
  assert.equal(overwrites, 0);
  assert.equal(journal(), null);
});

// ---- PIV-STORE-003: a conflict stays listed and playable after a restart ----
test('RT-05: a conflict, then the app restarts: the old song is still listed and plays', async () => {
  put('EXTERNAL', 'download/Artist - Song.mp3', 'BBBB');
  const store = launch();
  await store.list();
  await store.setDownloadDir(APPFOLDER, { move: true });
  for (let launches = 0; launches < 3; launches++) {
    const next = launch(); // restart
    const vpaths = (await next.list()).map((e) => e.vpath);
    assert.ok(vpaths.includes('/data/Downloads/Artist - Song.mp3'), 'the file in the new folder');
    assert.ok(vpaths.includes('/data/Downloads/Artist - Song (old).mp3'), 'the song that could not move, under its own name plus (old)');
    assert.equal(files.get(where(await next.fileUrl('/data/Downloads/Artist - Song.mp3'))), 'BBBB');
    assert.equal(files.get(where(await next.fileUrl('/data/Downloads/Artist - Song (old).mp3'))), 'AAAA', 'it plays from where it is');
    await next.resumeMove(); // still a conflict
    assert.equal(has('EXTERNAL_STORAGE', 'Music/Piverxy/Artist - Song.mp3'), true);
    assert.ok(journal(), 'and the journal is still there');
  }
});

test('a conflict is settled by the person (removing one of the files); then Retry finishes the move', async () => {
  put('EXTERNAL', 'download/Artist - Song.mp3', 'BBBB');
  let store = launch();
  await store.list();
  await store.setDownloadDir(APPFOLDER, { move: true });
  store = launch();
  await store.list();
  assert.deepEqual(
    { pending: store.moveStatus().pending, conflicts: store.moveStatus().conflicts, left: store.moveStatus().left },
    { pending: true, conflicts: 1, left: 1 });
  const again = await store.retryMove();
  assert.equal(again.ran, true);
  assert.equal(store.moveStatus().conflicts, 1, 'nothing was resolved by itself');
  assert.equal(has('EXTERNAL_STORAGE', 'Music/Piverxy/Artist - Song.mp3'), true);

  files.delete(`${ROOTS.EXTERNAL}/download/Artist - Song.mp3`); // the person got rid of the namesake
  const done = await store.retryMove();
  assert.equal(done.ran, true);
  assert.equal(done.pending, false);
  assert.equal(files.get(`${ROOTS.EXTERNAL}/download/Artist - Song.mp3`), 'AAAA');
  assert.equal(has('EXTERNAL_STORAGE', 'Music/Piverxy/Artist - Song.mp3'), false);
  assert.equal(journal(), null);
});

// ---- PIV-STORE-002: an old folder that cannot be read is not an old folder that is gone ----
test('RT-03: an old folder that will not be read (permission, I/O): the journal stays, a later try finishes it', async () => {
  const store = launch();
  await store.list();
  readFail.push(`${ROOTS.EXTERNAL_STORAGE}/Music/Piverxy`);
  const res = await store.setDownloadDir(APPFOLDER, { move: true });
  assert.equal(res.unreadable, 1);
  assert.equal(res.missing, 0, 'not told apart from a folder that is gone: it is not');
  assert.equal(res.moved, 0);
  assert.ok(journal(), 'the journal stays');
  assert.equal(journal().last.unreadable, 1);
  assert.equal(files.get(where(await store.fileUrl('/data/Downloads/Artist - Song.mp3'))), 'AAAA', 'the song still plays from where it is');
  assert.equal(has('EXTERNAL_STORAGE', 'Music/Piverxy/Artist - Song.mp3'), true);

  readFail = []; // whatever it was is over
  const next = launch();
  const vpaths = (await next.list()).map((e) => e.vpath);
  assert.ok(vpaths.includes('/data/Downloads/Artist - Song.mp3'), 'listed from the old folder');
  const r = await next.resumeMove();
  assert.equal(r.moved, 2);
  assert.equal(r.unreadable, 0);
  assert.equal(journal(), null);
  assert.equal(has('EXTERNAL', 'download/Artist - Song.mp3'), true);
});

test('RT-04: an old folder that is really gone (not there) is marked as missing, and is not mistaken for a read error', async () => {
  ls.set('piverxy_download_move', JSON.stringify({ to: APPFOLDER, from: ['Music/Gone Folder'], tries: 1 }));
  const store = launch();
  await store.list();
  const r = await store.resumeMove();
  assert.equal(r.missing, 1);
  assert.equal(r.unreadable, 0);
  assert.equal(journal(), null, 'nothing left to settle');
  // the same folder, but now it is there and cannot be read: that is not "gone"
  mkdirs(`${ROOTS.EXTERNAL_STORAGE}/Music/Locked Folder`);
  readFail.push(`${ROOTS.EXTERNAL_STORAGE}/Music/Locked Folder`);
  ls.set('piverxy_download_move', JSON.stringify({ to: APPFOLDER, from: ['Music/Locked Folder'], tries: 1 }));
  const next = launch();
  await next.list();
  const locked = await next.resumeMove();
  assert.equal(locked.missing, 0);
  assert.equal(locked.unreadable, 1);
  assert.ok(journal());
});

// ---- PIV-STORE-004: a move is never dropped because it was tried often ----
test('RT-06: songs that fail to copy stay where they are, stay listed, and the move stays pending after 3, 10 or more runs', async () => {
  const store = launch();
  await store.list();
  copyHook = async () => { throw new Error('no space left'); };
  const res = await store.setDownloadDir(APPFOLDER, { move: true });
  assert.equal(res.failed, 2);
  assert.equal(res.moved, 0);
  assert.equal(has('EXTERNAL_STORAGE', 'Music/Piverxy/Artist - Song.mp3'), true);
  assert.equal(journal().tries, 1);
  assert.equal([...files.keys()].some((f) => f.includes('.piverxy-part-')), false);

  for (let tries = 2; tries <= 12; tries++) {
    const next = launch(); // a restart
    const vpaths = (await next.list()).map((e) => e.vpath);
    assert.ok(vpaths.includes('/data/Downloads/Artist - Song.mp3'), `still listed at run ${tries}`);
    assert.equal(files.get(where(await next.fileUrl('/data/Downloads/Artist - Song.mp3'))), 'AAAA', 'and it plays');
    await next.resumeMove(); // still failing
    assert.equal(has('EXTERNAL_STORAGE', 'Music/Piverxy/Artist - Song.mp3'), true);
    assert.ok(journal(), `the journal is still there after run ${tries}`);
    assert.equal(journal().tries, tries);
    assert.deepEqual({ pending: next.moveStatus().pending, left: next.moveStatus().left, failed: next.moveStatus().failed }, { pending: true, left: 2, failed: 2 });
  }
  // the cause goes away: the next run completes
  copyHook = null;
  const last = launch();
  await last.list();
  await last.resumeMove();
  assert.equal(has('EXTERNAL', 'download/Artist - Song.mp3'), true);
  assert.equal(has('EXTERNAL_STORAGE', 'Music/Piverxy/Artist - Song.mp3'), false);
  assert.equal(journal(), null);
});

// ---- PIV-STORE-005: a song counts as moved only when the old copy is really gone ----
test('RT-10: copied, but the old copy would not delete: the new copy plays, the old one is not forced, cleanup is pending', async () => {
  deleteFails.push('Music/Piverxy/Artist - Song.mp3');
  const store = launch();
  await store.list();
  const res = await store.setDownloadDir(APPFOLDER, { move: true });
  assert.equal(res.cleanup, 1);
  assert.equal(res.moved, 1, 'Opus: fully moved');
  assert.equal(res.failed, 0);
  assert.equal(files.get(`${ROOTS.EXTERNAL}/download/Artist - Song.mp3`), 'AAAA', 'the new copy is whole');
  assert.equal(has('EXTERNAL_STORAGE', 'Music/Piverxy/Artist - Song.mp3'), true, 'the old copy is left alone (no forcing)');
  assert.equal(journal().last.cleanup, 1);
  assert.equal(journal().last.left, 1);

  const next = launch(); // restart: the song is listed once, from the new folder
  const vpaths = (await next.list()).map((e) => e.vpath);
  assert.equal(vpaths.filter((v) => v.startsWith('/data/Downloads/Artist - Song')).length, 1, 'one entry, not a duplicate');
  assert.equal(files.get(where(await next.fileUrl('/data/Downloads/Artist - Song.mp3'))), 'AAAA');
  assert.ok(journal());

  deleteFails = []; // the cause is gone: the old copy goes now
  const r = await next.resumeMove();
  assert.equal(r.moved, 1);
  assert.equal(r.cleanup, 0);
  assert.equal(has('EXTERNAL_STORAGE', 'Music/Piverxy/Artist - Song.mp3'), false);
  assert.equal(journal(), null);
});

// ---- Android 11+ hides songs the app did not make until it may read music and audio ----
test('RT-12: with the permission taken back, an old folder looks empty: that is not "nothing to move"', async () => {
  audioGranted = false; // the foreign songs in Music/Piverxy are hidden now
  const store = launch();
  await store.list();
  const res = await store.setDownloadDir(APPFOLDER, { move: true });
  assert.equal(res.permission, true);
  assert.equal(res.moved, 0);
  assert.ok(journal(), 'kept: there may be songs behind the permission');
  assert.equal(store.moveStatus().permission, true);
  assert.equal(has('EXTERNAL_STORAGE', 'Music/Piverxy/Artist - Song.mp3'), true, 'nothing was unlinked or deleted');

  audioGranted = true; // allowed in Settings
  const next = launch();
  await next.list();
  const done = await next.retryMove();
  assert.equal(done.ran, true);
  assert.equal(done.pending, false);
  assert.equal(has('EXTERNAL', 'download/Artist - Song.mp3'), true);
  assert.equal(journal(), null);
});

test('a move whose new folder is not in use right now cannot run, and keeps what it knows', async () => {
  ls.set('piverxy_download_move', JSON.stringify({ to: 'Download/Piverxy songs', from: ['Music/Piverxy'], tries: 1 }));
  denied.push(`${ROOTS.EXTERNAL_STORAGE}/Download/Piverxy songs`); // the new folder can't be opened
  const store = launch();
  const vpaths = (await store.list()).map((e) => e.vpath);
  assert.equal(store.downloadsFolder(), 'Music/Piverxy', 'the app falls back to the default folder');
  assert.ok(vpaths.includes('/data/Downloads/Artist - Song.mp3'));
  const r = await store.retryMove();
  assert.equal(r.ok, false);
  assert.equal(store.moveStatus().pending, true);
  assert.ok(journal());
});

test('a journal that is still there finishes once the cause is gone', async () => {
  const store = launch();
  await store.list();
  copyHook = async () => { throw new Error('no space left'); };
  await store.setDownloadDir(APPFOLDER, { move: true });
  copyHook = null;
  const next = launch();
  await next.list();
  await next.resumeMove();
  assert.equal(has('EXTERNAL', 'download/Artist - Song.mp3'), true);
  assert.equal(has('EXTERNAL_STORAGE', 'Music/Piverxy/Artist - Song.mp3'), false);
  assert.equal(journal(), null);
});

test('changing the folder again before a move finished brings along the songs of both old folders', async () => {
  const store = launch();
  await store.list();
  copyHook = async () => { throw new Error('no space left'); };
  await store.setDownloadDir(APPFOLDER, { move: true }); // nothing moved: the songs are all in Music/Piverxy
  put('EXTERNAL', 'download/Artist - Later.mp3', 'LLLL'); // and one arrived in the app folder meanwhile
  copyHook = null;
  const next = launch();
  await next.list();
  const res = await next.setDownloadDir('Download/Piverxy', { move: true });
  assert.equal(res.moved, 3);
  for (const rel of ['Artist - Song.mp3', 'Artist - Opus.mka', 'Artist - Later.mp3']) assert.equal(has('EXTERNAL_STORAGE', `Download/Piverxy/${rel}`), true, rel);
  assert.equal(has('EXTERNAL', 'download/Artist - Later.mp3'), false);
  assert.equal(journal(), null);
});

test('a scan that could not read everything says so (the caller must not take missing songs for deleted ones)', async () => {
  const store = launch();
  await store.list();
  readFail.push(`${ROOTS.EXTERNAL_STORAGE}/Music/Album One`);
  const found = await store.scanLinked();
  assert.equal(found.partial, true);
  assert.deepEqual(found.groups.map((g) => g.folder), ['']);

  readFail = [];
  assert.equal((await store.scanLinked()).partial, false);

  readFail.push(`${ROOTS.EXTERNAL_STORAGE}/Music`); // the folder next to the downloads itself
  assert.deepEqual(await store.scanLinked(), { failed: true });
});

// ---- PIV-LIB-001: a scan that saw only part must not make the app forget a folder ----
const sibKey = () => JSON.parse(ls.get('piverxy_local_folders') || 'null');

test('RT-07: a partial scan does not take a linked folder out of what is remembered', async () => {
  const store = launch();
  await store.list();
  assert.equal((await store.scanLinked()).partial, false);
  assert.deepEqual(sibKey(), { folders: ['Album One'], loose: true });

  readFail.push(`${ROOTS.EXTERNAL_STORAGE}/Music/Album One`); // it can't be read just now
  const partial = await store.scanLinked();
  assert.equal(partial.partial, true);
  assert.deepEqual(partial.groups.map((g) => g.folder), ['']);
  assert.deepEqual(sibKey(), { folders: ['Album One'], loose: true }, 'the folder that could not be read is still remembered');

  readFail = []; // a complete scan is the one that may change what is remembered
  assert.equal((await store.scanLinked()).partial, false);
  assert.deepEqual(sibKey(), { folders: ['Album One'], loose: true });
});

test('RT-07: a partial scan adds what it found; a complete scan is what takes a folder out', async () => {
  const store = launch();
  await store.list();
  await store.scanLinked();
  put('EXTERNAL_STORAGE', 'Music/Album Two/a.mp3');
  readFail.push(`${ROOTS.EXTERNAL_STORAGE}/Music/Album One`);
  await store.scanLinked(); // partial: Album Two is new, Album One was not readable
  assert.deepEqual(sibKey().folders.slice().sort(), ['Album One', 'Album Two']);
  readFail = [];
  for (const f of [...files.keys()]) if (f.includes('/Music/Album One/')) files.delete(f); // the person really deleted it
  assert.equal((await store.scanLinked()).partial, false);
  assert.deepEqual(sibKey().folders, ['Album Two'], 'seen in full and gone: now it is forgotten');
});

test('RT-07: a first scan that is partial still remembers what it linked (nothing to lose, and the songs must play after a restart)', async () => {
  const store = launch();
  await store.list();
  readFail.push(`${ROOTS.EXTERNAL_STORAGE}/Music/Album One`);
  assert.equal((await store.scanLinked()).partial, true);
  assert.deepEqual(sibKey(), { folders: [], loose: true });
});

test('RT-08: after a partial scan and a restart the earlier folder is back in the file index', async () => {
  let store = launch();
  await store.list();
  await store.scanLinked();
  readFail.push(`${ROOTS.EXTERNAL_STORAGE}/Music/Album One`);
  assert.equal((await store.scanLinked()).partial, true);
  readFail = []; // restart: whatever it was is over
  store = launch();
  const vpaths = (await store.list()).map((e) => e.vpath);
  assert.ok(vpaths.includes('/data/LocalMusic/Album One/01 First.mp3'), 'the folder is restored');
  assert.ok(vpaths.includes('/data/LocalMusic/Album One/Disc 2/02 Second.flac'));
  assert.equal(await store.fileUrl('/data/LocalMusic/Album One/01 First.mp3'), `file://${ROOTS.EXTERNAL_STORAGE}/Music/Album One/01 First.mp3`);
});

// ---- PIV-LIB-002: the limit is for the whole scan, not for one folder ----
function songs(folder, count) { for (let i = 0; i < count; i++) put('EXTERNAL_STORAGE', `Music/${folder}/song ${i}.mp3`); }

test('RT-09: many folders, each under the limit, together over it: the scan stops at the limit and says it is partial', async () => {
  songs('Big A', 2400);
  songs('Big B', 2400);
  songs('Big C', 2400); // 7200 and the 3 of the fixture: each folder alone is far under 5000
  const store = launch();
  await store.list();
  const found = await store.scanLinked();
  const total = found.groups.reduce((n, g) => n + g.files.length, 0);
  assert.equal(total, 5000, 'never over the limit');
  assert.equal(found.partial, true);
  // a partial scan must not unlink anything: it remembers every folder it saw
  assert.ok(sibKey().folders.length >= 1);
});

test('RT-09: exactly the limit is not partial, one song more is', async () => {
  songs('Exact', 4997); // 4997 + the 3 songs of the fixture
  const store = launch();
  await store.list();
  const exact = await store.scanLinked();
  assert.equal(exact.groups.reduce((n, g) => n + g.files.length, 0), 5000);
  assert.equal(exact.partial, false, 'nothing was left out');
  put('EXTERNAL_STORAGE', 'Music/Exact/one more.mp3');
  const over = await store.scanLinked();
  assert.equal(over.groups.reduce((n, g) => n + g.files.length, 0), 5000);
  assert.equal(over.partial, true);
});

test('RT-09: the limit holds at launch too (the folders remembered are read again with the same limit)', async () => {
  songs('Big A', 3000);
  songs('Big B', 3000);
  let store = launch();
  await store.list();
  await store.scanLinked();
  store = launch();
  const vpaths = (await store.list()).map((e) => e.vpath).filter((v) => v.startsWith('/data/LocalMusic/'));
  assert.ok(vpaths.length <= 5000, `${vpaths.length} linked songs listed`);
});

// ---- the permission to read music and audio (Android 11+ hides songs the app did not make until it is given) ----
const apiId = require.resolve('../mobile/electron-api.js');
// electron-api.js with the store of this launch (it takes it from the module cache, which launch() just filled)
function api(store) {
  global.document = { addEventListener() {}, hidden: false };
  global.window = {};
  delete require.cache[apiId];
  const registered = [];
  const fakeFs = { _register: (p, size) => registered.push(p), _flush: async () => {} };
  return { registered, api: require(apiId)({ ready: Promise.resolve(), port: 1, fs: fakeFs, fileUrlFor: () => '' }) };
}

test('without the permission songs the app did not save are hidden; once it is given they show up, in the downloads and as playlists', async () => {
  audioGranted = false;
  const store = launch();
  const entries = await store.list();
  assert.equal(entries.some((e) => e.vpath === '/data/Downloads/Artist - Song.mp3'), false, 'hidden');
  assert.equal(store.needsReadAccess(), true);
  assert.deepEqual(await store.readAccess(), { granted: false, canAsk: true });
  assert.deepEqual((await store.scanLinked()).groups, [], 'no songs next to the download folder either');

  assert.deepEqual(await store.readAccess({ ask: true }), { granted: true, canAsk: false });
  const fresh = (await store.rescanDownloads()).map((e) => e.vpath).sort();
  assert.deepEqual(fresh, ['/data/Downloads/Artist - Opus.webm', '/data/Downloads/Artist - Song.mp3']);
  assert.deepEqual(await store.rescanDownloads(), [], 'each song turns up once');
  assert.equal(await store.fileUrl('/data/Downloads/Artist - Song.mp3'), `file://${ROOTS.EXTERNAL_STORAGE}/Music/Piverxy/Artist - Song.mp3`);
  assert.equal((await store.scanLinked()).groups.length, 2);
});

test('the folder playlists ask for the permission first, and scan once it is given (songs hidden before show up as well)', async () => {
  audioGranted = false;
  const store = launch();
  await store.list();
  const { api: electron, registered } = api(store);
  const found = await electron.scanLocalFolders();
  assert.deepEqual(asked, [{ settings: false }], 'the system dialog, not the Settings page');
  assert.deepEqual(found.groups.map((g) => g.folder), ['', 'Album One']);
  for (const g of found.groups) for (const i of g.items) assert.match(i.id, /^local_[a-f0-9]{12}$/);
  assert.ok(registered.includes('/data/LocalMusic/Album One/01 First.mp3'), 'the linked songs are in the file index');
  assert.ok(registered.includes('/data/Downloads/Artist - Song.mp3'), 'and so are the downloads that were hidden until now');
  assert.equal(found.partial, false);

  asked.length = 0;
  await electron.scanLocalFolders();
  assert.deepEqual(asked, [], 'already allowed: nothing is asked again');
});

test('when the person says no, nothing is scanned and the app says what to do', async () => {
  audioGranted = false;
  answer = 'deny';
  const store = launch();
  await store.list();
  const { api: electron } = api(store);
  assert.deepEqual(await electron.scanLocalFolders(), { needsPermission: true, settingsOpened: false });
  assert.equal(canAsk, true, 'one refusal: the dialog can come again');
  assert.deepEqual(await electron.scanLocalFolders(), { needsPermission: true, settingsOpened: false });
  assert.equal(canAsk, false, 'two refusals: Android stops showing the dialog');
  assert.equal(opened, 0);
});

test('refused for good: the app opens its page in Settings instead of a dialog that will not come', async () => {
  audioGranted = false;
  canAsk = false;
  const store = launch();
  await store.list();
  const { api: electron } = api(store);
  assert.deepEqual(await electron.scanLocalFolders(), { needsPermission: true, settingsOpened: true });
  assert.deepEqual(asked, [{ settings: true }]);
  assert.equal(opened, 1);
});

test('the app\'s own folder needs no permission: its neighbours are scanned without asking', async () => {
  audioGranted = false;
  let store = launch();
  await store.list();
  await store.setDownloadDir(APPFOLDER, { move: false });
  store = launch();
  await store.list();
  assert.equal(store.needsReadAccess(), false);
  const { api: electron } = api(store);
  const found = await electron.scanLocalFolders();
  assert.deepEqual(found.groups.map((g) => g.folder), ['music']);
  assert.deepEqual(asked, []);
});

test('an older build of the plugin without these methods does not block the scan', async () => {
  audioGranted = false;
  capacitor.Plugins.PiverxyMedia = { audioAccess: async () => { throw new Error('UNIMPLEMENTED'); }, allowAudioAccess: async () => { throw new Error('UNIMPLEMENTED'); } };
  const store = launch();
  await store.list();
  assert.deepEqual(await store.readAccess(), { granted: true, canAsk: false });
});

// ---- Settings: where an unfinished move stands, and Retry (mobile/electron-api.js) ----
test('the API: with nothing pending, the status says so and Retry does nothing', async () => {
  const store = launch();
  await store.list();
  const { api: electron } = api(store);
  assert.deepEqual(await electron.getMoveStatus(), { pending: false });
  const res = await electron.retryMove();
  assert.equal(res.ok, true);
  assert.equal(res.ran, false);
  assert.equal(res.pending, false);
});

test('the API: the status tells what is left and why; Retry runs the move again', async () => {
  put('EXTERNAL', 'download/Artist - Song.mp3', 'BBBB'); // same name, same size, other bytes
  deleteFails.push('Music/Piverxy/Artist - Opus.mka');
  let store = launch();
  await store.list();
  await store.setDownloadDir(APPFOLDER, { move: true });
  store = launch();
  await store.list();
  const { api: electron } = api(store);
  const status = await electron.getMoveStatus();
  assert.equal(status.pending, true);
  assert.equal(status.conflicts, 1);
  assert.equal(status.cleanup, 1);
  assert.equal(status.left, 2);
  assert.equal(status.failed, 0);
  assert.equal(status.permission, false);
  deleteFails = [];
  const res = await electron.retryMove();
  assert.equal(res.ran, true);
  assert.equal(res.pending, true, 'the conflict is still there: it needs the person');
  assert.equal(res.conflicts, 1);
  assert.equal(res.cleanup, 0, 'the old copy that would not delete is gone now');
  assert.equal(res.moved, 1);
});

test('the API: Retry asks for the permission first when the move is waiting for it, then finishes the move', async () => {
  audioGranted = false; // songs the app did not save are hidden
  answer = 'allow';
  let store = launch();
  await store.list();
  await store.setDownloadDir(APPFOLDER, { move: true });
  assert.equal(journal().last.permission, true);
  store = launch();
  await store.list();
  const { api: electron } = api(store);
  assert.equal((await electron.getMoveStatus()).permission, true);
  asked.length = 0;
  const res = await electron.retryMove();
  assert.deepEqual(asked, [{ settings: false }], 'the system dialog came first');
  assert.equal(res.ok, true);
  assert.equal(res.ran, true);
  assert.equal(res.pending, false);
  assert.equal(journal(), null);
  assert.equal(has('EXTERNAL', 'download/Artist - Song.mp3'), true);
});

test('the API: Retry without the permission says so, moves nothing and keeps the move pending', async () => {
  audioGranted = false;
  answer = 'deny';
  let store = launch();
  await store.list();
  await store.setDownloadDir(APPFOLDER, { move: true });
  store = launch();
  await store.list();
  const { api: electron } = api(store);
  const res = await electron.retryMove();
  assert.equal(res.ok, false);
  assert.equal(res.needsPermission, true);
  assert.equal(res.settingsOpened, false);
  assert.equal(has('EXTERNAL_STORAGE', 'Music/Piverxy/Artist - Song.mp3'), true);
  assert.ok(journal());
});

// ---- The music permission taken back (Settings -> Apps -> Piverxy -> Permissions) ----
// The songs linked in place (the folders next to the download folder) stay in the library and in every playlist, but Android
// refuses to read them: they are LOCKED until the permission is given again. Locked is a state worked out from the permission as
// it is now; nothing is written down for it, and nothing is unlinked, forgotten or deleted because of it.
const nodeFs = require('node:fs');
const vm = require('node:vm');

const FIRST = '/data/LocalMusic/Album One/01 First.mp3';
const LOOSE = '/data/LocalMusic/loose song.mp3';
const SIB = 'piverxy_local_folders';

// a launch of the app: the storage shim and the API the page talks to, with the events the page would hear
function launchLive() {
  const store = launch();
  const listeners = {};
  const events = [];
  global.document = { addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); }, hidden: false };
  global.window = { dispatchEvent: (e) => { events.push({ type: e.type, detail: e.detail }); return true; } };
  global.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } };
  delete require.cache[apiId];
  const registered = [];
  const fakeFs = { _register: (p) => registered.push(p), _flush: async () => {} };
  const electron = require(apiId)({ ready: Promise.resolve(), port: 1, fs: fakeFs, fileUrlFor: () => '' });
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
  // the app comes back to the front (Android: visibilitychange / appStateChange)
  const foreground = async () => { for (const fn of listeners.visibilitychange || []) fn(); await settle(); };
  return { store, api: electron, registered, events, foreground, settle };
}
const accessEvents = (events) => events.filter((e) => e.type === 'piverxy:media-access').map((e) => e.detail);
const linkedIn = (entries) => entries.map((e) => e.vpath).filter((v) => v.startsWith('/data/LocalMusic/'));
const refused = (e) => e && e.code === 'MEDIA_PERMISSION_REQUIRED';

test('MP-01: permission granted -> scan -> the linked songs are in the file index and open from where they are', async () => {
  const { store, api: electron, registered } = launchLive();
  await store.list();
  const found = await electron.scanLocalFolders();
  assert.deepEqual(found.groups.map((g) => g.folder), ['', 'Album One']);
  assert.ok(registered.includes(FIRST) && registered.includes(LOOSE), 'registered with the file index');
  assert.deepEqual(store.linkedAccess(), { locked: false, canAsk: false });
  assert.equal(await store.fileUrl(FIRST), `file://${ROOTS.EXTERNAL_STORAGE}/Music/Album One/01 First.mp3`);
  // and after a restart, still granted: the same songs are back, nothing locked
  const again = launchLive();
  assert.ok(linkedIn(await again.store.list()).includes(FIRST));
  assert.equal(again.store.linkedAccess().locked, false);
});

test('MP-02: permission taken back, app restarted: what is remembered and every file are exactly as they were, and the songs are locked', async () => {
  let live = launchLive();
  await live.store.list();
  await live.api.scanLocalFolders();
  const remembered = ls.get(SIB);
  assert.ok(remembered, 'the scan remembered the folders');

  audioGranted = false; // turned off in Settings; Android restarts the app
  live = launchLive();
  const entries = await live.store.list();
  assert.deepEqual(linkedIn(entries), [], 'not read: Android would show the folders as empty, which says nothing about the songs');
  assert.deepEqual(live.store.linkedAccess(), { locked: true, canAsk: true });
  assert.equal(ls.get(SIB), remembered, 'the folders that were linked are still remembered, byte for byte');
  assert.deepEqual(deleted, [], 'nothing was deleted');
  for (const f of ['Music/Album One/01 First.mp3', 'Music/Album One/Disc 2/02 Second.flac', 'Music/loose song.mp3']) assert.equal(has('EXTERNAL_STORAGE', f), true, f);
  await assert.rejects(live.store.fileUrl(FIRST), refused, 'a locked song is never handed to the WebView');
});

test('MP-02b: the phone shim tells the server what the storage shim knows (platform.linkedAccessLocked)', async () => {
  let live = launchLive();
  await live.store.list();
  const platform = require('../mobile/shims/platform.js');
  assert.equal(platform.linkedAccessLocked(), false);
  audioGranted = false;
  live = launchLive();
  await live.store.list();
  assert.equal(platform.linkedAccessLocked(), true);
  assert.equal(platform.LOCAL_LINK_DIR, '/data/LocalMusic', 'the folder the server looks for locked songs in is the one the store links from');
});

test('MP-03: permission taken back, a song is asked for: refused with MEDIA_PERMISSION_REQUIRED, not "file missing"', async () => {
  let live = launchLive();
  await live.store.list();
  await live.api.scanLocalFolders();
  audioGranted = false;
  live = launchLive();
  await live.store.list();
  await assert.rejects(live.store.fileUrl(LOOSE), (e) => e.code === 'MEDIA_PERMISSION_REQUIRED' && e.message === 'MEDIA_PERMISSION_REQUIRED');
  assert.equal(live.store.isLinkedLocked(LOOSE), true);
  assert.equal(live.store.isLinkedLocked('/data/Downloads/x.mp3'), false);
  assert.equal(live.store.isLinkedLocked('/data/library/local_aaaaaaaaaaaa.mp3'), false);
});

test('MP-04: the permission given again: the linked songs are back in the file index first, then unlock, and play from where they are', async () => {
  let live = launchLive();
  await live.store.list();
  await live.api.scanLocalFolders();
  const remembered = ls.get(SIB);
  audioGranted = false;
  live = launchLive();
  await live.store.list();
  assert.equal((await live.api.getMediaAccess()).locked, true);
  assert.deepEqual(live.registered, []);

  audioGranted = true; // given again in Settings
  const seen = [];
  const hooked = live.store.refreshLinkedAccess;
  assert.equal(typeof hooked, 'function');
  await live.foreground();
  assert.deepEqual(live.store.linkedAccess(), { locked: false, canAsk: false });
  assert.ok(live.registered.includes(FIRST) && live.registered.includes(LOOSE), 'put back in the file index');
  assert.ok(live.registered.includes('/data/LocalMusic/Album One/Disc 2/02 Second.flac'));
  assert.equal(await live.store.fileUrl(FIRST), `file://${ROOTS.EXTERNAL_STORAGE}/Music/Album One/01 First.mp3`);
  const heard = accessEvents(live.events);
  assert.deepEqual(heard.map((d) => d.locked), [true, false], 'the page heard it locked, then unlocked');
  assert.equal(heard[1].restored, 3);
  assert.equal(ls.get(SIB), remembered, 'what is remembered did not change on the way');
  assert.deepEqual(seen, []);
});

test('MP-04b: the songs are registered before the lock lifts (none is asked for while it is not in the file index)', async () => {
  audioGranted = false;
  const store = launch();
  await store.list();
  put('EXTERNAL_STORAGE', 'Music/Album One/03 Third.mp3');
  // the folders were remembered by an earlier scan
  ls.set(SIB, JSON.stringify({ folders: ['Album One'], loose: false }));
  audioGranted = true;
  let lockWhenRegistered = null;
  const r = await store.refreshLinkedAccess((entries) => { lockWhenRegistered = store.linkedAccess().locked; assert.ok(linkedIn(entries).length >= 3); });
  assert.equal(lockWhenRegistered, true, 'registered while still locked');
  assert.equal(r.locked, false);
  assert.equal(store.linkedAccess().locked, false);
});

test('MP-05: the permission taken back while the app is running: coming back to the front refreshes the state, nothing else changes', async () => {
  const live = launchLive();
  await live.store.list();
  await live.api.scanLocalFolders();
  assert.deepEqual(await live.api.getMediaAccess(), { locked: false, canAsk: false });
  const remembered = ls.get(SIB);

  audioGranted = false; // turned off while Piverxy is in the background
  await live.foreground();
  assert.deepEqual(live.store.linkedAccess(), { locked: true, canAsk: true });
  assert.deepEqual(accessEvents(live.events).map((d) => d.locked), [false, true], 'the page is told');
  await assert.rejects(live.store.fileUrl(FIRST), refused);
  assert.equal(ls.get(SIB), remembered);
  assert.deepEqual(deleted, []);

  // looking again with nothing changed says nothing again
  await live.foreground();
  await live.foreground();
  assert.equal(accessEvents(live.events).length, 2);

  audioGranted = true;
  await live.foreground();
  assert.deepEqual(accessEvents(live.events).map((d) => d.locked), [false, true, false]);
  assert.equal(await live.store.fileUrl(FIRST), `file://${ROOTS.EXTERNAL_STORAGE}/Music/Album One/01 First.mp3`);
});

test('MP-05b: two looks at the permission at once are one look (a burst of foreground events)', async () => {
  const live = launchLive();
  await live.store.list();
  let reads = 0;
  const real = capacitor.Plugins.PiverxyMedia.audioAccess;
  capacitor.Plugins.PiverxyMedia.audioAccess = async () => { reads++; return real(); };
  const [a, b, c] = await Promise.all([live.api.getMediaAccess(), live.api.getMediaAccess(), live.api.getMediaAccess()]);
  assert.deepEqual([a, b, c], [{ locked: false, canAsk: false }, { locked: false, canAsk: false }, { locked: false, canAsk: false }]);
  assert.equal(reads, 1);
});

test('MP-06: songs kept inside the app (imported into the library) stay playable while the permission is off', async () => {
  let live = launchLive();
  await live.store.list();
  await live.store.writeBytes('/data/library/local_aaaaaaaaaaaa.mp3', new Uint8Array([1, 2, 3, 4]));
  await live.store.writeText('/data/library.json', '{"local_aaaaaaaaaaaa":{"id":"local_aaaaaaaaaaaa"}}');
  audioGranted = false;
  live = launchLive();
  const entries = await live.store.list();
  assert.ok(entries.some((e) => e.vpath === '/data/library/local_aaaaaaaaaaaa.mp3'), 'still listed');
  assert.ok(entries.some((e) => e.vpath === '/data/library.json'));
  assert.equal(live.store.linkedAccess().locked, true, 'while the linked ones are locked');
  assert.equal(live.store.isLinkedLocked('/data/library/local_aaaaaaaaaaaa.mp3'), false);
  assert.match(await live.store.fileUrl('/data/library/local_aaaaaaaaaaaa.mp3'), /^file:\/\/.*\/Piverxy\/library\/local_aaaaaaaaaaaa\.mp3$/);
});

test('MP-07: songs Piverxy downloaded itself stay listed and playable while the permission is off', async () => {
  let live = launchLive();
  await live.store.list();
  await live.store.writeBytes('/data/Downloads/Mine - Downloaded.mp3', new Uint8Array([9, 9, 9]));
  audioGranted = false;
  live = launchLive();
  const entries = await live.store.list();
  assert.ok(entries.some((e) => e.vpath === '/data/Downloads/Mine - Downloaded.mp3'), 'a file the app made is not hidden from it');
  assert.equal(live.store.isLinkedLocked('/data/Downloads/Mine - Downloaded.mp3'), false);
  assert.equal(await live.store.fileUrl('/data/Downloads/Mine - Downloaded.mp3'), `file://${ROOTS.EXTERNAL_STORAGE}/Music/Piverxy/Mine - Downloaded.mp3`);
  assert.equal(entries.some((e) => e.vpath === '/data/Downloads/Artist - Song.mp3'), false, 'one a file manager put there is hidden by Android (as before)');
});

test('MP-08: after the permission is back, scanning again finds the same songs under the same ids (nothing new to make playlists of)', async () => {
  let live = launchLive();
  await live.store.list();
  const first = await live.api.scanLocalFolders();
  audioGranted = false;
  live = launchLive();
  await live.store.list();
  audioGranted = true;
  await live.foreground();
  const second = await live.api.scanLocalFolders();
  assert.deepEqual(second.groups, first.groups, 'same folders, same songs, same ids');
});

test('MP-09: scanning without the permission remembers nothing, forgets nothing and deletes nothing', async () => {
  let live = launchLive();
  await live.store.list();
  await live.api.scanLocalFolders();
  const remembered = ls.get(SIB);
  audioGranted = false;
  live = launchLive();
  await live.store.list();
  // what the original code did here: a "complete" scan that saw nothing replaced what was remembered and had every song forgotten
  const scan = await live.store.scanLinked();
  assert.equal(scan.locked, true);
  assert.deepEqual(scan.groups, []);
  assert.equal(ls.get(SIB), remembered);
  answer = 'deny';
  assert.deepEqual(await live.api.scanLocalFolders(), { needsPermission: true, settingsOpened: false });
  assert.equal(ls.get(SIB), remembered);
  assert.deepEqual(live.registered, []);
  assert.deepEqual(deleted, []);
});

test('MP-09b: the permission taken back in the middle of a scan: the scan is not believed, nothing is remembered from it', async () => {
  let live = launchLive();
  await live.store.list();
  await live.api.scanLocalFolders();
  const remembered = ls.get(SIB);
  const realReaddir = Filesystem.readdir;
  let reads = 0;
  Filesystem.readdir = async (o) => { if (++reads === 1) audioGranted = false; return realReaddir(o); }; // gone as the first folder is read
  try {
    const found = await live.api.scanLocalFolders();
    assert.deepEqual(found, { needsPermission: true, settingsOpened: false });
  } finally { Filesystem.readdir = realReaddir; }
  assert.ok(reads >= 1);
  assert.equal(ls.get(SIB), remembered, 'what a scan that saw hidden folders found is not what is remembered');
  assert.deepEqual(deleted, []);
});

test('MP-10: the app\'s own folder needs no permission: its linked songs are never locked', async () => {
  audioGranted = false;
  let live = launchLive();
  await live.store.list();
  await live.store.setDownloadDir(APPFOLDER, { move: false });
  live = launchLive();
  await live.store.list();
  assert.deepEqual(await live.store.scanLinked().then((f) => f.groups.map((g) => g.folder)), ['music']);
  assert.deepEqual(live.store.linkedAccess(), { locked: false, canAsk: false });
  live = launchLive();
  assert.ok(linkedIn(await live.store.list()).length > 0, 'put back at launch with no permission at all');
  assert.match(await live.store.fileUrl(linkedIn(await live.store.list())[0]), /Android\/data/);
});

test('MP-11: an older build of the plugin (no audioAccess) locks nothing: the songs behave as they always did', async () => {
  let live = launchLive();
  await live.store.list();
  await live.api.scanLocalFolders();
  audioGranted = false;
  capacitor.Plugins.PiverxyMedia = { audioAccess: async () => { throw new Error('UNIMPLEMENTED'); } };
  live = launchLive();
  await live.store.list();
  assert.equal(live.store.linkedAccess().locked, false);
  assert.equal(await live.store.fileUrl(FIRST), `file://${ROOTS.EXTERNAL_STORAGE}/Music/Album One/01 First.mp3`);
});

test('MP-12: Android 10 and older, storage permission taken back: the linked songs lock, and the scan says what it always said', async () => {
  let live = launchLive();
  await live.store.list();
  await live.api.scanLocalFolders();
  const remembered = ls.get(SIB);
  audioGranted = false;
  const realCheck = Filesystem.checkPermissions;
  Filesystem.checkPermissions = async () => ({ publicStorage: 'prompt' }); // before Android 11 shared storage needs the real permission
  try {
    live = launchLive();
    await live.store.list();
    assert.equal(live.store.downloadsFolder(), 'Music/Piverxy', 'asked for when the first song is saved');
    assert.equal(live.store.needsReadAccess(), false, 'no shared folder in use');
    assert.deepEqual(live.store.linkedAccess(), { locked: true, canAsk: true });
    assert.equal(await live.store.scanLinked(), null, 'unchanged: nothing next to a download folder that is inside the app');
    assert.equal(ls.get(SIB), remembered);
    await assert.rejects(live.store.fileUrl(FIRST), refused);
  } finally { Filesystem.checkPermissions = realCheck; }
});

test('MP-13: Settings opens the app\'s page, whatever the dialog would do', async () => {
  audioGranted = false;
  canAsk = false;
  const live = launchLive();
  await live.store.list();
  assert.equal(await live.api.openAppSettings(), true);
  assert.equal(opened, 1);
  assert.deepEqual(asked, [], 'no dialog: a permission turned off in Settings is usually not asked for again');
  // an older build of the plugin has no openAppSettings: the dialog method that falls back to the page is used
  const media = capacitor.Plugins.PiverxyMedia;
  delete media.openAppSettings;
  assert.equal(await live.api.openAppSettings(), true);
  assert.deepEqual(asked, [{ settings: true }]);
});

// ---- the page: tapping "Folder playlists" must never empty the playlists because of the permission ----
const appSource = nodeFs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
function appFn(name) {
  let at = appSource.indexOf(`function ${name}(`);
  assert.ok(at >= 0, name);
  if (appSource.slice(at - 6, at) === 'async ') at -= 6; // keep the async of an async function
  const open = appSource.indexOf('{', appSource.slice(at).search(/\)\s*\{/) + at);
  let depth = 0;
  for (let i = open; i < appSource.length; i++) {
    if (appSource[i] === '{') depth++;
    else if (appSource[i] === '}' && --depth === 0) return appSource.slice(at, i + 1);
  }
  throw new Error('unbalanced ' + name);
}

// app.js's importLocalFolders / dropLinkedFromLists / saveAllPlaylists, as they are, against the real API of the phone and a
// server that behaves like server.js's /api/library-link, -unlink and library (the real server is exercised in
// media-permission-server.test.js)
function pagePlaylists(electronAPI) {
  const library = new Map(); // id -> { id, platform, title, artist, duration, linked }
  const posts = [];
  const toasts = [];
  const ctx = {
    window: { electronAPI }, document: { getElementById: () => null }, console,
    localStorage: global.localStorage,
    state: { serverPort: 1, playlists: [], localTracks: null, currentView: 'discover' },
    Tm: (s, ...a) => a.reduce((t, v, i) => t.replace(`{${i}}`, v), s),
    T: (s) => s,
    showToast: (m) => toasts.push(m),
    linkFolderSongs: require('../library-tools.js').linkFolderSongs,
    stampAddedAt: (t) => ({ ...t, addedAt: 1 }),
    renderPlaylistsList() {}, renderLocalView() {}, probeLinkedDurations: async () => {},
    createPlaylist(name, tracks) {
      const pl = { id: `pl_${ctx.state.playlists.length + 1}`, name, tracks: tracks.map(ctx.stampAddedAt) };
      ctx.state.playlists.push(pl);
      global.localStorage.setItem('devsize_playlists', JSON.stringify(ctx.state.playlists));
      return pl;
    },
    fetch: async (url, init = {}) => {
      const route = url.replace('http://127.0.0.1:1', '');
      const body = init.body ? JSON.parse(init.body) : {};
      const reply = (json, status = 200) => ({ ok: status < 400, status, json: async () => json });
      if (init.method === 'POST') posts.push({ route, body });
      if (route === '/api/library-link') {
        for (const i of body.items) library.set(i.id, { id: i.id, platform: 'local', title: i.name, artist: 'Unknown artist', duration: 0, linked: true });
        return reply({ success: true, count: body.items.length });
      }
      if (route === '/api/library-unlink') {
        // server.js: a rescan's unlink (it sends `keep`) is refused while the songs are locked; the hook is the phone's own
        if (Array.isArray(body.keep) && require('../mobile/shims/platform.js').linkedAccessLocked()) return reply({ success: false, code: 'MEDIA_PERMISSION_REQUIRED' }, 403);
        const keep = new Set(body.keep || []);
        const ids = [...library.values()].filter((t) => t.linked && !keep.has(t.id)).map((t) => t.id);
        for (const id of ids) library.delete(id);
        return reply({ success: true, ids });
      }
      if (route === '/api/library') return reply([...library.values()].map(({ linked, ...t }) => t));
      throw new Error('unexpected ' + route);
    },
  };
  vm.createContext(ctx);
  vm.runInContext(['saveAllPlaylists', 'dropLinkedFromLists', 'importLocalFolders'].map(appFn).join('\n') + '\nthis.importLocalFolders = importLocalFolders;', ctx);
  return { run: () => ctx.importLocalFolders(), ctx, library, posts, toasts, playlists: () => global.localStorage.getItem('devsize_playlists') };
}

test('MP-14: Folder playlists tapped with the permission off (or taken back mid-scan): no playlist loses a song, nothing is unlinked', async () => {
  // permission given: playlists made
  let live = launchLive();
  await live.store.list();
  let page = pagePlaylists(live.api);
  await page.run();
  assert.deepEqual(page.ctx.state.playlists.map((p) => [p.name, p.tracks.length]), [['Local files', 1], ['Album One', 2]]);
  const saved = page.playlists();
  const libraryBefore = JSON.stringify([...page.library.values()]);

  // taken back; the person taps Folder playlists and says no to the dialog
  audioGranted = false;
  answer = 'deny';
  live = launchLive();
  await live.store.list();
  const library = page.library;
  const playlists = page.ctx.state.playlists;
  page = pagePlaylists(live.api);
  page.ctx.state.playlists = playlists;
  for (const [id, t] of library) page.library.set(id, t);
  await page.run();
  assert.deepEqual(page.posts, [], 'nothing was linked or forgotten');
  assert.equal(page.playlists(), saved, 'the playlists are what they were');
  assert.equal(JSON.stringify([...page.library.values()]), libraryBefore);
  assert.match(page.toasts.join('|'), /permission/);

  // taken back in the middle of the scan: what the original code did was a "complete" scan that saw nothing, which forgot every song
  audioGranted = true;
  live = launchLive();
  await live.store.list();
  page = pagePlaylists(live.api);
  page.ctx.state.playlists = playlists;
  for (const [id, t] of library) page.library.set(id, t);
  const realReaddir = Filesystem.readdir;
  let reads = 0;
  Filesystem.readdir = async (o) => { if (++reads === 1) audioGranted = false; return realReaddir(o); };
  try { await page.run(); } finally { Filesystem.readdir = realReaddir; }
  assert.deepEqual(page.posts, [], 'nothing was linked or forgotten');
  assert.equal(page.playlists(), saved);
  assert.equal(JSON.stringify([...page.library.values()]), libraryBefore);
  assert.deepEqual(deleted, []);
});

test('MP-15: after the permission is back, Folder playlists again makes no second playlist and takes nothing out', async () => {
  let live = launchLive();
  await live.store.list();
  let page = pagePlaylists(live.api);
  await page.run();
  const playlists = page.ctx.state.playlists;
  const library = page.library;
  const named = () => playlists.map((p) => p.name);

  audioGranted = false;
  live = launchLive();
  await live.store.list();
  audioGranted = true;
  await live.foreground();
  for (let n = 0; n < 2; n++) {
    page = pagePlaylists(live.api);
    page.ctx.state.playlists = playlists;
    for (const [id, t] of library) page.library.set(id, t);
    await page.run();
    assert.deepEqual(named(), ['Local files', 'Album One'], `run ${n + 1}: no duplicate playlists`);
    assert.deepEqual(playlists.map((p) => p.tracks.length), [1, 2]);
    assert.equal(page.library.size, 3, 'every linked song is still known');
  }
});

test('MP-16: a first-time user (permission never given, so locked at launch) allows it in the dialog and the playlists are made: the lock is not stale', async () => {
  audioGranted = false;
  answer = 'allow';
  const live = launchLive();
  await live.store.list();
  assert.equal(live.store.linkedAccess().locked, true, 'nothing is linked yet, but the permission is not there');
  const page = pagePlaylists(live.api);
  await page.run();
  assert.deepEqual(page.ctx.state.playlists.map((p) => [p.name, p.tracks.length]), [['Local files', 1], ['Album One', 2]]);
  assert.deepEqual(page.posts.map((p) => p.route), ['/api/library-link', '/api/library-unlink'], 'the rescan\'s unlink was allowed: the permission is there now');
  assert.deepEqual(live.store.linkedAccess(), { locked: false, canAsk: false }, 'unlocked the moment it was given, not at the next time the app comes to the front');
  assert.deepEqual(page.toasts.filter((t) => /Could not/.test(t)), []);
});

test('MP-17: Retry of a move that waited for the permission: allowed in the dialog, the linked songs unlock at once (not at the next foreground)', async () => {
  audioGranted = false;
  answer = 'allow';
  let live = launchLive();
  await live.store.list();
  await live.store.setDownloadDir('Download/Piverxy songs', { move: true });
  assert.equal(journal().last.permission, true, 'the other apps\' songs in the old folder are hidden: the move waits for the permission');
  live = launchLive();
  await live.store.list();
  assert.equal(live.store.linkedAccess().locked, true);
  assert.equal((await live.api.getMediaAccess()).locked, true, 'the page looks at start');
  asked.length = 0;
  const res = await live.api.retryMove();
  assert.deepEqual(asked, [{ settings: false }], 'the system dialog came first');
  assert.equal(res.ok, true);
  assert.deepEqual(live.store.linkedAccess(), { locked: false, canAsk: false });
  assert.deepEqual(accessEvents(live.events).map((d) => d.locked), [true, false]);
});
