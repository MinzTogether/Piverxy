// keyOf (optional) gives each track an identity string; with it the check is one pass instead of comparing every
// pair, which froze big playlists (2 s for 6,000 songs on every open and every filter keystroke)
function dedupeTracks(tracks, same, keyOf) {
  if (!Array.isArray(tracks)) return [];
  const kept = [];
  if (typeof keyOf === 'function') {
    const seen = new Set();
    for (const track of tracks) {
      const k = keyOf(track);
      if (seen.has(k)) continue;
      seen.add(k);
      kept.push(track);
    }
    return kept;
  }
  for (const track of tracks) {
    if (!kept.some((other) => same(other, track))) kept.push(track);
  }
  return kept;
}

// Phones: links the songs found in the folders next to the download folder into the library, then forgets the linked
// songs that are no longer there. post(route, body) resolves to the server's JSON and throws when the server answers
// with an error. Forgetting happens only after every link went through AND the scan saw everything (`complete`): a link
// that failed, or a scan cut short by a folder it could not read, must never be taken for "those songs are gone".
// -> { ids: [every linked id], forgotten: [ids the library let go of] }
async function linkFolderSongs(post, groups, complete) {
  const all = groups.flatMap((g) => g.items);
  for (let i = 0; i < all.length; i += 300) {
    const r = await post('/api/library-link', { items: all.slice(i, i + 300) });
    if (!r || r.success === false) throw new Error('library-link failed');
  }
  let forgotten = [];
  if (complete) {
    const r = await post('/api/library-unlink', { keep: all.map((i) => i.id) });
    if (!r || r.success === false) throw new Error('library-unlink failed');
    forgotten = Array.isArray(r.ids) ? r.ids : [];
  }
  return { ids: all.map((i) => i.id), forgotten };
}

if (typeof module !== 'undefined') module.exports = { dedupeTracks, linkFolderSongs };
