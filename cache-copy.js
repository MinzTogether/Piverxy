'use strict';

// Caching a song that already plays (#17). The app used to run `yt-dlp -x` for it, a second full
// extraction (YouTube's player challenge included) of a song whose stream URL it had just looked up.
// ffmpeg reads that URL instead: an Opus stream (YouTube's usual audio) is copied into an .opus file
// without re-encoding, anything else (AAC, MP3, SoundCloud's HLS) is converted to Opus 128k like
// yt-dlp did. When the URL no longer works (expired, 403) the caller falls back to yt-dlp.

const { spawn } = require('child_process');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function cacheCopyArgs(url, outPath, mode) {
  const input = /^https?:/i.test(url)
    ? ['-user_agent', UA, '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5', '-rw_timeout', '20000000', '-i', url]
    : ['-i', url];
  const codec = mode === 'copy' ? ['-c:a', 'copy'] : ['-c:a', 'libopus', '-b:a', '128k'];
  return ['-y', '-v', 'error', '-nostdin', ...input, '-vn', '-map', '0:a:0', ...codec, '-f', 'opus', outPath];
}

function runFfmpeg(bin, args, { spawnFn = spawn, onChild, timeoutMs = 10 * 60 * 1000 } = {}) {
  return new Promise((resolve) => {
    let proc;
    try { proc = spawnFn(bin, args, { windowsHide: true }); } catch (e) { return resolve({ code: -1, err: String(e && e.message || e) }); }
    if (onChild) { try { onChild(proc); } catch (_) {} }
    let err = '';
    if (proc.stderr) proc.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch (_) {} }, timeoutMs);
    proc.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, err: String(e && e.message || e) }); });
    proc.on('close', (code) => { clearTimeout(timer); resolve({ code, err }); });
  });
}

// Copies the stream at `url` into `outPath` (an .opus file). Resolves true when a usable file is there.
// opts: { spawnFn, onChild(proc), minBytes, fs }
async function copyStreamToCache(ffmpegBin, url, outPath, opts = {}) {
  const fs = opts.fs || require('fs');
  const minBytes = opts.minBytes == null ? 60000 : opts.minBytes;
  const ok = async () => { try { return (await fs.promises.stat(outPath)).size > minBytes; } catch (_) { return false; } };
  const drop = async () => { try { await fs.promises.unlink(outPath); } catch (_) {} };
  if (!ffmpegBin || !url) return false;
  // YouTube's itag 251 (and most of its audio) is Opus already: no re-encoding, so hardly any CPU
  let r = await runFfmpeg(ffmpegBin, cacheCopyArgs(url, outPath, 'copy'), opts);
  if (r.code === 0 && await ok()) return true;
  await drop();
  if (r.code === null) return false; // killed (skipped)
  // a 403/404 won't get better by converting: the caller asks yt-dlp for a fresh URL instead
  if (/\b(403|404|410)\b|Forbidden|Not Found/i.test(r.err || '')) return false;
  r = await runFfmpeg(ffmpegBin, cacheCopyArgs(url, outPath, 'opus'), opts);
  if (r.code === 0 && await ok()) return true;
  await drop();
  return false;
}

module.exports = { cacheCopyArgs, copyStreamToCache };
