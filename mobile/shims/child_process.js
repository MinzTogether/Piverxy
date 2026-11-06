// `child_process.spawn` for the iOS build. iOS can't run processes; the only thing server.js spawns
// is yt-dlp, so this emulates the yt-dlp invocations it makes on top of the in-app extractor.
const { EventEmitter } = require('events');
const fs = require('./fs');
const store = require('./store');
const ex = require('../extract');
const { segmentsToAac, stripId3 } = require('../ts2aac');
const { enforceCacheLimit } = require('../cache-limit');

function fakeProcess(work) {
  const p = new EventEmitter();
  p.stdout = new EventEmitter();
  p.stderr = new EventEmitter();
  let killed = false;
  const ac = new AbortController();
  // like a killed process: stop the work and report the exit right away (server.js cleans up on 'close')
  p.kill = () => { if (killed) return; killed = true; ac.abort(); setTimeout(() => p.emit('close', null), 0); };
  setTimeout(async () => {
    try {
      const out = await work(ac.signal);
      if (killed) return;
      if (out) p.stdout.emit('data', out);
      p.emit('close', 0);
    } catch (e) {
      if (killed) return;
      p.stderr.emit('data', `ERROR: ${e && e.message || e}`);
      p.emit('close', 1);
    }
  }, 0);
  return p;
}

const opt = (args, name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

async function searchJson(target, limit) {
  let entries;
  let m = target.match(/^(yt|sc)search(\d*):(.*)$/);
  if (m) {
    const n = Number(m[2]) || limit || 20;
    entries = m[1] === 'sc' ? await ex.soundcloudSearch(m[3], n) : await ex.youtubeSearch(m[3], n);
  } else if ((m = target.match(/music\.youtube\.com\/search\?q=([^#&]+)/))) {
    entries = await ex.ytMusicSearch(decodeURIComponent(m[1].replace(/\+/g, ' ')), limit || 20);
  } else if (/^https?:\/\//.test(target)) {
    // playlist / album / set link (link import)
    const pl = await ex.playlist(target, limit || 500);
    return JSON.stringify({ title: pl.title, entries: pl.entries });
  } else {
    throw new Error(`unsupported search target ${target}`);
  }
  return JSON.stringify({ entries });
}

// Joins downloaded HLS segments into one playable file:
//  'aac'  (default, YouTube): packed audio / MPEG-TS → raw ADTS .aac
//  'mp3'  (SoundCloud): MP3 segments, ID3 tags stripped, frames appended → .mp3
//  'fmp4' (SoundCloud): init segment + moof/mdat fragments appended → fragmented .m4a
function joinSegments(parts, container) {
  if (container === 'aac' || !container) return segmentsToAac(parts);
  return concat(container === 'mp3' ? parts.map(stripId3) : parts);
}

function concat(pieces) {
  const out = new Uint8Array(pieces.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of pieces) { out.set(x, o); o += x.length; }
  return out;
}

// Fetches every segment of an HLS media playlist and joins them into one file.
async function downloadHls(playlistUrl, headers, signal, container) {
  const m3u = await (await globalThis.__murielFetch(playlistUrl, { headers, signal })).text();
  const lines = m3u.split('\n').map((l) => l.trim());
  const key = lines.find((l) => l.startsWith('#EXT-X-KEY') && !/METHOD=NONE/.test(l));
  if (key) throw new Error('this song is only available encrypted (DRM)');
  const urls = lines.filter((l) => l && !l.startsWith('#')).map((l) => new URL(l, playlistUrl).href);
  // fragmented MP4 needs its init segment (EXT-X-MAP) in front of the first fragment
  const map = lines.map((l) => l.startsWith('#EXT-X-MAP') && (l.match(/URI="([^"]+)"/) || [])[1]).find(Boolean);
  if (map) urls.unshift(new URL(map, playlistUrl).href);
  if (!urls.length) throw new Error('empty HLS playlist');
  return joinSegments(await fetchAll(urls, headers, signal), container);
}

// Fetches every URL (4 at a time) and returns their bodies in order.
async function fetchAll(urls, headers, signal) {
  const parts = new Array(urls.length);
  let next = 0;
  // once one segment has failed for good (or the download was cancelled) the other workers stop too,
  // instead of fetching the rest of a song that can't be finished
  let failed = null;
  const worker = async () => {
    while (next < urls.length && !failed) {
      if (signal && signal.aborted) throw (failed = new Error('download cancelled'));
      const i = next++;
      // a flaky segment shouldn't sink the whole song: retry it a couple of times with a short backoff
      for (let attempt = 0; ; attempt++) {
        try {
          const r = await globalThis.__murielFetch(urls[i], { headers, signal });
          if (!r.ok) throw Object.assign(new Error(`segment ${i} failed: ${r.status}`), { status: r.status });
          parts[i] = new Uint8Array(await r.arrayBuffer());
          break;
        } catch (e) {
          // a 403/404 won't change on retry
          if (attempt >= 2 || failed || (signal && signal.aborted) || (e.status >= 400 && e.status < 500)) throw (failed = failed || e);
          await new Promise((res) => setTimeout(res, 600 * (attempt + 1)));
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, urls.length) }, worker));
  return parts;
}

// A googlevideo file in 1 MiB ranges (like yt-dlp: long single requests get throttled or cut off),
// checked to have arrived whole.
async function downloadRanges(url, headers, signal, size) {
  const step = 1 << 20;
  const urls = [];
  for (let a = 0; a < size; a += step) urls.push(`${url}&range=${a}-${Math.min(size, a + step) - 1}`);
  const bytes = concat(await fetchAll(urls, headers, signal));
  if (bytes.length !== size) throw new Error(`incomplete download: ${bytes.length} of ${size} bytes`);
  return bytes;
}

// Android plays Opus (WebM) natively; set by bridge.js. iOS keeps the AAC stream.
const playsOpus = () => !!globalThis.__murielPlaysOpus;

async function download(args, target, signal) {
  const audio = await ex.resolveAudio(target);
  if (signal && signal.aborted) throw new Error('download cancelled');
  const template = opt(args, '-o');
  // yt-dlp templates: the user-facing download keeps the real container (no ffmpeg on iOS to convert)
  const named = (ext) => (template.includes('%(ext)s') ? template.replace('%(ext)s', ext) : template);
  let out = named(audio.ext);
  let size;
  // full-quality Opus when the extractor found it; any failure falls back to the stream below
  const opus = audio.opus && playsOpus() ? await downloadRanges(audio.opus.url, audio.headers, signal, audio.opus.size).catch((e) => {
    if (signal && signal.aborted) throw e;
    console.warn('[muriel] Opus download failed, using AAC', e && e.message);
    return null;
  }) : null;
  if (opus) {
    out = named('webm');
    await store.writeBytes(out, opus);
    size = opus.length;
  } else if (audio.kind === 'hls') {
    const bytes = await downloadHls(audio.url, audio.headers, signal, audio.container);
    await store.writeBytes(out, bytes);
    size = bytes.length;
  } else {
    size = await store.download(audio.url, out, audio.headers || { 'User-Agent': 'Mozilla/5.0' });
  }
  fs._register(out, size);
  enforceCacheLimit();
  return '';
}

function spawn(bin, args) {
  args = args || [];
  // yt-dlp takes the target anywhere: server.js puts search terms first and URLs last
  const target = [...args].reverse().find((a) => /^(yt|sc)search\d*:|^https?:\/\//.test(a)) || args[args.length - 1];
  const limit = Number(opt(args, '--playlist-end')) || undefined;

  if (args.includes('-g')) return fakeProcess(async () => `${(await ex.resolveAudio(target)).url}\n`);
  if (args.includes('--dump-single-json') || args.includes('-J')) return fakeProcess(() => searchJson(target, limit));
  if (args.includes('--print')) return fakeProcess(async () => `${(await ex.resolveAudio(target)).artist || 'NA'}\n`);
  if (args.includes('-x')) return fakeProcess((signal) => download(args, target, signal));
  return fakeProcess(async () => { throw new Error(`unsupported yt-dlp call: ${args.join(' ')}`); });
}

module.exports = { joinSegments, spawn, execFile: () => { throw new Error('execFile is not available on iOS'); } };
