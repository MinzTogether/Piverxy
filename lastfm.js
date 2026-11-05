// Settings → Integrations → Last.fm: what the open profile listens to goes to its Last.fm account.
// lastfm-core.js decides when (the scrobbling rules); the in-app server (server.js, /api/lastfm/*) talks to Last.fm
// and keeps the login, so this page never sees the session key. Works the same on phones.
(function () {
  const L = window.MurielLastfm;
  if (!L) return;
  const ENABLED = 'muriel_lastfm_enabled';
  const $ = (id) => document.getElementById(id);
  const profileId = () => (window.MurielProfiles && window.MurielProfiles.id) || 'default';
  const isPhone = () => !!(window.electronAPI && window.electronAPI.isMobile);
  let core = null;
  let account = { connected: false, username: '', error: '' };
  let enabled = (() => { try { return localStorage.getItem(ENABLED) !== 'false'; } catch (e) { return true; } })();
  const tracker = L.createTracker();
  let pollTimer = null;
  let pollUntil = 0;

  async function api(route, body = {}) {
    if (!core) return { success: false, error: 'Muriel is still starting' };
    try {
      const r = await fetch(`${core.base()}/api/lastfm/${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, profile: profileId() }),
      });
      const data = await r.json().catch(() => ({}));
      return data && typeof data === 'object' ? data : {};
    } catch (e) {
      return { success: false, error: "Can't reach Last.fm" };
    }
  }

  // ---------- Settings card and dialog ----------
  function setStatus(text, isError) {
    const s = $('lastfm-modal-status');
    if (!s) return;
    s.textContent = text || '';
    s.style.color = isError ? 'var(--md-sys-color-error, #ba1a1a)' : 'var(--md-sys-color-primary)';
    s.classList.toggle('hidden', !text);
  }

  // UI language (i18n.js); the Last.fm name is filled in after translating, so it's never sent
  const I18N = window.MurielI18n;
  const T = (s) => (I18N ? I18N.T(s) : s);
  const Tf = (s, ...a) => (I18N ? I18N.Tf(s, ...a) : s.replace(/\{(\d+)\}/g, (m, i) => a[i]));
  // the card's line is drawn before the words of another language arrive: draw it again when they do
  window.addEventListener('muriel:i18n', () => render());

  function cardLine(text) {
    const label = $('lastfm-status-label');
    if (label) label.textContent = text;
  }

  function render() {
    const on = account.connected;
    const who = on ? `@${account.username || 'you'}` : '';
    if (!on) cardLine(account.error || T('Not connected'));
    else cardLine(enabled ? Tf('Scrobbling as {0}', who) : Tf('Paused ({0})', who));
    const toggle = $('btn-lastfm-toggle');
    if (toggle) {
      toggle.classList.toggle('active', on && enabled);
      toggle.disabled = !on;
      toggle.style.opacity = on ? '' : '0.5';
    }
    const open = $('btn-lastfm-open-modal');
    if (open) open.textContent = on ? 'Account' : 'Connect';
    const box = $('lastfm-modal-connected-box');
    if (box) box.classList.toggle('hidden', !on);
    const auth = $('lastfm-modal-auth-box');
    if (auth) auth.style.display = on ? 'none' : 'flex';
    const user = $('lastfm-modal-user');
    if (user) user.textContent = who;
  }

  async function refresh() {
    let profiles = [];
    try { profiles = window.MurielProfiles ? window.MurielProfiles.list().map((p) => p.id) : []; } catch (e) {}
    const r = await api('status', profiles.length ? { profiles } : {});
    if (r && r.success) account = { connected: !!r.connected, username: String(r.username || ''), error: r.error ? String(r.error) : '' };
    render();
  }

  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  function openDialog() {
    const m = $('lastfm-modal');
    if (!m || !core) return;
    setStatus('');
    const pass = $('lastfm-input-pass');
    if (pass) pass.value = '';
    render();
    core.openModal(m);
  }

  function closeDialog() {
    stopPolling();
    const pass = $('lastfm-input-pass');
    if (pass) pass.value = '';
    const m = $('lastfm-modal');
    if (m && core) core.closeModal(m);
  }

  function keyPair() {
    const key = ($('lastfm-input-key') && $('lastfm-input-key').value.trim()) || '';
    const secret = ($('lastfm-input-secret') && $('lastfm-input-secret').value.trim()) || '';
    return key || secret ? { apiKey: key, apiSecret: secret } : {};
  }

  function connected(r) {
    stopPolling();
    account = { connected: true, username: String(r.username || ''), error: '' };
    enabled = true;
    try { localStorage.setItem(ENABLED, 'true'); } catch (e) {}
    const secret = $('lastfm-input-secret');
    if (secret) secret.value = '';
    render();
    if (r.error) core.toast(r.error, 'info');
    else core.toast(`Connected to Last.fm as @${account.username}`, 'success');
    closeDialog();
    // the song playing now is announced right away
    announceCurrent();
  }

  // the person approves Muriel on last.fm in the browser; this keeps asking the server until they have
  async function webAuth() {
    setStatus('Opening Last.fm…');
    const r = await api('token', keyPair());
    if (!r.success || !r.authUrl || !/^https:\/\/www\.last\.fm\/api\/auth\//.test(r.authUrl)) { setStatus(r.error || "Couldn't start the sign-in", true); return; }
    if (window.electronAPI && typeof window.electronAPI.openExternal === 'function') window.electronAPI.openExternal(r.authUrl);
    else if (isPhone()) location.href = r.authUrl; // phones hand outside links to the browser
    else window.open(r.authUrl, '_blank', 'noopener');
    setStatus('Allow Muriel on the Last.fm page, then come back here');
    stopPolling();
    pollUntil = Date.now() + 10 * 60 * 1000;
    let busy = false;
    pollTimer = setInterval(async () => {
      if (busy) return;
      if (Date.now() > pollUntil) { stopPolling(); setStatus('The sign-in took too long. Try again.', true); return; }
      busy = true;
      try {
        const s = await api('session');
        if (s.success) connected(s);
        else if (s.expired) { stopPolling(); setStatus(s.error || 'The sign-in expired. Try again.', true); }
        else if (!s.pending && s.error) setStatus(s.error, true);
      } finally { busy = false; }
    }, 2500);
  }

  async function directSignIn() {
    const user = $('lastfm-input-user');
    const pass = $('lastfm-input-pass');
    const username = user ? user.value.trim() : '';
    const password = pass ? pass.value : '';
    if (!username || !password) { setStatus('Enter your Last.fm username and password', true); return; }
    const btn = $('btn-lastfm-login-direct');
    if (btn) btn.disabled = true;
    setStatus('Signing in…');
    try {
      const r = await api('mobile-session', { username, password, ...keyPair() });
      if (pass) pass.value = '';
      if (r.success) connected(r);
      else setStatus(r.error || "Couldn't sign in", true);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function logout() {
    stopPolling();
    await api('logout');
    account = { connected: false, username: '', error: '' };
    render();
    setStatus('Logged out');
  }

  // ---------- listening ----------
  function currentSong() {
    const t = core && core.state && core.state.currentTrack;
    if (!t) return null;
    const meta = L.cleanMeta(t);
    if (!meta) return null;
    const a = core.audio;
    if (!meta.duration && a && Number.isFinite(a.duration) && a.duration > 0) meta.duration = Math.round(a.duration);
    return meta;
  }

  const active = () => account.connected && enabled;

  async function announce(meta) {
    const r = await api('now-playing', meta);
    if (r.success) cardLine(`Now playing: ${meta.artist} — ${meta.track}`);
    else if (r.code === 'reauth') { account = { connected: false, username: '', error: r.error || '' }; render(); }
  }

  async function scrobble(meta, timestamp) {
    const r = await api('scrobble', { ...meta, timestamp });
    if (r.success && r.accepted) cardLine(`Scrobbled: ${meta.artist} — ${meta.track}`);
    else if (r.code === 'reauth') { account = { connected: false, username: '', error: r.error || '' }; render(); core.toast('Last.fm signed Muriel out. Connect again in Settings.', 'info'); }
  }

  function announceCurrent() {
    if (!active() || !core || !core.audio || core.audio.paused) return;
    const meta = currentSong();
    if (meta) announce(meta);
  }

  function tick() {
    if (!core || !core.audio) return;
    const a = core.audio;
    const t = core.state && core.state.currentTrack;
    // every song is followed (so switching scrobbling on mid-song counts what was heard); only songs with a
    // usable title and artist go out
    const out = tracker.tick({
      key: L.trackKey(t),
      playing: !a.paused && !a.ended && a.readyState > 2,
      position: a.currentTime,
      duration: (t && Number(t.duration)) || a.duration,
      now: Date.now(),
    });
    if (!active() || (!out.nowPlaying && !out.scrobble)) return;
    const meta = currentSong();
    if (!meta) return;
    if (out.nowPlaying) announce(meta);
    if (out.scrobble) scrobble(meta, out.scrobble.timestamp);
  }

  function hook() {
    core = window.MurielCore;
    if (!core || !core.audio) return;
    ['timeupdate', 'play', 'playing', 'pause', 'seeked', 'emptied', 'ended'].forEach((ev) => core.audio.addEventListener(ev, tick));

    const on = (id, fn) => { const b = $(id); if (b) b.addEventListener('click', fn); };
    on('btn-lastfm-open-modal', openDialog);
    on('btn-close-lastfm-modal', closeDialog);
    on('btn-cancel-lastfm-modal', closeDialog);
    on('btn-lastfm-web-auth', webAuth);
    on('btn-lastfm-login-direct', directSignIn);
    on('btn-lastfm-disconnect', logout);
    on('btn-lastfm-toggle', () => {
      if (!account.connected) { openDialog(); return; }
      enabled = !enabled;
      try { localStorage.setItem(ENABLED, String(enabled)); } catch (e) {}
      render();
      if (enabled) announceCurrent();
    });
    const pass = $('lastfm-input-pass');
    if (pass) pass.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); directSignIn(); } });
    const m = $('lastfm-modal');
    if (m) m.addEventListener('click', (e) => { if (e.target === m) closeDialog(); });
    // back from the browser sign-in on a phone: ask right away instead of waiting for the next poll
    document.addEventListener('visibilitychange', () => { if (!document.hidden && pollTimer) api('session').then((s) => { if (s.success) connected(s); }); });
    render();
    refresh();
  }

  if (window.MurielCore) hook();
  else window.addEventListener('muriel:ready', hook, { once: true });
})();
