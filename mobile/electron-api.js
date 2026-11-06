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

// Settings → Folders → Download folder → Change (Android): a sheet listing the places Android lets Muriel save songs in,
// one of your own inside Music / Download / Documents, and whether the songs already downloaded go along.
// Resolves { text, move } (text: the folder as Settings shows it, e.g. Music/Muriel Mod), or null when cancelled.
function chooseDownloadFolder(current) {
  return new Promise((resolve) => {
    const choices = store.downloadChoices();
    const tops = store.sharedTops();
    const known = choices.find((c) => c.shown === current);
    const wrap = document.createElement('div');
    wrap.className = 'modal-backdrop';
    wrap.id = 'download-folder-picker';
    const card = document.createElement('div');
    card.className = 'dialog-card';
    card.style.cssText = 'max-height:85vh;overflow-y:auto;';
    const mk = (tag, css, text) => { const n = document.createElement(tag); if (css) n.style.cssText = css; if (text != null) n.textContent = text; return n; };
    card.appendChild(mk('h3', '', 'Download folder'));

    const rows = [];
    const addRow = (value, title, sub, extra) => {
      const label = mk('label', 'display:flex;gap:10px;align-items:flex-start;padding:10px 0;cursor:pointer;');
      const radio = document.createElement('input');
      radio.type = 'radio'; radio.name = 'dl-folder'; radio.value = value; radio.style.marginTop = '4px';
      const box = mk('div', 'display:flex;flex-direction:column;min-width:0;flex:1;');
      box.appendChild(mk('span', 'font-weight:600;', title));
      if (sub) box.appendChild(mk('span', 'font-size:12px;color:var(--md-sys-color-outline);word-break:break-all;', sub));
      if (extra) box.appendChild(extra);
      label.append(radio, box);
      card.appendChild(label);
      rows.push(radio);
      return radio;
    };
    for (const c of choices) {
      const r = addRow(c.text, c.label, c.full + (c.hint ? `\n${c.hint}` : ''));
      r.parentElement.querySelector('span:nth-child(2)').style.whiteSpace = 'pre-line';
      if (known && known.text === c.text) r.checked = true;
    }
    const custom = mk('div', 'display:flex;gap:8px;margin-top:6px;');
    const topSel = document.createElement('select');
    topSel.className = 'pill-text-input';
    topSel.style.cssText = 'flex:0 0 auto;width:auto;';
    for (const t of tops) topSel.appendChild(new Option(t, t));
    const nameIn = document.createElement('input');
    nameIn.type = 'text'; nameIn.className = 'pill-text-input'; nameIn.maxLength = 60; nameIn.placeholder = 'Folder name';
    nameIn.style.cssText = 'flex:1;min-width:0;';
    custom.append(topSel, nameIn);
    const customRadio = addRow('__custom', 'Another folder', 'Inside Music, Download, Documents, Podcasts or Audiobooks', custom);
    if (!known && current && !current.startsWith('Android/')) {
      const rel = current.split('/');
      if (tops.includes(rel[0])) { topSel.value = rel[0]; nameIn.value = rel.slice(1).join('/'); customRadio.checked = true; }
    }
    nameIn.addEventListener('focus', () => { customRadio.checked = true; });
    if (!rows.some((r) => r.checked)) rows[0].checked = true;

    const moveLabel = mk('label', 'display:flex;gap:10px;align-items:center;margin:12px 0 4px;cursor:pointer;');
    const move = document.createElement('input');
    move.type = 'checkbox'; move.checked = true;
    moveLabel.append(move, mk('span', '', 'Move the songs I already downloaded'));
    card.appendChild(moveLabel);
    const err = mk('div', 'color:var(--md-sys-color-error,#f2b8b5);font-size:12px;min-height:16px;margin-top:6px;', '');
    card.appendChild(err);

    const actions = mk('div', '');
    actions.className = 'dialog-actions';
    const cancel = mk('button', '', 'Cancel');
    cancel.className = 'btn-outline-pill';
    cancel.id = 'btn-cancel-download-folder'; // the Android back button presses this (bridge.js)
    const save = mk('button', '', 'Use this folder');
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
      if (!full) { err.textContent = "Type a folder name without special characters (no / \\ : * ? \" < > |, and no leading dot)."; return; }
      close({ text: full, move: move.checked });
    });
    document.body.appendChild(wrap);
    requestAnimationFrame(() => requestAnimationFrame(() => wrap.classList.add('visible')));
  });
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
      const j = await r.json();
      await fs._flush();
      return Array.isArray(j.ids) ? j.ids : [];
    } catch (e) { return []; }
  }

  // Android: the songs in the folders next to the download folder. Registers them with the file index and hands back
  // what app.js needs to add them to the library (/api/library-link) and make playlists of them.
  async function scanLocalFolders() {
    await ready;
    const found = await store.scanLinked();
    if (!found) return { unavailable: true };
    const groups = [];
    for (const g of found.groups) {
      const items = [];
      for (const f of g.files) {
        fs._register(f.vpath, f.size);
        items.push({ id: 'local_' + crypto._sha1(f.vpath + f.size).slice(0, 12), path: f.vpath, name: f.name, size: f.size });
      }
      groups.push({ folder: g.folder, items });
    }
    return { parent: found.parent, groups };
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
      if (move && window.MurielCore) window.MurielCore.toast('Moving your songs…', 'info');
      const res = await store.setDownloadDir(dir, { move });
      if (!res.ok) return res;
      return { ...res, unlinked: await forgetLinked(), restart: true };
    },
    async resetDownloadDir() {
      if (!ANDROID) return { ok: true };
      await ready;
      if (window.MurielCore) window.MurielCore.toast('Moving your songs…', 'info');
      const res = await store.resetDownloadDir({ move: true });
      if (!res.ok) return res;
      return { ...res, unlinked: await forgetLinked(), restart: true };
    },
    ...(ANDROID ? { scanLocalFolders } : {}),
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
