// Lyrics on the iPhone lock screen and in the Dynamic Island (a Live Activity, drawn by the PiverxyWidgets
// extension). This sends the song, its synced lyrics and every play/pause/seek to the native side
// (ios/App/App/LyricsLiveActivity.swift), which times the lines itself while the app is in the background.
const { Capacitor, registerPlugin } = require('@capacitor/core');

const KEY = 'piverxy_live_activity';

module.exports = function liveActivity() {
  if (Capacitor.getPlatform() !== 'ios') return;
  const plugin = registerPlugin('PiverxyLiveActivity');
  const enabled = () => localStorage.getItem(KEY) !== '0';
  const send = (method, data) => { if (enabled()) plugin[method](data).catch(() => {}); };

  const core = () => window.PiverxyCore;
  const keyOf = (t) => (t ? `${t.platform || ''}:${t.id || ''}:${t.title || ''}` : '');
  let lastSync = 0;

  function sendTrack() {
    const t = core() && core().state.currentTrack;
    if (!t) return;
    let art = '';
    try { art = (core().thumb && core().thumb(t)) || t.thumbnail || ''; } catch (e) { art = t.thumbnail || ''; }
    send('setTrack', { id: keyOf(t), title: t.title || '', artist: t.artist || '', artwork: /^https:\/\//.test(art) ? art : '' });
  }

  function sendLyrics() {
    const c = core();
    const t = c && c.state.currentTrack;
    if (!t) return;
    const lines = (c.state.syncedLyrics || []).filter((l) => l.time >= 0 && l.text).map((l) => ({ t: l.time, x: l.text }));
    send('setLyrics', { id: keyOf(t), lines: JSON.stringify(lines) });
  }

  function sendPlayback() {
    const a = core() && core().audio;
    if (!a) return;
    lastSync = Date.now();
    const t = core().state.currentTrack;
    const duration = Number.isFinite(a.duration) && a.duration > 0 ? a.duration : Number(t && t.duration) || 0;
    send('setPlayback', { playing: !a.paused && !a.ended, position: a.currentTime || 0, rate: a.playbackRate || 1, duration, shuffle: !!core().state.isShuffle });
  }

  function hook() {
    const a = core() && core().audio;
    if (!a) return;
    window.addEventListener('piverxy:track', () => sendTrack());
    window.addEventListener('piverxy:lyrics', () => sendLyrics());
    ['playing', 'pause', 'seeked', 'ratechange', 'ended', 'durationchange'].forEach((ev) => a.addEventListener(ev, sendPlayback));
    window.addEventListener('piverxy:modes', sendPlayback);
    // the buttons in the Dynamic Island (iOS 17+)
    plugin.addListener('action', ({ action } = {}) => {
      const c = core();
      if (!c) return;
      if (action === 'toggle') c.togglePlay();
      else if (action === 'next') c.next();
      else if (action === 'prev') c.prev();
      else if (action === 'shuffle') c.toggleShuffle();
    });
    // the native clock drifts a little from the audio over a long song; line it up now and then
    a.addEventListener('timeupdate', () => { if (!a.paused && Date.now() - lastSync > 15000) sendPlayback(); });
  }
  if (window.PiverxyCore) hook(); else window.addEventListener('piverxy:ready', hook, { once: true });

  // for the switch in Settings (mobile-ui.js)
  window.PiverxyLiveActivity = {
    enabled,
    available: () => plugin.isAvailable().then((r) => !!(r && r.available)).catch(() => false),
    setEnabled(on) {
      localStorage.setItem(KEY, on ? '1' : '0');
      if (!on) { plugin.stop().catch(() => {}); return; }
      sendTrack();
      sendLyrics();
      sendPlayback();
    },
  };
};
