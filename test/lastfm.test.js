'use strict';

// Last.fm scrobbling: the rules (lastfm-core.js), the phone's MD5 (Last.fm signs with it) and the server routes,
// with Last.fm itself faked. The session key must never reach the page, and is only stored encrypted.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const Module = require('node:module');
const { PassThrough } = require('node:stream');
const L = require('../lastfm-core.js');

test('a song is scrobbled after half its length or 4 minutes, and only if longer than 30 seconds', () => {
  assert.equal(L.scrobbleAfter(30), 0);
  assert.equal(L.scrobbleAfter(20), 0);
  assert.equal(L.scrobbleAfter(31), 15.5);
  assert.equal(L.scrobbleAfter(200), 100);
  assert.equal(L.scrobbleAfter(480), 240);
  assert.equal(L.scrobbleAfter(3600), 240);
  // length unknown: the full 4 minutes (which also proves it's longer than 30 s); a live stream: never
  assert.equal(L.scrobbleAfter(0), 240);
  assert.equal(L.scrobbleAfter(NaN), 240);
  assert.equal(L.scrobbleAfter(Infinity), 0);
});

// plays a song through the tracker: steps of [seconds of wall time, new position, playing]
function play(tracker, key, duration, steps, start = 1_700_000_000_000) {
  let now = start;
  const events = [];
  tracker.tick({ key, playing: true, position: 0, duration, now });
  for (const [dt, pos, playing = true] of steps) {
    now += dt * 1000;
    const out = tracker.tick({ key, playing, position: pos, duration, now });
    if (out.nowPlaying) events.push(['np', pos]);
    if (out.scrobble) events.push(['scrobble', pos, out.scrobble.timestamp]);
  }
  return events;
}
const steady = (from, to, step = 1) => { const s = []; for (let p = from + step; p <= to; p += step) s.push([step, p]); return s; };

test('listening time decides: now playing after a second, one scrobble at the halfway mark, stamped with the start', () => {
  const tr = L.createTracker();
  const ev = play(tr, 'a', 200, steady(0, 150));
  assert.deepEqual(ev[0], ['np', 1]);
  assert.deepEqual(ev[1], ['scrobble', 100, 1_700_000_000]);
  assert.equal(ev.length, 2, 'scrobbled once, announced once');
});

test('seeking ahead and pausing do not count as listening', () => {
  const tr = L.createTracker();
  // 10 s listened, jump to 150 s (of 200), 5 s more: 15 s heard, nowhere near the 100 s needed
  const ev = play(tr, 'b', 200, [...steady(0, 10), [0.2, 150], ...steady(150, 155)]);
  assert.ok(!ev.some((e) => e[0] === 'scrobble'));
  assert.ok(tr.state.listened < 16 && tr.state.listened > 14);
  // paused for a long while, the position doesn't move: still nothing
  const tr2 = L.createTracker();
  const ev2 = play(tr2, 'c', 100, [...steady(0, 20), [600, 20, false], [1, 21]]);
  assert.ok(!ev2.some((e) => e[0] === 'scrobble'));
  assert.ok(tr2.state.listened <= 21);
});

test('a short song is never scrobbled, a long one after 4 minutes', () => {
  const short = L.createTracker();
  assert.ok(!play(short, 's', 25, steady(0, 25)).some((e) => e[0] === 'scrobble'));
  const long = L.createTracker();
  const ev = play(long, 'l', 1200, steady(0, 300, 2));
  assert.deepEqual(ev.find((e) => e[0] === 'scrobble').slice(0, 2), ['scrobble', 240]);
});

test('the same song again from the top is a new listen; another song starts over', () => {
  const tr = L.createTracker();
  const ev = play(tr, 'r', 60, [...steady(0, 60), [1, 0.5], ...steady(0.5, 40.5)]);
  assert.equal(ev.filter((e) => e[0] === 'scrobble').length, 2);
  const tr2 = L.createTracker();
  play(tr2, 'x', 200, steady(0, 50));
  const ev2 = play(tr2, 'y', 200, steady(0, 3));
  assert.deepEqual(ev2.map((e) => e[0]), ['np']);
  assert.ok(tr2.state.listened <= 3);
});

test('song names are cleaned up the way Last.fm files them', () => {
  assert.deepEqual(L.cleanMeta({ title: 'Blinding Lights (Official Video)', artist: 'TheWeekndVEVO', duration: 200 }), { artist: 'TheWeeknd', track: 'Blinding Lights', duration: 200 });
  assert.deepEqual(L.cleanMeta({ title: 'Daft Punk - Get Lucky [Official Audio]', artist: 'Some Music Channel' }), { artist: 'Daft Punk', track: 'Get Lucky' });
  // a real artist with a version suffix in the title is left alone
  assert.deepEqual(L.cleanMeta({ title: 'Bohemian Rhapsody - Remastered 2011', artist: 'Queen' }), { artist: 'Queen', track: 'Bohemian Rhapsody - Remastered 2011' });
  assert.deepEqual(L.cleanMeta({ title: 'Queen - Bohemian Rhapsody', artist: 'Queen' }), { artist: 'Queen', track: 'Bohemian Rhapsody' });
  assert.equal(L.cleanMeta({ title: 'Song', artist: 'Artist - Topic' }).artist, 'Artist');
  assert.equal(L.cleanMeta({ title: 'Song', artist: 'Dua Lipa feat. DaBaby' }).artist, 'Dua Lipa');
  assert.equal(L.cleanMeta({ title: 'Song', artist: 'A (ft. B)' }).artist, 'A');
  assert.equal(L.cleanMeta({ title: 'Song', artist: 'A, B & C' }).artist, 'A');
  assert.equal(L.cleanMeta({ title: 'The Boxer', artist: 'Simon & Garfunkel' }).artist, 'Simon & Garfunkel');
  assert.equal(L.cleanMeta({ title: '', artist: 'X' }), null);
  assert.equal(L.cleanMeta({ title: 'Untitled', artist: 'Unknown artist' }), null);
  assert.equal(L.cleanMeta({ title: 'x'.repeat(2000), artist: 'y' }).track.length, 512);
});

test("the phone's MD5 matches Node's (Last.fm signatures are MD5)", () => {
  const shim = require('../mobile/shims/crypto.js');
  for (const s of ['', 'abc', 'api_keyxmethodauth.getTokensecret', 'ünïcødé ✓'.repeat(40), 'x'.repeat(55), 'x'.repeat(64)]) {
    assert.equal(shim.createHash('md5').update(s).digest('hex'), crypto.createHash('md5').update(s, 'utf8').digest('hex'));
  }
});

function post(port, route, body, token) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: route, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...(token ? { 'X-Muriel-Token': token } : {}) } }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => { let json; try { json = JSON.parse(raw); } catch (_) { json = raw; } resolve({ status: res.statusCode, data: json, raw }); });
    });
    req.on('error', reject);
    req.end(data);
  });
}

test('server: Last.fm logins are per profile, kept encrypted, and never handed to the page', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muriel-lastfm-'));
  const oldDataDir = process.env.MURIEL_DATA_DIR;
  const oldElectron = process.versions.electron;
  const oldLoad = Module._load;
  const oldRequest = https.request;
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (v) => Buffer.from(`sealed:${Buffer.from(v).toString('base64')}`),
    decryptString: (v) => Buffer.from(v.toString().slice(7), 'base64').toString(),
  };
  const calls = [];
  let revoked = false;
  let server;
  const SK = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
  const CUSTOM = { key: 'c'.repeat(32), secret: 'd'.repeat(32) };
  try {
    process.env.MURIEL_DATA_DIR = dir;
    process.versions.electron = '41';
    Module._load = function (name, parent, isMain) {
      if (name === 'electron') return { safeStorage };
      return oldLoad.call(this, name, parent, isMain);
    };
    https.request = (opts, callback) => {
      assert.equal(opts.hostname, 'ws.audioscrobbler.com');
      let body = '';
      const req = new PassThrough();
      req.write = (c) => { body += c; return true; };
      req.end = () => {
        const params = new URLSearchParams(opts.method === 'GET' ? opts.path.split('?')[1] : body);
        const p = Object.fromEntries(params);
        calls.push(p);
        // every call is signed: md5 of the sorted params (minus format) and the secret
        const secret = p.api_key === CUSTOM.key ? CUSTOM.secret : '716cc0a784bb62835de5bd674e65eb57';
        const sig = crypto.createHash('md5').update(Object.keys(p).filter((k) => k !== 'format' && k !== 'api_sig').sort().map((k) => k + p[k]).join('') + secret).digest('hex');
        assert.equal(p.api_sig, sig, `bad signature for ${p.method}`);
        let answer;
        if (p.method === 'auth.getToken') answer = { token: 'tok12345678' };
        else if (p.method === 'auth.getSession') answer = calls.filter((c) => c.method === 'auth.getSession').length < 2 ? { error: 14, message: 'This token has not been authorized' } : { session: { name: 'webuser', key: SK, subscriber: 0 } };
        else if (p.method === 'auth.getMobileSession') answer = p.password === 'right' ? { session: { name: p.username, key: SK } } : { error: 4, message: 'Invalid username or password' };
        else if (revoked) answer = { error: 9, message: 'Invalid session key - Please re-authenticate' };
        else if (p.method === 'track.updateNowPlaying') answer = { nowplaying: {} };
        else if (p.method === 'track.scrobble') answer = { scrobbles: { '@attr': { accepted: 1, ignored: 0 } } };
        const res = new PassThrough();
        res.statusCode = 200;
        process.nextTick(() => { callback(res); res.end(JSON.stringify(answer)); });
      };
      req.on = function (ev, fn) { PassThrough.prototype.on.call(this, ev, fn); return this; };
      return req;
    };

    delete require.cache[require.resolve('../server')];
    server = require('../server');
    let port = await server.startServer(0);
    let token = server.getServerToken();

    // no token, no Last.fm (any web page can reach 127.0.0.1)
    assert.equal((await post(port, '/api/lastfm/status', { profile: 'default' })).status, 403);
    assert.equal((await post(port, '/api/lastfm/status', { profile: '../x' }, token)).status, 400);
    assert.equal((await post(port, '/api/lastfm/status', { profile: 'default' }, token)).data.connected, false);

    // browser sign-in: token, a first poll before approval, then the session
    const start = await post(port, '/api/lastfm/token', { profile: 'default' }, token);
    assert.equal(start.data.success, true);
    assert.match(start.data.authUrl, /^https:\/\/www\.last\.fm\/api\/auth\/\?api_key=[a-f0-9]{32}&token=tok12345678$/);
    assert.equal((await post(port, '/api/lastfm/session', { profile: 'default' }, token)).data.pending, true);
    const done = await post(port, '/api/lastfm/session', { profile: 'default' }, token);
    assert.equal(done.data.success, true);
    assert.equal(done.data.username, 'webuser');
    assert.ok(!done.raw.includes(SK), 'the session key stays in the server');

    // direct sign-in for another profile, with its own API key pair; the password isn't kept
    const wrong = await post(port, '/api/lastfm/mobile-session', { profile: 'abcd1234', username: 'phone', password: 'nope', apiKey: CUSTOM.key, apiSecret: CUSTOM.secret }, token);
    assert.equal(wrong.data.success, false);
    assert.match(wrong.data.error, /Wrong Last.fm username or password/);
    assert.equal((await post(port, '/api/lastfm/mobile-session', { profile: 'abcd1234', username: 'phone', password: 'x', apiKey: 'short', apiSecret: 'y' }, token)).status, 400);
    const ok = await post(port, '/api/lastfm/mobile-session', { profile: 'abcd1234', username: 'phone', password: 'right', apiKey: CUSTOM.key, apiSecret: CUSTOM.secret }, token);
    assert.equal(ok.data.success, true);
    assert.ok(!ok.raw.includes(SK));

    const stored = fs.readFileSync(path.join(dir, 'lastfm-auth.enc'));
    assert.ok(stored.toString().startsWith('sealed:'), 'stored through safeStorage');
    for (const secret of [SK, 'right', CUSTOM.secret]) assert.ok(!stored.includes(Buffer.from(secret)), 'nothing readable on disk');
    const opened = JSON.parse(safeStorage.decryptString(stored));
    assert.deepEqual(Object.keys(opened).sort(), ['abcd1234', 'default']);
    assert.ok(!JSON.stringify(opened).includes('right'), 'the password is not stored');

    // now playing and scrobbles go out with the stored key of that profile, signed with its own pair
    assert.equal((await post(port, '/api/lastfm/now-playing', { profile: 'default', artist: 'A', track: 'T', duration: 200 }, token)).data.success, true);
    const np = calls[calls.length - 1];
    assert.equal(np.method, 'track.updateNowPlaying');
    assert.equal(np.sk, SK);
    assert.equal(np.duration, '200');
    const ts = Math.floor(Date.now() / 1000) - 120;
    const sc = await post(port, '/api/lastfm/scrobble', { profile: 'abcd1234', artist: 'A', track: 'T', album: 'Al', timestamp: ts }, token);
    assert.deepEqual(sc.data, { success: true, accepted: 1 });
    const last = calls[calls.length - 1];
    assert.equal(last.method, 'track.scrobble');
    assert.equal(last.api_key, CUSTOM.key);
    assert.equal(last['timestamp[0]'], String(ts));
    assert.equal(last['album[0]'], 'Al');
    // a timestamp from long ago becomes now (Last.fm refuses scrobbles older than two weeks)
    await post(port, '/api/lastfm/scrobble', { profile: 'default', artist: 'A', track: 'T', timestamp: 1000 }, token);
    assert.ok(Math.abs(Number(calls[calls.length - 1]['timestamp[0]']) - Date.now() / 1000) < 5);
    assert.equal((await post(port, '/api/lastfm/scrobble', { profile: 'default', artist: '', track: 'T' }, token)).status, 400);
    assert.equal((await post(port, '/api/lastfm/scrobble', { profile: 'zzzz9999', artist: 'A', track: 'T' }, token)).data.code, 'not_connected');

    // the logins survive a restart
    await server.stopServer();
    delete require.cache[require.resolve('../server')];
    server = require('../server');
    port = await server.startServer(0);
    token = server.getServerToken();
    assert.deepEqual((await post(port, '/api/lastfm/status', { profile: 'abcd1234' }, token)).data.username, 'phone');

    // a deleted profile's login is forgotten
    await post(port, '/api/lastfm/status', { profile: 'default', profiles: ['default'] }, token);
    assert.deepEqual(Object.keys(JSON.parse(safeStorage.decryptString(fs.readFileSync(path.join(dir, 'lastfm-auth.enc'))))), ['default']);

    // revoked on last.fm: signed out here too
    revoked = true;
    assert.equal((await post(port, '/api/lastfm/now-playing', { profile: 'default', artist: 'A', track: 'T' }, token)).data.code, 'reauth');
    assert.equal((await post(port, '/api/lastfm/status', { profile: 'default' }, token)).data.connected, false);
    revoked = false;

    // log out
    await post(port, '/api/lastfm/mobile-session', { profile: 'default', username: 'u', password: 'right' }, token);
    assert.equal((await post(port, '/api/lastfm/logout', { profile: 'default' }, token)).data.success, true);
    assert.equal((await post(port, '/api/lastfm/status', { profile: 'default' }, token)).data.connected, false);
    assert.equal((await post(port, '/api/lastfm/token', { profile: 'default' }, token)).status, 200);
  } finally {
    if (server) await server.stopServer();
    delete require.cache[require.resolve('../server')];
    https.request = oldRequest;
    Module._load = oldLoad;
    if (oldDataDir === undefined) delete process.env.MURIEL_DATA_DIR; else process.env.MURIEL_DATA_DIR = oldDataDir;
    if (oldElectron === undefined) delete process.versions.electron; else process.versions.electron = oldElectron;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('server: without a keychain the login lasts until Muriel closes, and says so', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muriel-lastfm-'));
  const oldDataDir = process.env.MURIEL_DATA_DIR;
  const oldRequest = https.request;
  let server;
  try {
    process.env.MURIEL_DATA_DIR = dir;
    https.request = (opts, callback) => {
      const req = new PassThrough();
      req.write = () => true;
      req.end = () => { const res = new PassThrough(); res.statusCode = 200; process.nextTick(() => { callback(res); res.end(JSON.stringify({ session: { name: 'u', key: 'f'.repeat(32) } })); }); };
      req.on = function (ev, fn) { PassThrough.prototype.on.call(this, ev, fn); return this; };
      return req;
    };
    delete require.cache[require.resolve('../server')];
    server = require('../server');
    const port = await server.startServer(0);
    const token = server.getServerToken();
    const r = await post(port, '/api/lastfm/mobile-session', { profile: 'default', username: 'u', password: 'p' }, token);
    assert.equal(r.data.success, true);
    assert.equal(r.data.saved, false);
    assert.match(r.data.error, /until Muriel closes|saved securely/);
    assert.ok(!fs.existsSync(path.join(dir, 'lastfm-auth.enc')));
  } finally {
    if (server) await server.stopServer();
    delete require.cache[require.resolve('../server')];
    https.request = oldRequest;
    if (oldDataDir === undefined) delete process.env.MURIEL_DATA_DIR; else process.env.MURIEL_DATA_DIR = oldDataDir;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
