// Last.fm scrobbling, the part that decides what gets sent and when. No DOM, no network: lastfm.js runs it in the
// app, test/lastfm.test.js in Node.
// Last.fm's rules (last.fm/api/scrobbling): a song longer than 30 seconds is scrobbled once it has been listened to
// for half its length or for 4 minutes, whichever comes first. Only listening counts: time spent paused or skipped
// over by seeking doesn't. "Now playing" goes out as soon as a song really plays.
(function (root) {
  const MIN_LENGTH = 30;
  const MAX_WAIT = 240;
  const NOW_PLAYING_AFTER = 1; // seconds listened: a song skipped straight away isn't announced

  // seconds of listening a song needs before it is scrobbled; 0 = never (30 s or shorter, or a live stream).
  // A song whose length isn't known yet waits the full 4 minutes, which also proves it is longer than 30 s.
  function scrobbleAfter(duration) {
    const d = Number(duration);
    if (d === Infinity) return 0;
    if (!Number.isFinite(d) || d <= 0) return MAX_WAIT;
    if (d <= MIN_LENGTH) return 0;
    return Math.min(MAX_WAIT, d / 2);
  }

  // Follows the song that is playing. tick() is called on every timeupdate/play/pause with what the player shows;
  // it answers with what to send now: { nowPlaying: true } and/or { scrobble: { timestamp } } (Unix seconds of the
  // moment the song started, as Last.fm wants it).
  function createTracker() {
    let key = null;
    let startedAt = 0;
    let listened = 0;
    let lastPos = 0;
    let lastAt = 0;
    let announced = false;
    let scrobbled = false;

    function restart(k, now, pos) {
      key = k;
      startedAt = Math.floor(now / 1000);
      listened = 0;
      lastPos = pos;
      lastAt = now;
      announced = false;
      scrobbled = false;
    }

    function tick({ key: k, playing, position, duration, now }) {
      const out = { nowPlaying: false, scrobble: null };
      const pos = Number.isFinite(position) && position >= 0 ? position : 0;
      const at = Number.isFinite(now) ? now : Date.now();
      if (!k) { key = null; return out; }
      if (k !== key) restart(k, at, pos);
      // the same song again from the top (repeat one, or played again): a new listen once the last one counted
      else if (scrobbled && pos < 3 && lastPos > 25) restart(k, at, pos);
      if (playing) {
        const wall = Math.max(0, (at - lastAt) / 1000);
        const moved = pos - lastPos;
        // the smaller of "time passed" and "how far the song moved": a seek ahead moves far in no time,
        // a stalled stream lets time pass without moving
        if (moved > 0) listened += Math.min(wall, moved);
      }
      lastPos = pos;
      lastAt = at;
      if (!playing) return out;
      if (!announced && listened >= NOW_PLAYING_AFTER) { announced = true; out.nowPlaying = true; }
      const need = scrobbleAfter(duration);
      if (!scrobbled && need > 0 && listened >= need) {
        scrobbled = true;
        out.scrobble = { timestamp: startedAt };
      }
      return out;
    }

    return { tick, get state() { return { key, startedAt, listened, announced, scrobbled }; } };
  }

  const NOISE = /\s*[([]\s*(?:official\s*(?:music\s*)?(?:video|audio|lyric\s*video|visuali[sz]er)|lyrics?(?:\s*video)?|audio|hd|hq|4k|remastered|explicit|clean|visuali[sz]er|mv|clip\s*officiel|slowed(?:\s*\+\s*reverb)?|sped\s*up|nightcore)\s*[)\]]/gi;
  const CHANNEL = /(?:vevo|official|records|music|tv|channel)$/i;
  const clip = (s, n) => (typeof s === 'string' || typeof s === 'number' ? String(s) : '').replace(/\s+/g, ' ').trim().slice(0, n);

  // What Last.fm should hear for a song: YouTube titles carry "(Official Video)" and "Artist - Title", channels end
  // in " - Topic" or "VEVO", and only the first of several listed artists names the song's artist.
  function cleanMeta(track) {
    if (!track) return null;
    let title = clip(track.title, 512).replace(NOISE, '').trim();
    let artist = clip(track.artist, 512).replace(/\s*-\s*Topic$/i, '').replace(/\s*VEVO$/i, '').trim();
    const dash = title.indexOf(' - ');
    if (dash > 0) {
      const left = title.slice(0, dash).trim();
      const right = title.slice(dash + 3).trim();
      const a = artist.toLowerCase();
      if (left && right) {
        if (left.toLowerCase() === a) title = right;
        else if (!a || a === 'unknown artist' || CHANNEL.test(clip(track.artist, 512))) { artist = left; title = right; }
      }
    }
    // "A feat. B" / "A (feat. B)": Last.fm files the song under A; "A, B & C" (YouTube Music's list): under A.
    // "A & B" alone stays, it's often one act (Simon & Garfunkel)
    artist = artist.replace(/\s*[([]\s*(?:feat\.?|ft\.?|featuring)\s+[^)\]]*[)\]]/gi, '').replace(/\s+(?:feat\.?|ft\.?|featuring)\s+.*$/i, '');
    if (artist.includes(',')) artist = artist.split(',')[0];
    artist = artist.trim();
    if (!title || !artist || artist.toLowerCase() === 'unknown artist') return null;
    const out = { artist, track: title };
    const album = clip(track.album, 512);
    if (album) out.album = album;
    const d = Math.round(Number(track.duration) || 0);
    if (d > 0 && d < 86400) out.duration = d;
    return out;
  }

  // the song as the tracker knows it: a new key is a new listen
  const trackKey = (t) => (t ? `${t.platform || ''}|${t.id || ''}|${t.title || ''}|${t.artist || ''}` : '');

  const api = { MIN_LENGTH, MAX_WAIT, scrobbleAfter, createTracker, cleanMeta, trackKey };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MurielLastfm = api;
})(typeof window !== 'undefined' ? window : globalThis);
