// Keeps the downloaded-songs cache under the limit chosen in Settings (default 2 GB):
// after each download, the songs touched longest ago are deleted first. The newest few always stay.
const fs = require('./shims/fs');

const TRACKS = '/data/tracks';
const KEEP_NEWEST = 4;

function limitBytes() {
  const mb = parseInt(localStorage.getItem('muriel_cache_limit_mb') || '2048', 10);
  return (Number.isFinite(mb) && mb > 0 ? mb : 2048) * 1024 * 1024;
}

// when each song was last played, from History (it survives restarts; file times only record the download).
// The cache is shared by every profile on the phone, so every profile's History counts.
function lastPlayedById() {
  const out = new Map();
  const P = window.MurielProfiles;
  const histories = P ? P.list().map((p) => P.peek(p.id, 'devsize_history')) : [localStorage.getItem('devsize_history')];
  for (const h of histories) {
    try {
      for (const t of JSON.parse(h || '[]')) {
        if (!t || !t.id || !t.playedAt) continue;
        const id = String(t.id).replace(/[^a-zA-Z0-9_-]/g, '_');
        out.set(id, Math.max(out.get(id) || 0, Number(t.playedAt) || 0));
      }
    } catch (e) {}
  }
  return out;
}

function enforceCacheLimit() {
  const limit = limitBytes();
  const played = lastPlayedById();
  let files;
  try {
    files = fs.readdirSync(TRACKS).map((n) => {
      const st = fs.statSync(`${TRACKS}/${n}`);
      const id = n.replace(/(\.temp)?\.[^.]+$/, '');
      return { path: `${TRACKS}/${n}`, size: st.size, used: Math.max(st.mtimeMs, played.get(id) || 0), temp: n.includes('.temp.') };
    });
  } catch (e) { return; }
  // the download that is still being written counts towards the limit (the cache stayed one song over)
  let total = files.reduce((n, f) => n + f.size, 0);
  if (total <= limit) return;
  files = files.filter((f) => !f.temp);
  files.sort((a, b) => a.used - b.used); // played longest ago first
  const removable = files.slice(0, Math.max(0, files.length - KEEP_NEWEST));
  for (const f of removable) {
    if (total <= limit) break;
    try { fs.unlinkSync(f.path); total -= f.size; } catch (e) {}
  }
  if (window.MurielLog) window.MurielLog.add('info', `cache trimmed to ${Math.round(total / 1048576)} MB`);
}

module.exports = { enforceCacheLimit };
