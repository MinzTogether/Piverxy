// Persistent storage behind the fs shim. Virtual paths under /data map to Capacitor Filesystem paths under
// Muriel/ (IndexedDB in a browser): in Documents on iOS, visible in the Files app; in the app's private storage
// on Android, except the songs people download, which go to Music/Muriel Mod (see "Android: downloads" below).
const path = require('path');
const { Filesystem, Directory, Encoding } = require('@capacitor/filesystem');
const { Capacitor } = require('@capacitor/core');

const ROOT = 'Muriel';
const ANDROID = Capacitor.getPlatform() === 'android';
// iOS: Documents (shown in the Files app). Android: app-private storage; public Documents needs permissions.
const DIR = ANDROID ? Directory.Data : Directory.Documents;

const toReal = (vpath) => ROOT + vpath.replace(/^\/data/, '');
const toVirtual = (rpath) => '/data' + rpath.slice(ROOT.length);
const priv = (vpath) => ({ path: toReal(vpath), directory: DIR });

// ---- Android: downloads ----
// Songs saved with Download (/data/Downloads) go to Music/Muriel Mod on the phone's shared storage (Documents/Muriel Mod
// if Music can't be used), where file managers and music apps find them. The song cache and the rest stay private.
// Android 11+ lets an app save files there without asking. Android 10 and older need the storage permission
// (AndroidManifest.xml); it's asked for when the first song is saved, and without it downloads stay private.
const DOWNLOADS = '/data/Downloads';
const PUBLIC = Directory.ExternalStorage;
// the app's own folder on shared storage: Android/data/<package>/files. Needs no permission on any Android version
// (other apps and, on Android 11+, file managers can't browse it).
const APPDIR = Directory.External;
// The mod's own folder name: the original Muriel saves to Music/Muriel, and on Android 11+ an app can't change or delete
// files another app made there, so two apps sharing one folder would trip over each other.
const FOLDER = 'Muriel Mod';
const PUBLIC_ROOTS = [`Music/${FOLDER}`, `Documents/${FOLDER}`];
let pub = null; // the folder in use, e.g. 'Music/Muriel Mod' (in PUBLIC) or 'download' (in APPDIR)
let pubDir = PUBLIC; // which of the two it is in
let mayAsk = false; // Android 10 and older: storage permission not given, but may be
let asked = false;
// ---- Android: choosing the download folder (Settings → Folders → Download folder → Change) ----
// The choice is kept as text: 'Music/Muriel Mod' (shared storage) or 'Android/data/<package>/files/download' (the app's
// own folder). Shared storage only takes the folders Android lets an app write to, and a folder of its own inside one.
// the package name; replaced by the real one at launch (list below), because a rebuilt app may carry another
let APP_ID = 'io.github.murielmod';
const appFiles = () => `Android/data/${APP_ID}/files`;
const SHARED_TOPS = ['Music', 'Documents', 'Download', 'Podcasts', 'Audiobooks'];
const LOC_KEY = 'muriel_download_location';
const SIB_KEY = 'muriel_local_folders'; // which folders next to the download folder were linked as playlists
const ROOT_PREFIX = '/storage/emulated/0/';
const lsGet = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } };
const lsSet = (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };

// text -> { kind: 'shared' | 'app', root } (root is relative to that kind's directory), or null when it isn't usable
function parseLocation(text) {
  const s = String(text == null ? '' : text).replace(/\\/g, '/').replace(/^\/storage\/(emulated\/0|self\/primary)\//, '').replace(/\/{2,}/g, '/').replace(/^\/+|\/+$/g, '');
  if (!s) return null;
  const segs = s.split('/');
  if (segs.some((x) => !x || x === '.' || x === '..' || x.startsWith('.') || /[<>:"|?*\u0000-\u001f]/.test(x))) return null;
  const APP_FILES = appFiles();
  if (s === APP_FILES || s.startsWith(APP_FILES + '/')) {
    const root = s.slice(APP_FILES.length).replace(/^\//, '');
    return root ? { kind: 'app', root } : null;
  }
  const top = SHARED_TOPS.find((t) => t.toLowerCase() === segs[0].toLowerCase());
  if (!top || segs.length < 2) return null; // 'Music' itself is not a folder of Muriel's
  return { kind: 'shared', root: [top, ...segs.slice(1)].join('/') };
}
const kindDir = (kind) => (kind === 'app' ? APPDIR : PUBLIC);
const textOf = (kind, root) => (kind === 'app' ? `${appFiles()}/${root}` : root);
const readLoc = () => parseLocation(lsGet(LOC_KEY));
// a folder as Settings shows it: 'Music/Muriel Mod' (the sheet that picks it also shows the full path)
const shown = (kind, root) => textOf(kind, root);
const sharedName = (rel, dir) => (dir === PUBLIC ? rel.replace(/\.webm$/i, '.mka') : rel);

// where each download really is: found at launch, or saved this session (a download from before: private)
const placed = new Map(); // vpath -> { path, directory }
const leftovers = []; // private copies of songs that are in the public folder already
const inUse = new Set(); // downloads whose file URL the app holds (bridge.js keeps it): those move next launch

const isDownload = (vpath) => ANDROID && vpath.startsWith(DOWNLOADS + '/');
// Android files .webm as video, and Music/ only takes audio: a WebM song (Opus) is saved as .mka there, which
// it is too (WebM is a kind of Matroska), so music apps list it. Inside the app it keeps its .webm name.
const pubLoc = (vpath) => ({ path: pub + sharedName(vpath.slice(DOWNLOADS.length), pubDir), directory: pubDir });
const fromPub = (rpath) => DOWNLOADS + rpath.slice(pub.length).replace(/\.mka$/i, '.webm');

// ---- Android: songs in the folders next to the download folder ----
// /data/LocalMusic/<rel> is <folder next to the download folder>/<rel>: the songs are played where they are (never copied
// and never deleted by Muriel) and show up as playlists (scanSiblings below).
const LOCALROOT = '/data/LocalMusic';
const isLocalLink = (vpath) => ANDROID && vpath.startsWith(LOCALROOT + '/');
const parentRoot = () => (pub && pub.includes('/') ? pub.slice(0, pub.lastIndexOf('/')) : '');
const localLoc = (vpath) => {
  const rel = vpath.slice(LOCALROOT.length + 1);
  const parent = parentRoot();
  return { path: parent ? `${parent}/${rel}` : rel, directory: pubDir };
};
const AUDIO_RE = /\.(mp3|m4a|flac|opus|wav|ogg|oga|aac|weba)$/i;
const MAX_LINKED = 5000;

// where a file is (everything outside Downloads: in the app's own storage)
function where(vpath) {
  if (!ANDROID) return priv(vpath);
  if (pub && isLocalLink(vpath)) return localLoc(vpath);
  if (vpath === DOWNLOADS) return pub ? { path: pub, directory: pubDir } : priv(vpath);
  if (!isDownload(vpath)) return priv(vpath);
  return placed.get(vpath) || (pub ? pubLoc(vpath) : priv(vpath));
}

// where a file being saved goes. On Android 10 and older the first download asks for the permission, without
// waiting for the answer: with Muriel in the background the question waits for its return, and the music (which
// waits for files to be saved) would too. Songs saved meanwhile stay private and move once it's given.
function saveTo(vpath) {
  if (isDownload(vpath) && !pub && mayAsk && !asked) {
    asked = true;
    Filesystem.requestPermissions()
      .then((r) => (r.publicStorage === 'granted' ? openPublic() : null))
      .catch(() => {})
      .then(() => { mayAsk = false; });
  }
  return where(vpath);
}

function saved(vpath, loc) {
  if (!isDownload(vpath)) return;
  placed.set(vpath, loc);
  scan(loc);
}

// Android 10 and older only index new files at their next full scan: tell the media index now, so the song shows
// up in music apps right away (Android 11+ does that by itself; MediaControlsPlugin.java)
function scan(loc) {
  const media = Capacitor.Plugins && Capacitor.Plugins.MurielMedia; // registered by media-controls.js
  if (loc.directory !== PUBLIC || !media) return;
  Filesystem.getUri(loc).then(({ uri }) => media.scanFile({ path: uri })).catch(() => {});
}

async function openPublic() {
  // the folder chosen in Settings first; when it can't be used (permission taken back, folder gone) the usual ones
  const chosen = readLoc();
  const tries = [...(chosen ? [chosen] : []), ...PUBLIC_ROOTS.map((root) => ({ kind: 'shared', root }))];
  for (const { kind, root } of tries) {
    const directory = kindDir(kind);
    try { await Filesystem.mkdir({ path: root, directory, recursive: true }); } catch (e) {} // there already
    try { if ((await Filesystem.stat({ path: root, directory })).type !== 'directory') continue; } catch (e) { continue; }
    pub = root;
    pubDir = directory;
    setTimeout(moveOldDownloads, 10000); // once the app has started
    return;
  }
}

// Songs downloaded before this went to the app's private storage, where nobody could find them: they move to the
// public folder, one at a time in the background
async function moveOldDownloads() {
  for (const old of leftovers.splice(0)) await Filesystem.deleteFile(old).catch(() => {});
  for (const [vpath, from] of [...placed]) {
    if (from.directory !== DIR || path.dirname(vpath) !== DOWNLOADS || inUse.has(vpath)) continue;
    const to = pubLoc(vpath);
    try {
      await Filesystem.copy({ from: from.path, directory: from.directory, to: to.path, toDirectory: to.directory });
    } catch (e) { continue; } // a type Android won't keep in Music/, say: it stays where it is
    saved(vpath, to);
    await Filesystem.deleteFile(from).catch(() => {});
  }
}

async function listDownloads(out) {
  for (const e of out) if (!e.isDir && isDownload(e.vpath)) placed.set(e.vpath, priv(e.vpath));
  const chosen = readLoc();
  if (chosen && chosen.kind === 'app') await openPublic(); // the app's own folder needs no permission
  if (!pub) {
    let perm = null;
    try { perm = (await Filesystem.checkPermissions()).publicStorage; } catch (e) {}
    if (perm === 'granted') await openPublic();
    else mayAsk = perm === 'prompt' || perm === 'prompt-with-rationale';
  }
  if (!pub) return;
  const found = [];
  await walk(pub, pubDir, fromPub, found);
  for (const e of found) {
    if (e.isDir) continue;
    const old = placed.get(e.vpath);
    if (old && old.directory === DIR) leftovers.push(old); // copied over before, but not deleted
    placed.set(e.vpath, { path: e.rpath, directory: pubDir });
  }
  out.push({ vpath: DOWNLOADS, isDir: true, size: 0, mtimeMs: Date.now() }, ...found);
}

function b64FromBytes(bytes) {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(s);
}

// Files reach the native side as base64 text. A FLAC (30-150 MB) used to go over as one string, held several
// times over on both sides of the bridge, and that crashed the app. Now they go in pieces this big
// (a multiple of 3, so the base64 of the pieces joins up into the base64 of the whole file).
const PIECE = 3 * 256 * 1024;

async function writeInPieces(vpath, size, piece) {
  const loc = saveTo(vpath);
  let at = 0;
  try {
    do {
      const data = b64FromBytes(await piece(at, Math.min(size, at + PIECE)));
      if (at === 0) await Filesystem.writeFile({ ...loc, data, recursive: true });
      else await Filesystem.appendFile({ ...loc, data });
      at += PIECE;
    } while (at < size);
  } catch (e) {
    // no half-written file left behind (it would look like the whole song)
    try { await Filesystem.deleteFile(loc); } catch (x) {}
    throw e;
  }
  saved(vpath, loc);
}

async function walk(rpath, directory, toV, out) {
  let res;
  try { res = await Filesystem.readdir({ path: rpath, directory }); } catch (e) { return; }
  for (const f of res.files) {
    const child = `${rpath}/${f.name}`;
    const isDir = f.type === 'directory';
    out.push({ vpath: toV(child), rpath: child, isDir, size: f.size || 0, mtimeMs: Number(f.mtime) || Date.now() });
    if (isDir) await walk(child, directory, toV, out);
  }
}

// ---- Android: moving the downloads to another folder ----
// null when the folder can be used, otherwise what to tell the person
async function checkWritable({ kind, root }) {
  const directory = kindDir(kind);
  if (kind === 'shared') {
    let perm = null;
    try { perm = (await Filesystem.checkPermissions()).publicStorage; } catch (e) {}
    if (perm === 'prompt' || perm === 'prompt-with-rationale') {
      try { perm = (await Filesystem.requestPermissions()).publicStorage; } catch (e) {}
    }
    if (perm && perm !== 'granted') return 'Muriel needs access to storage to save songs there';
  }
  try { await Filesystem.mkdir({ path: root, directory, recursive: true }); } catch (e) {} // there already
  // a real write: Android 11+ refuses some files in some folders (Music/ only takes audio, say), and that
  // would only show up with the first download. The probe is named like a song for that reason.
  const probe = `${root}/.muriel-write-test.mp3`;
  try {
    await Filesystem.writeFile({ path: probe, directory, data: 'AAAA', recursive: true });
    await Filesystem.deleteFile({ path: probe, directory });
  } catch (e) {
    return "Muriel can't save songs in that folder";
  }
  return null;
}

// Copies every download the app knows of to the new folder, then deletes the old copy. A song that can't be
// moved stays where it is. Returns how many went and how many didn't.
async function moveDownloads({ kind, root }) {
  const directory = kindDir(kind);
  let moved = 0;
  let failed = 0;
  for (const [vpath, from] of [...placed]) {
    if (path.dirname(vpath) !== DOWNLOADS) continue;
    const to = { path: root + sharedName(vpath.slice(DOWNLOADS.length), directory), directory };
    if (from.directory === to.directory && from.path === to.path) continue;
    try {
      await Filesystem.mkdir({ path: path.dirname(to.path), directory, recursive: true }).catch(() => {});
      await Filesystem.copy({ from: from.path, directory: from.directory, to: to.path, toDirectory: to.directory });
    } catch (e) { failed++; continue; }
    await Filesystem.deleteFile(from).catch(() => {});
    scan(from);
    scan(to);
    moved++;
  }
  return { moved, failed };
}

// ---- Android: the folders next to the download folder, as playlists ----
// Reads one folder (relative to the folder that holds the download folder), down to `depth` levels of subfolders.
async function listAudio(rel, depth, found) {
  let res;
  try { res = await Filesystem.readdir({ path: parentRoot() ? `${parentRoot()}/${rel}` : rel, directory: pubDir }); } catch (e) { return; }
  for (const f of res.files) {
    if (found.length >= MAX_LINKED) return;
    if (f.name.startsWith('.')) continue;
    const child = `${rel}/${f.name}`;
    if (f.type === 'directory') { if (depth > 0) await listAudio(child, depth - 1, found); }
    else if (AUDIO_RE.test(f.name)) found.push({ rel: child, size: f.size || 0, mtimeMs: Number(f.mtime) || Date.now() });
  }
}

// -> [{ folder, files: [{ vpath, name, size, mtimeMs }] }]; folder '' holds the songs that lie loose next to the
// download folder. `only` ({ folders, loose }) narrows it to what was linked before (done at every launch).
async function collectLinked(only) {
  if (!ANDROID || !pub) return null;
  let top;
  try { top = await Filesystem.readdir({ path: parentRoot(), directory: pubDir }); } catch (e) { return null; }
  const mine = pub.slice(pub.lastIndexOf('/') + 1).toLowerCase(); // the download folder itself is not a playlist
  const groups = [];
  const loose = [];
  let total = 0;
  for (const f of top.files) {
    if (f.name.startsWith('.') || total >= MAX_LINKED) continue;
    if (f.type === 'directory') {
      if (f.name.toLowerCase() === mine || f.name === 'Android') continue;
      if (only && !only.folders.includes(f.name)) continue;
      const found = [];
      await listAudio(f.name, 2, found);
      if (found.length) { groups.push({ folder: f.name, found }); total += found.length; }
    } else if (AUDIO_RE.test(f.name) && (!only || only.loose)) {
      loose.push({ rel: f.name, size: f.size || 0, mtimeMs: Number(f.mtime) || Date.now() });
      total++;
    }
  }
  if (loose.length) groups.unshift({ folder: '', found: loose });
  // Android lists a folder in no particular order: playlists go by file name (01 before 2 before 10), so they come out the same every time
  const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  return groups.map((g) => ({
    folder: g.folder,
    files: g.found.sort((a, b) => byName.compare(a.rel, b.rel)).map((f) => ({ vpath: `${LOCALROOT}/${f.rel}`, name: f.rel.slice(f.rel.lastIndexOf('/') + 1).replace(/\.[^.]+$/, ''), size: f.size, mtimeMs: f.mtimeMs })),
  }));
}

// at launch: the songs of the folders that were linked before are put back in the file index (fs shim), so they play
async function listLinked(out) {
  const was = lsGet(SIB_KEY);
  if (!was || !pub) return;
  const groups = await collectLinked({ folders: Array.isArray(was.folders) ? was.folders : [], loose: !!was.loose }).catch(() => null);
  for (const g of groups || []) for (const f of g.files) out.push({ vpath: f.vpath, isDir: false, size: f.size, mtimeMs: f.mtimeMs });
}

module.exports = {
  isNative: () => Capacitor.isNativePlatform(),

  async list() {
    try { await Filesystem.mkdir({ path: ROOT, directory: DIR, recursive: true }); } catch (e) {}
    const out = [];
    await walk(ROOT, DIR, toVirtual, out);
    if (ANDROID) {
      try { APP_ID = (await require('@capacitor/app').App.getInfo()).id || APP_ID; } catch (e) {}
      await listDownloads(out);
      await listLinked(out);
    }
    return out;
  },


  // ---- Android: download folder choice ----
  // each place offered in Settings: text (what is kept), shown (as Settings shows it), full (the path on the phone)
  downloadChoices: () => [
    { text: PUBLIC_ROOTS[0], label: `Music / ${FOLDER}`, hint: 'Music apps and file managers find it' },
    { text: `Download/${FOLDER}`, label: `Download / ${FOLDER}`, hint: 'Next to your other downloads' },
    { text: PUBLIC_ROOTS[1], label: `Documents / ${FOLDER}`, hint: '' },
    { text: `${appFiles()}/download`, label: 'App folder', hint: 'Android / data / … / files / download. Needs no permission; file managers on Android 11+ can\'t open it' },
  ].map((c) => ({ ...c, shown: c.text, full: ROOT_PREFIX + c.text })),
  isCustomDownloadDir: () => !!readLoc(),
  sharedTops: () => SHARED_TOPS.slice(),
  // a folder typed or picked in the sheet, as Settings shows it (null: not a folder Muriel can use)
  showDownloadDir(text) {
    const loc = parseLocation(text);
    return loc ? shown(loc.kind, loc.root) : null;
  },

  // Saves the choice. With move, the songs already downloaded go along. The app restarts afterwards (the caller),
  // because every part of it has the old folder in its file index.
  async setDownloadDir(text, { move = true } = {}) {
    if (!ANDROID) return { ok: false, error: 'The download folder is fixed here' };
    const loc = parseLocation(text);
    if (!loc) return { ok: false, error: "That isn't a folder Muriel can save songs in" };
    const problem = await checkWritable(loc);
    if (problem) return { ok: false, error: problem };
    let result = { moved: 0, failed: 0 };
    if (move) result = await moveDownloads(loc);
    lsSet(LOC_KEY, textOf(loc.kind, loc.root));
    lsSet(SIB_KEY, null); // the folders next to the old one are not the ones next to the new one
    return { ok: true, dir: shown(loc.kind, loc.root), ...result };
  },

  async resetDownloadDir({ move = true } = {}) {
    if (!ANDROID) return { ok: true };
    for (const root of PUBLIC_ROOTS) {
      const loc = { kind: 'shared', root };
      if (await checkWritable(loc)) continue;
      let result = { moved: 0, failed: 0 };
      if (move) result = await moveDownloads(loc);
      lsSet(LOC_KEY, null);
      lsSet(SIB_KEY, null);
      return { ok: true, dir: shown('shared', root), ...result };
    }
    return { ok: false, error: "Muriel can't save songs in the default folder right now" };
  },

  // ---- Android: folders next to the download folder ----
  // -> null when downloads are kept inside the app (nothing "next to" them to read), else { parent, groups }
  async scanLinked() {
    const groups = await collectLinked(null);
    if (!groups) return null;
    lsSet(SIB_KEY, { folders: groups.filter((g) => g.folder).map((g) => g.folder), loose: groups.some((g) => !g.folder) });
    return { parent: ROOT_PREFIX + (pubDir === APPDIR ? `${appFiles()}/` : '') + parentRoot(), groups };
  },
  hasLinkedFolders: () => !!(ANDROID && pub),

  // the folder downloads go to, as people see it on their phone (null: inside the app, where only it sees them)
  downloadsFolder: () => (pub ? shown(pubDir === APPDIR ? 'app' : 'shared', pub) : mayAsk ? PUBLIC_ROOTS[0] : null),

  async readText(vpath) {
    const r = await Filesystem.readFile({ ...where(vpath), encoding: Encoding.UTF8 });
    return typeof r.data === 'string' ? r.data : await r.data.text();
  },

  async writeText(vpath, text) {
    const loc = saveTo(vpath);
    await Filesystem.writeFile({ ...loc, data: text, encoding: Encoding.UTF8, recursive: true });
    saved(vpath, loc);
  },

  writeBytes: (vpath, bytes) => writeInPieces(vpath, bytes.length, async (from, to) => bytes.subarray(from, to)),

  // a picked File: only one piece of it is ever read into memory
  writeBlob: (vpath, blob) => writeInPieces(vpath, blob.size, async (from, to) => new Uint8Array(await blob.slice(from, to).arrayBuffer())),

  async remove(vpath, isDir) {
    if (isLocalLink(vpath)) return; // the user's own files: Muriel only forgets them
    const loc = where(vpath);
    if (isDir) await Filesystem.rmdir({ ...loc, recursive: true });
    else await Filesystem.deleteFile(loc);
    for (const k of [...placed.keys()]) if (k === vpath || k.startsWith(vpath + '/')) placed.delete(k);
    scan(loc);
  },

  async mkdir(vpath) {
    try { await Filesystem.mkdir({ ...where(vpath), recursive: true }); } catch (e) {}
  },

  async rename(from, to) {
    const a = where(from);
    const b = saveTo(to);
    await Filesystem.rename({ from: a.path, directory: a.directory, to: b.path, toDirectory: b.directory });
    placed.delete(from);
    scan(a);
    saved(to, b);
  },

  async copy(from, to) {
    const a = where(from);
    const copyTo = async (b) => {
      // a download's folder may not be there yet (which one it is can change while the app runs)
      if (isDownload(to)) await Filesystem.mkdir({ path: path.dirname(b.path), directory: b.directory, recursive: true }).catch(() => {});
      await Filesystem.copy({ from: a.path, directory: a.directory, to: b.path, toDirectory: b.directory });
      saved(to, b);
    };
    const b = saveTo(to);
    try {
      await copyTo(b);
    } catch (e) {
      if (b.directory === DIR) throw e;
      // the public folder refused it (Android 11+ won't let the app replace a song a former install of it saved
      // there, for one): kept in the app's storage, as before
      await copyTo(priv(to));
    }
  },

  // Streams a remote file straight to disk natively; returns the byte size.
  async download(url, vpath, headers = {}) {
    const loc = saveTo(vpath);
    if (!Capacitor.isNativePlatform()) {
      // browser harness: downloadFile would hit CORS, so go through the dev proxy
      const r = await globalThis.__murielFetch(url, { headers });
      if (!r.ok) throw new Error(`download failed: ${r.status}`);
      const bytes = new Uint8Array(await r.arrayBuffer());
      await Filesystem.writeFile({ ...loc, data: b64FromBytes(bytes), recursive: true });
      return bytes.length;
    }
    await Filesystem.downloadFile({ url, ...loc, recursive: true, headers });
    const st = await Filesystem.stat(loc);
    saved(vpath, loc);
    return st.size || 0;
  },

  // A URL the WebView can load directly (same origin, so Web Audio can process it).
  async fileUrl(vpath, mime) {
    const loc = where(vpath);
    if (isDownload(vpath)) inUse.add(vpath);
    if (Capacitor.isNativePlatform()) {
      const { uri } = await Filesystem.getUri(loc);
      return Capacitor.convertFileSrc(uri);
    }
    const r = await Filesystem.readFile(loc);
    const blob = r.data instanceof Blob ? r.data : await (await fetch(`data:${mime || 'application/octet-stream'};base64,${r.data}`)).blob();
    return URL.createObjectURL(blob);
  },
};
