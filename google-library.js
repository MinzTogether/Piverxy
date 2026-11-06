// YouTube / YouTube Music library import (desktop): log in to Google in a separate window, then read the liked
// songs and playlists of that account. Registered by main.js.
// The Google login lives in its own persistent browser storage, one per Muriel profile ("persist:muriel-google"
// for the first one), apart from the app's own pages: Muriel's window never gets the Google cookies, and the
// login window gets neither Muriel's preload API nor its server token. Only "logged in or not" and the songs
// (checked and capped here) go back to the page.
const { BrowserWindow, ipcMain, session, shell } = require('electron');
const crypto = require('crypto');

const PROFILE_RE = /^(?:default|[a-z0-9]{4,16})$/;
const YT_ID = /^[A-Za-z0-9_-]{11}$/;
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const LIMITS = { likePages: 60, playlists: 200, playlistPages: 40, tracksPerList: 5000, requests: 1500 };

const partitionFor = (profile) => (PROFILE_RE.test(String(profile || '')) && profile !== 'default' ? `persist:muriel-google-${profile}` : 'persist:muriel-google');

function googleSession(profile) {
  const s = session.fromPartition(partitionFor(profile));
  if (!s.__murielReady) {
    s.__murielReady = true;
    try { s.setUserAgent(CHROME_UA); } catch (e) {}
    // the login page needs no camera, microphone, notifications or anything else
    try { s.setPermissionRequestHandler((wc, permission, cb) => cb(false)); } catch (e) {}
    try { s.setPermissionCheckHandler(() => false); } catch (e) {}
  }
  return s;
}

async function sapisid(s) {
  try {
    const cookies = await s.cookies.get({ name: 'SAPISID' });
    const c = Array.isArray(cookies) ? cookies.find((x) => x && x.value && /(^|\.)youtube\.com$|(^|\.)google\.com$/.test(String(x.domain || '').replace(/^\./, ''))) : null;
    return c ? c.value : '';
  } catch (e) { return ''; }
}

const clip = (s, n) => (typeof s === 'string' || typeof s === 'number' ? String(s) : '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
const httpsUrl = (s) => { try { const u = new URL(String(s)); return u.protocol === 'https:' && String(s).length < 2048 ? u.href : ''; } catch (e) { return ''; } };

function text(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (typeof node.simpleText === 'string') return node.simpleText;
  if (Array.isArray(node.runs)) return node.runs.map((r) => (r && r.text) || '').join('');
  return '';
}

function seconds(v) {
  if (typeof v === 'number') return v;
  const m = String(v || '').trim().match(/^(?:(\d+):)?(\d+):(\d{2})$/);
  if (m) return (m[1] ? Number(m[1]) * 3600 : 0) + Number(m[2]) * 60 + Number(m[3]);
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
}

// walks a youtubei answer without recursing forever (the answers are deep but finite; this caps it anyway)
function walk(root, visit) {
  const stack = [root];
  const seen = new Set();
  let steps = 0;
  while (stack.length && steps++ < 500000) {
    const node = stack.pop();
    if (!node || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);
    if (visit(node) === false) continue;
    // pushed last-first, so nodes come off the stack in the order they appear (the first copy of a song wins)
    const keys = Object.keys(node);
    for (let i = keys.length - 1; i >= 0; i--) {
      const v = node[keys[i]];
      if (v && typeof v === 'object') stack.push(v);
    }
  }
}

function find(root, pick) {
  let out = null;
  walk(root, (n) => { if (out) return false; const v = pick(n); if (v) { out = v; return false; } return true; });
  return out;
}

const continuationOf = (root) => find(root, (n) => {
  if (n.continuationCommand && typeof n.continuationCommand.token === 'string') return n.continuationCommand.token;
  if (n.nextContinuationData && typeof n.nextContinuationData.continuation === 'string') return n.nextContinuationData.continuation;
  return null;
});

const thumbOf = (thumbs) => (Array.isArray(thumbs) && thumbs.length ? httpsUrl(thumbs[thumbs.length - 1] && thumbs[thumbs.length - 1].url) : '');

function tracksIn(root, out, seen) {
  walk(root, (n) => {
    const r = n.musicResponsiveListItemRenderer;
    if (r) {
      const vid = (r.playlistItemData && r.playlistItemData.videoId) || find(r, (x) => (x.watchEndpoint && typeof x.watchEndpoint.videoId === 'string' ? x.watchEndpoint.videoId : null));
      if (YT_ID.test(vid || '') && !seen.has(vid)) {
        seen.add(vid);
        const cols = Array.isArray(r.flexColumns) ? r.flexColumns.map((c) => c && c.musicResponsiveListItemFlexColumnRenderer && c.musicResponsiveListItemFlexColumnRenderer.text) : [];
        const runs = cols[1] && Array.isArray(cols[1].runs) ? cols[1].runs : [];
        const artist = runs.length ? (runs[0].text || '') : text(cols[1]);
        let duration = 0;
        walk(r, (x) => {
          if (duration) return false;
          if (Array.isArray(x.runs)) for (const run of x.runs) if (run && /^\d+:\d{2}(?::\d{2})?$/.test(String(run.text || '').trim())) { duration = seconds(run.text); break; }
          return true;
        });
        out.push({ id: vid, title: text(cols[0]), artist, duration, thumbnail: thumbOf(r.thumbnail && r.thumbnail.musicThumbnailRenderer && r.thumbnail.musicThumbnailRenderer.thumbnail && r.thumbnail.musicThumbnailRenderer.thumbnail.thumbnails) });
      }
      return false;
    }
    const v = n.playlistVideoRenderer || n.videoRenderer;
    if (v) {
      if (YT_ID.test(v.videoId || '') && !seen.has(v.videoId)) {
        seen.add(v.videoId);
        out.push({ id: v.videoId, title: text(v.title), artist: text(v.shortBylineText) || text(v.ownerText), duration: v.lengthSeconds ? Number(v.lengthSeconds) : seconds(text(v.lengthText)), thumbnail: thumbOf(v.thumbnail && v.thumbnail.thumbnails) });
      }
      return false;
    }
    return true;
  });
}

function playlistsIn(root, out, seen) {
  walk(root, (n) => {
    const r = n.musicTwoRowItemRenderer;
    if (r) {
      const id = (r.navigationEndpoint && r.navigationEndpoint.browseEndpoint && r.navigationEndpoint.browseEndpoint.browseId) || find(r, (x) => (x.browseEndpoint && typeof x.browseEndpoint.browseId === 'string' ? x.browseEndpoint.browseId : null));
      if (/^(?:VL)?(?:PL|LM|RD|OL|FL)[A-Za-z0-9_-]{0,60}$|^VL[A-Za-z0-9_-]{2,60}$/.test(id || '') && !seen.has(id)) {
        seen.add(id);
        out.push({ id, name: text(r.title), cover: thumbOf(r.thumbnailRenderer && r.thumbnailRenderer.musicThumbnailRenderer && r.thumbnailRenderer.musicThumbnailRenderer.thumbnail && r.thumbnailRenderer.musicThumbnailRenderer.thumbnail.thumbnails) });
      }
      return false;
    }
    const p = n.gridPlaylistRenderer || n.playlistRenderer || n.compactPlaylistRenderer || n.lockupViewModel;
    if (p) {
      const id = p.playlistId || p.contentId || (p.navigationEndpoint && p.navigationEndpoint.browseEndpoint && p.navigationEndpoint.browseEndpoint.browseId);
      if (/^(?:VL)?[A-Za-z0-9_-]{2,64}$/.test(id || '') && !seen.has(id) && (!n.lockupViewModel || p.contentType === 'LOCKUP_CONTENT_TYPE_PLAYLIST')) {
        seen.add(id);
        const name = text(p.title) || (p.metadata && p.metadata.lockupMetadataViewModel && p.metadata.lockupMetadataViewModel.title && p.metadata.lockupMetadataViewModel.title.content) || '';
        out.push({ id, name, cover: thumbOf((p.thumbnail && p.thumbnail.thumbnails) || (p.thumbnails && p.thumbnails[0] && p.thumbnails[0].thumbnails)) });
      }
      return false;
    }
    return true;
  });
}

const toTrack = (t) => ({
  id: t.id,
  title: clip(t.title, 300) || 'Unknown',
  artist: clip(t.artist, 300),
  duration: t.duration > 0 && t.duration < 86400 ? Math.round(t.duration) : 0,
  thumbnail: t.thumbnail || `https://i.ytimg.com/vi/${t.id}/hqdefault.jpg`,
  url: `https://www.youtube.com/watch?v=${t.id}`,
  platform: 'youtube',
});

async function importLibrary(opts) {
  const profile = opts && opts.profile;
  const ytm = opts && opts.platform === 'ytmusic';
  const doLikes = !opts || opts.doLikes !== false;
  const doPlaylists = !opts || opts.doPlaylists !== false;
  const s = googleSession(profile);
  const sid = await sapisid(s);
  if (!sid) return { success: false, code: 'not_logged_in', error: 'Not logged in to Google' };

  const origin = ytm ? 'https://music.youtube.com' : 'https://www.youtube.com';
  const client = ytm ? { clientName: 'WEB_REMIX', clientVersion: '1.20240401.01.00', hl: 'en' } : { clientName: 'WEB', clientVersion: '2.20240401.01.00', hl: 'en' };
  let requests = 0;
  async function browse(body) {
    if (++requests > LIMITS.requests) throw new Error('The library is too big to read at once');
    const ts = Math.floor(Date.now() / 1000);
    const hash = crypto.createHash('sha1').update(`${ts} ${sid} ${origin}`).digest('hex');
    const res = await s.fetch(`${origin}/youtubei/v1/browse?prettyPrint=false`, {
      method: 'POST',
      headers: { 'Authorization': `SAPISIDHASH ${ts}_${hash}`, 'Content-Type': 'application/json', 'Origin': origin, 'Referer': `${origin}/`, 'X-Origin': origin, 'X-Goog-AuthUser': '0' },
      body: JSON.stringify({ context: { client }, ...body }),
      // the session's Google cookies go with it (Electron's fetch leaves cookies out unless asked)
      credentials: 'include',
      signal: AbortSignal.timeout(20000),
    });
    if (res.status === 401 || res.status === 403) { const e = new Error('Google refused: log in again'); e.code = 'not_logged_in'; throw e; }
    if (!res.ok) throw new Error(`YouTube answered ${res.status}`);
    const raw = await res.text();
    if (raw.length > 30e6) throw new Error('YouTube sent too much data');
    return JSON.parse(raw);
  }
  async function allTracks(browseId, maxPages) {
    const out = [];
    const seen = new Set();
    let data = await browse({ browseId });
    tracksIn(data, out, seen);
    let token = continuationOf(data);
    for (let page = 0; token && page < maxPages && out.length < LIMITS.tracksPerList; page++) {
      const before = out.length;
      data = await browse({ continuation: token });
      tracksIn(data, out, seen);
      const next = continuationOf(data);
      if (out.length === before || !next || next === token) break;
      token = next;
    }
    return out.slice(0, LIMITS.tracksPerList).map(toTrack);
  }

  try {
    const likes = doLikes ? await allTracks(ytm ? 'VLLM' : 'VLLL', LIMITS.likePages) : [];
    const playlists = [];
    if (doPlaylists) {
      const found = [];
      const seen = new Set();
      let data = await browse({ browseId: ytm ? 'FEmusic_liked_playlists' : 'FEplaylist_aggregation' });
      playlistsIn(data, found, seen);
      let token = continuationOf(data);
      for (let page = 0; token && page < 10 && found.length < LIMITS.playlists; page++) {
        const before = found.length;
        data = await browse({ continuation: token });
        playlistsIn(data, found, seen);
        const next = continuationOf(data);
        if (found.length === before || !next || next === token) break;
        token = next;
      }
      // liked songs come in separately; the "Liked music" and "Watch later" lists aren't playlists of yours
      for (const pl of found.slice(0, LIMITS.playlists)) {
        const bare = pl.id.replace(/^VL/, '');
        if (bare === 'LM' || bare === 'LL' || bare === 'WL' || bare.startsWith('RD')) continue;
        let tracks = [];
        try { tracks = await allTracks(`VL${bare}`, LIMITS.playlistPages); } catch (e) { if (e.code === 'not_logged_in') throw e; }
        playlists.push({ id: bare, name: clip(pl.name, 100) || 'YouTube playlist', cover: pl.cover, tracks });
      }
    }
    return { success: true, likes, playlists };
  } catch (e) {
    return { success: false, code: e && e.code, error: clip((e && e.message) || "Couldn't read the library", 200) };
  }
}

function login(parent, profile) {
  const s = googleSession(profile);
  return new Promise((resolve) => {
    let finished = false;
    const win = new BrowserWindow({
      width: 480,
      height: 680,
      parent: parent || undefined,
      modal: !!parent,
      title: 'Log in to Google',
      autoHideMenuBar: true,
      webPreferences: { session: s, contextIsolation: true, nodeIntegration: false, sandbox: true, webviewTag: false },
    });
    const wc = win.webContents;
    try { wc.setUserAgent(CHROME_UA); } catch (e) {}
    // help links and the like open in the browser; the login itself only ever shows https pages
    wc.setWindowOpenHandler(({ url }) => { try { if (new URL(url).protocol === 'https:') shell.openExternal(url); } catch (e) {} return { action: 'deny' }; });
    wc.on('will-navigate', (e, url) => { try { if (new URL(url).protocol !== 'https:') e.preventDefault(); } catch (x) { e.preventDefault(); } });
    const finish = (loggedIn) => {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      if (!win.isDestroyed()) win.close();
      resolve({ success: loggedIn, loggedIn });
    };
    const check = async () => {
      if (finished || win.isDestroyed()) return;
      const url = wc.getURL() || '';
      if (/^https:\/\/(?:music|www)\.youtube\.com\//.test(url) && (await sapisid(s))) finish(true);
    };
    const timer = setInterval(check, 1000);
    wc.on('did-navigate', check);
    wc.on('did-navigate-in-page', check);
    wc.on('did-finish-load', check);
    win.on('closed', () => { if (!finished) sapisid(s).then((v) => finish(!!v), () => finish(false)); });
    win.loadURL('https://accounts.google.com/ServiceLogin?service=youtube&continue=https%3A%2F%2Fmusic.youtube.com%2F', { userAgent: CHROME_UA }).catch(() => {});
  });
}

function register(getMainWindow) {
  for (const ch of ['google-auth-status', 'google-login', 'google-logout', 'google-import-library']) ipcMain.removeHandler(ch);
  ipcMain.handle('google-auth-status', async (e, profile) => ({ loggedIn: !!(await sapisid(googleSession(profile))) }));
  ipcMain.handle('google-login', (e, profile) => login(BrowserWindow.fromWebContents(e.sender) || getMainWindow(), profile));
  ipcMain.handle('google-logout', async (e, profile) => {
    try { await googleSession(profile).clearStorageData(); return { success: true }; } catch (err) { return { success: false, error: 'Logout failed' }; }
  });
  let running = false;
  ipcMain.handle('google-import-library', async (e, opts) => {
    if (running) return { success: false, error: 'An import is already running' };
    running = true;
    try { return await importLibrary(opts && typeof opts === 'object' ? opts : {}); } finally { running = false; }
  });
}

module.exports = { register, partitionFor, _test: { tracksIn, playlistsIn, continuationOf, toTrack } };
