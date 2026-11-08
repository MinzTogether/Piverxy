// window.electronAPI for the iOS build. Desktop-only features (window controls, tray, mini player,
// data folders, hardware acceleration) become no-ops; file pickers use the iOS document picker.
const crypto = require('./shims/crypto');
const store = require('./shims/store');
const { Capacitor } = require('@capacitor/core');
const { Share } = require('@capacitor/share');
const { Filesystem, Directory, Encoding } = require('@capacitor/filesystem');

function pickFiles(accept, multiple) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = !!multiple;
    input.style.display = 'none';
    input.addEventListener('change', () => { resolve([...input.files]); input.remove(); }, { once: true });
    input.addEventListener('cancel', () => { resolve([]); input.remove(); }, { once: true });
    document.body.appendChild(input);
    input.click();
  });
}

const ANDROID = Capacitor.getPlatform() === 'android';

// Words of Muriel's own go through the translation system (i18n.js): an element made here carries data-i18n (its text,
// and data-i18n-attr for a placeholder) and is translated when it is added to the page; text set later goes through
// text(). What is not Muriel's words (folder names, paths) is left out of it: it would be sent to the translator.
const i18n = () => window.MurielI18n || null;
const Tm = (s) => (i18n() ? i18n().Tm(s) : s);
const say = (el, s) => { if (i18n() && i18n().text) i18n().text(el, s); else el.textContent = s; };
const toast = (msg, kind) => { if (window.MurielCore) window.MurielCore.toast(msg, kind); };

// Settings → Folders → Download folder → Change (Android): a sheet listing the places Android lets Muriel save songs in,
// one of your own inside Music / Download / Documents, and whether the songs already downloaded go along.
// Resolves { text, move } (text: the folder as Settings shows it, e.g. Music/Muriel Mod), or null when cancelled.
function chooseDownloadFolder(current) {
  return new Promise((resolve) => {
    const choices = store.downloadChoices();
    const tops = store.sharedTops();
    const known = choices.find((c) => c.shown === current);
    // mk(tag, css, text, words): words = Muriel's own words (translated); without it the text is a name or a path
    const mk = (tag, css, text, words) => {
      const n = document.createElement(tag);
      if (css) n.style.cssText = css;
      if (text != null) n.textContent = text;
      if (words) n.setAttribute('data-i18n', ''); else if (text != null) n.setAttribute('translate', 'no');
      return n;
    };
    const wrap = document.createElement('div');
    wrap.className = 'modal-backdrop';
    wrap.id = 'download-folder-picker';
    const card = document.createElement('div');
    card.className = 'dialog-card';
    card.style.cssText = 'max-height:85vh;overflow-y:auto;';
    card.appendChild(mk('h3', '', 'Download folder', true));

    const rows = [];
    const sub = 'font-size:12px;color:var(--md-sys-color-outline);word-break:break-all;';
    // title: a folder name (words false) or Muriel's words; path and hint are optional lines under it
    const addRow = (value, title, titleIsWords, path, hint, extra) => {
      const label = mk('label', 'display:flex;gap:10px;align-items:flex-start;padding:10px 0;cursor:pointer;');
      const radio = document.createElement('input');
      radio.type = 'radio'; radio.name = 'dl-folder'; radio.value = value; radio.style.marginTop = '4px';
      const box = mk('div', 'display:flex;flex-direction:column;min-width:0;flex:1;');
      box.appendChild(mk('span', 'font-weight:600;', title, titleIsWords));
      if (path) box.appendChild(mk('span', sub, path, false));
      if (hint) box.appendChild(mk('span', sub, hint, true));
      if (extra) box.appendChild(extra);
      label.append(radio, box);
      card.appendChild(label);
      rows.push(radio);
      return radio;
    };
    for (const c of choices) {
      const r = addRow(c.text, c.label, c.kind === 'app', c.full, c.hint);
      if (known && known.text === c.text) r.checked = true;
    }
    const custom = mk('div', 'display:flex;gap:8px;margin-top:6px;');
    const topSel = document.createElement('select');
    topSel.className = 'pill-text-input';
    topSel.setAttribute('translate', 'no');
    topSel.style.cssText = 'flex:0 0 auto;width:auto;';
    for (const t of tops) topSel.appendChild(new Option(t, t));
    const nameIn = document.createElement('input');
    nameIn.type = 'text'; nameIn.className = 'pill-text-input'; nameIn.maxLength = 60; nameIn.placeholder = 'Folder name';
    nameIn.setAttribute('data-i18n-attr', 'placeholder');
    nameIn.style.cssText = 'flex:1;min-width:0;';
    custom.append(topSel, nameIn);
    const customRadio = addRow('__custom', 'Another folder', true, null, null, custom);
    if (!known && current && !current.startsWith('Android/')) {
      const rel = current.split('/');
      if (tops.includes(rel[0])) { topSel.value = rel[0]; nameIn.value = rel.slice(1).join('/'); customRadio.checked = true; }
    }
    nameIn.addEventListener('focus', () => { customRadio.checked = true; });
    if (!rows.some((r) => r.checked)) rows[0].checked = true;

    const moveLabel = mk('label', 'display:flex;gap:10px;align-items:center;margin:12px 0 4px;cursor:pointer;');
    const move = document.createElement('input');
    move.type = 'checkbox'; move.checked = true;
    moveLabel.append(move, mk('span', '', 'Move the songs I already downloaded', true));
    card.appendChild(moveLabel);
    const err = mk('div', 'color:var(--md-sys-color-error,#f2b8b5);font-size:12px;min-height:16px;margin-top:6px;');
    card.appendChild(err);

    const actions = document.createElement('div');
    actions.className = 'dialog-actions';
    const cancel = mk('button', '', 'Cancel', true);
    cancel.className = 'btn-outline-pill';
    cancel.id = 'btn-cancel-download-folder'; // the Android back button presses this (bridge.js)
    const save = mk('button', '', 'Use this folder', true);
    save.className = 'btn-pill-primary';
    actions.append(cancel, save);
    card.appendChild(actions);
    wrap.appendChild(card);

    const close = (value) => {
      wrap.classList.remove('visible');
      setTimeout(() => wrap.remove(), 220);
      resolve(value);
    };
    cancel.addEventListener('click', () => close(null));
    wrap.addEventListener('click', (e) => { if (e.target === wrap) close(null); });
    save.addEventListener('click', () => {
      const picked = rows.find((r) => r.checked);
      const text = picked && picked.value === '__custom' ? `${topSel.value}/${nameIn.value.trim()}` : picked && picked.value;
      const full = text && store.showDownloadDir(text);
      if (!full) { say(err, 'Use a folder name without special characters: no slashes, colons or quotes, and no leading dot.'); return; }
      close({ text: full, move: move.checked });
    });
    document.body.appendChild(wrap);
    requestAnimationFrame(() => requestAnimationFrame(() => wrap.classList.add('visible')));
  });
}

// What a locked song says when it is asked to play (Android): music access is off, nothing was removed, and the way back is the
// app's page in Settings (a permission turned off there is not asked for again by a system dialog). Resolves 'settings' once
// that page was opened, or null for "not now". Only one is ever open; `close` shuts it when the permission turns up again.
const MEDIA_PROMPT_TEXT = "Muriel can't read the songs from your folders because the permission to read music and audio (Files and media on Android 11 and 12) is turned off. Your playlists and files are untouched. Turn it back on in the app settings and the songs play again.";
let mediaPrompt = null;
function askForMediaAccess({ openSettings }) {
  if (mediaPrompt) return mediaPrompt.promise;
  const mk = (tag, css, text, words) => {
    const n = document.createElement(tag);
    if (css) n.style.cssText = css;
    if (text != null) n.textContent = text;
    if (words) n.setAttribute('data-i18n', '');
    return n;
  };
  const wrap = document.createElement('div');
  wrap.className = 'modal-backdrop';
  wrap.id = 'media-access-prompt';
  const card = document.createElement('div');
  card.className = 'dialog-card';
  card.appendChild(mk('h3', '', 'Music access is off', true));
  card.appendChild(mk('p', 'margin:8px 0 0;line-height:1.45;',
    MEDIA_PROMPT_TEXT, true));
  const actions = document.createElement('div');
  actions.className = 'dialog-actions';
  const cancel = mk('button', '', 'Not now', true);
  cancel.className = 'btn-outline-pill';
  cancel.id = 'btn-cancel-media-access'; // the Android back button presses this (bridge.js)
  const open = mk('button', '', 'Open app settings', true);
  open.className = 'btn-pill-primary';
  open.id = 'btn-open-app-settings';
  actions.append(cancel, open);
  card.appendChild(actions);
  wrap.appendChild(card);
  let resolveIt;
  const promise = new Promise((resolve) => { resolveIt = resolve; });
  const close = (value) => {
    if (mediaPrompt && mediaPrompt.wrap === wrap) mediaPrompt = null;
    wrap.classList.remove('visible');
    setTimeout(() => wrap.remove(), 220);
    resolveIt(value);
  };
  cancel.addEventListener('click', () => close(null));
  wrap.addEventListener('click', (e) => { if (e.target === wrap) close(null); });
  open.addEventListener('click', async () => { try { await openSettings(); } catch (e) {} close('settings'); });
  mediaPrompt = { wrap, promise, close };
  document.body.appendChild(wrap);
  requestAnimationFrame(() => requestAnimationFrame(() => wrap.classList.add('visible')));
  return promise;
}

const extOf = (name) => (name.match(/\.([a-z0-9]+)$/i) || [, 'bin'])[1].toLowerCase();
const noop = () => {};

module.exports = function electronAPI({ ready, port, fs, fileUrlFor }) {
  const visibilityListeners = [];
  document.addEventListener('visibilitychange', () => visibilityListeners.forEach((cb) => cb(!document.hidden)));

  let lastPick = null; // what the sheet returned last: setDownloadDir needs its "move the songs" answer

  // after the download folder changed the folders "next to" it are other ones: forget the songs linked from the old
  // ones (their playlists lose them; the files are untouched)
  async function forgetLinked() {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/library-unlink`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (!r.ok) return [];
      const j = await r.json();
      await fs._flush();
      return Array.isArray(j.ids) ? j.ids : [];
    } catch (e) { return []; }
  }

  // Android: the songs in the folders next to the download folder. Registers them with the file index and hands back
  // what app.js needs to add them to the library (/api/library-link) and make playlists of them.
  async function scanLocalFolders() {
    await ready;
    // Android 11+ hides the songs the app did not save itself until it may read music and audio. Ask now (the system
    // dialog; once refused for good, the app's page in Settings opens instead) and carry on when it is given.
    let justAllowed = false;
    if (store.needsReadAccess()) {
      let access = await store.readAccess();
      if (!access.granted) {
        const settings = !access.canAsk;
        access = await store.readAccess({ ask: true, settings });
        if (!access.granted) { await syncMediaAccess(); return { needsPermission: true, settingsOpened: settings }; }
        justAllowed = true;
      }
    }
    // The permission may just have been given (in the dialog above), or have changed some other way since the app last looked: the
    // linked songs unlock (or lock) now. The server refuses to forget songs while they are locked, so a lock that is out of date
    // would stop this very scan from finishing.
    await syncMediaAccess();
    const found = await store.scanLinked();
    if (!found) return { unavailable: true };
    if (found.failed) return { failed: true };
    // The permission went away between the check above and the scan (or during it). What such a scan saw says nothing about the
    // songs: nothing is linked, forgotten or remembered from it. The page is told, and says what to do.
    if (found.locked) return { needsPermission: true, settingsOpened: false };
    const groups = [];
    for (const g of found.groups) {
      const items = [];
      for (const f of g.files) {
        fs._register(f.vpath, f.size);
        items.push({ id: 'local_' + crypto._sha1(f.vpath + f.size).slice(0, 12), path: f.vpath, name: f.name, size: f.size });
      }
      groups.push({ folder: g.folder, items });
    }
    // songs of the download folder that were hidden too (an earlier install saved them) show up now
    if (justAllowed) for (const e of await store.rescanDownloads()) fs._register(e.vpath, e.size);
    return { parent: found.parent, groups, partial: found.partial };
  }

  // Android: a move of the songs that is not finished (see shims/store.js). Settings shows where it stands; Retry runs
  // the move once more, now (it also runs by itself at every launch).
  async function getMoveStatus() {
    await ready;
    return store.moveStatus();
  }
  async function retryMove() {
    await ready;
    const status = store.moveStatus();
    if (!status.pending) return { ok: true, ran: false, ...status };
    // songs the app did not save itself stay hidden until it may read music and audio: ask first, carry on once it is given
    if (status.permission) {
      let access = await store.readAccess();
      if (!access.granted) {
        const settings = !access.canAsk;
        access = await store.readAccess({ ask: true, settings });
        await syncMediaAccess(); // given (or refused) just now: the linked songs unlock (or stay locked) at once
        if (!access.granted) return { ok: false, needsPermission: true, settingsOpened: settings, ...store.moveStatus() };
      }
    }
    toast(Tm('Moving your songs…'), 'info');
    return store.retryMove();
  }

  // ---- Android: the permission behind the songs linked in place (shims/store.js) ----
  // The linked songs lock while Muriel may not read music and audio, and unlock when it may again; nothing is removed either
  // way. The page hears of every change as 'muriel:media-access' ({ locked, canAsk, restored }), and can ask at any time
  // (getMediaAccess). It is looked at again whenever the app comes back to the front: the person may have been in Settings.
  let lastAccess = null; // what the page was last told
  let looking = null;    // a look at the permission that is going on: asked again meanwhile, it is the same look
  async function getMediaAccess() {
    await ready;
    if (!looking) {
      looking = store.refreshLinkedAccess((entries) => { for (const e of entries) fs._register(e.vpath, e.size); })
        .finally(() => { looking = null; });
    }
    const r = await looking;
    const now = { locked: !!r.locked, canAsk: !!r.canAsk };
    if (!now.locked && mediaPrompt) mediaPrompt.close(null); // given back while the prompt was up
    if (!lastAccess || now.locked !== lastAccess.locked || now.canAsk !== lastAccess.canAsk) {
      lastAccess = now;
      try { window.dispatchEvent(new CustomEvent('muriel:media-access', { detail: { ...now, restored: r.restored || 0 } })); } catch (e) {}
    }
    return now;
  }
  // looks at the permission again, and never fails the caller: used after the app itself asked for it
  const syncMediaAccess = () => getMediaAccess().catch(() => {});
  // the app's page in Settings, where "Permissions" turns it back on (older builds of the plugin: the dialog, or that page when
  // the dialog can't come any more)
  async function openAppSettings() {
    const media = Capacitor.Plugins && Capacitor.Plugins.MurielMedia;
    if (!media) return false;
    try { await media.openAppSettings(); return true; } catch (e) {}
    try { await media.allowAudioAccess({ settings: true }); return true; } catch (e) { return false; }
  }
  if (ANDROID) {
    const lookAgain = () => { getMediaAccess().catch(() => {}); };
    document.addEventListener('visibilitychange', () => { if (!document.hidden) lookAgain(); });
    try {
      const { App } = require('@capacitor/app');
      if (App && typeof App.addListener === 'function') App.addListener('appStateChange', (state) => { if (state && state.isActive) lookAgain(); });
    } catch (e) {}
  }

  return {
    isWindows: false,
    isMobile: true,
    minimizeWindow: noop, maximizeWindow: noop, closeWindow: noop,
    getServerPort: () => ready.then(() => port),
    getGpuCompositing: async () => 'enabled',
    onWindowVisibility: (cb) => visibilityListeners.push(cb),
    setZoomFactor: noop,
    getZoomFactor: () => 1,

    // Background image/GIF/video: copied into app storage so it survives the picker's temp file.
    async pickMedia() {
      const [file] = await pickFiles('image/*,video/mp4,video/webm,.gif', false);
      if (!file) return null;
      await ready;
      const vpath = `/data/backgrounds/bg_${Date.now()}.${extOf(file.name)}`;
      await fs._writeBlob(vpath, file);
      if (!fs.existsSync(vpath)) return null;
      // the absolute file URL changes when iOS moves the app container (every reinstall); mobile-ui.js
      // rebuilds saved ones on launch from the file name
      return fileUrlFor(vpath);
    },
    // deletes picked files that no saved setting points to any more (called by mobile-ui.js after the repair)
    async pruneMedia(keep) {
      await ready;
      let names = [];
      try { names = fs.readdirSync('/data/backgrounds'); } catch (e) { return; }
      for (const n of names) {
        if (keep.has(n)) continue;
        const pickedAt = Number((n.match(/^bg_(\d+)/) || [])[1]);
        if (!pickedAt || Date.now() - pickedAt < 3600e3) continue; // not ours, or picked just now and not saved yet
        try { fs.unlinkSync(`/data/backgrounds/${n}`); } catch (e) {}
      }
    },

    // Same contract as main.js: copy into the library folder as local_<sha1>.<ext>.
    async importAudioFiles() {
      const files = await pickFiles('audio/*,.mp3,.m4a,.flac,.wav,.aac,.ogg,.opus', true);
      await ready;
      // lossless files take a while to copy; say so, or the app looks stuck
      const total = files.reduce((n, f) => n + f.size, 0);
      if (total > 20e6 && window.MurielCore) window.MurielCore.toast(`Adding ${files.length} song${files.length === 1 ? '' : 's'}…`, 'info');
      const out = [];
      for (const f of files) {
        const ext = extOf(f.name);
        const id = 'local_' + crypto._sha1(f.name + f.size).slice(0, 12);
        const file = `${id}.${ext}`;
        const target = `/data/library/${file}`;
        // one at a time, each in pieces (fs._writeBlob); a copy cut short (app closed mid-import) is redone
        if (!fs.existsSync(target) || fs.statSync(target).size !== f.size) await fs._writeBlob(target, f);
        if (!fs.existsSync(target)) continue; // couldn't be saved (storage full): the app has said so
        out.push({ id, file, ext, name: f.name.replace(/\.[^.]+$/, '') });
      }
      await fs._flush();
      return out;
    },

    async getCacheSize() {
      await ready;
      let audio = 0;
      try { for (const n of fs.readdirSync('/data/tracks')) audio += fs.statSync(`/data/tracks/${n}`).size; } catch (e) {}
      return { audio, web: 0, total: audio };
    },
    // like desktop: delete the cached songs and thumbnails (via the in-app server), then wait for the disk.
    // It used to only report success, so the cache never shrank.
    clearCache: async () => {
      await ready;
      try { await fetch('http://127.0.0.1:38472/api/clear-offline-library', { method: 'POST' }); } catch (e) {}
      await fs._flush();
      return true;
    },
    getDataDir: async () => ({ dir: 'On this iPhone (Files → Muriel)', defaultDir: '/data', isCustom: false }),
    pickDataDir: async () => null,
    setDataDir: async () => ({ success: false, error: 'The music folder is fixed on iPhone' }),
    // iOS: fixed, Files → Muriel → Downloads. Android: Music/Muriel Mod unless changed in Settings (shims/store.js)
    async getDownloadDir() {
      if (!ANDROID) return { dir: 'Files → Muriel → Downloads', isCustom: false };
      await ready;
      return { dir: store.downloadsFolder() || "Inside the app (other apps can't see it)", isCustom: store.isCustomDownloadDir() };
    },
    async pickDownloadDir() {
      if (!ANDROID) return null;
      await ready;
      lastPick = await chooseDownloadFolder(store.downloadsFolder());
      return lastPick ? lastPick.text : null;
    },
    async setDownloadDir(dir) {
      if (!ANDROID) return { ok: false, error: 'The download folder is fixed on iPhone' };
      await ready;
      const move = lastPick && lastPick.text === dir ? lastPick.move : true;
      if (move) toast(Tm('Moving your songs…'), 'info');
      const res = await store.setDownloadDir(dir, { move });
      if (!res.ok) return { ...res, error: Tm(res.error) };
      return { ...res, unlinked: await forgetLinked(), restart: true };
    },
    async resetDownloadDir() {
      if (!ANDROID) return { ok: true };
      await ready;
      toast(Tm('Moving your songs…'), 'info');
      const res = await store.resetDownloadDir({ move: true });
      if (!res.ok) return { ...res, error: Tm(res.error) };
      return { ...res, unlinked: await forgetLinked(), restart: true };
    },
    ...(ANDROID ? {
      scanLocalFolders, getMoveStatus, retryMove,
      getMediaAccess, openAppSettings,
      promptMediaAccess: () => askForMediaAccess({ openSettings: openAppSettings }),
    } : {}),
    restartApp: () => location.reload(),
    getAppVersion: async () => { const b = window.MURIEL_BUILD || {}; return b.version ? `${b.version}${b.run ? ` (build ${b.run})` : ''}` : '1.1.2'; },
    getHwAccel: async () => true,
    setHwAccel: noop,
    trimMemory: noop,
    setTrayOnClose: noop,
    toggleMiniWindow: async () => false,
    setMediaKeys: noop,
    mediaKeysActive: noop,
    onMediaCommand: noop, // lock-screen controls come from navigator.mediaSession in app.js
    welcomeFinish: noop,
    onWelcomeResult: noop,
    getLauncherInfo: async () => ({ platform: 'ios', canInstall: false, installed: true }),
    fileUrl: async (vpath) => { await ready; return fs.existsSync(vpath) ? fileUrlFor(vpath) : null; },
    // playlist files and profile backups (backup.js): written to the app's cache, then handed to the share sheet,
    // where "Save to Files" / Drive / Mail take it. In a desktop browser (dev harness) it's a plain download.
    async saveTextFile({ defaultName, content } = {}) {
      if (typeof content !== 'string') return { success: false, error: 'Nothing to save' };
      const name = String(defaultName || 'muriel.json').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').replace(/^\.+/, '').slice(0, 120) || 'muriel.json';
      if (!Capacitor.isNativePlatform()) {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
        a.download = name;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
        return { success: true };
      }
      const loc = { path: `exports/${name}`, directory: Directory.Cache };
      try {
        await Filesystem.writeFile({ ...loc, data: content, encoding: Encoding.UTF8, recursive: true });
        const { uri } = await Filesystem.getUri(loc);
        await Share.share({ title: name, files: [uri], dialogTitle: name });
        return { success: true };
      } catch (e) {
        if (e && /cancel/i.test(String(e.message || e))) return { canceled: true };
        return { success: false, error: "Couldn't share the file" };
      } finally {
        // the share sheet has its own copy by now
        setTimeout(() => { Filesystem.deleteFile(loc).catch(() => {}); }, 60000);
      }
    },

    // native share sheet (WhatsApp, Mail, …); falls back to the clipboard
    async shareText(title, text) {
      try { await Share.share({ title, text, dialogTitle: title }); return 'shared'; } catch (e) {
        if (e && /cancel/i.test(String(e.message || e))) return 'cancelled';
        try { await navigator.clipboard.writeText(text); return 'copied'; } catch (x) { return 'failed'; }
      }
    },
  };
};

// for test/android-picker.test.js
module.exports.chooseDownloadFolder = chooseDownloadFolder;
module.exports.MEDIA_PROMPT_TEXT = MEDIA_PROMPT_TEXT;
