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
  // A move that is not settled (cut short, or with songs it could not move): the songs still in the old folders stay where
  // they are and are listed from there, so none disappears, and the move carries on. A song with the same name as one in
  // the folder in use is that same song when the move was cut short after copying it (the copy counts). When it hit a
  // conflict it is another file: it is listed under another name (its own with "(old)" added) so that it can still be played.
  const behind = [];
  const m = readMove();
  if (m) {
    const have = new Set(found.map((e) => e.vpath));
    const sizes = new Map(found.filter((e) => !e.isDir).map((e) => [e.vpath, e.size]));
    const held = heldOf(m);
    const active = { kind: pubDir === APPDIR ? 'app' : 'shared', root: pub };
    for (const from of m.from) {
      if (sameLoc(from, active)) continue; // walked above
      const dir = kindDir(from.kind);
      let list;
      try { list = (await Filesystem.readdir({ path: from.root, directory: dir })).files; } catch (e) { warnMove('list', textOfLoc(from), e); continue; }
      for (const f of list) {
        if (f.type !== 'file' || f.name.startsWith('.')) continue;
        let vpath = `${DOWNLOADS}/${dir === PUBLIC ? f.name.replace(/\.mka$/i, '.webm') : f.name}`;
        if (have.has(vpath)) {
          if (sizes.get(vpath) === (f.size || 0) && !held(textOfLoc(from), f.name)) continue; // in the folder in use as well: that is the one that counts
          vpath = freeName(vpath, have);
        }
        have.add(vpath);
        placed.set(vpath, { path: `${from.root}/${f.name}`, directory: dir });
        behind.push({ vpath, isDir: false, size: f.size || 0, mtimeMs: Number(f.mtime) || Date.now() });
      }
    }
    if (sameLoc(active, m.to)) {
      const timer = setTimeout(resumeMove, 10000); // once the app has started
      if (timer && timer.unref) timer.unref();
    }
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
  const subdirs = [];
  for (const f of res.files) {
    if (f.name.startsWith(PART)) continue; // a song still being copied by a move
    const child = `${rpath}/${f.name}`;
    const isDir = f.type === 'directory';
    out.push({ vpath: toV(child), rpath: child, isDir, size: f.size || 0, mtimeMs: Number(f.mtime) || Date.now() });
    if (isDir) subdirs.push(child);
  }
  if (subdirs.length) await Promise.all(subdirs.map((d) => walk(d, directory, toV, out)));
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

// A move writes a journal first (MOVE_KEY: where the songs go, where they come from, how often it was run, what the last
// run left over), then moves the songs one by one. If the app is closed in the middle, the next launch reads the journal:
// the songs still in an old folder show up where they are (none disappears) and the move carries on in the background.
// The journal goes only when nothing is left to settle: a song that could not move (a failed copy, another file with its
// name, an old copy that would not delete), a folder that could not be read and a missing permission all keep it, however
// often it was tried. `tries` only counts the runs; it never ends the move. Every launch tries once more, and so does
// Retry in Settings.
const MOVE_KEY = 'muriel_download_move';
const PART = '.muriel-part-'; // a song being copied has this in front of its name; it gets its own name once it is whole
const MAX_HELD = 500; // names of conflicting songs the journal remembers (see listDownloads)
const sameLoc = (a, b) => !!a && !!b && a.kind === b.kind && a.root === b.root;
const textOfLoc = (l) => textOf(l.kind, l.root);

// -> { to, from: [..], tries, last } or null; last: what the latest run left over (see summary)
function readMove() {
  const j = lsGet(MOVE_KEY);
  const to = j && typeof j.to === 'string' ? parseLocation(j.to) : null;
  if (!to) return null;
  const from = (Array.isArray(j.from) ? j.from : []).map(parseLocation).filter((l) => l && !sameLoc(l, to));
  return { to, from, tries: Number(j.tries) || 0, last: j.last && typeof j.last === 'object' ? j.last : null };
}
// no `to`, or nowhere to move from: the journal goes
const writeMove = (to, from, tries, last) => lsSet(MOVE_KEY, to && from.length ? { to: textOfLoc(to), from: from.map(textOfLoc), tries, ...(last ? { last } : {}) } : null);

// ---- what went wrong is told apart: a folder that is not there is not a folder that could not be read ----
const NOT_THERE = /not exist|no such|not found|enoent|doesn'?t exist/i;
const errText = (e) => `${e && e.code ? `${e.code} ` : ''}${e && e.message ? e.message : e}`;
const isNotThere = (e) => NOT_THERE.test(errText(e));
// what the log keeps: the phase, the path and the error; never what is in a song
const warnMove = (phase, path, e) => { try { console.warn(`[muriel move] ${phase} ${path}: ${errText(e)}`); } catch (x) {} };

// true only when the error says "not there" AND the folder really is not there. Anything else (no permission, an I/O
// error, a provider that does not answer) says nothing about whether the songs are still there.
async function isGoneDir(loc, err) {
  if (!isNotThere(err)) return false;
  try { await Filesystem.stat({ path: loc.root, directory: kindDir(loc.kind) }); return false; } catch (e) { return isNotThere(e); }
}

// Whether two files hold exactly the same bytes: true, false, or null (could not be checked). The same name and the same
// size prove nothing; only the bytes do. MediaControlsPlugin.sameFile reads both in pieces (a FLAC is 30-150 MB).
async function sameBytes(a, b) {
  const media = Capacitor.Plugins && Capacitor.Plugins.MurielMedia; // registered by media-controls.js
  if (!media) return null;
  try {
    const [ua, ub] = await Promise.all([Filesystem.getUri(a), Filesystem.getUri(b)]);
    const r = await media.sameFile({ a: ua.uri, b: ub.uri });
    return r && typeof r.same === 'boolean' ? r.same : null;
  } catch (e) { return null; } // an older build of the plugin, or a file that can't be read: not proven
}

// The old copy is deleted, and only counts as gone when it really is (a delete that fails must not pass for a move).
async function dropSource(src) {
  try { await Filesystem.deleteFile(src); } catch (e) { /* it may be gone already: the check below says */ }
  try { await Filesystem.stat(src); return false; } catch (e) { return isNotThere(e); }
}

// 'moved' | 'cleanup' | 'conflict' | 'failed'. Never copies onto a file that is already there: what the plugin does then
// (replace it, refuse, something else) is not something to lean on. When the name is taken, the same name and the same
// size are not proof that it is the same song. Only equal bytes are (sameBytes): then the song was copied before a move
// was cut short and the old copy can go. A different file, or one that could not be checked, is a conflict: both files
// stay exactly as they are. The copy goes to a temporary name and is renamed once its size is right, so a half song never
// has the real name. The old copy goes only after the new one is checked, and the song counts as moved only when the old
// copy is really gone; if it would not go it is 'cleanup' (copied, old copy still there).
async function moveOne(from, to, f) {
  const fromDir = kindDir(from.kind);
  const toDir = kindDir(to.kind);
  const vname = fromDir === PUBLIC ? f.name.replace(/\.mka$/i, '.webm') : f.name;
  const dname = sharedName(vname, toDir);
  const src = { path: `${from.root}/${f.name}`, directory: fromDir };
  const dst = { path: `${to.root}/${dname}`, directory: toDir };
  const part = { path: `${to.root}/${PART}${dname}`, directory: toDir };
  const result = (status, why) => ({ status, why, vpath: `${DOWNLOADS}/${vname}`, dst });
  const finish = async () => {
    const gone = await dropSource(src);
    scan(dst);
    if (gone) scan(src);
    else warnMove('delete-old-copy', src.path, 'the old copy is still there');
    return result(gone ? 'moved' : 'cleanup');
  };
  let size = f.size;
  if (!size) { try { size = (await Filesystem.stat(src)).size; } catch (e) { return result('failed', 'stat'); } }
  let there = null;
  try { there = await Filesystem.stat(dst); } catch (e) {
    // nothing there is the usual case; but when it can't be told whether the name is taken, copying could replace a song
    if (!isNotThere(e)) { warnMove('stat-new', dst.path, e); return result('failed', 'stat'); }
  }
  if (there) {
    if (there.type !== 'file' || there.size !== size) return result('conflict', 'other');
    const same = await sameBytes(src, dst);
    if (same !== true) return result('conflict', same === false ? 'other' : 'unchecked');
    return finish();
  }
  try {
    await Filesystem.mkdir({ path: to.root, directory: toDir, recursive: true }).catch(() => {}); // there already
    await Filesystem.deleteFile(part).catch(() => {}); // a half copy from an earlier try
    await Filesystem.copy({ from: src.path, directory: fromDir, to: part.path, toDirectory: toDir });
    if ((await Filesystem.stat(part)).size !== size) throw new Error('short copy');
    await Filesystem.rename({ from: part.path, directory: toDir, to: dst.path, toDirectory: toDir });
  } catch (e) {
    warnMove('copy', src.path, e);
    await Filesystem.deleteFile(part).catch(() => {});
    return result('failed', 'copy');
  }
  // the old copy is deleted only after the new one is seen to be there and whole
  try { if ((await Filesystem.stat(dst)).size !== size) throw new Error('wrong size'); } catch (e) {
    warnMove('verify', dst.path, e);
    return result('failed', 'verify');
  }
  return finish();
}

const emptyRun = () => ({ moved: 0, failed: 0, conflicts: 0, cleanup: 0, unreadable: 0, missing: 0, left: 0, permission: false, held: {}, heldMore: false });

// every song in the old folders goes to `to`; one that can't go stays where it is. -> counts of what happened:
//   moved (copied and the old copy gone), cleanup (copied, the old copy would not delete), conflicts (the name is taken by
//   another file, or one that could not be compared), failed (the copy did not work), unreadable (an old folder that could
//   not be read, which says nothing about its songs), missing (an old folder that is really gone), permission (Android 11+
//   hides songs the app did not make until it may read music and audio, so a folder read without it can look empty), left
//   (songs still in the old folders). `prev` is the journal's last summary: what it knew about a folder that can't be read now.
async function runMove(to, froms, prev) {
  const total = emptyRun();
  const toDir = kindDir(to.kind);
  if ([to, ...froms].some((l) => l.kind === 'shared') && !(await readAccessOf()).granted) total.permission = true;
  try { // half copies that a cut-short run left behind
    for (const f of (await Filesystem.readdir({ path: to.root, directory: toDir })).files) {
      if (f.name.startsWith(PART)) await Filesystem.deleteFile({ path: `${to.root}/${f.name}`, directory: toDir }).catch(() => {});
    }
  } catch (e) {}
  const before = (prev && prev.held) || {};
  for (const from of froms) {
    if (sameLoc(from, to)) continue;
    const key = textOfLoc(from);
    let list;
    try { list = (await Filesystem.readdir({ path: from.root, directory: kindDir(from.kind) })).files; } catch (e) {
      if (await isGoneDir(from, e)) { total.missing++; continue; } // really gone: nothing left there
      total.unreadable++; // permission, I/O, a provider that does not answer: nothing is known about the songs there
      if (Array.isArray(before[key])) total.held[key] = before[key];
      warnMove('readdir', key, e);
      continue;
    }
    for (const f of list) {
      if (f.type !== 'file' || f.name.startsWith('.')) continue;
      const r = await moveOne(from, to, f);
      if (r.status === 'moved' || r.status === 'cleanup') {
        total[r.status === 'moved' ? 'moved' : 'cleanup']++;
        if (placed.has(r.vpath)) placed.set(r.vpath, r.dst);
      } else if (r.status === 'conflict') {
        total.conflicts++;
        (total.held[key] = total.held[key] || []).push(f.name);
      } else total.failed++;
    }
  }
  total.left = total.failed + total.conflicts + total.cleanup;
  return total;
}

// what the journal keeps of a run: the counts, and the names of the songs that hit a conflict (listDownloads needs them)
function summary(r) {
  const held = {};
  let count = 0;
  let more = !!r.heldMore;
  for (const [key, names] of Object.entries(r.held || {})) {
    const keep = [];
    for (const n of names) { if (count >= MAX_HELD) { more = true; break; } keep.push(n); count++; }
    if (keep.length) held[key] = keep;
  }
  const { moved, failed, conflicts, cleanup, unreadable, missing, left } = r;
  return { moved, failed, conflicts, cleanup, unreadable, missing, left, permission: !!r.permission, ...(count ? { held } : {}), ...(more ? { heldMore: true } : {}), at: Date.now() };
}
const publicRun = (r) => { const { moved, failed, conflicts, cleanup, unreadable, missing, left, permission } = r; return { moved, failed, conflicts, cleanup, unreadable, missing, left, permission }; };

// After a run: the journal goes only when nothing is left to settle. Conflicts, failed copies, old copies that would not
// delete, folders that could not be read and a missing permission keep it (see the top of this section).
function settleMove(to, froms, tries, r) {
  if (r.failed + r.conflicts + r.cleanup + r.unreadable === 0 && !r.permission) writeMove(null);
  else writeMove(to, froms, tries + 1, summary(r));
}

// -> a function (folder text, file name) -> whether that song hit a conflict; every one when the journal could not keep them all
function heldOf(m) {
  const held = (m && m.last && m.last.held) || {};
  const more = !!(m && m.last && m.last.heldMore);
  return (key, name) => more || (Array.isArray(held[key]) && held[key].includes(name));
}

// Two runs at once would trip over each other's half copies: one after the other. A background retry or a tap on Retry
// while a run is going on does not queue up behind it; it says "busy" and leaves it to that run.
let running = 0; // runs going on, or waiting for their turn
let busy = Promise.resolve();
const exclusive = (job) => {
  running++;
  const run = busy.then(job);
  busy = run.then(() => {}, () => {});
  return run.finally(() => { running--; });
};

// where a move stands, for Settings: { pending: false }, or what is left over from the last run
function moveStatus() {
  const m = readMove();
  if (!m) return { pending: false };
  const last = m.last || {};
  const n = (k) => Number(last[k]) || 0;
  return {
    pending: true,
    to: shown(m.to.kind, m.to.root),
    from: m.from.map((l) => shown(l.kind, l.root)),
    tries: m.tries,
    left: n('left'), conflicts: n('conflicts'), failed: n('failed'), cleanup: n('cleanup'), unreadable: n('unreadable'),
    permission: !!last.permission,
  };
}
// the page listens for this to refresh what Settings says (a move finishes in the background, after launch)
function announceMove() {
  try { window.dispatchEvent(new CustomEvent('muriel-move-status')); } catch (e) {}
}

async function resumeMove() {
  const m = readMove();
  // only into the folder that is in use (the app falls back to another one when the chosen one can't be opened)
  if (!m || running || !pub || pubDir !== kindDir(m.to.kind) || pub !== m.to.root) return null;
  const r = await exclusive(() => runMove(m.to, m.from, m.last));
  settleMove(m.to, m.from, m.tries, r);
  announceMove();
  return r;
}

// Retry in Settings: the same run the app makes at every launch, now. -> { ok, ran, ...moveStatus, moved }
async function retryMove() {
  const m = ANDROID ? readMove() : null;
  if (!m) return { ok: true, ran: false, ...moveStatus() };
  if (!pub || pubDir !== kindDir(m.to.kind) || pub !== m.to.root) {
    return { ok: false, ran: false, error: "Muriel can't use the new download folder right now", ...moveStatus() };
  }
  const r = await resumeMove();
  if (!r) return { ok: true, ran: false, busy: true, ...moveStatus() }; // one is running already
  return { ok: true, ran: true, ...moveStatus(), moved: r.moved };
}

// Saves the new folder. The journal goes before the choice, and both before the first song moves.
async function switchTo(loc, move, custom) {
  const pending = readMove();
  const was = pub ? { kind: pubDir === APPDIR ? 'app' : 'shared', root: pub } : null;
  // where songs may be now: the folder in use, and the folders of an earlier move that never finished
  const froms = [...(pending ? [...pending.from, pending.to] : []), ...(was ? [was] : [])]
    .filter((l, i, all) => !sameLoc(l, loc) && all.findIndex((x) => sameLoc(x, l)) === i);
  writeMove(move ? loc : null, move ? froms : [], 0, move && pending ? pending.last : null);
  lsSet(LOC_KEY, custom ? textOfLoc(loc) : null);
  lsSet(SIB_KEY, null); // the folders next to the old one are not the ones next to the new one
  let r = emptyRun();
  if (move && froms.length) {
    r = await exclusive(() => runMove(loc, froms, pending && pending.last));
    settleMove(loc, froms, 0, r);
  }
  return { ok: true, dir: shown(loc.kind, loc.root), ...publicRun(r), pending: !!readMove() };
}

// -> { granted, canAsk } (canAsk false: said no for good, only the app's page in Settings turns it on). With ask, the
// system dialog comes first (answers when it is closed); with settings too, a refusal for good opens that page.
async function readAccessOf({ ask = false, settings = false } = {}) {
  const media = Capacitor.Plugins && Capacitor.Plugins.MurielMedia; // registered by media-controls.js
  if (!ANDROID || !media) return { granted: true, canAsk: false };
  try { return await (ask ? media.allowAudioAccess({ settings }) : media.audioAccess()); } catch (e) {
    return { granted: true, canAsk: false }; // an older build of the plugin: nothing to ask
  }
}

// ---- Android: the songs linked in place, and the permission that lets Muriel read them ----
// Linked songs stay in the folders next to the download folder (shared storage). From Android 11 the app sees them only
// while it may read music and audio. When that is taken back (Settings -> Apps -> Muriel -> Permissions) the files are
// untouched and the library and playlists still know them, but Android refuses every read: the songs are LOCKED until the
// permission is given again. Locked is only ever a state held here, computed from the permission as it is now: nothing is
// written down for it, so it cannot go stale, and nothing is forgotten, unlinked or deleted because of it.
// The app's own folder (Android/data/<package>/files) needs no permission, so songs linked from it are never locked.
const MEDIA_PERMISSION_REQUIRED = 'MEDIA_PERMISSION_REQUIRED';
let linkedLock = { locked: false, canAsk: false };
const mediaPermissionError = () => Object.assign(new Error(MEDIA_PERMISSION_REQUIRED), { code: MEDIA_PERMISSION_REQUIRED });

// -> { locked, granted, canAsk } for the permission as it is right now (asks the plugin, which reads Android's answer)
async function readLinkedAccess() {
  if (!ANDROID || (pub && pubDir === APPDIR)) return { locked: false, granted: true, canAsk: false };
  const access = await readAccessOf();
  return { locked: !access.granted, granted: !!access.granted, canAsk: !!access.canAsk };
}

// The songs of the linked folders as the file index wants them (what listLinked puts back at every launch). Nothing is
// written: SIB_KEY and the library are only ever changed by a scan that saw everything.
async function restoredLinked() {
  const was = lsGet(SIB_KEY);
  if (!was || !pub) return [];
  const found = await collectLinked({ folders: Array.isArray(was.folders) ? was.folders : [], loose: !!was.loose }).catch(() => null);
  const out = [];
  for (const g of (found && found.groups) || []) for (const f of g.files) out.push({ vpath: f.vpath, isDir: false, size: f.size, mtimeMs: f.mtimeMs });
  return out;
}

// Looks at the permission again (at launch, when the app comes back to the front, after the person was sent to Settings).
// Taken back: the linked songs lock. Given again: they are put back in the file index first (`register(entries)`, so none
// is asked for before it is there) and unlock. Never touches the library, the playlists or SIB_KEY.
// -> { locked, granted, canAsk, changed, restored }
async function refreshLinkedAccess(register) {
  const now = await readLinkedAccess();
  const was = linkedLock;
  let restored = 0;
  if (!now.locked && was.locked) {
    const entries = await restoredLinked();
    if (typeof register === 'function') register(entries);
    restored = entries.length;
  }
  linkedLock = { locked: now.locked, canAsk: now.canAsk };
  return { ...now, changed: now.locked !== was.locked || now.canAsk !== was.canAsk, restored };
}

// `vpath` with " (old)" before its extension, or " (old 2)" ... when that is taken too
function freeName(vpath, taken) {
  const parts = /^(.*?)(\.[^./]+)?$/.exec(vpath);
  for (let n = 1; ; n++) {
    const alt = `${parts[1]} (old${n > 1 ? ` ${n}` : ''})${parts[2] || ''}`;
    if (!taken.has(alt)) return alt;
  }
}

// ---- Android: the folders next to the download folder, as playlists ----
// Reads one folder (relative to the folder that holds the download folder), down to `depth` levels of subfolders.
// ctx.partial turns true when something could not be read or the limit cut the list short: the result is then not
// "everything there is", and the caller must not take a missing song for a deleted one. The limit (MAX_LINKED) is for the
// whole scan: ctx.count counts every song found so far, in every folder.
async function listAudio(rel, depth, found, ctx) {
  if (ctx.count >= MAX_LINKED) { ctx.partial = true; return; } // not read: it may hold songs
  let res;
  try { res = await Filesystem.readdir({ path: parentRoot() ? `${parentRoot()}/${rel}` : rel, directory: pubDir }); } catch (e) { ctx.partial = true; return; }
  for (const f of res.files) {
    if (f.name.startsWith('.')) continue;
    const child = `${rel}/${f.name}`;
    if (f.type === 'directory') { if (depth > 0) await listAudio(child, depth - 1, found, ctx); }
    else if (AUDIO_RE.test(f.name)) {
      if (ctx.count >= MAX_LINKED) { ctx.partial = true; return; }
      found.push({ rel: child, size: f.size || 0, mtimeMs: Number(f.mtime) || Date.now() });
      ctx.count++;
    }
  }
}

// -> null (the downloads are inside the app), { failed: true } (the folder next to them can't be read), or
// { groups: [{ folder, files: [{ vpath, name, size, mtimeMs }] }], partial }; folder '' holds the songs that lie
// loose next to the download folder. `only` ({ folders, loose }) narrows it to what was linked before (every launch).
async function collectLinked(only) {
  if (!ANDROID || !pub) return null;
  const ctx = { partial: false, count: 0 };
  let top;
  try { top = await Filesystem.readdir({ path: parentRoot(), directory: pubDir }); } catch (e) { return { failed: true }; }
  const mine = pub.slice(pub.lastIndexOf('/') + 1).toLowerCase(); // the download folder itself is not a playlist
  const groups = [];
  const loose = [];
  for (const f of top.files) {
    if (f.name.startsWith('.')) continue;
    if (f.type === 'directory') {
      if (f.name.toLowerCase() === mine || f.name === 'Android') continue;
      if (only && !only.folders.includes(f.name)) continue;
      const found = [];
      await listAudio(f.name, 2, found, ctx);
      if (found.length) groups.push({ folder: f.name, found });
    } else if (AUDIO_RE.test(f.name) && (!only || only.loose)) {
      if (ctx.count >= MAX_LINKED) { ctx.partial = true; continue; }
      loose.push({ rel: f.name, size: f.size || 0, mtimeMs: Number(f.mtime) || Date.now() });
      ctx.count++;
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

// at launch: the songs of the folders that were linked before are put back in the file index (fs shim), so they play.
// While Muriel may not read music and audio they are not: Android would show the folders as empty or refuse every read,
// which says nothing about the songs. They stay remembered (SIB_KEY, the library, the playlists) and come back the moment
// the permission does (refreshLinkedAccess).
async function listLinked(out) {
  if (linkedLock.locked) return;
  out.push(...(await restoredLinked()));
}

// true for a song linked in place while Muriel may not read music and audio: nothing under /data/LocalMusic is readable then.
// The downloads, the songs imported into the app and everything else Muriel keeps are not affected.
const isLinkedLocked = (vpath) => linkedLock.locked && isLocalLink(vpath);

module.exports = {
  isNative: () => Capacitor.isNativePlatform(),

  async list() {
    try { await Filesystem.mkdir({ path: ROOT, directory: DIR, recursive: true }); } catch (e) {}
    const out = [];
    await walk(ROOT, DIR, toVirtual, out);
    if (ANDROID) {
      try { APP_ID = (await require('@capacitor/app').App.getInfo()).id || APP_ID; } catch (e) {}
      await listDownloads(out);
      // never lets this check keep the app from starting: when it fails, nothing is locked (what it always was)
      try { const a = await readLinkedAccess(); linkedLock = { locked: a.locked, canAsk: a.canAsk }; } catch (e) { linkedLock = { locked: false, canAsk: false }; }
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
  // a move that was cut short carries on by itself shortly after launch (and at every launch after, until nothing is left)
  resumeMove,
  // where an unfinished move stands, and Retry: for Settings
  moveStatus,
  retryMove,

  // ---- Android: folders next to the download folder ----
  // -> null when downloads are kept inside the app (nothing "next to" them to read); { failed: true } when the folder
  // can't be read; else { parent, groups, partial } (partial: some folder could not be read, or there are too many songs)
  async scanLinked() {
    // Without the permission a scan sees what Android lets it see, not what is there: it must not become what is remembered
    // (SIB_KEY), nor what the caller takes for "gone" and forgets. -> { locked: true } and nothing else happens.
    const shared = ANDROID && !!pub && pubDir === PUBLIC;
    if (shared && (await readLinkedAccess()).locked) return { locked: true, groups: [], partial: true };
    const found = await collectLinked(null);
    if (!found || found.failed) return found;
    // the permission can be taken back while the folders are read: such a scan is not to be believed either
    if (shared && (await readLinkedAccess()).locked) return { locked: true, groups: [], partial: true };
    const { groups, partial } = found;
    // What is remembered for the next launch (listLinked) is exactly what the scan saw only when the scan saw everything.
    // A partial one (a folder it could not read, or the limit) adds what it found and never takes a folder out: a folder
    // that was linked before and could not be read now must come back at the next launch, not be taken for a deleted one.
    const seen = { folders: groups.filter((g) => g.folder).map((g) => g.folder), loose: groups.some((g) => !g.folder) };
    const was = partial ? lsGet(SIB_KEY) : null;
    lsSet(SIB_KEY, was ? { folders: [...new Set([...(Array.isArray(was.folders) ? was.folders : []), ...seen.folders])], loose: !!was.loose || seen.loose } : seen);
    return { parent: ROOT_PREFIX + (pubDir === APPDIR ? `${appFiles()}/` : '') + parentRoot(), groups, partial };
  },
  hasLinkedFolders: () => !!(ANDROID && pub),

  // ---- Android: the permission behind the songs linked in place (see "the songs linked in place" above) ----
  MEDIA_PERMISSION_REQUIRED,
  // as it was last looked at: { locked, canAsk }. The server asks this for every linked song it is about to serve.
  linkedAccess: () => ({ ...linkedLock }),
  isLinkedLocked,
  // looks at the permission again; see refreshLinkedAccess
  refreshLinkedAccess,

  // ---- Android: reading songs the app did not save itself ----
  // Android 11+ hides a song the app did not make (a file manager or a computer put it there, or an earlier install of
  // Muriel saved it) until the app may read music and audio (MediaControlsPlugin.allowAudioAccess). That is only so on
  // shared storage: the app's own folder (Android/data/<package>/files) needs nothing.
  needsReadAccess: () => !!(ANDROID && pub && pubDir === PUBLIC),
  // -> { granted, canAsk } (canAsk false: said no for good, only the app's page in Settings turns it on). With ask, the
  // system dialog comes first (answers when it is closed); with settings too, a refusal for good opens that page.
  readAccess: readAccessOf,
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
    if (isLinkedLocked(vpath)) throw mediaPermissionError(); // the WebView would only meet a refused read
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
