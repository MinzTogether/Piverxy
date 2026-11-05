'use strict';

// mobile/background-audio.js: on iPhone, silence plays between two songs so iOS doesn't suspend the app.
const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const path = require('path');

function setup(platform = 'ios') {
  const silent = [];
  global.Audio = class {
    constructor() { this.paused = true; silent.push(this); }
    play() { this.paused = false; return Promise.resolve(); }
    pause() { this.paused = true; }
  };
  global.URL.createObjectURL = () => 'blob:silence';
  const fakeCore = { Capacitor: { getPlatform: () => platform } };
  const origLoad = Module._load;
  Module._load = function (request, ...rest) { return request === '@capacitor/core' ? fakeCore : origLoad.call(this, request, ...rest); };
  const file = path.join(__dirname, '../mobile/background-audio.js');
  delete require.cache[file];
  const audio = new EventTarget();
  audio.paused = true;
  const state = { trackLoading: false };
  global.window = new EventTarget();
  window.MurielCore = { state, audio };
  try { require(file)(); } finally { Module._load = origLoad; }
  const loading = (on) => { state.trackLoading = on; window.dispatchEvent(new Event('muriel:loading')); };
  const playing = () => { audio.paused = false; audio.dispatchEvent(new Event('play')); audio.dispatchEvent(new Event('playing')); };
  return { silent, audio, loading, playing, silence: () => silent[0] };
}

test('silence plays while the next song loads and stops when it starts', () => {
  const { silence, loading, playing, audio } = setup();
  audio.paused = false;
  loading(false);
  assert.strictEqual(silence(), undefined);
  // the song ends and the next one is asked for
  audio.paused = true;
  audio.dispatchEvent(new Event('pause'));
  loading(true);
  assert.strictEqual(silence().paused, false);
  assert.strictEqual(silence().loop, true);
  assert.strictEqual(silence().src, 'blob:silence');
  playing();
  loading(false);
  assert.strictEqual(silence().paused, true);
});

test('a song that fails for good (nothing more to load) ends the silence', () => {
  const { silence, loading } = setup();
  loading(true);
  assert.strictEqual(silence().paused, false);
  loading(false);
  assert.strictEqual(silence().paused, true);
});

test('nothing on Android, where the native service keeps the app running', () => {
  const { silent, loading } = setup('android');
  loading(true);
  assert.strictEqual(silent.length, 0);
});

test('the silent clip is a valid one-second WAV', async () => {
  const s = setup();
  let blob = null;
  // the clip is only built when it's first needed
  global.URL.createObjectURL = (b) => { blob = b; return 'blob:x'; };
  s.loading(true);
  assert.ok(blob, 'clip built');
  const buf = Buffer.from(await blob.arrayBuffer());
  assert.strictEqual(buf.toString('ascii', 0, 4), 'RIFF');
  assert.strictEqual(buf.toString('ascii', 8, 12), 'WAVE');
  assert.strictEqual(buf.readUInt32LE(4), buf.length - 8);
  assert.strictEqual(buf.readUInt32LE(24), 8000);
  assert.strictEqual(buf.readUInt32LE(40), 16000);
  assert.ok(buf.subarray(44).every((b) => b === 0));
  assert.strictEqual(blob.type, 'audio/wav');
  s.loading(false); // clears the 3-minute cap timer
});

test.after(() => { delete global.window; delete global.Audio; });
