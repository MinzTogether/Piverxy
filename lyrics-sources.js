// More places to get lyrics from (Riff 43): Genius pages (plain lyrics, picked in Settings → Lyrics source, with
// lrclib as the fallback either way) and NetEase's word-timed lyrics ("yrc"), which give word-by-word karaoke real
// timings instead of evenly spread ones. Also lines that carry their own word times as <mm:ss.xx> tags (enhanced
// LRC). Only text handling lives here: server.js does the fetching, app.js lines the word times up with the lyrics
// it shows. test/lyrics-sources.test.js runs this in Node.
(function () {
  const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#039': "'", '#39': "'" };
  function decodeEntities(s) {
    return String(s || '').replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
      const k = e.toLowerCase();
      if (ENTITIES[k] !== undefined) return ENTITIES[k];
      if (k.startsWith('#x')) return String.fromCodePoint(parseInt(k.slice(2), 16));
      if (k.startsWith('#')) return String.fromCodePoint(parseInt(k.slice(1), 10));
      return m;
    });
  }

  // the lyrics on a genius.com song page: every <div data-lyrics-container="true"> block, as plain lines
  function extractGeniusLyrics(html) {
    html = String(html || '');
    const marker = 'data-lyrics-container="true"';
    const blocks = [];
    let pos = 0;
    for (;;) {
      const idx = html.indexOf(marker, pos);
      if (idx === -1) break;
      const contentStart = html.indexOf('>', idx) + 1;
      let depth = 1;
      let cur = contentStart;
      let closed = false;
      while (depth > 0 && cur < html.length) {
        const nextOpen = html.indexOf('<div', cur);
        const nextClose = html.indexOf('</div>', cur);
        if (nextClose === -1) break;
        if (nextOpen !== -1 && nextOpen < nextClose) { depth++; cur = nextOpen + 4; continue; }
        depth--;
        if (depth === 0) { blocks.push(html.substring(contentStart, nextClose)); pos = nextClose + 6; closed = true; break; }
        cur = nextClose + 6;
      }
      if (!closed) break;
    }
    // Genius puts the "Read more" header and annotations inside the container as their own elements
    let text = decodeEntities(blocks.join('\n')
      .replace(/<div[^>]*data-exclude-from-selection="true"[^>]*>[\s\S]*?<\/div>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ''));
    // section headers ([Chorus], [Verse 2: Someone]) go; the ones that mean "no singing here" stay
    text = text.replace(/\[(?!(?:instrumental|music|intro|outro|solo)\b)[^\]\n]*\]/gi, '').replace(/\n{3,}/g, '\n\n');
    return text.split('\n')
      .map(l => l.trim())
      .filter(l => !/^\d*\s*Contributors?\b/i.test(l) && !(/Lyrics$/i.test(l) && !l.includes(' ') && l.length < 30))
      .join('\n')
      .trim();
  }

  const simple = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, '');
  const overlaps = (a, b) => !!a && !!b && (a === b || a.includes(b) || b.includes(a));

  // the Genius search hit for this song: the title has to match, the artist too when the hit names one
  function pickGeniusHit(hits, title, artist) {
    const t = simple(title);
    const artists = String(artist || '').split(/\s*(?:,|&|\/|\+|\bx\b|\band\b|\bfeat\.?|\bft\.?)\s*/i).map(simple).filter(Boolean);
    let best = null;
    let bestScore = 0;
    for (const h of Array.isArray(hits) ? hits : []) {
      const r = h && (h.result || h);
      if (!r || !r.url || !/^https:\/\/genius\.com\//.test(r.url)) continue;
      if (!overlaps(simple(r.title), t)) continue;
      const ha = simple(r.artist_names || (r.primary_artist && r.primary_artist.name));
      const artistOk = !artists.length || !ha || artists.some(a => overlaps(a, ha));
      if (!artistOk) continue;
      const score = (simple(r.title) === t ? 2 : 1) + (ha && artists.some(a => a === ha) ? 1 : 0);
      if (score > bestScore) { best = r; bestScore = score; }
    }
    return best ? best.url : null;
  }

  const CJK = /[぀-ヿ㐀-䶿一-鿿가-힯]/;

  // one yrc line's words: "(start,dur,0)text" pieces; Latin pieces are glued until a space, CJK ones stand alone
  function parseYrcWords(rest) {
    const re = /\((\d+),(\d+)(?:,\d+)?\)([^(]*)/g;
    const words = [];
    let cur = null;
    const flush = () => { if (cur) { cur.text = cur.text.trim(); if (cur.text) words.push(cur); cur = null; } };
    let m;
    while ((m = re.exec(rest)) !== null) {
      const start = parseInt(m[1], 10) / 1000;
      const end = (parseInt(m[1], 10) + parseInt(m[2], 10)) / 1000;
      const piece = m[3];
      const isCjk = CJK.test(piece);
      if (cur && (isCjk || CJK.test(cur.text))) flush();
      if (!cur) cur = { text: piece, start, end };
      else { cur.text += piece; cur.end = Math.max(cur.end, end); }
      if (/\s/.test(piece) || isCjk) flush();
    }
    flush();
    return words;
  }

  // NetEase "yrc": "[lineStartMs,lineDurMs](wordStartMs,wordDurMs,0)word ..." per line; credit lines are left out
  function parseYrc(text) {
    const lines = [];
    for (const raw of String(text || '').split('\n')) {
      const m = /^\[(\d+),(\d+)\](.*)$/.exec(raw.trim());
      if (!m) continue;
      const words = parseYrcWords(m[3]);
      if (!words.length) continue;
      const full = words.map(w => w.text).join(' ').replace(/\s+/g, ' ').trim();
      if (!full || /^(作词|作曲|编曲|制作人|混音|母带|和声|吉他|贝斯|鼓|录音|监制|出品|发行)\s*[:：]/.test(full)) continue;
      lines.push({ start: parseInt(m[1], 10) / 1000, end: (parseInt(m[1], 10) + parseInt(m[2], 10)) / 1000, text: full, words });
    }
    return lines;
  }

  // the NetEase search result that is this song: length within 3 s (when known), title and an artist matching
  function pickNetEaseSong(songs, title, artist, duration) {
    const t = simple(title);
    const artists = String(artist || '').split(/\s*(?:,|&|\/|\+|\bx\b|\band\b|\bfeat\.?|\bft\.?)\s*/i).map(simple).filter(Boolean);
    for (const s of Array.isArray(songs) ? songs : []) {
      if (!s || !s.id) continue;
      const len = (Number(s.duration || s.dt) || 0) / 1000;
      if (duration > 0 && len > 0 && Math.abs(len - duration) > 3) continue;
      if (!overlaps(simple(s.name), t)) continue;
      const cand = (s.artists || s.ar || []).map(a => simple(a && a.name)).filter(Boolean);
      if (artists.length && cand.length && !cand.some(c => artists.some(a => overlaps(a, c)))) continue;
      return s.id;
    }
    return null;
  }

  // "<00:12.34>word <00:12.80>word" inside an LRC line -> [{ text, start, end }], or null without word tags
  function parseEnhancedLrcWords(lineStr, lineEnd) {
    const re = /<(\d+):(\d+(?:\.\d+)?)>/g;
    const tags = [];
    let m;
    while ((m = re.exec(lineStr)) !== null) tags.push({ time: parseInt(m[1], 10) * 60 + parseFloat(m[2]), from: m.index, to: m.index + m[0].length });
    const words = [];
    tags.forEach((tag, i) => {
      const next = tags[i + 1];
      const text = lineStr.substring(tag.to, next ? next.from : lineStr.length).trim();
      if (!text) return;
      const end = next ? next.time : (lineEnd > tag.time ? lineEnd : tag.time + 0.5);
      for (const part of text.split(/\s+/)) words.push({ text: part, start: tag.time, end });
    });
    return words.length ? words : null;
  }

  // 0..1: how alike two lines are, ignoring case, punctuation and spacing
  function lineSimilarity(a, b) {
    const x = simple(a);
    const y = simple(b);
    if (!x && !y) return 1;
    if (!x || !y) return 0;
    if (x === y) return 1;
    if (x.includes(y) || y.includes(x)) return Math.min(x.length, y.length) / Math.max(x.length, y.length);
    // longest common subsequence: a dropped "oh" or a different apostrophe shouldn't sink the match
    const prev = new Array(y.length + 1).fill(0);
    for (let i = 1; i <= x.length; i++) {
      let diag = 0;
      for (let j = 1; j <= y.length; j++) {
        const keep = prev[j];
        prev[j] = x[i - 1] === y[j - 1] ? diag + 1 : Math.max(prev[j], prev[j - 1]);
        diag = keep;
      }
    }
    return prev[y.length] / Math.max(x.length, y.length);
  }

  // a line's words for karaoke: split at spaces, CJK text one character at a time
  function lineTokens(text) {
    const out = [];
    for (const w of String(text || '').replace(/<[^>]+>/g, '').trim().split(/\s+/)) {
      if (!w) continue;
      if (CJK.test(w)) { for (const ch of Array.from(w)) if (simple(ch)) out.push(ch); } else out.push(w);
    }
    return out;
  }
  const sameWord = (a, b) => a === b || (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a)));

  // word times from `wordLines` (NetEase) for the synced lyrics on screen (`lines`, from lrclib/Genius). The two
  // sites split lines differently, so this goes word by word: each shown word takes the time of the same word
  // NetEase has around that line's time. Returns each line's words (or undefined for a line too few words of which
  // were found), or null when too little matched to be the same lyrics.
  function alignWordTimings(lines, wordLines) {
    const shown = [];
    (lines || []).forEach((l, i) => { if (l && l.text && !l.isGap && l.time >= 0) shown.push(i); });
    const pool = [];
    for (const wl of wordLines || []) for (const w of wl.words || []) { const n = simple(w.text); if (n) pool.push({ n, start: w.start, end: w.end }); }
    if (!shown.length || !pool.length) return null;
    const matches = [];
    let p = 0;
    shown.forEach((i, k) => {
      const line = lines[i];
      const next = k + 1 < shown.length ? lines[shown[k + 1]].time : line.time + 8;
      const toks = lineTokens(line.text);
      if (!toks.length) return;
      const hit = new Array(toks.length);
      let found = 0;
      // where this line's words can be: from a little before it starts to a little after the next one starts
      while (p < pool.length && pool[p].start < line.time - 2.5) p++;
      let q = p;
      toks.forEach((tok, j) => {
        const n = simple(tok);
        for (let c = q; c < pool.length && pool[c].start <= next + 2.5; c++) {
          if (n && sameWord(pool[c].n, n)) { hit[j] = pool[c]; q = c + 1; found++; break; }
        }
      });
      if (found / toks.length < 0.7) return;
      p = q;
      matches.push({ i, next, toks, hit });
    });
    if (matches.length / shown.length < 0.6) return null;
    // the two sites may have timed slightly different releases: move NetEase's words by the usual gap between a
    // line's start and its first word, so the words follow the line highlighting on screen
    const gaps = matches.filter(m => m.hit[0]).map(m => lines[m.i].time - m.hit[0].start).sort((a, b) => a - b);
    const median = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0;
    const shift = Math.abs(median) > 0.25 ? median : 0;
    const out = new Array(lines.length);
    for (const { i, next, toks, hit } of matches) {
      const line = lines[i];
      // words NetEase doesn't have get the time between their neighbours
      const words = toks.map((tok, j) => (hit[j] ? { text: tok, start: hit[j].start + shift, end: hit[j].end + shift } : { text: tok, start: null, end: null }));
      for (let j = 0; j < words.length; j++) {
        if (words[j].start !== null) continue;
        let e = j;
        while (e < words.length && words[e].start === null) e++;
        const from = j > 0 ? words[j - 1].end : Math.min(line.time, e < words.length ? words[e].start : line.time);
        const to = e < words.length ? words[e].start : Math.max(from + 0.3 * (e - j), Math.min(next, from + 0.6 * (e - j)));
        const step = Math.max(0, to - from) / (e - j);
        for (let m = j; m < e; m++) { words[m].start = from + step * (m - j); words[m].end = from + step * (m - j + 1); }
        j = e;
      }
      out[i] = words.map(w => ({ text: w.text, start: Math.round(w.start * 1000) / 1000, end: Math.round(w.end * 1000) / 1000 }));
    }
    return out;
  }

  // the words to show for a line with timings: its own spelling when the word counts agree, else the timed words
  function timedWords(text, words) {
    if (!Array.isArray(words) || !words.length) return null;
    const own = String(text || '').replace(/<[^>]+>/g, '').trim().split(/\s+/).filter(Boolean);
    if (own.length === words.length) return own.map((w, i) => ({ text: w, start: words[i].start, end: words[i].end }));
    return words.map(w => ({ text: String(w.text || '').trim(), start: w.start, end: w.end })).filter(w => w.text);
  }

  // how far (0..1, by characters) the karaoke fill should be at time t for a line with word times
  function timedProgress(words, t) {
    if (!Array.isArray(words) || !words.length) return null;
    const total = words.reduce((n, w) => n + Math.max(1, w.text.length), 0);
    let done = 0;
    for (const w of words) {
      const len = Math.max(1, w.text.length);
      if (t >= w.end) { done += len; continue; }
      if (t > w.start) done += len * (t - w.start) / Math.max(0.05, w.end - w.start);
      break;
    }
    return Math.min(1, Math.max(0, done / total));
  }

  const api = { extractGeniusLyrics, pickGeniusHit, parseYrc, pickNetEaseSong, parseEnhancedLrcWords, lineSimilarity, alignWordTimings, timedWords, timedProgress };
  if (typeof module !== 'undefined') module.exports = api;
  else window.MurielLyricsSources = api;
})();
