'use strict';

// SoundCloud search straight from SoundCloud's own api-v2 (#17). Each `yt-dlp scsearch` run started a
// whole yt-dlp process (about 1.5 s of CPU, much more on Windows), and the home page matches dozens of
// songs that way; one HTTPS request does the same. Results have the shape yt-dlp's flat search printed,
// so the callers don't change, and songs that can never play here are left out:
// Go+ previews (30 seconds) and DRM-only songs (only encrypted streams).

function playable(t) {
  if (!t || t.policy === 'SNIP' || t.policy === 'BLOCK') return false;
  const list = (t.media && t.media.transcodings) || [];
  if (list.some((x) => x && x.snipped)) return false;
  return list.some((x) => x && !x.snipped && x.format && (x.format.protocol === 'progressive' || x.format.protocol === 'hls'));
}

function toEntry(t) {
  const art = t.artwork_url || (t.user && t.user.avatar_url) || '';
  return {
    id: String(t.id),
    title: t.title || '',
    uploader: (t.user && t.user.username) || '',
    duration: Math.round((t.full_duration || t.duration || 0) / 1000),
    thumbnails: art ? [{ url: art.replace('-large.', '-t500x500.') }] : [],
    webpage_url: t.permalink_url || '',
    url: t.permalink_url || '',
    playable: true,
  };
}

// opts: { fetch(url) -> Response, clientId() -> Promise<string>, resetClientId() }
async function searchSoundcloudApi(query, limit, opts) {
  const ask = async () => {
    const cid = await opts.clientId();
    // ask for more than needed: a good share of the hits can be previews or DRM-only
    const url = `https://api-v2.soundcloud.com/search/tracks?q=${encodeURIComponent(query)}&limit=${Math.min(50, Math.max(1, limit) * 3)}&client_id=${cid}`;
    return opts.fetch(url);
  };
  let r = await ask();
  // the client_id rotates now and then: read it again once
  if (r && (r.status === 401 || r.status === 403) && opts.resetClientId) { opts.resetClientId(); r = await ask(); }
  if (!r || !r.ok) throw new Error(`SoundCloud search answered ${r ? r.status : 'nothing'}`);
  const body = await r.json();
  if (!body || !Array.isArray(body.collection)) throw new Error('SoundCloud search: unexpected answer');
  return body.collection.filter((t) => t && (t.kind === 'track' || t.kind === undefined) && playable(t)).slice(0, limit).map(toEntry);
}

module.exports = { searchSoundcloudApi, soundcloudSearchPlayable: playable };
