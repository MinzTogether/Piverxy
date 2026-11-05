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

if (typeof module !== 'undefined') module.exports = { dedupeTracks };
