'use strict';

// UI language: which strings i18n.js sends, and server.js /api/i18n-batch (batched, cached on disk and in memory,
// English free). The translate service is a local stand-in; nothing touches the network or the real data dir.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');

const I18n = require('../i18n');

test('only Muriel\'s own words are worth translating', () => {
  for (const s of ['Play next', 'Add to queue', 'No playlists yet. Create one first.', '{0} songs']) assert.equal(I18n.translatable(s), true, s);
  for (const s of ['', ' ', 'x', '100%', '0:00', '1.25x', '-6 dB', '44.1 kHz', 'FLAC', 'HQ', 'v1.2.9', 'https://example.com/a', 'Ctrl+K',
    'Muriel', 'YouTube Music', 'SoundCloud', 'me@example.com', 'a'.repeat(501)]) assert.equal(I18n.translatable(s), false, s);
});

test('a translation must keep every placeholder', () => {
  assert.equal(I18n.pick('{0} songs', '{0} Lieder'), '{0} Lieder');
  assert.equal(I18n.pick('{0} songs', '{ 0 } Lieder'), '{0} Lieder');
  assert.equal(I18n.pick('{0} songs', 'Lieder'), null);
  assert.equal(I18n.pick('Added {0} to {1}', '{1}: {0} hinzugefügt'), '{1}: {0} hinzugefügt');
  assert.equal(I18n.pick('Play', ''), null);
  assert.equal(I18n.pick('Play', null), null);
  assert.equal(I18n.pick('Play', 'x'.repeat(200)), null);
  assert.equal(I18n.fill('{0} songs in {1}', [12, 'Road trip']), '12 songs in Road trip');
  assert.equal(I18n.fill('<b>{0}</b>', ['<i>']), '<b><i></b>', 'filling never escapes or interprets: it goes into textContent');
  assert.equal(I18n.keepSpace('\n   Play  ', 'Abspielen'), '\n   Abspielen  ');
});

test('numbers on the page become slots, so counts share one translation and never leave the device', () => {
  assert.deepEqual(I18n.numbered('12 tracks'), { template: '{0} tracks', args: ['12'] });
  assert.deepEqual(I18n.numbered('0 / 0 lines synced'), { template: '{0} / {1} lines synced', args: ['0', '0'] });
  assert.deepEqual(I18n.numbered('Version 1.2.9'), { template: 'Version {0}', args: ['1.2.9'] });
  assert.equal(I18n.numbered('Play next'), null);
  assert.equal(I18n.numbered('{0} songs'), null, 'a template from code is left alone');
  assert.equal(I18n.translatable(I18n.numbered('12.3 MB').template), false);
  assert.equal(I18n.translatable(I18n.numbered('3:45').template), false);
});

test('the language is per profile, the quick-start copy of its words belongs to the device', () => {
  const P = require('../profiles-core');
  assert.equal(P.isDevice(I18n.KEY), false);
  assert.equal(P.isDevice(I18n.SNAP), true);
});

test('i18n.js loads before app.js, after profiles-core.js, on desktop and phones', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const at = (f) => html.indexOf(`<script src="${f}"></script>`);
  assert.ok(at('profiles-core.js') >= 0 && at('profiles-core.js') < at('i18n.js') && at('i18n.js') < at('app.js'));
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'mobile', 'build.mjs'), 'utf8'), /'i18n\.js'/);
});

test('language codes and right-to-left languages', () => {
  assert.equal(I18n.normLang('de'), 'de');
  assert.equal(I18n.normLang('zh-CN'), 'zh-CN');
  assert.equal(I18n.normLang('mni-Mtei'), 'mni-Mtei');
  assert.equal(I18n.normLang('../../etc'), 'en');
  assert.equal(I18n.normLang(''), 'en');
  for (const c of ['ar', 'he', 'fa', 'ur', 'ckb']) assert.equal(I18n.isRtl(c), true, c);
  for (const c of ['de', 'en', 'zh-CN', 'ku']) assert.equal(I18n.isRtl(c), false, c);
});

// ---------- the server ----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'muriel-i18n-'));
for (const key of ['HOME', 'USERPROFILE', 'LOCALAPPDATA', 'XDG_CONFIG_HOME']) process.env[key] = tmp;
process.env.MURIEL_DATA_DIR = path.join(tmp, 'data');

// the translate service: upper-cases each line and puts the language in front; `mode` breaks it on purpose
let mode = 'ok';
const asked = []; // the text of every request it got
const service = http.createServer((req, res) => {
  const target = new URL(new URL(req.url, 'http://x').searchParams.get('u'));
  if (target.hostname !== 'translate.googleapis.com') { res.writeHead(404); return res.end(); }
  const text = target.searchParams.get('q');
  const tl = target.searchParams.get('tl');
  asked.push(text);
  if (mode === 'down') return req.socket.destroy();
  let lines = text.split('\n').map((l) => (l === 'Bloat' ? 'x'.repeat(400) : `${tl}:${l.toUpperCase()}`));
  // merges every second line into the one before, the way a real service sometimes does with short lines
  if (mode === 'merge' && lines.length > 1) lines = [lines.slice(0, 2).join(' '), ...lines.slice(2)];
  const out = lines.join('\n');
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify([[[out, text, null, null]]]));
});
https.get = (target, opts, cb) => {
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  return http.get(`http://127.0.0.1:${service.address().port}/?u=${encodeURIComponent(String(target))}`, opts || {}, cb);
};

const { startServer, stopServer, getServerToken } = require('../server');
let port;
before(async () => {
  await new Promise((resolve) => service.listen(0, '127.0.0.1', resolve));
  port = await startServer(0);
});
after(async () => {
  await stopServer();
  service.closeAllConnections();
  await new Promise((resolve) => service.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
});

function call(method, route, body, token = getServerToken()) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: route, headers: { 'Content-Type': 'application/json', ...(token ? { 'x-muriel-token': token } : {}) } }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => { let json = null; try { json = JSON.parse(b); } catch (e) {} resolve({ status: res.statusCode, json }); });
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
const batch = (target, texts) => call('POST', '/api/i18n-batch', { target, texts });
const saved = (lang) => { try { return JSON.parse(fs.readFileSync(path.join(process.env.MURIEL_DATA_DIR, 'i18n', `${lang}.json`), 'utf8')); } catch (e) { return null; } };

test('English costs nothing', async () => {
  const before = asked.length;
  const r = await batch('en', ['Play next', 'Add to queue']);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.translations, ['Play next', 'Add to queue']);
  assert.equal(asked.length, before);
  assert.equal(saved('en'), null);
});

test('needs the token and a real language code', async () => {
  assert.equal((await call('POST', '/api/i18n-batch', { target: 'de', texts: ['Play'] }, null)).status, 403);
  for (const target of ['../../x', 'de/../../x', '', 'toolonglanguage']) {
    const r = await batch(target, ['Play']);
    assert.equal(r.status, 400, target);
  }
  assert.equal(fs.existsSync(path.join(process.env.MURIEL_DATA_DIR, 'x.json')), false);
});

test('translates many strings in one request and keeps them on disk', async () => {
  const before = asked.length;
  const r = await batch('de', ['Play next', 'Add to queue', '  Play   next ', '', 42, 'x'.repeat(600)]);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.translations, ['de:PLAY NEXT', 'de:ADD TO QUEUE', 'de:PLAY NEXT', null, null, null]);
  assert.equal(r.json.complete, true);
  assert.equal(asked.length - before, 1, 'one request for the batch');
  assert.deepEqual(saved('de'), { 'Play next': 'de:PLAY NEXT', 'Add to queue': 'de:ADD TO QUEUE' });

  // known strings come from the cache
  const again = await batch('de', ['Add to queue', 'Play next']);
  assert.deepEqual(again.json.translations, ['de:ADD TO QUEUE', 'de:PLAY NEXT']);
  assert.equal(asked.length - before, 1, 'nothing new asked');

  // everything at once, for the start
  const all = await call('GET', '/api/i18n-batch?target=de');
  assert.deepEqual(all.json.translations, { 'Play next': 'de:PLAY NEXT', 'Add to queue': 'de:ADD TO QUEUE' });
  assert.deepEqual((await call('GET', '/api/i18n-batch?target=en')).json.translations, {});
});

test('two requests for the same strings translate them once', async () => {
  const before = asked.length;
  const texts = ['Shuffle', 'Repeat', 'Sleep timer'];
  const [a, b] = await Promise.all([batch('es', texts), batch('es', texts)]);
  assert.deepEqual(a.json.translations, ['es:SHUFFLE', 'es:REPEAT', 'es:SLEEP TIMER']);
  assert.deepEqual(b.json.translations, a.json.translations);
  assert.equal(asked.length - before, 1);
});

test('lines that come back merged are retried in halves, not one by one', async () => {
  mode = 'merge';
  const before = asked.length;
  const texts = ['One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight'];
  const r = await batch('fr', texts);
  mode = 'ok';
  // a line never gets its neighbour's translation: every string is either its own or not translated
  r.json.translations.forEach((v, i) => assert.ok(v === null || v === `fr:${texts[i].toUpperCase()}`, `${texts[i]} -> ${v}`));
  assert.ok(r.json.translations.filter(Boolean).length >= 4);
  assert.ok(asked.length - before < texts.length * 2, `${asked.length - before} requests`);
});

test('when the service is down nothing is cached and the app is told', async () => {
  mode = 'down';
  const r = await batch('it', ['Play next', 'Lyrics']);
  mode = 'ok';
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.translations, [null, null]);
  assert.equal(r.json.complete, false);
  assert.equal(saved('it'), null);
  // and it works once the service is back
  const ok = await batch('it', ['Play next', 'Lyrics']);
  assert.deepEqual(ok.json.translations, ['it:PLAY NEXT', 'it:LYRICS']);
});

test('an answer that is no use is dropped, without making the app wait a minute', async () => {
  const r = await batch('nl', ['Bloat', 'Fine']);
  assert.deepEqual(r.json.translations, [null, 'nl:FINE']);
  assert.equal(r.json.complete, true);
  assert.deepEqual(saved('nl'), { Fine: 'nl:FINE' });
});

test('a translation keeps placeholders and is never HTML', async () => {
  const r = await batch('pt', ['{0} songs', '<b>Bold</b> & co']);
  assert.deepEqual(r.json.translations, ['pt:{0} SONGS', 'pt:<B>BOLD</B> & CO']);
  // the client only uses a translation that kept its placeholders; the text goes into textContent as it is
  assert.equal(I18n.pick('{0} songs', r.json.translations[0]), 'pt:{0} SONGS');
});

test('MurielI18n.lang follows setLang (it used to stay at the startup language, so picking English again did nothing, #20)', async () => {
  const vm = require('node:vm');
  const store = new Map();
  const ctx = { localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) },
    document: { body: null, documentElement: { classList: { toggle() {} } } }, setTimeout, clearTimeout, console };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'i18n.js'), 'utf8').replace(/typeof window !== 'undefined' \? window : globalThis/, 'window'), ctx);
  const api = ctx.MurielI18n;
  assert.equal(api.lang, 'en');
  api.setLang('de');
  assert.equal(api.lang, 'de');
  await api.setLang('en');
  assert.equal(api.lang, 'en');
  assert.equal(store.get(I18n.KEY), 'en');
  assert.equal(api.T('Settings'), 'Settings');
});
