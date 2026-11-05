'use strict';

// On Android/iOS there is no yt-dlp: mobile/extract.js resolves SoundCloud itself. Many tracks no longer have a
// progressive MP3, only HLS, and those failed with "Couldn't play this song". Plain HLS (MP3 segments, or AAC in
// fragmented MP4) is now downloaded and joined; encrypted HLS is refused with a clear message.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');

// stand-ins for the Capacitor-backed storage the shim writes to
const written = new Map();
const fakes = {
  [path.join(__dirname, '../mobile/shims/fs.js')]: { _register: () => {} },
  [path.join(__dirname, '../mobile/shims/store.js')]: {
    writeBytes: async (out, bytes) => { written.set(out, bytes); },
    download: async (url, out) => { written.set(out, { direct: url }); return 1000; },
  },
  [path.join(__dirname, '../mobile/cache-limit.js')]: { enforceCacheLimit: () => {} },
};
const realLoad = Module._load;
Module._load = function (request, parent, ...rest) {
  if (parent && parent.filename) {
    const resolved = path.resolve(path.dirname(parent.filename), request);
    for (const ext of ['', '.js']) if (fakes[resolved + ext]) return fakes[resolved + ext];
  }
  return realLoad.call(this, request, parent, ...rest);
};

const ex = require('../mobile/extract');
const { spawn, joinSegments } = require('../mobile/shims/child_process');

// ---- a fake SoundCloud ----
let track;
let routes;
let resolved = [];
let searchHits = [];
const bytes = (...b) => new Uint8Array(b);
function respond(body, status = 200) {
  return {
    ok: status < 400, status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    json: async () => body,
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  };
}
globalThis.__murielFetch = async (input) => {
  const url = String(input);
  if (url === 'https://soundcloud.com/') return respond('<script crossorigin src="https://a-v2.sndcdn.com/assets/app.js"></script>');
  if (url === 'https://a-v2.sndcdn.com/assets/app.js') return respond('x={client_id:"abcdefghijklmnopqrstuvwxyz123456"}');
  if (url.startsWith('https://api-v2.soundcloud.com/resolve')) {
    const asked = decodeURIComponent(url.match(/url=([^&]+)/)[1]);
    resolved.push(asked);
    // like the real api: only canonical soundcloud.com links resolve
    return /^https:\/\/soundcloud\.com\/[^?]+$/.test(asked) ? respond(track) : respond({ code: 404 }, 404);
  }
  if (url === 'https://on.soundcloud.com/AbC123') return { ...respond('<html></html>'), url: 'https://soundcloud.com/artist/sets/mix?ref=clipboard&si=F2373777&utm_source=clipboard' };
  if (url.startsWith('https://api-v2.soundcloud.com/search/tracks')) return respond({ collection: searchHits });
  for (const [prefix, body] of Object.entries(routes)) if (url.startsWith(prefix)) return typeof body === 'number' ? respond('', body) : respond(body);
  return respond('', 404);
};

const tc = (protocol, mime, id) => ({ url: `https://api-v2.soundcloud.com/media/${id}`, format: { protocol, mime_type: mime }, snipped: false });
const baseTrack = (transcodings) => ({ title: 'Song', user: { username: 'Artist' }, duration: 200000, policy: 'ALLOW', track_authorization: 'tok', media: { transcodings } });

function runDownload(target) {
  return new Promise((resolve, reject) => {
    const p = spawn('yt-dlp', ['-x', '-o', '/data/cache/abc.%(ext)s', '--', target]);
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err))));
  });
}

beforeEach(() => { written.clear(); routes = {}; resolved = []; searchHits = []; });

test('prefers progressive MP3 when SoundCloud still has it', async () => {
  track = baseTrack([tc('hls', 'audio/mpeg', 'hls'), tc('progressive', 'audio/mpeg', 'prog')]);
  routes['https://api-v2.soundcloud.com/media/prog'] = { url: 'https://cf-media.sndcdn.com/song.128.mp3' };
  const a = await ex.resolveAudio('https://soundcloud.com/artist/song');
  assert.equal(a.kind, undefined);
  assert.equal(a.ext, 'mp3');
  await runDownload('https://soundcloud.com/artist/song');
  assert.deepEqual(written.get('/data/cache/abc.mp3'), { direct: 'https://cf-media.sndcdn.com/song.128.mp3' });
});

test('HLS-only MP3 track is downloaded and joined into one .mp3', async () => {
  track = baseTrack([tc('hls', 'audio/mpeg', 'hls')]);
  routes['https://api-v2.soundcloud.com/media/hls'] = { url: 'https://cf-hls-media.sndcdn.com/playlist/x.m3u8' };
  routes['https://cf-hls-media.sndcdn.com/playlist/x.m3u8'] = '#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nhttps://cf-hls-media.sndcdn.com/media/0\n#EXTINF:10,\nhttps://cf-hls-media.sndcdn.com/media/1\n#EXT-X-ENDLIST\n';
  // first segment carries an ID3 tag (10-byte header, 2-byte body) before the MP3 frames
  routes['https://cf-hls-media.sndcdn.com/media/0'] = bytes(0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 2, 9, 9, 0xff, 0xfb, 1);
  routes['https://cf-hls-media.sndcdn.com/media/1'] = bytes(0xff, 0xfb, 2);
  await runDownload('https://soundcloud.com/artist/song');
  assert.deepEqual([...written.get('/data/cache/abc.mp3')], [0xff, 0xfb, 1, 0xff, 0xfb, 2]);
});

test('HLS AAC (fragmented MP4) keeps its init segment in front', async () => {
  track = baseTrack([tc('hls', 'audio/mp4; codecs="mp4a.40.2"', 'aac')]);
  routes['https://api-v2.soundcloud.com/media/aac'] = { url: 'https://playback.media-streaming.soundcloud.cloud/a/playlist.m3u8' };
  routes['https://playback.media-streaming.soundcloud.cloud/a/playlist.m3u8'] = '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:10,\nseg1.m4s\n#EXTINF:10,\nseg2.m4s\n#EXT-X-ENDLIST\n';
  routes['https://playback.media-streaming.soundcloud.cloud/a/init.mp4'] = bytes(0, 0, 0, 8, 0x66, 0x74, 0x79, 0x70);
  routes['https://playback.media-streaming.soundcloud.cloud/a/seg1.m4s'] = bytes(1, 1);
  routes['https://playback.media-streaming.soundcloud.cloud/a/seg2.m4s'] = bytes(2, 2);
  await runDownload('https://soundcloud.com/artist/song');
  assert.deepEqual([...written.get('/data/cache/abc.m4a')], [0, 0, 0, 8, 0x66, 0x74, 0x79, 0x70, 1, 1, 2, 2]);
});

test('falls back to HLS when the progressive URL is refused', async () => {
  track = baseTrack([tc('progressive', 'audio/mpeg', 'prog'), tc('hls', 'audio/mpeg', 'hls')]);
  routes['https://api-v2.soundcloud.com/media/prog'] = 404;
  routes['https://api-v2.soundcloud.com/media/hls'] = { url: 'https://cf-hls-media.sndcdn.com/playlist/y.m3u8' };
  const a = await ex.resolveAudio('https://soundcloud.com/artist/song');
  assert.equal(a.kind, 'hls');
  assert.equal(a.container, 'mp3');
});

test('encrypted-only tracks fail with a clear reason', async () => {
  track = baseTrack([tc('ctr-encrypted-hls', 'audio/mp4', 'enc1'), tc('cbc-encrypted-hls', 'audio/mp4', 'enc2')]);
  await assert.rejects(ex.resolveAudio('https://soundcloud.com/artist/song'), /encrypted/);
});

test('a playlist with an encryption key is refused instead of saving noise', async () => {
  track = baseTrack([tc('hls', 'audio/mpeg', 'hls')]);
  routes['https://api-v2.soundcloud.com/media/hls'] = { url: 'https://cf-hls-media.sndcdn.com/playlist/z.m3u8' };
  routes['https://cf-hls-media.sndcdn.com/playlist/z.m3u8'] = '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="k"\n#EXTINF:10,\nseg\n';
  await assert.rejects(runDownload('https://soundcloud.com/artist/song'), /encrypted/);
  assert.equal(written.size, 0);
});

// #13: SoundCloud no longer serves MP3 HLS; the "audio/mpegurl" transcoding is an adaptive master playlist
test('the audio/mpegurl master playlist is not taken for MP3 segments', async () => {
  track = baseTrack([tc('hls', 'audio/mpegurl', 'abr'), tc('hls', 'audio/mp4; codecs="mp4a.40.2"', 'aac')]);
  assert.deepEqual(ex.scCandidates(track.media.transcodings).map((c) => c.tc.url), ['https://api-v2.soundcloud.com/media/aac']);
  routes['https://api-v2.soundcloud.com/media/aac'] = { url: 'https://playback.media-streaming.soundcloud.cloud/x/aac_96k/playlist.m3u8' };
  const a = await ex.resolveAudio('https://soundcloud.com/artist/song');
  assert.equal(a.container, 'fmp4');
});

// #13: links from the app's Share button (on.soundcloud.com) and the mobile site answered "SoundCloud 404"
test('share links, mobile-site links and tracking parameters resolve', async () => {
  track = { kind: 'playlist', title: 'Mix', tracks: [{ id: 1, title: 'One', user: { username: 'A' }, duration: 1000, permalink_url: 'https://soundcloud.com/a/one' }] };
  for (const link of [
    'https://on.soundcloud.com/AbC123',
    'https://m.soundcloud.com/artist/sets/mix',
    'https://soundcloud.com/artist/sets/mix?si=abc&utm_source=clipboard&utm_medium=text',
    'https://www.soundcloud.com/artist/sets/mix/',
  ]) {
    const pl = await ex.playlist(link);
    assert.equal(pl.title, 'Mix', link);
    assert.equal(pl.entries.length, 1);
  }
  assert.deepEqual([...new Set(resolved)], ['https://soundcloud.com/artist/sets/mix']);
});

// #13: search offered songs SoundCloud only streams encrypted, which then failed to play
test('search leaves out DRM-only songs and previews', async () => {
  const hit = (id, transcodings, policy = 'ALLOW') => ({ kind: 'track', id, title: `t${id}`, user: { username: 'u' }, duration: 200000, policy, permalink_url: `https://soundcloud.com/u/t${id}`, media: { transcodings } });
  searchHits = [
    hit(1, [tc('ctr-encrypted-hls', 'audio/mp4', 'e1'), tc('cbc-encrypted-hls', 'audio/mpegurl', 'e2')], 'MONETIZE'),
    hit(2, [tc('hls', 'audio/mp4; codecs="mp4a.40.2"', 'a2'), tc('hls', 'audio/mpegurl', 'm2')]),
    hit(3, [tc('hls', 'audio/mp4', 'a3')], 'SNIP'),
    hit(4, [tc('progressive', 'audio/mpeg', 'p4')]),
  ];
  const r = await ex.soundcloudSearch('x', 5);
  assert.deepEqual(r.map((t) => t.id), ['2', '4']);
  assert.ok(r.every((t) => t.playable === true));
  assert.equal((await ex.soundcloudSearch('x', 1)).length, 1);
});

test('YouTube segments still go through the AAC path', () => {
  // packed audio: ID3 tag then ADTS frame
  const seg = bytes(0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0, 0xff, 0xf1, 7);
  assert.deepEqual([...joinSegments([seg])], [0xff, 0xf1, 7]);
});
