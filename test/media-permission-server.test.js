'use strict';

// The music permission taken back (phones, Android 11+): the songs linked in place are LOCKED. They stay in the library and in
// every playlist and nothing is unlinked or deleted for it, but they are not served: the server answers
// MEDIA_PERMISSION_REQUIRED, which the page turns into "allow access" instead of a song that fails to load.
// server.js is the real one. platform.js is the computer's, so the test plays the part of the phone's shim
// (mobile/shims/platform.js): LOCAL_LINK_DIR is a real folder here, and linkedAccessLocked is what the storage shim answers.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'piverxy-perm-'));
for (const key of ['HOME', 'USERPROFILE', 'LOCALAPPDATA', 'XDG_CONFIG_HOME']) process.env[key] = tmp;
const DATA = path.join(tmp, 'data');
process.env.PIVERXY_DATA_DIR = DATA;
const LINK = path.join(tmp, 'LocalMusic');
fs.mkdirSync(path.join(LINK, 'Road trip'), { recursive: true });
fs.mkdirSync(path.join(DATA, 'library'), { recursive: true });
const platform = require('../platform');
platform.LOCAL_LINK_DIR = LINK;
let locked = false;
platform.linkedAccessLocked = () => locked;

const { startServer, stopServer, getServerToken } = require('../server');

const BYTES = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz');
const songA = path.join(LINK, 'Road trip', '01 - Artist One - First song.mp3');
const songB = path.join(LINK, 'loose.flac');
fs.writeFileSync(songA, BYTES);
fs.writeFileSync(songB, BYTES);
const idA = 'local_aaaaaaaaaaaa';
const idB = 'local_bbbbbbbbbbbb';
const idImported = 'local_111111111111';
fs.writeFileSync(path.join(DATA, 'library', `${idImported}.mp3`), BYTES);
const libraryJson = () => fs.readFileSync(path.join(DATA, 'library.json'), 'utf8');

let port;
before(async () => { port = await startServer(0); });
after(async () => { await stopServer(); fs.rmSync(tmp, { recursive: true, force: true }); });

function call(method, route, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: route, method, headers: { 'x-piverxy-token': getServerToken(), ...(data ? { 'Content-Type': 'application/json' } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(raw.toString()); } catch (_) {}
        resolve({ status: res.statusCode, raw, json, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

let before_;  // the library as it was with the permission on

test('SRV-01: permission granted: songs are linked, and a linked song plays from where it is (whole, and by range)', async () => {
  await call('POST', '/api/library-add', { items: [{ id: idImported, file: `${idImported}.mp3`, name: 'Imported' }] });
  const r = await call('POST', '/api/library-link', { items: [{ id: idA, path: songA, name: '01 - Artist One - First song' }, { id: idB, path: songB, name: 'loose' }] });
  assert.equal(r.json.count, 2);
  before_ = (await call('GET', '/api/library')).json;
  assert.equal(before_.length, 3);
  const whole = await call('GET', `/api/library-file?id=${idA}`);
  assert.equal(whole.status, 200);
  assert.deepEqual(whole.raw, BYTES);
  const part = await call('GET', `/api/library-file?id=${idA}`, undefined, { Range: 'bytes=2-5' });
  assert.equal(part.status, 206);
  assert.equal(part.raw.toString(), '2345');
});

test('SRV-02: permission taken back: a linked song is refused with MEDIA_PERMISSION_REQUIRED (403, JSON), not "not found"', async () => {
  locked = true;
  for (const id of [idA, idB]) {
    const r = await call('GET', `/api/library-file?id=${id}`);
    assert.equal(r.status, 403);
    assert.match(r.headers['content-type'], /application\/json/);
    assert.equal(r.json.code, 'MEDIA_PERMISSION_REQUIRED');
    assert.equal(r.json.error, 'MEDIA_PERMISSION_REQUIRED');
    assert.equal(r.json.success, false);
    assert.match(r.json.message, /permission/i);
  }
  // a range request (what the audio element sends) gets the same answer, never a half-served file
  assert.equal((await call('GET', `/api/library-file?id=${idA}`, undefined, { Range: 'bytes=0-9' })).status, 403);
  // a song that is not in the library is still just not found
  assert.equal((await call('GET', '/api/library-file?id=local_000000000000')).status, 404);
  assert.equal(fs.existsSync(songA) && fs.existsSync(songB), true, 'the files are where they were');
});

test('SRV-03: permission taken back: the library list is exactly what it was; asked for, it marks the linked songs and keeps their metadata', async () => {
  const plain = (await call('GET', '/api/library')).json;
  assert.deepEqual(plain, before_, 'every caller that does not ask gets the list as it always was (it is copied into playlists, which are saved)');
  const marked = (await call('GET', '/api/library?locked=1')).json;
  assert.deepEqual(marked.filter((t) => t.locked).map((t) => t.id).sort(), [idA, idB]);
  assert.equal(marked.find((t) => t.id === idImported).locked, undefined, 'a song inside the app is not locked');
  const strip = (list) => list.map(({ locked: _l, ...t }) => t);
  assert.deepEqual(strip(marked), before_, 'apart from the mark, nothing about a song changed: title, artist, length, cover');
  assert.equal(marked.length, 3, 'none was dropped from the list');
});

test('SRV-04: permission taken back: a song kept inside the app still plays', async () => {
  const r = await call('GET', `/api/library-file?id=${idImported}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.raw, BYTES);
});

test('SRV-05: permission taken back: a rescan cannot forget the songs it could not see; nothing is unlinked or deleted', async () => {
  const jsonBefore = libraryJson();
  // what a rescan sends: what it saw is `keep`. With the permission off it saw nothing.
  let r = await call('POST', '/api/library-unlink', { keep: [] });
  assert.equal(r.status, 403);
  assert.equal(r.json.code, 'MEDIA_PERMISSION_REQUIRED');
  r = await call('POST', '/api/library-unlink', { keep: [idImported] });
  assert.equal(r.status, 403);
  assert.equal(libraryJson(), jsonBefore, 'library.json is untouched');
  assert.deepEqual((await call('GET', '/api/library')).json.map((t) => t.id).sort(), [idA, idB, idImported].sort());
  assert.equal(fs.existsSync(songA) && fs.existsSync(songB) && fs.existsSync(path.join(DATA, 'library', `${idImported}.mp3`)), true);
});

test('SRV-06: permission given again: the same song plays again, byte for byte, and the list carries no mark', async () => {
  locked = false;
  const whole = await call('GET', `/api/library-file?id=${idA}`);
  assert.equal(whole.status, 200);
  assert.deepEqual(whole.raw, BYTES);
  assert.equal((await call('GET', `/api/library-file?id=${idB}`)).status, 200);
  const list = (await call('GET', '/api/library?locked=1')).json;
  assert.equal(list.some((t) => t.locked), false);
  assert.deepEqual(list, before_);
});

test('SRV-07: the whole cycle (granted, taken back, given again) leaves library.json as it was, and no playlist-relevant record changed', async () => {
  const snapshot = libraryJson();
  for (let n = 0; n < 3; n++) {
    locked = true;
    await call('GET', `/api/library-file?id=${idA}`);
    await call('GET', '/api/library?locked=1');
    await call('POST', '/api/library-unlink', { keep: [] });
    locked = false;
    assert.equal((await call('GET', `/api/library-file?id=${idA}`)).status, 200);
  }
  assert.equal(libraryJson(), snapshot);
});

test('SRV-08: while locked, linking is unaffected and forgetting everything on purpose (no keep: the download folder changed) is still the person\'s own doing', async () => {
  locked = true;
  // no `keep`: what the app sends when the download folder was changed on purpose, not what a scan sends
  const r = await call('POST', '/api/library-unlink', {});
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.ids.sort(), [idA, idB].sort());
  assert.equal(fs.existsSync(songA) && fs.existsSync(songB), true, 'the files are never deleted, either way');
  assert.deepEqual((await call('GET', '/api/library')).json.map((t) => t.id), [idImported]);
  locked = false;
});

test('SRV-09: a computer or an iPhone has no such hook: nothing is ever locked there', async () => {
  await call('POST', '/api/library-link', { items: [{ id: idA, path: songA, name: '01 - Artist One - First song' }] });
  const saved = platform.linkedAccessLocked;
  try {
    delete platform.linkedAccessLocked;
    assert.equal((await call('GET', `/api/library-file?id=${idA}`)).status, 200);
    assert.equal((await call('GET', '/api/library?locked=1')).json.some((t) => t.locked), false);
    assert.equal((await call('POST', '/api/library-unlink', { keep: [idA] })).status, 200);
    await call('POST', '/api/library-link', { items: [{ id: idA, path: songA, name: '01 - Artist One - First song' }] });
    // a hook that fails says nothing: the songs are served as they always were
    platform.linkedAccessLocked = () => { throw new Error('boom'); };
    assert.equal((await call('GET', `/api/library-file?id=${idA}`)).status, 200);
  } finally { platform.linkedAccessLocked = saved; }
});
