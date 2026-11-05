'use strict';

// Phones got YouTube songs as ~128 kbps AAC (the visionOS client's HLS). The same player answer also lists the
// full-quality Opus file (itag 251); Android, which plays WebM/Opus, now downloads that in ranges and falls back
// to the AAC stream when it can't. iOS keeps AAC.
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');

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

const { spawn } = require('../mobile/shims/child_process');

// ---- a fake YouTube ----
const OPUS = 'https://rr1.googlevideo.com/videoplayback?itag=251&c=VISIONOS';
const MASTER = 'https://manifest.googlevideo.com/master.m3u8';
const AAC = 'https://manifest.googlevideo.com/itag/234/playlist.m3u8';
let opusSize;
let opusStatus;
let opusShort;
let requested;
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
  requested.push(url);
  if (url === 'https://www.youtube.com/') return respond('"VISITOR_DATA":"visitor123"');
  if (url.startsWith('https://www.youtube.com/youtubei/v1/player')) {
    return respond({
      playabilityStatus: { status: 'OK' },
      videoDetails: { title: 'Song', author: 'Artist - Topic', lengthSeconds: '150' },
      streamingData: {
        hlsManifestUrl: MASTER,
        adaptiveFormats: [
          { itag: 140, url: 'https://rr1.googlevideo.com/videoplayback?itag=140', contentLength: '999' },
          { itag: 251, url: OPUS, contentLength: String(opusSize) },
        ],
      },
    });
  }
  if (url === MASTER) return respond(`#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",URI="${AAC}"\n`);
  if (url === AAC) return respond('#EXTM3U\n#EXTINF:10,\nhttps://manifest.googlevideo.com/seg/0\n#EXT-X-ENDLIST\n');
  if (url === 'https://manifest.googlevideo.com/seg/0') return respond(new Uint8Array([0xff, 0xf1, 7]));
  if (url.startsWith(`${OPUS}&range=`)) {
    if (opusStatus !== 200) return respond('', opusStatus);
    const [a, b] = url.split('&range=')[1].split('-').map(Number);
    const part = new Uint8Array(b - a + 1).map((_, i) => (a + i) % 251);
    return respond(opusShort ? part.subarray(1) : part);
  }
  return respond('', 404);
};

function runDownload() {
  return new Promise((resolve, reject) => {
    const p = spawn('yt-dlp', ['-x', '-o', '/data/cache/abc.temp.%(ext)s', '--', 'https://www.youtube.com/watch?v=nac6B__nFl0']);
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err))));
  });
}

const warn = console.warn;
beforeEach(() => { written.clear(); requested = []; opusSize = (1 << 20) + 5; opusStatus = 200; opusShort = false; globalThis.__murielPlaysOpus = true; console.warn = () => {}; });
afterEach(() => { console.warn = warn; });

test('Android gets the whole Opus file, fetched in 1 MiB ranges', async () => {
  await runDownload();
  const file = written.get('/data/cache/abc.temp.webm');
  assert.ok(file instanceof Uint8Array);
  assert.equal(file.length, opusSize);
  assert.ok(file.every((x, i) => x === i % 251));
  assert.deepEqual(requested.filter((u) => u.startsWith(OPUS)).map((u) => u.split('&range=')[1]), ['0-1048575', `1048576-${opusSize - 1}`]);
  assert.equal(written.has('/data/cache/abc.temp.aac'), false);
});

test('a refused Opus file falls back to the AAC stream', async () => {
  opusStatus = 403;
  await runDownload();
  assert.deepEqual([...written.get('/data/cache/abc.temp.aac')], [0xff, 0xf1, 7]);
  assert.equal(written.has('/data/cache/abc.temp.webm'), false);
});

test('a cut-off Opus file is not saved', async () => {
  opusShort = true;
  await runDownload();
  assert.equal(written.has('/data/cache/abc.temp.webm'), false);
  assert.ok(written.has('/data/cache/abc.temp.aac'));
});

test('iPhone keeps the AAC stream and never asks for Opus', async () => {
  globalThis.__murielPlaysOpus = false;
  await runDownload();
  assert.ok(written.has('/data/cache/abc.temp.aac'));
  assert.equal(requested.some((u) => u.startsWith(OPUS)), false);
});
