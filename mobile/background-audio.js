// iPhone: keeps Muriel running in the background between two songs.
// iOS lets an app run in the background only while it plays something. Between two songs nothing does:
// the next one is still downloading, or one that can't play is being skipped. iOS then suspended Muriel
// within seconds, and the next song didn't start until the app was opened again. So while a song is on
// its way (app.js `state.trackLoading`), a second <audio> element loops a second of silence.
const { Capacitor } = require('@capacitor/core');

// a stuck download shouldn't keep the phone busy for good (each request gives up after 30s anyway)
const MAX_MS = 3 * 60 * 1000;

// one second of 16-bit mono silence as a WAV file
function silentWav(rate = 8000) {
  const bytes = rate * 2;
  const v = new DataView(new ArrayBuffer(44 + bytes));
  const text = (at, s) => { for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i)); };
  text(0, 'RIFF'); v.setUint32(4, 36 + bytes, true); text(8, 'WAVE');
  text(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  text(36, 'data'); v.setUint32(40, bytes, true);
  return new Blob([v.buffer], { type: 'audio/wav' });
}

module.exports = function backgroundAudio() {
  if (Capacitor.getPlatform() !== 'ios') return;
  const core = () => window.MurielCore;
  let silence = null;
  let capTimer = null;

  function start() {
    if (!silence) {
      silence = new Audio();
      silence.loop = true;
      silence.preload = 'auto';
      silence.src = URL.createObjectURL(silentWav());
    }
    if (!silence.paused) return;
    silence.play().catch(() => {});
    clearTimeout(capTimer);
    capTimer = setTimeout(stop, MAX_MS);
  }

  function stop() {
    clearTimeout(capTimer);
    capTimer = null;
    if (silence && !silence.paused) silence.pause();
  }

  function sync() {
    const c = core();
    if (c && c.state.trackLoading && c.audio.paused) start(); else stop();
  }

  function hook() {
    const c = core();
    if (!c || !c.audio) return;
    window.addEventListener('muriel:loading', sync);
    ['play', 'playing', 'pause'].forEach((ev) => c.audio.addEventListener(ev, sync));
  }
  if (window.MurielCore) hook(); else window.addEventListener('muriel:ready', hook, { once: true });
};
