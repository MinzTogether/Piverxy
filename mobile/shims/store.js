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
// the folder chosen in Settings; while a move to another one is unfinished, that one (see "moving the downloads")
const readLoc = () => { const m = readMove(); return m ? m.to : parseLocation(lsGet(LOC_KEY)); };
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
  // a move that was cut short: the songs still in the old folders stay where they are, and the move carries on
  const behind = [];
  const m = readMove();
  if (m && pubDir === kindDir(m.to.kind) && pub === m.to.root) {
    const have = new Set(found.map((e) => e.vpath));
    for (const from of m.from) {
      const dir = kindDir(from.kind);
      let list;
      try { list = (await Filesystem.readdir({ path: from.root, directory: dir })).files; } catch (e) { continue; }
      for (const f of list) {
        if (f.type !== 'file' || f.name.startsWith('.')) continue;
        const vpath = `${DOWNLOADS}/${dir === PUBLIC ? f.name.replace(/\.mka$/i, '.webm') : f.name}`;
        if (have.has(vpath)) continue; // in the new folder as well: it is the one that counts
        have.add(vpath);
        placed.set(vpath, { path: `${from.root}/${f.name}`, directory: dir });
        behind.push({ vpath, isDir: false, size: f.size || 0, mtimeMs: Number(f.mtime) || Date.now() });
      }
    }
    const timer = setTimeout(resumeMove, 10000); // once the app has started
    if (timer && timer.unref) timer.unref();
  }
  out.push({ vpath: DOWNLOADS, isDir: true, size: 0, mtimeMs: Date.now() }, ...found, ...behind);
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
    if (f.name.startsWith(PART)) continue; // a song still being copied by a move
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

// A move writes a journal first (MOVE_KEY: where the songs go, where they come from, how often it was tried), then
// moves the songs one by one. If the app is closed in the middle, the next launch reads the journal: the songs still
// in an old folder show up where they are (none disappears) and the move carries on in the background.
const MOVE_KEY = 'muriel_download_move';
const PART = '.muriel-part-'; // a song being copied has this in front of its name; it gets its own name once it is whole
const sameLoc = (a, b) => !!a && !!b && a.kind === b.kind && a.root === b.root;
const textOfLoc = (l) => textOf(l.kind, l.root);

// -> { to, from: [..], tries } or null
function readMove() {
  const j = lsGet(MOVE_KEY);
  const to = j && typeof j.to === 'string' ? parseLocation(j.to) : null;
  if (!to) return null;
  const from = (Array.isArray(j.from) ? j.from : []).map(parseLocation).filter((l) => l && !sameLoc(l, to));
  return { to, from, tries: Number(j.tries) || 0 };
}
// no `to`, or nowhere to move from: the journal goes
const writeMove = (to, from, tries) => lsSet(MOVE_KEY, to && from.length ? { to: textOfLoc(to), from: from.map(textOfLoc), tries } : null);

// 'moved' | 'conflict' | 'failed'. Never copies onto a file that is already there: what the plugin does then
// (replace it, refuse, something else) is not something to lean on. Same name and same size means the song is
// already there (a move cut short after copying it); a different file with that name is left alone, and so is the song.
// The copy goes to a temporary name and is renamed once its size is right, so a half song never has the real name.
async function moveOne(from, to, f) {
  const fromDir = kindDir(from.kind);
  const toDir = kindDir(to.kind);
  const vname = fromDir === PUBLIC ? f.name.replace(/\.mka$/i, '.webm') : f.name;
  const dname = sharedName(vname, toDir);
  const src = { path: `${from.root}/${f.name}`, directory: fromDir };
  const dst = { path: `${to.root}/${dname}`, directory: toDir };
  const part = { path: `${to.root}/${PART}${dname}`, directory: toDir };
  const result = (status) => ({ status, vpath: `${DOWNLOADS}/${vname}`, dst });
  let size = f.size;
  if (!size) { try { size = (await Filesystem.stat(src)).size; } catch (e) { return result('failed'); } }
  let there = null;
  try { there = await Filesystem.stat(dst); } catch (e) {} // nothing there: the usual case
  if (there) {
    if (there.type !== 'file' || there.size !== size) return result('conflict');
    await Filesystem.deleteFile(src).catch(() => {});
    scan(src);
    return result('moved');
  }
  try {
    await Filesystem.mkdir({ path: to.root, directory: toDir, recursive: true }).catch(() => {}); // there already
    await Filesystem.deleteFile(part).catch(() => {}); // a half copy from an earlier try
    await Filesystem.copy({ from: src.path, directory: fromDir, to: part.path, toDirectory: toDir });
    if ((await Filesystem.stat(part)).size !== size) throw new Error('short copy');
    await Filesystem.rename({ from: part.path, directory: toDir, to: dst.path, toDirectory: toDir });
  } catch (e) {
    await Filesystem.deleteFile(part).catch(() => {});
    return result('failed');
  }
  await Filesystem.deleteFile(src).catch(() => {});
  scan(src);
  scan(dst);
  return result('moved');
}

// every song in the old folders goes to `to`; one that can't go stays where it is
async function runMove(to, froms) {
  const total = { moved: 0, failed: 0, conflicts: 0 };
  const toDir = kindDir(to.kind);
  try { // half copies that a cut-short run left behind
    for (const f of (await Filesystem.readdir({ path: to.root, directory: toDir })).files) {
      if (f.name.startsWith(PART)) await Filesystem.deleteFile({ path: `${to.root}/${f.name}`, directory: toDir }).catch(() => {});
    }
  } catch (e) {}
  for (const from of froms) {
    if (sameLoc(from, to)) continue;
    let list;
    try { list = (await Filesystem.readdir({ path: from.root, directory: kindDir(from.kind) })).files; } catch (e) { continue; } // gone: nothing left there
    for (const f of list) {
      if (f.type !== 'file' || f.name.startsWith('.')) continue;
      const r = await moveOne(from, to, f);
      if (r.status === 'moved') {
        total.moved++;
        if (placed.has(r.vpath)) placed.set(r.vpath, r.dst);
      } else if (r.status === 'conflict') total.conflicts++;
      else total.failed++;
    }
  }
  return total;
}

// After a run: done, or only conflicts (another try would not change them): the journal goes. A song that failed to
// copy is tried again at the next launches, three runs in all.
function settleMove(to, froms, tries, r) {
  if (r.failed === 0 || tries + 1 >= 3) writeMove(null);
  else writeMove(to, froms, tries + 1);
}

let resuming = false;
async function resumeMove() {
  const m = readMove();
  // only into the folder that is in use (the app falls back to another one when the chosen one can't be opened)
  if (!m || resuming || !pub || pubDir !== kindDir(m.to.kind) || pub !== m.to.root) return;
  resuming = true;
  try {
    settleMove(m.to, m.from, m.tries, await runMove(m.to, m.from));
  } finally { resuming = false; }
}

// Saves the new folder. The journal goes before the choice, and both before the first song moves.
async function switchTo(loc, move, custom) {
  const pending = readMove();
  const was = pub ? { kind: pubDir === APPDIR ? 'app' : 'shared', root: pub } : null;
  // where songs may be now: the folder in use, and the folders of an earlier move that never finished
  const froms = [...(pending ? [...pending.from, pending.to] : []), ...(was ? [was] : [])]
    .filter((l, i, all) => !sameLoc(l, loc) && all.findIndex((x) => sameLoc(x, l)) === i);
  writeMove(move ? loc : null, move ? froms : [], 0);
  lsSet(LOC_KEY, custom ? textOfLoc(loc) : null);
  lsSet(SIB_KEY, null); // the folders next to the old one are not the ones next to the new one
  let r = { moved: 0, failed: 0, conflicts: 0 };
  if (move && froms.length) {
    r = await runMove(loc, froms);
    settleMove(loc, froms, 0, r);
  }
  return { ok: true, dir: shown(loc.kind, loc.root), ...r };
}

// ---- Android: the folders next to the download folder, as playlists ----
// Reads one folder (relative to the folder that holds the download folder), down to `depth` levels of subfolders.
// ctx.partial turns true when something could not be read or the limit cut the list short: the result is then not
// "everything there is", and the caller must not take a missing song for a deleted one.
async function listAudio(rel, depth, found, ctx) {
  let res;
  try { res = await Filesystem.readdir({ path: parentRoot() ? `${parentRoot()}/${rel}` : rel, directory: pubDir }); } catch (e) { ctx.partial = true; return; }
  for (const f of res.files) {
    if (found.length >= MAX_LINKED) { ctx.partial = true; return; }
    if (f.name.startsWith('.')) continue;
    const child = `${rel}/${f.name}`;
    if (f.type === 'directory') { if (depth > 0) await listAudio(child, depth - 1, found, ctx); }
    else if (AUDIO_RE.test(f.name)) found.push({ rel: child, size: f.size || 0, mtimeMs: Number(f.mtime) || Date.now() });
  }
}

// -> null (the downloads are inside the app), { failed: true } (the folder next to them can't be read), or
// { groups: [{ folder, files: [{ vpath, name, size, mtimeMs }] }], partial }; folder '' holds the songs that lie
// loose next to the download folder. `only` ({ folders, loose }) narrows it to what was linked before (every launch).
async function collectLinked(only) {
  if (!ANDROID || !pub) return null;
  const ctx = { partial: false };
  let top;
  try { top = await Filesystem.readdir({ path: parentRoot(), directory: pubDir }); } catch (e) { return { failed: true }; }
  const mine = pub.slice(pub.lastIndexOf('/') + 1).toLowerCase(); // the download folder itself is not a playlist
  const groups = [];
  const loose = [];
  let total = 0;
  for (const f of top.files) {
    if (f.name.startsWith('.')) continue;
    if (total >= MAX_LINKED) { ctx.partial = true; continue; }
    if (f.type === 'directory') {
      if (f.name.toLowerCase() === mine || f.name === 'Android') continue;
      if (only && !only.folders.includes(f.name)) continue;
      const found = [];
      await listAudio(f.name, 2, found, ctx);
      if (found.length) { groups.push({ folder: f.name, found }); total += found.length; }
    } else if (AUDIO_RE.test(f.name) && (!only || only.loose)) {
      loose.push({ rel: f.name, size: f.size || 0, mtimeMs: Number(f.mtime) || Date.now() });
      total++;
    }
  }
  if (loose.length) groups.unshift({ folder: '', found: loose });
  // Android lists a folder in no particular order: playlists go by file name (01 before 2 before 10), so they come out the same every time
  const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  const sorted = groups.map((g) => ({
    folder: g.folder,
    files: g.found.sort((a, b) => byName.compare(a.rel, b.rel)).map((f) => ({ vpath: `${LOCALROOT}/${f.rel}`, name: f.rel.slice(f.rel.lastIndexOf('/') + 1).replace(/\.[^.]+$/, ''), size: f.size, mtimeMs: f.mtimeMs })),
  }));
  return { groups: sorted, partial: ctx.partial };
}

// at launch: the songs of the folders that were linked before are put back in the file index (fs shim), so they play
async function listLinked(out) {
  const was = lsGet(SIB_KEY);
  if (!was || !pub) return;
  const found = await collectLinked({ folders: Array.isArray(was.folders) ? was.folders : [], loose: !!was.loose }).catch(() => null);
  for (const g of (found && found.groups) || []) for (const f of g.files) out.push({ vpath: f.vpath, isDir: false, size: f.size, mtimeMs: f.mtimeMs });
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
  // each place offered in Settings: text (what is kept), shown (as Settings shows it), full (the path on the phone).
  // `label` of a shared folder is the folder's name (not translated); the app folder's label and every hint are Muriel's words.
  downloadChoices: () => [
    { text: PUBLIC_ROOTS[0], kind: 'shared', label: `Music / ${FOLDER}`, hint: 'Music apps and file managers find it' },
    { text: `Download/${FOLDER}`, kind: 'shared', label: `Download / ${FOLDER}`, hint: 'Next to your other downloads' },
    { text: PUBLIC_ROOTS[1], kind: 'shared', label: `Documents / ${FOLDER}`, hint: '' },
    { text: `${appFiles()}/download`, kind: 'app', label: 'App folder', hint: "Needs no permission. File managers on Android 11+ can't open it" },
  ].map((c) => ({ ...c, shown: c.text, full: ROOT_PREFIX + c.text })),
  isCustomDownloadDir: () => !!parseLocation(lsGet(LOC_KEY)),
  sharedTops: () => SHARED_TOPS.slice(),
  // a folder typed or picked in the sheet, as Settings shows it (null: not a folder Muriel can use)
  showDownloadDir(text) {
    const loc = parseLocation(text);
    return loc ? shown(loc.kind, loc.root) : null;
  },

  // Saves the choice. With move, the songs already downloaded go along (see switchTo). The app restarts afterwards
  // (the caller), because every part of it has the old folder in its file index.
  async setDownloadDir(text, { move = true } = {}) {
    if (!ANDROID) return { ok: false, error: 'The download folder is fixed here' };
    const loc = parseLocation(text);
    if (!loc) return { ok: false, error: "That isn't a folder Muriel can save songs in" };
    const problem = await checkWritable(loc);
    if (problem) return { ok: false, error: problem };
    return switchTo(loc, move, true);
  },

  async resetDownloadDir({ move = true } = {}) {
    if (!ANDROID) return { ok: true };
    for (const root of PUBLIC_ROOTS) {
      const loc = { kind: 'shared', root };
      if (!(await checkWritable(loc))) return switchTo(loc, move, false);
    }
    return { ok: false, error: "Muriel can't save songs in the default folder right now" };
  },
  // a move that was cut short carries on by itself shortly after launch; this is for tests
  resumeMove,

  // ---- Android: folders next to the download folder ----
  // -> null when downloads are kept inside the app (nothing "next to" them to read); { failed: true } when the folder
  // can't be read; else { parent, groups, partial } (partial: some folder could not be read, or there are too many songs)
  async scanLinked() {
    const found = await collectLinked(null);
    if (!found || found.failed) return found;
    const { groups, partial } = found;
    lsSet(SIB_KEY, { folders: groups.filter((g) => g.folder).map((g) => g.folder), loose: groups.some((g) => !g.folder) });
    return { parent: ROOT_PREFIX + (pubDir === APPDIR ? `${appFiles()}/` : '') + parentRoot(), groups, partial };
  },
  hasLinkedFolders: () => !!(ANDROID && pub),

  // ---- Android: reading songs the app did not save itself ----
  // Android 11+ hides a song the app did not make (a file manager or a computer put it there, or an earlier install of
  // Muriel saved it) until the app may read music and audio (MediaControlsPlugin.allowAudioAccess). That is only so on
  // shared storage: the app's own folder (Android/data/<package>/files) needs nothing.
  needsReadAccess: () => !!(ANDROID && pub && pubDir === PUBLIC),
  // -> { granted, canAsk } (canAsk false: said no for good, only the app's page in Settings turns it on). With ask, the
  // system dialog comes first (answers when it is closed); with settings too, a refusal for good opens that page.
  async readAccess({ ask = false, settings = false } = {}) {
    const media = Capacitor.Plugins && Capacitor.Plugins.MurielMedia; // registered by media-controls.js
    if (!ANDROID || !media) return { granted: true, canAsk: false };
    try { return await (ask ? media.allowAudioAccess({ settings }) : media.audioAccess()); } catch (e) {
      return { granted: true, canAsk: false }; // an older build of the plugin: nothing to ask
    }
  },
  // The download folder read again, for songs that were hidden until the permission came in. -> the ones that are new.
  async rescanDownloads() {
    if (!ANDROID || !pub) return [];
    const found = [];
    await walk(pub, pubDir, fromPub, found);
    const fresh = [];
    for (const e of found) {
      if (e.isDir || placed.has(e.vpath)) continue;
      placed.set(e.vpath, { path: e.rpath, directory: pubDir });
      fresh.push({ vpath: e.vpath, size: e.size, mtimeMs: e.mtimeMs });
    }
    return fresh;
  },

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
