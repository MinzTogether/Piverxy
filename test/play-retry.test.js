'use strict';

// A song that failed once and then played on Retry should play the first time. The first attempt failed
// for a passing reason: it shared someone else's failing yt-dlp run (the next-song prefetch, another
// request for the same song), or it got a remembered stream URL that no longer worked.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createTaskQueue } = require('../ytdlp-queue');

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = () => new Promise((r) => setImmediate(r));

test('a play request that joined a failing background run gets a fresh run of its own', async () => {
  const q = createTaskQueue({ limit: 2 });
  const prefetch = deferred();
  let runs = 0;
  q.run(() => { runs++; return prefetch.promise; }, { key: 'g:x', priority: 'normal' }).catch(() => {});
  await tick();
  const play = q.run(() => { runs++; return runs === 1 ? prefetch.promise : Promise.resolve('url'); }, { key: 'g:x', priority: 'play' });
  prefetch.reject(new Error('timed out'));
  assert.equal(await play, 'url');
  assert.equal(runs, 2);
});

test('the fresh run is tried once only, and ignores the backoff the failure left', async () => {
  const q = createTaskQueue({ limit: 2 });
  const first = deferred();
  q.run(() => first.promise, { key: 'g:y', priority: 'background' }).catch(() => {});
  await tick();
  let runs = 0;
  const play = q.run(() => { runs++; return Promise.reject(new Error('still broken')); }, { key: 'g:y', priority: 'play' });
  first.reject(new Error('broken'));
  await assert.rejects(play, /still broken/);
  assert.equal(runs, 1);
});

test('non-play callers still share a failure', async () => {
  const q = createTaskQueue({ limit: 2 });
  const first = deferred();
  q.run(() => first.promise, { key: 'g:z', priority: 'normal' }).catch(() => {});
  await tick();
  let runs = 0;
  const other = q.run(() => { runs++; return Promise.resolve('x'); }, { key: 'g:z', priority: 'normal' });
  first.reject(new Error('broken'));
  await assert.rejects(other, /broken/);
  assert.equal(runs, 0);
});

// ---- the stream lookup on the server, with a fake yt-dlp ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'muriel-retry-'));
const plan = path.join(tmp, 'plan');
const count = path.join(tmp, 'count');
const fake = path.join(tmp, 'yt-dlp');
let server;
let port;
let token;

before(async () => {
  for (const key of ['HOME', 'USERPROFILE', 'LOCALAPPDATA', 'XDG_CONFIG_HOME']) process.env[key] = tmp;
  process.env.MURIEL_DATA_DIR = path.join(tmp, 'data');
  // each call: the next word of the plan, "fail" or "ok"; slow enough for a second request to join it
  fs.writeFileSync(fake, `#!/bin/sh
n=$(( $(cat "${count}" 2>/dev/null || echo 0) + 1 )); echo $n > "${count}"
what=$(cut -d, -f$n "${plan}")
sleep 0.4
[ "$what" = "fail" ] && { echo "ERROR: passing failure" >&2; exit 1; }
echo "https://rr1.googlevideo.com/videoplayback?n=$n"
`);
  fs.chmodSync(fake, 0o755);
  process.env.MURIEL_YTDLP = fake;
  process.env.MURIEL_FFMPEG = fake;
  server = require('../server.js');
  port = await server.startServer(0);
  token = server.getServerToken();
});

after(() => { try { server.stopServer(); } catch (_) {} });

const get = (p) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: p, headers: { 'x-muriel-token': token } }, (res) => {
    let body = ''; res.on('data', (c) => { body += c; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
  }).on('error', reject);
});
const setPlan = (p) => { fs.writeFileSync(plan, p); fs.writeFileSync(count, '0'); };
const calls = () => Number(fs.readFileSync(count, 'utf8'));
let n = 0;
const song = () => { n++; return `url=${encodeURIComponent(`https://soundcloud.com/a/song${n}`)}&id=retry${n}&platform=soundcloud`; };

test('playing the song whose next-song prefetch is failing still plays', async () => {
  setPlan('fail,ok');
  const q = song();
  get(`/api/prefetch?${q}&next=1`);
  await new Promise((r) => setTimeout(r, 150));
  const r = await get(`/api/stream-info?${q}`);
  assert.equal(r.status, 200);
  assert.match(r.body.streamUrl, /n=2$/);
  assert.equal(calls(), 2);
});

test('a second request for a song whose lookup fails looks it up itself', async () => {
  setPlan('fail,ok');
  const q = song();
  const first = get(`/api/stream-info?${q}`);
  await new Promise((r) => setTimeout(r, 100));
  const second = await get(`/api/stream-info?${q}`);
  assert.equal(second.status, 200);
  assert.equal((await first).status, 500);
});

test('fresh=1 skips the remembered stream URL', async () => {
  setPlan('ok,ok');
  const q = song();
  const a = await get(`/api/stream-info?${q}`);
  const again = await get(`/api/stream-info?${q}`);
  assert.equal(again.body.streamUrl, a.body.streamUrl, 'without fresh the URL is remembered');
  const b = await get(`/api/stream-info?${q}&fresh=1`);
  assert.equal(b.status, 200);
  assert.notEqual(b.body.streamUrl, a.body.streamUrl);
});

test('the app looks a failing song up once more, afresh, before telling the listener', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  assert.match(app, /function retryFresh\(token, track\)/);
  assert.match(app, /fresh \? '&fresh=1' : ''/);
  // every place that shows "try again or skip" (lookup, audio element error, HLS error, nothing loading) tries it first
  const sites = app.split('\n').filter((l) => /retryFresh\((currentToken|state\.loadToken|token), (track|state\.currentTrack)\)\) return/.test(l));
  assert.ok(sites.length >= 4, `retryFresh guards ${sites.length} failure paths`);
});
