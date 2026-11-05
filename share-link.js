// Shared playlists: the whole playlist travels inside the link (after the #, so it never reaches a server).
// https://cloverscripts.github.io/riff-muriel/play/#p=<payload>  — opens the web player
// muriel://playlist?p=<payload>                                   — opens the app
// payload, when every song is on YouTube (the usual case): "y" + base64url(name length byte, name, then each
// video id as its 8 bytes). Titles aren't in the link; fillInfo() looks them up from YouTube. That keeps a
// 10-song link around 170 characters.
// Otherwise: "z" + base64url(deflate-raw(JSON)) or, where the browser can't compress, "j" + base64url(JSON).
// JSON: { v: 1, n: name, t: [[kind, ref, title, artist, seconds], ...] }; kind "y" = YouTube / YouTube Music
// (ref = video id), "s" = SoundCloud (ref = track URL), "u" = anything else with a URL. Songs from files on
// the device can't be shared and are left out. Used by the app (app.js), the website (site/play) and tests.
(function (root) {
  const WEB = 'https://cloverscripts.github.io/riff-muriel/play/';
  const MAX_TRACKS = 500;
  const clip = (s, n) => String(s == null ? '' : s).slice(0, n);
  const YT_ID = /^[A-Za-z0-9_-]{11}$/;

  const ytId = (t) => {
    if (t && YT_ID.test(String(t.id || ''))) return String(t.id);
    const m = /(?:v=|youtu\.be\/|\/shorts\/|\/embed\/)([A-Za-z0-9_-]{11})/.exec(String((t && t.url) || ''));
    return m ? m[1] : '';
  };

  // a Muriel track -> a compact row, or null when it can't be shared
  function packTrack(t) {
    if (!t || t.platform === 'local' || t.isLocal) return null;
    const meta = [clip(t.title, 140), clip(t.artist, 80), Math.max(0, Math.round(Number(t.duration) || 0))];
    const id = ytId(t);
    if (id && (!t.platform || t.platform === 'youtube' || t.platform === 'ytmusic')) return ['y', id, ...meta];
    const url = String(t.url || '');
    if (t.platform === 'soundcloud' && /^https:\/\/(?:www\.|m\.)?soundcloud\.com\//.test(url)) return ['s', url, ...meta];
    if (id) return ['y', id, ...meta];
    if (/^https:\/\//.test(url)) return ['u', url, ...meta];
    return null;
  }

  // a compact row -> a track the app and the web player both understand
  function unpackTrack(r) {
    if (!Array.isArray(r) || typeof r[1] !== 'string') return null;
    const [kind, ref, title, artist, duration] = r;
    const base = { title: clip(title, 140) || 'Unknown', artist: clip(artist, 80), duration: Math.max(0, Number(duration) || 0) };
    if (kind === 'y' && YT_ID.test(ref)) {
      return { ...base, id: ref, platform: 'youtube', url: `https://www.youtube.com/watch?v=${ref}`, thumbnail: `https://i.ytimg.com/vi/${ref}/hqdefault.jpg` };
    }
    if (kind === 's' && /^https:\/\/(?:www\.|m\.)?soundcloud\.com\/[^\s]+$/.test(ref)) return { ...base, id: ref, platform: 'soundcloud', url: ref, thumbnail: '' };
    if (kind === 'u' && /^https:\/\/[^\s]+$/.test(ref)) return { ...base, id: ref, platform: 'youtube', url: ref, thumbnail: '' };
    return null;
  }

  const b64url = {
    enc(bytes) {
      let s = '';
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    },
    dec(str) {
      const s = atob(String(str).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((String(str).length + 3) % 4));
      const out = new Uint8Array(s.length);
      for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
      return out;
    },
  };
  const canZip = typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';
  async function pipe(bytes, Stream, fmt) {
    const res = new Response(new Blob([bytes]).stream().pipeThrough(new Stream(fmt)));
    return new Uint8Array(await res.arrayBuffer());
  }

  // a YouTube id is 64 bits: 11 base64url characters whose last one carries 2 unused bits
  const idBytes = (id) => { const b = b64url.dec(id); return b.length === 8 && b64url.enc(b) === id ? b : null; };

  // name + ids only; null when a song isn't a plain YouTube video
  function packIds(name, rows) {
    if (!rows.length || rows.some((r) => r[0] !== 'y')) return null;
    const ids = rows.map((r) => idBytes(r[1]));
    if (ids.some((b) => !b)) return null;
    let nameBytes = new TextEncoder().encode(name);
    for (let n = name.length; nameBytes.length > 255; n--) nameBytes = new TextEncoder().encode(name.slice(0, n));
    const out = new Uint8Array(1 + nameBytes.length + ids.length * 8);
    out[0] = nameBytes.length;
    out.set(nameBytes, 1);
    ids.forEach((b, i) => out.set(b, 1 + nameBytes.length + i * 8));
    return 'y' + b64url.enc(out);
  }

  // { name, tracks } -> payload string (and how many songs made it in)
  async function encode(playlist) {
    const rows = (playlist && Array.isArray(playlist.tracks) ? playlist.tracks : []).map(packTrack).filter(Boolean).slice(0, MAX_TRACKS);
    const name = clip((playlist && playlist.name) || 'Playlist', 100);
    const short = packIds(name, rows);
    if (short) return { payload: short, count: rows.length };
    const json = JSON.stringify({ v: 1, n: name, t: rows });
    const bytes = new TextEncoder().encode(json);
    const payload = canZip ? 'z' + b64url.enc(await pipe(bytes, CompressionStream, 'deflate-raw')) : 'j' + b64url.enc(bytes);
    return { payload, count: rows.length };
  }

  // payload string -> { name, tracks } (throws on anything that isn't a Muriel playlist)
  async function decode(payload) {
    const p = String(payload || '').trim();
    if (p.length < 2 || p.length > 400000) throw new Error('not a playlist link');
    let bytes = b64url.dec(p.slice(1));
    if (p[0] === 'y') {
      const len = bytes[0];
      const rest = bytes.length - 1 - len;
      if (!(bytes.length > 1 + len) || rest % 8) throw new Error('not a playlist link');
      const name = clip(new TextDecoder().decode(bytes.subarray(1, 1 + len)), 100) || 'Shared playlist';
      const tracks = [];
      for (let o = 1 + len; o < bytes.length && tracks.length < MAX_TRACKS; o += 8) {
        // title and artist come from fillInfo()
        tracks.push({ ...unpackTrack(['y', b64url.enc(bytes.subarray(o, o + 8)), 'YouTube video', '', 0]), needsInfo: true });
      }
      return { name, tracks };
    }
    if (p[0] === 'z') {
      if (!canZip) throw new Error('this browser is too old to open the link');
      bytes = await pipe(bytes, DecompressionStream, 'deflate-raw');
    } else if (p[0] !== 'j') throw new Error('not a playlist link');
    const data = JSON.parse(new TextDecoder().decode(bytes));
    if (!data || data.v !== 1 || !Array.isArray(data.t)) throw new Error('not a playlist link');
    const tracks = data.t.slice(0, MAX_TRACKS).map(unpackTrack).filter(Boolean);
    return { name: clip(data.n, 100) || 'Shared playlist', tracks };
  }

  // the payload in a pasted link: the web player link or muriel://playlist?p=…
  // (a bare payload isn't taken: "juicewrld" typed into the search bar looked like one)
  function payloadFrom(text) {
    const m = /[#?&]p=([yzj][A-Za-z0-9_-]+)/.exec(String(text || '').trim());
    return m ? m[1] : '';
  }

  // "Artist - Song (Official Video)" uploaded by "ArtistVEVO" -> { title: 'Song', artist: 'Artist' }
  function tidy(title, author) {
    const junk = /\s*[([](?:[^)\]]*\b(?:official|lyrics?|audio|video|visuali[sz]er|hd|4k|remaster(?:ed)?|m\/?v)\b[^)\]]*)[)\]]/gi;
    let t = String(title || '').replace(junk, '').replace(/\s{2,}/g, ' ').trim();
    let a = String(author || '').trim();
    if (/\s-\sTopic$/i.test(a)) a = a.replace(/\s-\sTopic$/i, '');
    else {
      const m = /^(.+?)\s[-–—]\s(.+)$/.exec(t);
      if (m) { a = m[1]; t = m[2]; }
      else a = a.replace(/VEVO$/, '').replace(/\s*official$/i, '');
    }
    return { title: clip(t || title, 140), artist: clip(a, 80) };
  }

  // Looks up the title and artist of songs from a short link (YouTube's oEmbed, open to any page).
  // Songs it can't find keep "YouTube video". opts.fetch for tests, opts.onUpdate(track) as each one lands.
  async function fillInfo(tracks, opts = {}) {
    const get = opts.fetch || ((u, o) => fetch(u, o));
    const todo = (tracks || []).filter((t) => t && t.needsInfo);
    let next = 0;
    const worker = async () => {
      while (next < todo.length) {
        const t = todo[next++];
        try {
          const signal = typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined;
          const r = await get(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${t.id}`)}`, { signal });
          if (r.ok) {
            const d = await r.json();
            if (d && d.title) Object.assign(t, tidy(d.title, d.author_name));
          }
        } catch (e) { /* stays "YouTube video" */ }
        delete t.needsInfo;
        if (opts.onUpdate) opts.onUpdate(t);
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, todo.length) }, worker));
    return tracks;
  }

  const webLink = (payload) => `${WEB}#p=${payload}`;
  const appLink = (payload) => `muriel://playlist?p=${payload}`;

  const api = { encode, decode, payloadFrom, fillInfo, tidy, webLink, appLink, packTrack, unpackTrack, WEB };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MurielShare = api;
})(typeof window !== 'undefined' ? window : globalThis);
