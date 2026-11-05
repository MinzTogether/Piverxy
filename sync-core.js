// Muriel sync, the part that decides what wins: every synced thing (a playlist, a favorite, a history entry,
// a setting) carries the time it last changed on any device, and when two devices meet the newer version
// wins item by item. Removing something leaves a dated "tombstone" so the removal spreads too. No network,
// no DOM: sync.js runs it in the app, test/sync-core.test.js in Node.
(function (root) {
  // FNV-1a: cheap content fingerprint to notice "this item changed"
  function hash(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(16).padStart(8, '0');
  }
  const fingerprint = (v) => hash(typeof v === 'string' ? v : JSON.stringify(v));

  // SHA-256 for the link handshake (WebCrypto isn't available in every WebView context)
  const K = [], H0 = [];
  (() => {
    const primes = [];
    for (let n = 2; primes.length < 64; n++) if (primes.every((p) => n % p)) primes.push(n);
    const frac = (x) => ((x - Math.floor(x)) * 0x100000000) >>> 0;
    primes.forEach((p, i) => { K[i] = frac(Math.cbrt(p)); if (i < 8) H0[i] = frac(Math.sqrt(p)); });
  })();
  function sha256(str) {
    const bytes = new TextEncoder().encode(str);
    const padded = new Uint8Array(((bytes.length + 9 + 63) >> 6) << 6);
    padded.set(bytes);
    padded[bytes.length] = 0x80;
    const dv = new DataView(padded.buffer);
    const bits = bytes.length * 8;
    dv.setUint32(padded.length - 8, Math.floor(bits / 0x100000000));
    dv.setUint32(padded.length - 4, bits >>> 0);
    const h = H0.slice();
    const w = new Uint32Array(64);
    const ror = (x, n) => (x >>> n) | (x << (32 - n));
    for (let off = 0; off < padded.length; off += 64) {
      for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
      for (let i = 16; i < 64; i++) {
        const s0 = ror(w[i - 15], 7) ^ ror(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        const s1 = ror(w[i - 2], 17) ^ ror(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }
      let [a, b, c, d, e, f, g, k] = h;
      for (let i = 0; i < 64; i++) {
        const t1 = (k + (ror(e, 6) ^ ror(e, 11) ^ ror(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
        const t2 = ((ror(a, 2) ^ ror(a, 13) ^ ror(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
        k = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      [a, b, c, d, e, f, g, k].forEach((v, i) => { h[i] = (h[i] + v) | 0; });
    }
    return h.map((x) => (x >>> 0).toString(16).padStart(8, '0')).join('');
  }

  // meta entry: [changedAt, fingerprint] or [changedAt, '', 1] for a removal
  const isGone = (m) => !!(m && m[2]);

  // Notes what changed in a list since the last look. The first look (prev === null) dates everything to `base`
  // (long ago), so data that was there before linking never overrides a real edit made elsewhere.
  function stampList(prev, items, keyOf, now, base = 1) {
    const meta = {};
    const first = !prev;
    prev = prev || {};
    const seen = new Set();
    for (const it of items || []) {
      const k = keyOf(it);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      const fp = fingerprint(it);
      const p = prev[k];
      meta[k] = p && !isGone(p) && p[1] === fp ? p : [first ? base : now, fp];
    }
    for (const [k, p] of Object.entries(prev)) {
      if (seen.has(k)) continue;
      meta[k] = isGone(p) ? p : [now, '', 1];
    }
    return meta;
  }

  // newer wins; on a tie the bigger fingerprint, so both devices pick the same one
  function remoteWins(l, r) {
    if (!r) return false;
    if (!l) return true;
    if (r[0] !== l[0]) return r[0] > l[0];
    return (r[1] || '') > (l[1] || '');
  }

  // Merges a list item by item. Keeps this device's order; things only the other device has go at the end.
  function mergeList(local, remote, keyOf, opts = {}) {
    const lItems = new Map(), rItems = new Map();
    for (const it of local.items || []) { const k = keyOf(it); if (k && !lItems.has(k)) lItems.set(k, it); }
    for (const it of remote.items || []) { const k = keyOf(it); if (k && !rItems.has(k)) rItems.set(k, it); }
    const meta = {};
    const pick = {};
    for (const k of new Set([...Object.keys(local.meta || {}), ...Object.keys(remote.meta || {})])) {
      const l = (local.meta || {})[k], r = (remote.meta || {})[k];
      const useRemote = remoteWins(l, r) && (isGone(r) || rItems.has(k));
      meta[k] = useRemote ? r : (l || r);
      pick[k] = useRemote ? 'r' : 'l';
    }
    const out = [];
    const take = (k) => {
      if (isGone(meta[k])) return;
      const it = pick[k] === 'r' ? rItems.get(k) : lItems.get(k);
      if (it !== undefined) out.push(it);
    };
    const placed = new Set();
    for (const k of lItems.keys()) { placed.add(k); take(k); }
    for (const k of rItems.keys()) if (!placed.has(k)) { placed.add(k); take(k); }
    let items = out;
    if (opts.sort) items = items.slice().sort(opts.sort);
    if (opts.cap) items = items.slice(0, opts.cap);
    const changed = items.length !== (local.items || []).length
      || items.some((it, i) => fingerprint(it) !== fingerprint(local.items[i]));
    return { items, meta, changed };
  }

  // settings: one value per key (null = not set)
  function stampMap(prev, values, now, base = 1) {
    const meta = {};
    const first = !prev;
    prev = prev || {};
    for (const [k, v] of Object.entries(values)) {
      const fp = v == null ? '' : fingerprint(v);
      const p = prev[k];
      meta[k] = p && p[1] === fp ? p : [first ? base : now, fp];
    }
    return meta;
  }

  function mergeMap(local, remote) {
    const values = { ...local.values }, meta = { ...local.meta };
    const changedKeys = [];
    for (const [k, r] of Object.entries(remote.meta || {})) {
      if (!(k in (remote.values || {}))) continue;
      if (!remoteWins(meta[k], r)) continue;
      meta[k] = r;
      if (values[k] !== remote.values[k]) { values[k] = remote.values[k]; changedKeys.push(k); }
    }
    return { values, meta, changedKeys };
  }

  // { id: { t, del?, ... } }: devices in the group, other devices' listening stats, what they're playing
  function mergeById(local, remote, skipId) {
    const out = { ...local };
    let changed = false;
    for (const [id, r] of Object.entries(remote || {})) {
      if (id === skipId || !r || typeof r.t !== 'number') continue;
      if (!out[id] || r.t > out[id].t) { out[id] = r; changed = true; }
    }
    return { value: out, changed };
  }

  // tombstones only have to outlive the time a device can stay away; after that they're dropped
  function pruneMeta(meta, now, maxAge) {
    const out = {};
    for (const [k, m] of Object.entries(meta || {})) if (!isGone(m) || now - m[0] < maxAge) out[k] = m;
    return out;
  }

  const api = { hash, fingerprint, sha256, stampList, mergeList, stampMap, mergeMap, mergeById, pruneMeta, isGone };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MurielSyncCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
