'use strict';

// profiles-core.js: each profile is its own set of localStorage keys, the first one keeps the plain keys.
const test = require('node:test');
const assert = require('node:assert');
const P = require('../profiles-core.js');

// the real localStorage, as profiles-core.js reaches it
const over = (m) => ({ get: (k) => (m.has(k) ? m.get(k) : null), set: (k, v) => { m.set(k, String(v)); }, remove: (k) => { m.delete(k); }, keys: () => [...m.keys()] });
const memory = (init = {}) => over(new Map(Object.entries(init)));

// a page with Storage, localStorage and sessionStorage, close enough to a browser's for install()
function fakeWindow(init = {}) {
  const data = new WeakMap();
  class Storage {}
  const S = Storage.prototype;
  const m = (s) => { if (!data.has(s)) throw new TypeError('Illegal invocation'); return data.get(s); };
  S.getItem = function (k) { const d = m(this); k = String(k); return d.has(k) ? d.get(k) : null; };
  S.setItem = function (k, v) { m(this).set(String(k), String(v)); };
  S.removeItem = function (k) { m(this).delete(String(k)); };
  S.key = function (i) { const ks = [...m(this).keys()]; return i < ks.length ? ks[i] : null; };
  S.clear = function () { m(this).clear(); };
  Object.defineProperty(S, 'length', { configurable: true, enumerable: true, get() { return m(this).size; } });
  const make = (entries) => { const s = new Storage(); data.set(s, new Map(Object.entries(entries))); return s; };
  const win = { Storage, localStorage: make(init), sessionStorage: make({}) };
  win.raw = data.get(win.localStorage);
  return win;
}

test('the first profile is today\'s data: plain keys, nothing moved', () => {
  const store = memory({ devsize_playlists: '[{"id":"p1"}]', muriel_theme_mode: 'light' });
  assert.deepStrictEqual(P.list(store).map((p) => p.id), ['default']);
  assert.strictEqual(P.activeId(store), 'default');
  const v = P.view(store, 'default');
  assert.strictEqual(v.getItem('devsize_playlists'), '[{"id":"p1"}]');
  v.setItem('devsize_favorites', '[]');
  assert.strictEqual(store.get('devsize_favorites'), '[]');
  assert.deepStrictEqual(v.keys().sort(), ['devsize_favorites', 'devsize_playlists', 'muriel_theme_mode']);
});

test('another profile keeps its keys under its own prefix and starts empty', () => {
  const store = memory({ devsize_playlists: '[{"id":"p1"}]', muriel_theme_mode: 'light' });
  const b = P.create(store, { name: '  Hasan  ' });
  assert.strictEqual(b.name, 'Hasan');
  assert.match(b.id, /^[a-z0-9]{8}$/);
  const v = P.view(store, b.id);
  assert.strictEqual(v.getItem('devsize_playlists'), null);
  assert.strictEqual(v.getItem('muriel_theme_mode'), null);
  v.setItem('devsize_playlists', '[{"id":"p2"}]');
  assert.strictEqual(store.get(`muriel_p:${b.id}:devsize_playlists`), '[{"id":"p2"}]');
  // the first profile's playlists are untouched
  assert.strictEqual(store.get('devsize_playlists'), '[{"id":"p1"}]');
  assert.strictEqual(P.view(store, 'default').getItem('devsize_playlists'), '[{"id":"p1"}]');
  v.removeItem('devsize_playlists');
  assert.strictEqual(store.get(`muriel_p:${b.id}:devsize_playlists`), null);
});

test('device settings are shared by every profile', () => {
  const store = memory({ muriel_perf_mode: '1', muriel_debug_log: '["x"]' });
  const b = P.create(store, { name: 'B' });
  const vb = P.view(store, b.id);
  assert.strictEqual(vb.getItem('muriel_perf_mode'), '1');
  vb.setItem('muriel_tray_on_close', 'false');
  vb.setItem('muriel_audio_analysis_abc', '{"bpm":120}');
  assert.strictEqual(store.get('muriel_tray_on_close'), 'false');
  assert.strictEqual(P.view(store, 'default').getItem('muriel_tray_on_close'), 'false');
  assert.strictEqual(P.view(store, 'default').getItem('muriel_audio_analysis_abc'), '{"bpm":120}');
  // the sync group is the person's, not the device's
  assert.ok(!P.isDevice('muriel_sync_device') && !P.isDevice('muriel_sync_group'));
  assert.ok(P.isDevice(P.LIST) && P.isDevice(P.ACTIVE));
});

test('key(), length and clear() see only the open profile (and the device)', () => {
  const store = memory({ devsize_history: '[]', muriel_volume: '0.5', muriel_perf_mode: '1' });
  const b = P.create(store, { name: 'B' });
  const c = P.create(store, { name: 'C' });
  P.view(store, c.id).setItem('devsize_favorites', '[1]');
  const vb = P.view(store, b.id);
  vb.setItem('devsize_playlists', '[]');
  vb.setItem('muriel_volume', '0.9');
  assert.deepStrictEqual(vb.keys().sort(), ['devsize_playlists', 'muriel_perf_mode', 'muriel_profiles', 'muriel_volume']);
  assert.strictEqual(vb.length, 4);
  const listed = [];
  for (let i = 0; i < vb.length; i++) listed.push(vb.key(i));
  assert.deepStrictEqual(listed.sort(), vb.keys().sort());
  assert.strictEqual(vb.key(99), null);
  // the first profile doesn't see B's or C's keys
  assert.deepStrictEqual(P.view(store, 'default').keys().sort(), ['devsize_history', 'muriel_perf_mode', 'muriel_profiles', 'muriel_volume']);

  vb.clear();
  assert.deepStrictEqual(vb.keys().sort(), ['muriel_perf_mode', 'muriel_profiles']);
  assert.strictEqual(store.get('muriel_volume'), '0.5');
  assert.strictEqual(store.get(`muriel_p:${c.id}:devsize_favorites`), '[1]');
  assert.deepStrictEqual(P.list(store).map((p) => p.name), ['Me', 'B', 'C']);

  P.view(store, 'default').clear();
  assert.strictEqual(store.get('devsize_history'), null);
  assert.strictEqual(store.get('muriel_perf_mode'), '1');
  assert.strictEqual(store.get(`muriel_p:${c.id}:devsize_favorites`), '[1]');
});

test('deleting a profile removes everything in it; the open one can\'t be deleted', () => {
  const store = memory({ devsize_playlists: '[1]', muriel_cache_limit_mb: '1024' });
  const b = P.create(store, { name: 'B' });
  P.view(store, b.id).setItem('devsize_playlists', '[2]');
  P.view(store, b.id).setItem('muriel_sync_group', '{"id":"g"}');
  assert.strictEqual(P.remove(store, b.id, b.id), false);
  assert.strictEqual(P.remove(store, b.id, 'default'), true);
  assert.deepStrictEqual(store.keys().filter((k) => k.startsWith('muriel_p:')), []);
  assert.deepStrictEqual(P.list(store).map((p) => p.id), ['default']);
  assert.strictEqual(store.get('devsize_playlists'), '[1]');
  // the last profile stays
  assert.strictEqual(P.remove(store, 'default', 'nobody'), false);
});

test('the first profile can be deleted from another one: its plain keys go, the device\'s stay', () => {
  const store = memory({ devsize_playlists: '[1]', muriel_theme_mode: 'light', muriel_perf_mode: '1' });
  const b = P.create(store, { name: 'B' });
  P.view(store, b.id).setItem('devsize_playlists', '[2]');
  P.setActive(store, b.id);
  assert.strictEqual(P.remove(store, 'default', b.id), true);
  assert.deepStrictEqual(store.keys().sort(), [P.ACTIVE, P.LIST, `muriel_p:${b.id}:devsize_playlists`, 'muriel_perf_mode'].sort());
  assert.deepStrictEqual(P.list(store).map((p) => p.id), [b.id]);
  assert.strictEqual(P.activeId(store), b.id);
});

test('profiles: names, colors, switching, a lost list', () => {
  const store = memory();
  const a = P.create(store, {});
  const b = P.create(store, { name: 'x'.repeat(60), color: '#123abc', emoji: '🎧' });
  assert.strictEqual(a.name, 'Profile 2');
  assert.strictEqual(b.name.length, 24);
  assert.strictEqual(b.color, '#123ABC');
  assert.notStrictEqual(a.color, P.list(store)[0].color);
  assert.notStrictEqual(a.id, b.id);
  assert.strictEqual(P.update(store, a.id, { name: 'Kids', emoji: '🦊', color: 'red' }).name, 'Kids');
  assert.strictEqual(P.list(store)[1].emoji, '🦊');
  assert.strictEqual(P.list(store)[1].color, a.color);
  assert.strictEqual(P.update(store, a.id, { name: '   ' }).name, 'Kids');
  // what else is stored with a profile stays (an account it is signed in to, later)
  store.set(P.LIST, JSON.stringify(P.list(store).map((p) => (p.id === a.id ? { ...p, account: { provider: 'google', sub: '42' } } : p))));
  P.update(store, a.id, { name: 'Kids 2' });
  assert.deepStrictEqual(P.list(store)[1].account, { provider: 'google', sub: '42' });
  assert.strictEqual(P.list(store)[1].id, a.id);
  assert.strictEqual(P.setActive(store, 'nope'), false);
  assert.strictEqual(P.setActive(store, a.id), true);
  assert.strictEqual(P.activeId(store), a.id);
  // a profile whose things are stored but which fell off the list comes back
  P.view(store, b.id).setItem('devsize_favorites', '[]');
  store.set(P.LIST, JSON.stringify([{ id: 'default', name: 'Me' }]));
  assert.ok(P.list(store).some((p) => p.id === b.id));
  assert.strictEqual(P.activeId(store), 'default');
});

test('install(): localStorage shows the open profile, and later Storage patches see the app\'s keys', () => {
  const win = fakeWindow({ devsize_playlists: '[1]', muriel_perf_mode: '1' });
  const b = P.create(over(win.raw), { name: 'Hasan' });
  P.setActive(over(win.raw), b.id);

  const api = P.install(win);
  assert.strictEqual(api.id, b.id);
  assert.strictEqual(P.install(win), api);
  const ls = win.localStorage;
  // like sync.js: wraps setItem after install and only counts writes to localStorage
  const rawSet = win.Storage.prototype.setItem;
  const seen = [];
  win.Storage.prototype.setItem = function (k, v) { const r = rawSet.call(this, k, v); if (this === win.localStorage) seen.push(k); return r; };

  assert.strictEqual(ls.getItem('devsize_playlists'), null);
  ls.setItem('devsize_playlists', '[2]');
  assert.deepStrictEqual(seen, ['devsize_playlists']);
  assert.strictEqual(win.raw.get(`muriel_p:${b.id}:devsize_playlists`), '[2]');
  assert.strictEqual(win.raw.get('devsize_playlists'), '[1]');
  assert.strictEqual(ls.getItem('muriel_perf_mode'), '1');
  assert.strictEqual(ls.devsize_playlists, '[2]');
  assert.strictEqual(ls.nothing, undefined);
  assert.deepStrictEqual(Object.keys(ls).sort(), ['devsize_playlists', 'muriel_perf_mode', 'muriel_profile_active', 'muriel_profiles']);
  assert.strictEqual(ls.length, 4);
  assert.ok(ls instanceof win.Storage);
  ls.muriel_volume = '0.3';
  assert.strictEqual(win.raw.get(`muriel_p:${b.id}:muriel_volume`), '0.3');
  delete ls.muriel_volume;
  assert.strictEqual(ls.getItem('muriel_volume'), null);
  // sessionStorage is left alone
  win.sessionStorage.setItem('muriel_tools_prompt_dismissed', '1');
  assert.strictEqual(win.sessionStorage.getItem('muriel_tools_prompt_dismissed'), '1');
  assert.strictEqual(win.sessionStorage.length, 1);

  ls.clear();
  assert.strictEqual(win.raw.get('devsize_playlists'), '[1]');
  assert.strictEqual(win.raw.get('muriel_perf_mode'), '1');
  assert.strictEqual(win.raw.has(`muriel_p:${b.id}:devsize_playlists`), false);

  // switching takes effect with the next load: until then this page keeps writing to its own profile
  assert.strictEqual(api.open('default'), true);
  ls.setItem('muriel_queue_state', '{}');
  assert.strictEqual(win.raw.get(`muriel_p:${b.id}:muriel_queue_state`), '{}');
  assert.strictEqual(api.peek('default', 'devsize_playlists'), '[1]');
  assert.strictEqual(api.remove(b.id), false);
});
