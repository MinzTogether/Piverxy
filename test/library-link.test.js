'use strict';

// Songs linked in place (phones: the folders next to the download folder). /api/library-link adds them to the
// library without copying; they play from where they are, and Piverxy never deletes the files.
// platform.js is the computer's; LOCAL_LINK_DIR is what the phone's shim (mobile/shims/platform.js) sets, so the test sets it
// here, before server.js is loaded, to a real folder of this machine.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'piverxy-link-'));
for (const key of ['HOME', 'USERPROFILE', 'LOCALAPPDATA', 'XDG_CONFIG_HOME']) process.env[key] = tmp;
process.env.PIVERXY_DATA_DIR = path.join(tmp, 'data');
const LINK = path.join(tmp, 'LocalMusic');
fs.mkdirSync(path.join(LINK, 'Road trip'), { recursive: true });
require('../platform').LOCAL_LINK_DIR = LINK;
// a library.json record somebody edited by hand to point at another file on the phone
const evil = 'local_999999999999';
fs.mkdirSync(process.env.PIVERXY_DATA_DIR, { recursive: true });
fs.writeFileSync(path.join(process.env.PIVERXY_DATA_DIR, 'library.json'), JSON.stringify({ [evil]: { id: evil, file: '', path: path.join(tmp, 'secret.txt'), ext: 'mp3', title: 'x', artist: 'y', duration: 0, addedAt: 1 } }));
fs.writeFileSync(path.join(tmp, 'secret.txt'), 'not for the player');

const { startServer, stopServer, getServerToken } = require('../server');

const BYTES = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz');
const songA = path.join(LINK, 'Road trip', '01 - Artist One - First song.mp3');
const songB = path.join(LINK, 'loose.flac');
fs.writeFileSync(songA, BYTES);
fs.writeFileSync(songB, BYTES);

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

const idA = 'local_aaaaaaaaaaaa';
const idB = 'local_bbbbbbbbbbbb';

test('library-link adds songs in place, with title and artist from the file name', async () => {
  const r = await call('POST', '/api/library-link', { items: [{ id: idA, path: songA, name: '01 - Artist One - First song' }, { id: idB, path: songB, name: 'loose' }] });
  assert.equal(r.json.count, 2);
  const lib = (await call('GET', '/api/library')).json;
  const a = lib.find((t) => t.id === idA);
  assert.equal(a.artist, 'Artist One');
  assert.equal(a.title, 'First song');
  assert.equal(lib.find((t) => t.id === idB).artist, 'Unknown artist');
  assert.equal(a.platform, 'local');
});

test('a linked song plays from where it is, ranges included', async () => {
  const whole = await call('GET', `/api/library-file?id=${idA}`);
  assert.equal(whole.status, 200);
  assert.deepEqual(whole.raw, BYTES);
  const part = await call('GET', `/api/library-file?id=${idA}`, undefined, { Range: 'bytes=2-5' });
  assert.equal(part.status, 206);
  assert.equal(part.raw.toString(), '2345');
});

test('only audio files inside the link folder are accepted', async () => {
  fs.writeFileSync(path.join(tmp, 'outside.mp3'), BYTES);
  fs.writeFileSync(path.join(LINK, 'notes.txt'), 'x');
  const bad = [
    { id: 'local_cccccccccccc', path: path.join(tmp, 'outside.mp3') },            // outside the folder
    { id: 'local_dddddddddddd', path: `${LINK}/Road trip/../../outside.mp3` },     // walks out of it
    { id: 'local_eeeeeeeeeeee', path: path.join(LINK, 'missing.mp3') },            // not there
    { id: 'local_ffffffffffff', path: path.join(LINK, 'notes.txt') },              // not audio
    { id: 'not-a-local-id', path: songB },                                         // id of another shape
    { id: '__proto__', path: songB },
  ];
  const r = await call('POST', '/api/library-link', { items: bad });
  assert.equal(r.json.count, 0);
  const ids = (await call('GET', '/api/library')).json.map((t) => t.id).filter((id) => id !== evil);
  assert.deepEqual(ids.sort(), [idA, idB]);
});

test('linking again keeps what is known (length, date added)', async () => {
  await call('POST', '/api/library-update', { id: idA, duration: 187 });
  await call('POST', '/api/library-link', { items: [{ id: idA, path: songA, name: '01 - Artist One - First song' }] });
  const a = (await call('GET', '/api/library')).json.find((t) => t.id === idA);
  assert.equal(a.duration, 187);
});

test('removing a linked song forgets it but never deletes the file', async () => {
  const r = await call('POST', '/api/library-remove', { id: idB });
  assert.equal(r.status, 200);
  assert.equal(fs.existsSync(songB), true);
  assert.equal((await call('GET', '/api/library')).json.some((t) => t.id === idB), false);
});

test('library-unlink forgets linked songs that are not kept, and leaves imported ones and every file alone', async () => {
  // an imported song: a copy inside the library folder
  const imported = 'local_111111111111';
  const libDir = path.join(process.env.PIVERXY_DATA_DIR, 'library');
  fs.writeFileSync(path.join(libDir, `${imported}.mp3`), BYTES);
  await call('POST', '/api/library-add', { items: [{ id: imported, file: `${imported}.mp3`, name: 'Imported' }] });
  await call('POST', '/api/library-link', { items: [{ id: idB, path: songB, name: 'loose' }] });

  let r = await call('POST', '/api/library-unlink', { keep: [idA, imported] });
  assert.deepEqual(r.json.ids.filter((id) => id !== evil).sort(), [idB]);
  assert.equal(fs.existsSync(songB), true);

  r = await call('POST', '/api/library-unlink', {});
  assert.deepEqual(r.json.ids.filter((id) => id !== evil), [idA]);
  assert.equal(fs.existsSync(songA), true);
  const ids = (await call('GET', '/api/library')).json.map((t) => t.id).filter((id) => id !== evil);
  assert.deepEqual(ids, [imported]);
  assert.equal(fs.existsSync(path.join(libDir, `${imported}.mp3`)), true);
});

test('a library record that points outside the link folder is not served', async () => {
  const r = await call('GET', `/api/library-file?id=${evil}`);
  assert.equal(r.status, 404);
  assert.notEqual(r.raw.toString(), 'not for the player');
  assert.equal(fs.existsSync(path.join(tmp, 'secret.txt')), true);
});
