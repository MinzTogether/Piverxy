'use strict';

// The music permission taken back, from the page's side (phones, Android 11+). Songs linked from the folders next to the download
// folder are LOCKED: asked for, they are not played, queued or counted; a prompt says what is wrong and opens the app's page in
// Settings; nothing is skipped through, removed or marked missing. The pieces run here as they are in app.js, mobile/bridge.js and
// mobile/electron-api.js, against small stand-ins for what they use.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const appSource = read('app.js');
const bridgeSource = read('mobile/bridge.js');

// the source of one function (async ones included), found by name, up to its closing brace
function fn(source, name) {
  let at = source.indexOf(`function ${name}(`);
  assert.ok(at >= 0, `function ${name} not found`);
  if (source.slice(at - 6, at) === 'async ') at -= 6;
  const open = source.indexOf('{', at + source.slice(at).search(/\)\s*\{/));
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(at, i + 1);
  }
  throw new Error(`unbalanced ${name}`);
}
const run = (code, ctx) => { vm.createContext(ctx); vm.runInContext(code, ctx); return ctx; };
const evalIn = (code, ctx) => { vm.createContext(ctx); return vm.runInContext(code, ctx); }; // the value of the script
// objects made inside the sandbox have another Object.prototype than the test's: compared as plain data
const plain = (x) => JSON.parse(JSON.stringify(x));

// ---- isMediaLocked / applyMediaAccess (app.js) ----

function pageState() {
  const rows = [{ dataset: { trackId: 'local_a' }, on: false }, { dataset: { trackId: 'local_b' }, on: false }, { dataset: { trackId: 'local_c' }, on: false }];
  for (const r of rows) r.classList = { toggle: (c, on) => { assert.equal(c, 'is-locked'); r.on = !!on; } };
  return { rows, state: { serverPort: 1 }, document: { querySelectorAll: () => rows } };
}
const lockedList = [
  { id: 'local_a', platform: 'local', title: 'A', locked: true },
  { id: 'local_b', platform: 'local', title: 'B', locked: true },
  { id: 'local_c', platform: 'local', title: 'C' }, // kept inside the app
];
function pageFns(extra) {
  const p = pageState();
  const ctx = { ...p, console, Promise, Set, ...extra };
  run(`${fn(appSource, 'isMediaLocked')}\n${fn(appSource, 'markLockedRows')}\n${fn(appSource, 'applyMediaAccess')}\nlet mediaAccessSeq = 0;`, ctx);
  return { ...p, ctx };
}

test('PG-01: a song is locked only if it is a library song the server said is locked', () => {
  const { ctx } = pageFns({ fetch: async () => { throw new Error('no network here'); } });
  const locked = new Set(['local_a']);
  ctx.state.lockedIds = locked;
  assert.equal(ctx.isMediaLocked({ platform: 'local', id: 'local_a' }), true);
  assert.equal(ctx.isMediaLocked({ platform: 'local', id: 'local_c' }), false, 'a song kept inside the app');
  assert.equal(ctx.isMediaLocked({ platform: 'youtube', id: 'local_a' }), false, 'only library songs can be locked');
  assert.equal(ctx.isMediaLocked(null), false);
  ctx.state.lockedIds = undefined;
  assert.equal(ctx.isMediaLocked({ platform: 'local', id: 'local_a' }), false, 'nothing is locked until the phone says so (computers, iPhones)');
});

test('PG-02: the phone says the permission is off: the songs the server marks become locked, and their rows show it', async () => {
  const urls = [];
  const { ctx, rows } = pageFns({ fetch: async (u) => { urls.push(u); return { ok: true, json: async () => lockedList }; } });
  await ctx.applyMediaAccess({ locked: true, canAsk: true });
  assert.deepEqual([...ctx.state.lockedIds].sort(), ['local_a', 'local_b']);
  assert.deepEqual(plain(ctx.state.mediaAccess), { locked: true, canAsk: true });
  assert.deepEqual(rows.map((r) => r.on), [true, true, false]);
  assert.deepEqual(urls, ['http://127.0.0.1:1/api/library?locked=1'], 'the marks are asked for; the plain list is not changed');
});

test('PG-03: the permission is back: every mark goes, and nothing is asked of the server', async () => {
  let asked = 0;
  const { ctx, rows } = pageFns({ fetch: async () => { asked++; return { ok: true, json: async () => lockedList }; } });
  await ctx.applyMediaAccess({ locked: true });
  asked = 0;
  await ctx.applyMediaAccess({ locked: false, canAsk: false });
  assert.equal(ctx.state.lockedIds.size, 0);
  assert.deepEqual(rows.map((r) => r.on), [false, false, false]);
  assert.equal(asked, 0);
  assert.equal(ctx.isMediaLocked({ platform: 'local', id: 'local_a' }), false);
});

test('PG-04: an answer that arrives late does not undo a newer one (locked, then unlocked before the list came back)', async () => {
  let release;
  const slow = new Promise((r) => { release = r; });
  const { ctx } = pageFns({ fetch: async () => { await slow; return { ok: true, json: async () => lockedList }; } });
  const first = ctx.applyMediaAccess({ locked: true });
  await ctx.applyMediaAccess({ locked: false });
  release();
  await first;
  assert.equal(ctx.state.lockedIds.size, 0, 'the permission is back; the old list must not lock anything');
  assert.equal(ctx.state.mediaAccess.locked, false);
});

test('PG-05: when the list cannot be had, the page does not break and locks nothing it cannot name', async () => {
  const { ctx } = pageFns({ fetch: async () => { throw new Error('offline'); } });
  await ctx.applyMediaAccess({ locked: true });
  assert.equal(ctx.state.mediaAccess.locked, true, 'the page still knows the permission is off');
  assert.equal(ctx.state.lockedIds.size, 0);
});

// ---- playTrack's guard (app.js) ----

test('PG-06: a locked song asked for never reaches the player: no queue, no history, no audio engine, and the prompt shows', async () => {
  const at = appSource.indexOf('async function playTrack(');
  assert.ok(at >= 0);
  const guard = 'if (isMediaLocked(track)) { promptMediaAccess(); return; }';
  const guardAt = appSource.indexOf(guard, at);
  assert.ok(guardAt > at && guardAt - at < 700, 'the guard is at the very top of playTrack');
  const between = appSource.slice(appSource.indexOf('{', at) + 1, guardAt).replace(/\/\/.*$/gm, '').trim();
  assert.equal(between, 'if (!track || !el.nativeAudio) return;', 'nothing else runs before it');
  // the top of the real function, then a marker that says "the player was reached"
  const top = `${appSource.slice(at, guardAt + guard.length)}\n throw new Error('REACHED_PLAYER');\n}`;
  let prompts = 0;
  const ctx = run(`${fn(appSource, 'isMediaLocked')}\n${top}`, { el: { nativeAudio: {} }, state: { lockedIds: new Set(['local_a']) }, promptMediaAccess: () => { prompts++; } });
  assert.equal(await ctx.playTrack({ platform: 'local', id: 'local_a', title: 'A' }, [], 0, null), undefined);
  assert.equal(prompts, 1);
  // a song that is not locked goes on to the player, exactly as before
  await assert.rejects(ctx.playTrack({ platform: 'local', id: 'local_c', title: 'C' }), /REACHED_PLAYER/);
  await assert.rejects(ctx.playTrack({ platform: 'youtube', id: 'local_a' }), /REACHED_PLAYER/);
  assert.equal(prompts, 1);
});

test('PG-07: a locked song that fails to load is not "missing" and is not skipped through: the prompt shows, the queue stays put', () => {
  const start = appSource.indexOf("el.nativeAudio.addEventListener('error', () => {");
  assert.ok(start >= 0);
  const open = appSource.indexOf('{', start);
  let depth = 0, end = open;
  for (let i = open; i < appSource.length; i++) {
    if (appSource[i] === '{') depth++;
    else if (appSource[i] === '}' && --depth === 0) { end = i; break; }
  }
  const handler = appSource.slice(start, end + 1);
  const calls = [];
  const make = (locked, track) => evalIn(`(function () { ${handler.replace("el.nativeAudio.addEventListener('error', ", 'return (')}) ; })`, {
    el: { nativeAudio: { src: 'blob:x' }, trackLoadingOverlay: null },
    state: { currentTrack: track, loadToken: 1, isPlaying: true, lockedIds: new Set(locked ? [track.id] : []) },
    hlsInstance: null,
    document: { body: { classList: { remove() {} } } },
    isMediaLocked: (t) => !!(t && t.platform === 'local' && locked),
    logPlaybackIssue: () => calls.push('log'),
    setTrackLoading: (on) => calls.push(`loading:${on}`),
    updatePlayPauseButton: () => calls.push('buttons'),
    promptMediaAccess: () => calls.push('PROMPT'),
    tryProxyFallback: () => { calls.push('proxy'); return false; },
    retryFresh: () => { calls.push('retry'); return false; },
    skipUnplayable: () => { calls.push('SKIP'); return false; },
    showToast: (m) => calls.push(`toast:${m.i18n || m}`),
    Tm: (s) => s,
  });
  const lockedSong = { platform: 'local', id: 'local_a', title: 'A' };
  make(true, lockedSong)()();
  assert.ok(calls.includes('PROMPT'));
  for (const bad of ['SKIP', 'proxy', 'retry', 'toast:File missing from library']) assert.equal(calls.includes(bad), false, `not ${bad}`);
  assert.ok(calls.includes('loading:false'), 'the loading state ends');
  // a library song that fails for another reason is handled exactly as before
  calls.length = 0;
  make(false, { platform: 'local', id: 'local_c', title: 'C' })()();
  assert.deepEqual(calls.filter((c) => c !== 'log' && c !== 'buttons'), ['proxy', 'retry', 'SKIP', 'toast:File missing from library']);
});

test('PG-08: the page wiring: rows are marked, the phone is asked at start and listened to, and it is phones with the API only', () => {
  assert.match(fn(appSource, 'createTrackRow'), /if \(isMediaLocked\(track\)\) row\.classList\.add\('is-locked'\);/);
  assert.match(appSource, /if \(isPhoneApp && window\.electronAPI && window\.electronAPI\.getMediaAccess\) \{/);
  for (const ev of ['muriel:media-access', 'muriel:media-permission-required']) assert.ok(appSource.includes(`window.addEventListener('${ev}'`), ev);
  assert.ok(appSource.includes("window.addEventListener('muriel:media-access', (e) => { applyMediaAccess(e.detail); });"));
  assert.match(read('mobile/mobile.css'), /html\.is-mobile \.track-row\.is-locked \{ opacity: 0\.5; \}/);
});

test('PG-09: the words of the prompt are in the translation list under exactly the text the dialog shows', () => {
  Module._load = ((load) => function (request, ...rest) {
    if (request === '@capacitor/core') return { Capacitor: { getPlatform: () => 'android', isNativePlatform: () => true, Plugins: {}, convertFileSrc: (u) => u } };
    if (request === '@capacitor/filesystem') return { Filesystem: {}, Directory: {}, Encoding: {} };
    if (request === '@capacitor/share') return { Share: {} };
    return load.call(this, request, ...rest);
  })(Module._load);
  const { MEDIA_PROMPT_TEXT } = require('../mobile/electron-api.js');
  assert.ok(appSource.includes(JSON.stringify(MEDIA_PROMPT_TEXT)), 'the long text');
  for (const s of ['Music access is off', 'Not now', 'Open app settings']) assert.ok(appSource.includes(`'${s}'`), s);
});

// ---- mobile/bridge.js: what the WebView is handed ----

function bridgeFns(over = {}) {
  const events = [];
  const fileUrls = new Map();
  const ctx = {
    fileUrls, events, URL, Object, JSON, Error,
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    window: { dispatchEvent: (e) => { events.push({ type: e.type, detail: e.detail }); return true; } },
    fs: { _flush: async () => {} },
    mimeOf: () => 'audio/mpeg',
    store: { MEDIA_PERMISSION_REQUIRED: 'MEDIA_PERMISSION_REQUIRED', isLinkedLocked: () => false, fileUrl: async (v) => `file://${v}` },
    call: async () => ({ status: 404, body: '' }),
    ...over,
  };
  run(`${fn(bridgeSource, 'fileUrlFor')}\n${fn(bridgeSource, 'resolveLocalUrl')}`, ctx);
  return ctx;
}

test('BR-01: a locked linked song gets no file URL, not even from the cache; a song kept in the app does', async () => {
  const lockedPaths = new Set();
  const ctx = bridgeFns({ store: { MEDIA_PERMISSION_REQUIRED: 'MEDIA_PERMISSION_REQUIRED', isLinkedLocked: (v) => lockedPaths.has(v), fileUrl: async (v) => `file://${v}` } });
  assert.equal(await ctx.fileUrlFor('/data/LocalMusic/a.mp3'), 'file:///data/LocalMusic/a.mp3');
  lockedPaths.add('/data/LocalMusic/a.mp3'); // taken back: the URL that worked a minute ago is cached, and must not be handed out
  await assert.rejects(ctx.fileUrlFor('/data/LocalMusic/a.mp3'), (e) => e.code === 'MEDIA_PERMISSION_REQUIRED');
  assert.equal(await ctx.fileUrlFor('/data/library/local_x.mp3'), 'file:///data/library/local_x.mp3');
  lockedPaths.clear();
  assert.equal(await ctx.fileUrlFor('/data/LocalMusic/a.mp3'), 'file:///data/LocalMusic/a.mp3', 'and back again');
});

test('BR-02: a refused file URL is not cached: asked again later (the permission given back), it is tried afresh', async () => {
  let fail = true;
  let tries = 0;
  const ctx = bridgeFns({ store: { MEDIA_PERMISSION_REQUIRED: 'X', isLinkedLocked: () => false, fileUrl: async (v) => { tries++; if (fail) throw new Error('refused'); return `file://${v}`; } } });
  await assert.rejects(ctx.fileUrlFor('/data/Downloads/a.mp3'), /refused/);
  await new Promise((r) => setImmediate(r));
  assert.equal(ctx.fileUrls.has('/data/Downloads/a.mp3'), false, 'the failure was not kept');
  fail = false;
  assert.equal(await ctx.fileUrlFor('/data/Downloads/a.mp3'), 'file:///data/Downloads/a.mp3');
  assert.equal(tries, 2);
  assert.equal(await ctx.fileUrlFor('/data/Downloads/a.mp3'), 'file:///data/Downloads/a.mp3');
  assert.equal(tries, 2, 'a URL that worked is still reused');
});

test('BR-03: the server says MEDIA_PERMISSION_REQUIRED: the page hears which song first, then the element gets its error; other failures are as before', async () => {
  const body = JSON.stringify({ success: false, error: 'MEDIA_PERMISSION_REQUIRED', code: 'MEDIA_PERMISSION_REQUIRED' });
  let ctx = bridgeFns({ call: async () => ({ status: 403, body }) });
  await assert.rejects(ctx.resolveLocalUrl('http://127.0.0.1:38472/api/library-file?id=local_a&t=tok'), (e) => e.code === 'MEDIA_PERMISSION_REQUIRED');
  assert.deepEqual(plain(ctx.events), [{ type: 'muriel:media-permission-required', detail: { id: 'local_a' } }]);

  ctx = bridgeFns({ call: async () => ({ status: 404, body: 'File not found in library' }) });
  await assert.rejects(ctx.resolveLocalUrl('http://127.0.0.1:38472/api/library-file?id=local_a'), (e) => e.code === undefined && /no file behind/.test(e.message));
  assert.deepEqual(ctx.events, [], 'missing is missing');
  ctx = bridgeFns({ call: async () => ({ status: 403, body: 'forbidden' }) });
  await assert.rejects(ctx.resolveLocalUrl('http://127.0.0.1:38472/api/x'), /no file behind/);
  assert.deepEqual(ctx.events, []);
  ctx = bridgeFns({ call: async () => ({ file: '/data/Downloads/a.mp3' }) });
  assert.equal(await ctx.resolveLocalUrl('http://127.0.0.1:38472/api/local-track?id=x'), 'file:///data/Downloads/a.mp3');
});

// ---- mobile/electron-api.js: the prompt ----

class El {
  constructor(tag) { this.tag = tag; this.style = {}; this.attrs = new Map(); this.children = []; this.listeners = {}; this.className = ''; this.textContent = ''; this.classes = new Set(); this.id = ''; }
  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  hasAttribute(k) { return this.attrs.has(k); }
  appendChild(c) { this.children.push(c); c.parent = this; return c; }
  append(...cs) { for (const c of cs) this.appendChild(c); }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  click() { for (const fn of this.listeners.click || []) fn({ target: this }); }
  remove() { this.removed = true; if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); }
  get classList() { return { add: (c) => this.classes.add(c), remove: (c) => this.classes.delete(c) }; }
  all() { return [this, ...this.children.flatMap((c) => c.all())]; }
}

let body, settingsOpened, audioGranted;
beforeEach(() => {
  body = new El('body');
  settingsOpened = 0;
  audioGranted = false;
  const media = { audioAccess: async () => ({ granted: audioGranted, canAsk: !audioGranted }), openAppSettings: async () => { settingsOpened++; return {}; }, allowAudioAccess: async () => ({}) };
  Module._load = ((load) => function (request, ...rest) {
    if (request === '@capacitor/core') return { Capacitor: { getPlatform: () => 'android', isNativePlatform: () => true, Plugins: { MurielMedia: media }, convertFileSrc: (u) => u } };
    if (request === '@capacitor/filesystem') return { Filesystem: {}, Directory: {}, Encoding: {} };
    if (request === '@capacitor/share') return { Share: {} };
    return load.call(this, request, ...rest);
  })(Module._load.__orig || Module._load);
  global.document = { body, createElement: (t) => new El(t), addEventListener() {}, hidden: false };
  global.window = { dispatchEvent: () => true };
  global.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } };
  global.requestAnimationFrame = (fn) => fn();
  for (const id of Object.keys(require.cache)) if (/mobile[\\/](electron-api|shims[\\/]store)\.js$/.test(id)) delete require.cache[id];
});

function openPrompt() {
  const electron = require('../mobile/electron-api.js')({ ready: Promise.resolve(), port: 1, fs: { _register() {}, _flush: async () => {} }, fileUrlFor: () => '' });
  const p = electron.promptMediaAccess();
  const wrap = body.children[body.children.length - 1];
  const els = wrap.all();
  return { electron, p, wrap, els, byId: (id) => els.find((e) => e.id === id) };
}

test('PR-01: the prompt says what is wrong, that nothing was removed, and offers the app\'s page in Settings or "Not now"', async () => {
  const { MEDIA_PROMPT_TEXT } = require('../mobile/electron-api.js');
  const ui = openPrompt();
  assert.equal(ui.wrap.className, 'modal-backdrop');
  assert.ok(ui.wrap.classes.has('visible'));
  const texts = ui.els.map((e) => e.textContent);
  assert.ok(texts.includes('Music access is off'));
  assert.ok(texts.includes(MEDIA_PROMPT_TEXT));
  assert.match(MEDIA_PROMPT_TEXT, /playlists and files are untouched/);
  assert.match(MEDIA_PROMPT_TEXT, /app settings/);
  assert.equal(ui.byId('btn-open-app-settings').textContent, 'Open app settings');
  assert.equal(ui.byId('btn-cancel-media-access').textContent, 'Not now');
  // the Android Back button presses the first element whose id starts with btn-cancel / btn-close (bridge.js)
  assert.match(ui.byId('btn-cancel-media-access').id, /^btn-cancel/);
  // every word the person reads goes through the translation system
  for (const e of ui.els.filter((x) => x.tag === 'h3' || x.tag === 'p' || x.tag === 'button')) assert.equal(e.hasAttribute('data-i18n'), true, e.textContent);
  ui.byId('btn-cancel-media-access').click();
  assert.equal(await ui.p, null);
});

test('PR-02: "Open app settings" opens the app\'s page in Settings, and the prompt is done', async () => {
  const ui = openPrompt();
  ui.byId('btn-open-app-settings').click();
  assert.equal(await ui.p, 'settings');
  assert.equal(settingsOpened, 1);
  assert.equal(ui.wrap.classes.has('visible'), false);
});

test('PR-03: "Not now" (or a tap outside) closes it and opens nothing', async () => {
  let ui = openPrompt();
  ui.byId('btn-cancel-media-access').click();
  assert.equal(await ui.p, null);
  ui = openPrompt();
  ui.wrap.listeners.click.forEach((fn) => fn({ target: ui.wrap }));
  assert.equal(await ui.p, null);
  assert.equal(settingsOpened, 0);
});

test('PR-04: only one prompt at a time, however many locked songs are asked for', async () => {
  const electron = require('../mobile/electron-api.js')({ ready: Promise.resolve(), port: 1, fs: { _register() {}, _flush: async () => {} }, fileUrlFor: () => '' });
  const a = electron.promptMediaAccess();
  const b = electron.promptMediaAccess();
  const c = electron.promptMediaAccess();
  assert.equal(a, b);
  assert.equal(b, c);
  assert.equal(body.children.length, 1);
  body.children[0].all().find((e) => e.id === 'btn-cancel-media-access').click();
  await a;
  const again = electron.promptMediaAccess();
  assert.notEqual(again, a, 'once closed, the next locked song asks again');
});

test('PR-05: the prompt closes by itself when the permission is back (the person turned it on in Settings and came back)', async () => {
  const ui = openPrompt();
  audioGranted = false;
  assert.equal((await ui.electron.getMediaAccess()).locked, true);
  let settled = false;
  ui.p.then(() => { settled = true; });
  await new Promise((r) => setImmediate(r));
  assert.equal(settled, false, 'still off: it stays');
  audioGranted = true;
  assert.equal((await ui.electron.getMediaAccess()).locked, false);
  assert.equal(await ui.p, null);
  assert.equal(ui.wrap.classes.has('visible'), false);
});
