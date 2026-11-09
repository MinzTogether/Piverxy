// "My Wave" and "For you" from the last launch, kept so the next one opens with songs on screen instead of a
// spinner; the page still asks for fresh ones in the background (stale-while-revalidate).
// It lives in localStorage like the page's other small caches, so it follows the open profile, and profile
// backups leave it out (backup-core NEVER). Whatever is read back is checked and trimmed: a damaged value, an
// older layout or a stale entry reads as "nothing cached" and the page loads exactly as it always did.
const VERSION = 1;
const KEY_WAVE = 'muriel_appcache_wave';
const KEY_FOR_YOU = 'muriel_appcache_foryou';
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SKEW_MS = 24 * 60 * 60 * 1000; // a clock that jumped back must not pin an entry forever
const MAX_BYTES = 256 * 1024; // per entry
const MAX_TRACKS = 30;
const MAX_GENRES = 12;
const MAX_SECTIONS = 12;
const MAX_ITEMS = 40;

const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
const isStr = (x) => typeof x === 'string' && x.trim() !== '';
const isTrack = (t) => isObj(t) && (isStr(t.id) || isStr(t.url) || isStr(t.title));
const isArtist = (a) => isObj(a) && isStr(a.name);
const take = (list, ok, max) => (Array.isArray(list) ? list.filter(ok).slice(0, max) : []);

function cleanWave(d) {
  if (!isObj(d)) return null;
  const tracks = take(d.tracks, isTrack, MAX_TRACKS);
  if (!tracks.length) return null;
  return { tracks, hot: d.hot === true, title: typeof d.title === 'string' ? d.title.slice(0, 120) : '' };
}

// the /api/discover answer the page paints: genres, and sections of artists (items) or songs (tracks)
function cleanForYou(d) {
  if (!isObj(d)) return null;
  const genres = take(d.genres, isStr, MAX_GENRES);
  const sections = [];
  for (const raw of Array.isArray(d.sections) ? d.sections : []) {
    if (sections.length >= MAX_SECTIONS) break;
    if (!isObj(raw) || !isStr(raw.title)) continue;
    const sec = { ...raw };
    if ('items' in sec) sec.items = take(sec.items, isArtist, MAX_ITEMS);
    if ('tracks' in sec) sec.tracks = take(sec.tracks, isTrack, MAX_ITEMS);
    if (!(sec.items || sec.tracks || []).length) continue;
    sections.push(sec);
  }
  if (!genres.length && !sections.length) return null;
  return { success: true, genres, sections };
}

function createHomeCache({ storage, now = Date.now, enabled = () => true } = {}) {
  const read = (key, clean) => {
    try {
      if (!storage || !enabled()) return null;
      const raw = storage.getItem(key);
      if (!raw) return null;
      const rec = JSON.parse(raw);
      if (!isObj(rec) || rec.v !== VERSION || typeof rec.at !== 'number') return null;
      const age = now() - rec.at;
      if (age > MAX_AGE_MS || age < -MAX_SKEW_MS) return null;
      return clean(rec.data);
    } catch (e) { return null; }
  };
  const write = (key, data) => {
    try {
      if (!storage || !enabled() || !data) return false;
      const raw = JSON.stringify({ v: VERSION, at: now(), data });
      if (raw.length > MAX_BYTES) return false;
      storage.setItem(key, raw);
      return true;
    } catch (e) { return false; } // storage full or blocked: the cache is optional
  };
  return {
    readWave: () => read(KEY_WAVE, cleanWave),
    writeWave: (d) => write(KEY_WAVE, cleanWave(d)),
    readForYou: () => read(KEY_FOR_YOU, cleanForYou),
    writeForYou: (d) => write(KEY_FOR_YOU, cleanForYou(d)),
    clear() { try { storage.removeItem(KEY_WAVE); storage.removeItem(KEY_FOR_YOU); } catch (e) {} },
    bytes() {
      try { return [KEY_WAVE, KEY_FOR_YOU].reduce((n, k) => n + String(storage.getItem(k) || '').length, 0); } catch (e) { return 0; }
    },
  };
}

module.exports = { createHomeCache, KEY_WAVE, KEY_FOR_YOU, VERSION, MAX_AGE_MS };
