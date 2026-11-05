'use strict';

// Stability regressions for server.js: hangs, crashes and leaks found by fuzzing the local API.
// Nothing here touches the network or the real data dir: HOME and the data dir point at a temp folder,
// and every outbound https request is routed to a local server whose behaviour each test sets.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'muriel-stability-'));
for (const key of ['HOME', 'USERPROFILE', 'LOCALAPPDATA', 'XDG_CONFIG_HOME']) process.env[key] = tmp;
process.env.MURIEL_DATA_DIR = path.join(tmp, 'data');
// the library index is read when server.js loads: one entry whose cover can't be read
fs.mkdirSync(path.join(tmp, 'data', 'thumbnails', 'localcover_local_000000000001.jpg'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'data', 'library.json'), JSON.stringify({
  local_000000000001: { id: 'local_000000000001', file: 'local_000000000001.mp3', title: 't', artist: 'a', addedAt: 1 },
}));

// ---- fake internet ----
let outbound = (req) => req.socket.destroy(); // default: every outside request fails
let outboundTimeout = null; // shortens the timeout servers ask for (tools download test)
const outboundHosts = [];
const internet = http.createServer((req, res) => {
  const target = new URL(req.url, 'http://x').searchParams.get('u') || '';
  outboundHosts.push(new URL(target).hostname);
  outbound(req, res, target);
});
const toInternet = (target) => `http://127.0.0.1:${internet.address().port}/?u=${encodeURIComponent(String(target))}`;
https.get = (target, opts, cb) => {
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  const o = { ...(opts || {}) };
  if (o.timeout && outboundTimeout) o.timeout = outboundTimeout;
  return http.get(toInternet(target), o, cb);
};
https.request = (target, opts, cb) => {
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  if (typeof target === 'object' && !(target instanceof URL)) {
    const { hostname, host, path: urlPath, protocol, port: _port, ...rest } = target;
    return http.request(toInternet(`https://${hostname || host}${urlPath || '/'}`), rest, cb);
  }
  return http.request(toInternet(target), opts || {}, cb);
};
const json = (res, data, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
const resetMidBody = (req, res) => { res.writeHead(200, { 'Content-Length': 100000 }); res.write('{"data":['); setTimeout(() => req.socket.destroy(), 20); };

const crashes = [];
process.on('unhandledRejection', (e) => crashes.push(e));
process.on('uncaughtException', (e) => crashes.push(e));

const { startServer, stopServer, getServerToken } = require('../server');
const { CACHE_DIR } = require('../platform');
let port;

before(async () => {
  await new Promise((resolve) => internet.listen(0, '127.0.0.1', resolve));
  port = await startServer(0);
});

after(async () => {
  await stopServer();
  internet.closeAllConnections();
  await new Promise((resolve) => internet.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
});

// resolves { status, headers, body }, { error } or { timedOut } - never hangs the test
function call(method, route, { body, headers = {}, timeout = 5000 } = {}) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: route, headers: { 'x-muriel-token': getServerToken(), ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { clearTimeout(timer); resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }); });
      res.on('error', (error) => { clearTimeout(timer); resolve({ error }); });
    });
    const timer = setTimeout(() => { req.destroy(); resolve({ timedOut: true }); }, timeout);
    req.on('error', (error) => { clearTimeout(timer); resolve({ error }); });
    req.end(body);
  });
}
const parse = (r) => JSON.parse(r.body.toString());
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

test('repeated query parameters are read as one value instead of crashing the route', async () => {
  const cache = await call('GET', '/api/check-cache?id=a&id=b');
  assert.equal(cache.status, 200);
  assert.equal(parse(cache).cached, false);
  const lyrics = await call('GET', '/api/lyrics?title=a&title=b&artist=x&online=0');
  assert.equal(lyrics.status, 200);
  // used to reject inside a fire-and-forget call: an unhandled rejection
  const prefetch = await call('GET', '/api/prefetch?id=a&id=b&platform=soundcloud');
  assert.equal(prefetch.status, 200);
  await settle();
  assert.deepEqual(crashes, []);
});

test('translate answers even when a lyric line is not a string', async () => {
  // the service echoes the text back, like a translation into the same language
  outbound = (req, res, target) => json(res, [[[new URL(target).searchParams.get('q'), '']]]);
  const r = await call('POST', '/api/translate', { body: JSON.stringify({ texts: [null, 5, 'hi'], targetLang: 'de' }) });
  assert.ok(!r.timedOut, 'request hung');
  assert.equal(r.status, 200);
  assert.deepEqual(parse(r).translations, ['', '5', 'hi']);
  await settle();
  assert.deepEqual(crashes, []);
});

test('translate gives up at once when the service is down instead of retrying every line', async () => {
  outbound = (req, res) => json(res, {}, 500);
  const before = outboundHosts.length;
  const r = await call('POST', '/api/translate', { body: JSON.stringify({ texts: Array.from({ length: 40 }, (_, i) => `line ${i}`), targetLang: 'de' }) });
  assert.ok(!r.timedOut, 'request hung');
  assert.equal(parse(r).success, false);
  // one try per translate client for the whole batch, not one per line
  assert.equal(outboundHosts.length - before, 2);
});

test('a range past the end of a file is clamped and an impossible one gets 416', async () => {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(path.join(CACHE_DIR, 'rangetest.mp3'), Buffer.alloc(100000, 7));
  const past = await call('GET', '/api/local-track?id=rangetest', { headers: { range: 'bytes=0-999999999' } });
  assert.ok(!past.timedOut, 'Content-Length larger than the file left the request hanging');
  assert.equal(past.status, 206);
  assert.equal(past.headers['content-length'], '100000');
  assert.equal(past.headers['content-range'], 'bytes 0-99999/100000');
  assert.equal(past.body.length, 100000);
  const suffix = await call('GET', '/api/local-track?id=rangetest', { headers: { range: 'bytes=-500' } });
  assert.equal(suffix.status, 206);
  assert.equal(suffix.body.length, 500);
  for (const range of ['bytes=200000-', 'bytes=100000-100000', 'bytes=50-10', 'bytes=x-y']) {
    const bad = await call('GET', '/api/local-track?id=rangetest', { headers: { range } });
    assert.equal(bad.status, 416, range);
    assert.equal(bad.headers['content-range'], 'bytes */100000');
  }
});

test('a file that fails to read ends the response instead of crashing the process', async () => {
  fs.mkdirSync(path.join(tmp, 'Downloads', '.tmp', 'broken.wav'), { recursive: true });
  const wav = await call('GET', '/api/tmp-file?name=broken.wav');
  assert.ok(!wav.timedOut, 'tmp-file hung');
  const cover = await call('GET', '/api/local-cover?id=local_000000000001');
  assert.ok(!cover.timedOut, 'local-cover hung');
  await settle();
  assert.deepEqual(crashes, []);
});

test('library ids cannot write to Object.prototype', async () => {
  try {
    await call('POST', '/api/library-update', { body: JSON.stringify({ id: '__proto__', duration: 4242 }) });
    await call('POST', '/api/library-add', { body: JSON.stringify({ items: [{ id: '__proto__', file: 'local_000000000001.mp3', name: 'x' }] }) });
    assert.equal(({}).duration, undefined);
    assert.equal(Object.getPrototypeOf(JSON.parse('{}')), Object.prototype);
  } finally {
    delete Object.prototype.duration;
  }
});

test('a connection dropped mid-response does not wedge searches that later requests wait on', async () => {
  outbound = resetMidBody;
  for (let i = 0; i < 2; i++) {
    const albums = await call('GET', '/api/albums/search?q=reset');
    assert.ok(!albums.timedOut, 'album search hung');
    assert.equal(albums.status, 502);
    const hot = await call('GET', '/api/hot');
    assert.ok(!hot.timedOut, 'hot picks hung');
    assert.equal(parse(hot).success, false);
    const artist = await call('GET', '/api/artist?name=Reset%20Band');
    assert.ok(!artist.timedOut, 'artist page hung');
    assert.equal(artist.status, 200);
  }
});

test('identical discover and artist requests share one lookup', async () => {
  outbound = (req, res) => setTimeout(() => json(res, {}), 50);
  outboundHosts.length = 0;
  const body = JSON.stringify({ history: [{ artist: 'Shared Artist', title: 'x' }] });
  const discover = await Promise.all(Array.from({ length: 10 }, () => call('POST', '/api/discover', { body })));
  assert.ok(discover.every((r) => r.status === 200));
  assert.equal(outboundHosts.length, 2, `one discover build is one iTunes + one Deezer lookup, got ${outboundHosts.join(', ')}`);

  outboundHosts.length = 0;
  const artist = await Promise.all(Array.from({ length: 10 }, () => call('GET', '/api/artist?name=Shared%20Artist')));
  assert.ok(artist.every((r) => r.status === 200));
  assert.equal(outboundHosts.length, 3, `one artist page is Deezer + Wikipedia + YouTube, got ${outboundHosts.join(', ')}`);
});

test('lyrics that were not found are looked up again later', async () => {
  let online = false;
  outbound = (req, res, target) => {
    if (!online) return req.socket.destroy();
    if (target.includes('/api/get')) return json(res, { syncedLyrics: '[00:01.00] found later' });
    return json(res, []);
  };
  const route = '/api/lyrics?title=Later%20Song&artist=Later%20Artist';
  assert.equal(parse(await call('GET', route)).lyrics, null);
  online = true;
  const realNow = Date.now;
  Date.now = () => realNow() + 11 * 60 * 1000;
  try {
    assert.equal(parse(await call('GET', route)).lyrics, '[00:01.00] found later');
  } finally {
    Date.now = realNow;
  }
});

test('aborting a proxied stream closes the upstream connection', async () => {
  let open = 0;
  const upstream = http.createServer((req, res) => {
    open++;
    res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
    const t = setInterval(() => res.write(Buffer.alloc(16384, 1)), 10);
    res.on('close', () => { clearInterval(t); open--; });
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const realLookup = dns.promises.lookup;
  const realRequest = http.request;
  dns.promises.lookup = async (host, opts) => (host === 'stream.test' ? [{ address: '93.184.216.34', family: 4 }] : realLookup(host, opts));
  http.request = function (target, ...rest) {
    if (String(target).includes('stream.test')) {
      target = String(target).replace('stream.test', `127.0.0.1:${upstream.address().port}`);
      // the proxy pins the address it checked (93.184.216.34 here); the stand-in upstream lives on 127.0.0.1
      if (rest[0] && typeof rest[0] === 'object') { const { lookup, ...opts } = rest[0]; rest[0] = opts; }
    }
    return realRequest.call(this, target, ...rest);
  };
  try {
    for (let i = 0; i < 3; i++) {
      await new Promise((resolve) => {
        const req = http.get({ host: '127.0.0.1', port, path: `/api/audio-proxy?url=${encodeURIComponent('http://stream.test/song.mp3')}`, headers: { 'x-muriel-token': getServerToken() } }, (res) => {
          let got = 0;
          res.on('data', (c) => { got += c.length; if (got > 40000) { req.destroy(); resolve(); } });
        });
        req.on('error', resolve);
      });
    }
    for (let i = 0; i < 40 && open > 0; i++) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(open, 0, 'upstream downloads kept running after the player went away');
  } finally {
    dns.promises.lookup = realLookup;
    http.request = realRequest;
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test('a stalled tool download ends in an error instead of "downloading" forever', async (t) => {
  const { resolveBinary } = require('../platform');
  if (resolveBinary('yt-dlp') && resolveBinary('ffmpeg')) return t.skip('yt-dlp and ffmpeg are already installed');
  outbound = (req, res) => { res.writeHead(200, { 'Content-Length': 100000 }); res.write('abc'); }; // then silence
  outboundTimeout = 300;
  try {
    const tools = require('../tools');
    const status = await Promise.race([tools.ensureTools(), new Promise((resolve) => setTimeout(() => resolve(null), 5000))]);
    assert.ok(status, 'ensureTools never finished');
    assert.equal(status.progress.status, 'error');
  } finally {
    outboundTimeout = null;
  }
});

test('phone shims implement the stream methods server.js calls', async () => {
  globalThis.__murielFetch = async () => new Response('{}', { status: 404 });
  try {
    const shimHttps = require('../mobile/shims/https');
    const res = await new Promise((resolve, reject) => shimHttps.get('https://example.test/', { timeout: 1000 }, resolve).on('error', reject));
    assert.doesNotThrow(() => { res.resume(); res.destroy(); });

    const shimHttp = require('../mobile/shims/http');
    shimHttp.createServer((req, res) => {
      req.on('data', () => {
        res.writeHead(413);
        res.end('too big');
        req.resume(); // what server.js does after rejecting an oversized body
      });
    });
    const out = await shimHttp.dispatch({ url: '/api/state', method: 'POST', body: 'x' });
    assert.equal(out.status, 413);
    await settle();
    assert.deepEqual(crashes, []);
  } finally {
    delete globalThis.__murielFetch;
  }
});

test('YouTube Music search falls back to music videos where it has no songs', async () => {
  const row = (id, title, meta) => ({ musicResponsiveListItemRenderer: {
    playlistItemData: { videoId: id },
    flexColumns: [title, meta].map((runs) => ({ musicResponsiveListItemFlexColumnRenderer: { text: { runs: runs.map((text) => ({ text })) } } })),
  } });
  const page = (items) => ({ contents: { tabbedSearchResultsRenderer: { tabs: [{ tabRenderer: { content: { sectionListRenderer: { contents: items.length ? [{ musicShelfRenderer: { contents: items } }] : [{ itemSectionRenderer: { contents: [{ messageRenderer: { text: { runs: [{ text: 'No results' }] } } }] } }] } } } }] } } });
  const asked = [];
  outbound = (req, res, target) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (!target.includes('music.youtube.com')) return json(res, {}, 404);
      const { params } = JSON.parse(body);
      asked.push(params);
      // the songs filter has nothing in this country; the videos filter does
      json(res, params.startsWith('EgWKAQIQ') ? page([row('aaaaaaaaaaa', ['Get Lucky (Official Video)'], ['Daft Punk', ' • ', '1.2B views', ' • ', '4:08'])]) : page([]));
    });
  };
  const r = await call('GET', '/api/search?platform=ytmusic&q=fallback%20test%20lucky');
  assert.equal(r.status, 200);
  const { tracks } = parse(r);
  assert.equal(asked.length, 2);
  assert.equal(tracks[0].id, 'aaaaaaaaaaa');
  assert.equal(tracks[0].artist, 'Daft Punk');
  assert.equal(tracks[0].duration, 248);
});

test('Genius first: its lyrics are used and kept, lrclib is the fallback', async () => {
  const asked = [];
  const geniusPage = '<div data-lyrics-container="true">[Chorus]<br>Genius line one<br>Genius line two</div>';
  let geniusUp = true;
  outbound = (req, res, target) => {
    asked.push(new URL(target).hostname);
    if (target.startsWith('https://genius.com/api/search')) {
      if (!geniusUp) return req.socket.destroy();
      return json(res, { response: { sections: [{ hits: [{ result: { title: 'Source Song', artist_names: 'Source Artist', url: 'https://genius.com/Source-artist-source-song-lyrics' } }] }] } });
    }
    if (target.startsWith('https://genius.com/Source')) { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(geniusPage); }
    if (target.includes('lrclib.net/api/get')) return json(res, { syncedLyrics: '[00:01.00] from lrclib' });
    return json(res, []);
  };
  const g = parse(await call('GET', '/api/lyrics?title=Source%20Song&artist=Source%20Artist&source=genius'));
  assert.equal(g.lyrics, 'Genius line one\nGenius line two');
  assert.ok(!asked.includes('lrclib.net'), `lrclib asked although Genius had it: ${asked.join(', ')}`);
  // the default source is still lrclib, cached separately
  const l = parse(await call('GET', '/api/lyrics?title=Source%20Song&artist=Source%20Artist'));
  assert.equal(l.lyrics, '[00:01.00] from lrclib');
  // Genius down: its saved copy is used, nothing is fetched
  geniusUp = false;
  asked.length = 0;
  const again = parse(await call('GET', '/api/lyrics?title=Source%20Song&artist=Source%20Artist&source=genius&online=0'));
  assert.equal(again.lyrics, 'Genius line one\nGenius line two');
  assert.deepEqual(asked, []);
});

test('lrclib without the song falls back to Genius', async () => {
  outbound = (req, res, target) => {
    if (target.startsWith('https://genius.com/api/search')) return json(res, { response: { sections: [{ hits: [{ result: { title: 'Only On Genius', artist_names: 'Someone', url: 'https://genius.com/Someone-only-on-genius-lyrics' } }] }] } });
    if (target.startsWith('https://genius.com/Someone')) { res.writeHead(200); return res.end('<div data-lyrics-container="true">Just here</div>'); }
    return json(res, target.includes('/api/get') ? {} : [], target.includes('/api/get') ? 404 : 200);
  };
  assert.equal(parse(await call('GET', '/api/lyrics?title=Only%20On%20Genius&artist=Someone')).lyrics, 'Just here');
});

test('word timings come from NetEase for the matching song', async () => {
  const asked = [];
  outbound = (req, res, target) => {
    asked.push(target);
    if (target.includes('music.163.com/api/search/get')) {
      return json(res, { result: { songs: [
        { id: 7, name: 'Timed Song', duration: 100000, artists: [{ name: 'Timed Artist' }] },
        { id: 8, name: 'Timed Song', duration: 200000, artists: [{ name: 'Timed Artist' }] },
      ] } });
    }
    if (target.includes('music.163.com/api/song/lyric')) {
      assert.match(target, /id=8/);
      return json(res, { yrc: { lyric: '[1000,2000](1000,500,0)Hello (1500,1500,0)world' } });
    }
    return json(res, {}, 404);
  };
  const r = parse(await call('GET', '/api/lyrics-words?title=Timed%20Artist%20-%20Timed%20Song%20(Official%20Video)&artist=TimedArtistVEVO&duration=201'));
  assert.equal(r.success, true);
  assert.deepEqual(r.lines[0].words, [{ text: 'Hello', start: 1, end: 1.5 }, { text: 'world', start: 1.5, end: 3 }]);
  // asked once; the answer is kept
  const before = asked.length;
  parse(await call('GET', '/api/lyrics-words?title=Timed%20Artist%20-%20Timed%20Song%20(Official%20Video)&artist=TimedArtistVEVO&duration=201'));
  assert.equal(asked.length, before);
  const none = parse(await call('GET', '/api/lyrics-words?title=Unknown&artist=Nobody'));
  assert.equal(none.success, false);
  assert.deepEqual(none.lines, []);
});
