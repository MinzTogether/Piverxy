'use strict';

// #17: no yt-dlp process for SoundCloud search, and no second extraction to cache a song that plays.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { searchSoundcloudApi } = require('../soundcloud-search');
const { cacheCopyArgs, copyStreamToCache } = require('../cache-copy');

const tc = (protocol, extra = {}) => ({ url: 'https://api-v2.soundcloud.com/media/x', format: { protocol, mime_type: 'audio/mpeg' }, snipped: false, ...extra });
const hit = (id, o = {}) => ({ kind: 'track', id, title: 'Song ' + id, user: { username: 'Artist' }, duration: 200000, permalink_url: `https://soundcloud.com/a/s${id}`, artwork_url: `https://i1.sndcdn.com/a${id}-large.jpg`, policy: 'ALLOW', media: { transcodings: [tc('progressive')] }, ...o });
const respond = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

test('SoundCloud search uses the api and keeps the flat-search shape', async () => {
  const asked = [];
  const out = await searchSoundcloudApi('daft punk', 2, {
    fetch: async (u) => { asked.push(u); return respond({ collection: [hit(1), hit(2), hit(3)] }); },
    clientId: async () => 'CID',
  });
  assert.equal(asked.length, 1);
  assert.match(asked[0], /^https:\/\/api-v2\.soundcloud\.com\/search\/tracks\?q=daft%20punk&limit=6&client_id=CID$/);
  assert.deepEqual(out[0], { id: '1', title: 'Song 1', uploader: 'Artist', duration: 200, thumbnails: [{ url: 'https://i1.sndcdn.com/a1-t500x500.jpg' }], webpage_url: 'https://soundcloud.com/a/s1', url: 'https://soundcloud.com/a/s1', playable: true });
  assert.equal(out.length, 2);
});

test('SoundCloud search leaves out previews and DRM-only songs', async () => {
  const out = await searchSoundcloudApi('x', 10, {
    fetch: async () => respond({ collection: [
      hit(1, { policy: 'SNIP' }),
      hit(2, { media: { transcodings: [tc('progressive', { snipped: true })] } }),
      hit(3, { media: { transcodings: [{ url: 'u', format: { protocol: 'ctr-encrypted-hls' } }] } }),
      hit(4, { media: { transcodings: [tc('hls')] } }),
      { kind: 'playlist', id: 5 },
    ] }),
    clientId: async () => 'CID',
  });
  assert.deepEqual(out.map((t) => t.id), ['4']);
});

test('SoundCloud search reads the client id again once when it is refused, and fails on errors', async () => {
  let cid = 'OLD', resets = 0;
  const out = await searchSoundcloudApi('x', 1, {
    fetch: async (u) => (u.includes('client_id=OLD') ? respond({}, 401) : respond({ collection: [hit(9)] })),
    clientId: async () => cid,
    resetClientId: () => { resets++; cid = 'NEW'; },
  });
  assert.equal(resets, 1);
  assert.equal(out[0].id, '9');
  await assert.rejects(searchSoundcloudApi('x', 1, { fetch: async () => respond({}, 500), clientId: async () => 'C' }));
  await assert.rejects(searchSoundcloudApi('x', 1, { fetch: async () => respond({ nope: 1 }), clientId: async () => 'C' }));
});

test('cache copy: stream copy first, Opus output, browser user agent for http', () => {
  const a = cacheCopyArgs('https://rr1.googlevideo.com/videoplayback?x=1', '/c/id.temp.opus', 'copy');
  assert.deepEqual(a.slice(a.indexOf('-vn')), ['-vn', '-map', '0:a:0', '-c:a', 'copy', '-f', 'opus', '/c/id.temp.opus']);
  assert.ok(a.includes('-user_agent') && a.includes('-reconnect'));
  const b = cacheCopyArgs('/tmp/in.m4a', '/c/o.opus', 'opus');
  assert.deepEqual(b.slice(b.indexOf('-c:a')), ['-c:a', 'libopus', '-b:a', '128k', '-f', 'opus', '/c/o.opus']);
});

test('cache copy: a 403 goes straight back to the caller (yt-dlp) without converting', async () => {
  const calls = [];
  const { EventEmitter } = require('node:events');
  const spawnFn = (bin, args) => {
    calls.push(args);
    const p = new EventEmitter(); p.stderr = new EventEmitter(); p.kill = () => {};
    setImmediate(() => { p.stderr.emit('data', 'HTTP error 403 Forbidden'); p.emit('close', 1); });
    return p;
  };
  const ok = await copyStreamToCache('ffmpeg', 'https://x/y', path.join(os.tmpdir(), 'nope-17.opus'), { spawnFn });
  assert.equal(ok, false);
  assert.equal(calls.length, 1);
});

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
test('cache copy with a real ffmpeg: Opus is copied, AAC is converted', { skip: !hasFfmpeg && 'no ffmpeg' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc17-'));
  const opusSrc = path.join(dir, 'a.webm'), aacSrc = path.join(dir, 'b.m4a');
  spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=f=440:d=8', '-c:a', 'libopus', '-b:a', '96k', opusSrc]);
  spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=f=440:d=8', '-c:a', 'aac', '-b:a', '96k', aacSrc]);
  const out1 = path.join(dir, 'o1.opus'), out2 = path.join(dir, 'o2.opus');
  assert.equal(await copyStreamToCache('ffmpeg', opusSrc, out1, { minBytes: 1000 }), true);
  assert.equal(await copyStreamToCache('ffmpeg', aacSrc, out2, { minBytes: 1000 }), true);
  for (const f of [out1, out2]) assert.match(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', f]).stdout.toString(), /opus/);
  assert.equal(await copyStreamToCache('ffmpeg', path.join(dir, 'missing.webm'), path.join(dir, 'o3.opus'), { minBytes: 1000 }), false);
  assert.equal(fs.existsSync(path.join(dir, 'o3.opus')), false);
  fs.rmSync(dir, { recursive: true, force: true });
});
