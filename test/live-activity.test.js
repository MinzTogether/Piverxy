'use strict';

// mobile/live-activity.js: what the page sends to the iPhone lock-screen lyrics (Live Activity) plugin.
const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const path = require('path');

function setup({ platform = 'ios', stored = {} } = {}) {
  const calls = [];
  let onAction = null;
  const plugin = new Proxy({}, {
    get: (_, method) => (method === 'addListener'
      ? (name, cb) => { if (name === 'action') onAction = cb; return Promise.resolve({ remove() {} }); }
      : (data) => { calls.push([method, data]); return Promise.resolve({ available: true }); }),
  });
  const fakeCore = { Capacitor: { getPlatform: () => platform }, registerPlugin: () => plugin };
  const origLoad = Module._load;
  Module._load = function (request, ...rest) { return request === '@capacitor/core' ? fakeCore : origLoad.call(this, request, ...rest); };
  const file = path.join(__dirname, '../mobile/live-activity.js');
  delete require.cache[file];
  const store = { ...stored };
  const audio = new EventTarget();
  Object.assign(audio, { paused: true, ended: false, currentTime: 0, playbackRate: 1 });
  const state = { currentTrack: null, syncedLyrics: [] };
  global.window = new EventTarget();
  global.localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } };
  window.MurielCore = { state, audio, thumb: (t) => t.thumbnail };
  try { require(file)(); } finally { Module._load = origLoad; }
  return { calls, audio, state, store, action: (a) => onAction && onAction({ action: a }) };
}

test('sends the song, its synced lines and playback to the plugin', () => {
  const { calls, audio, state } = setup();
  state.currentTrack = { platform: 'youtube', id: 'abc', title: 'Song', artist: 'Someone', thumbnail: 'https://i.ytimg.com/vi/abc/mqdefault.jpg' };
  window.dispatchEvent(new Event('muriel:track'));
  state.syncedLyrics = [{ time: -1, text: 'plain' }, { time: 1.5, text: 'one' }, { time: 4, text: '' }, { time: 6, text: 'two' }];
  window.dispatchEvent(new Event('muriel:lyrics'));
  Object.assign(audio, { paused: false, currentTime: 12.5 });
  audio.dispatchEvent(new Event('playing'));

  const [track, lyrics, playback] = calls;
  assert.deepStrictEqual(track, ['setTrack', { id: 'youtube:abc:Song', title: 'Song', artist: 'Someone', artwork: 'https://i.ytimg.com/vi/abc/mqdefault.jpg' }]);
  assert.strictEqual(lyrics[0], 'setLyrics');
  assert.strictEqual(lyrics[1].id, 'youtube:abc:Song');
  assert.deepStrictEqual(JSON.parse(lyrics[1].lines), [{ t: 1.5, x: 'one' }, { t: 6, x: 'two' }]);
  assert.deepStrictEqual(playback, ['setPlayback', { playing: true, position: 12.5, rate: 1, duration: 0, shuffle: false }]);
});

test('the song length and shuffle go along, for the progress bar and the shuffle button', () => {
  const { calls, audio, state } = setup();
  state.currentTrack = { id: 'x', title: 'T', duration: 200 };
  state.isShuffle = true;
  Object.assign(audio, { paused: false, currentTime: 3 });
  audio.dispatchEvent(new Event('playing'));
  assert.deepStrictEqual(calls[0], ['setPlayback', { playing: true, position: 3, rate: 1, duration: 200, shuffle: true }]);
  audio.duration = 201.4; // the real length, once the file is loaded
  audio.dispatchEvent(new Event('durationchange'));
  assert.strictEqual(calls[1][1].duration, 201.4);
  state.isShuffle = false;
  window.dispatchEvent(new Event('muriel:modes'));
  assert.strictEqual(calls[2][1].shuffle, false);
});

test('the Dynamic Island buttons drive the player', () => {
  const { action } = setup();
  const did = [];
  Object.assign(window.MurielCore, { togglePlay: () => did.push('toggle'), next: () => did.push('next'), prev: () => did.push('prev'), toggleShuffle: () => did.push('shuffle') });
  ['toggle', 'next', 'prev', 'shuffle', 'bogus'].forEach(action);
  assert.deepStrictEqual(did, ['toggle', 'next', 'prev', 'shuffle']);
});

test('artwork that is not https is left out', () => {
  const { calls, state } = setup();
  state.currentTrack = { id: 'x', title: 'Local', artist: '', thumbnail: 'capacitor://localhost/_capacitor_file_/a.jpg' };
  window.dispatchEvent(new Event('muriel:track'));
  assert.strictEqual(calls[0][1].artwork, '');
});

test('switched off: nothing is sent, and switching off ends the activity', () => {
  const { calls, state, audio, store } = setup({ stored: { muriel_live_activity: '0' } });
  state.currentTrack = { id: 'x', title: 'T' };
  window.dispatchEvent(new Event('muriel:track'));
  audio.dispatchEvent(new Event('pause'));
  assert.strictEqual(calls.length, 0);
  window.MurielLiveActivity.setEnabled(true);
  assert.strictEqual(store.muriel_live_activity, '1');
  assert.deepStrictEqual(calls.map((c) => c[0]), ['setTrack', 'setLyrics', 'setPlayback']);
  window.MurielLiveActivity.setEnabled(false);
  assert.strictEqual(calls[calls.length - 1][0], 'stop');
});

test('does nothing outside iOS', () => {
  const { calls, state } = setup({ platform: 'android' });
  state.currentTrack = { id: 'x', title: 'T' };
  window.dispatchEvent(new Event('muriel:track'));
  assert.strictEqual(calls.length, 0);
  assert.strictEqual(window.MurielLiveActivity, undefined);
});

test.after(() => { delete global.window; delete global.localStorage; });
