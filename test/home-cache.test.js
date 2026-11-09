const test = require('node:test');
const assert = require('node:assert');
const { createHomeCache, KEY_WAVE, KEY_FOR_YOU, VERSION, MAX_AGE_MS } = require('../mobile/home-cache.js');

const memStorage = () => {
  const m = new Map();
  return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
};
const track = (n) => ({ id: `id${n}`, title: `Song ${n}`, artist: 'A', url: `https://x/${n}` });
const DAY = 24 * 60 * 60 * 1000;

test('home cache: My Wave comes back as it was saved', () => {
  const s = memStorage();
  const c = createHomeCache({ storage: s });
  assert.strictEqual(c.readWave(), null);
  assert.strictEqual(c.writeWave({ tracks: [track(1), track(2)], hot: true, title: 'Hot picks 2026' }), true);
  const got = c.readWave();
  assert.deepStrictEqual(got.tracks, [track(1), track(2)]);
  assert.strictEqual(got.hot, true);
  assert.strictEqual(got.title, 'Hot picks 2026');
});

test('home cache: broken tracks are left out and the list is capped', () => {
  const c = createHomeCache({ storage: memStorage() });
  const many = Array.from({ length: 50 }, (_, i) => track(i));
  c.writeWave({ tracks: [null, 7, 'x', [], {}, { title: '  ' }, ...many] });
  const got = c.readWave();
  assert.strictEqual(got.tracks.length, 30);
  assert.strictEqual(got.tracks[0].id, 'id0');
  assert.strictEqual(got.hot, false);
});

test('home cache: an empty wave never replaces a good one', () => {
  const c = createHomeCache({ storage: memStorage() });
  c.writeWave({ tracks: [track(1)] });
  assert.strictEqual(c.writeWave({ tracks: [] }), false);
  assert.strictEqual(c.writeWave(null), false);
  assert.strictEqual(c.readWave().tracks.length, 1);
});

test('home cache: an old, future, damaged or foreign entry reads as nothing', () => {
  const s = memStorage();
  let t = 1_000_000_000_000;
  const c = createHomeCache({ storage: s, now: () => t });
  c.writeWave({ tracks: [track(1)] });
  t += MAX_AGE_MS - 1000;
  assert.ok(c.readWave(), 'just inside a week');
  t += 2000;
  assert.strictEqual(c.readWave(), null, 'over a week');
  t -= MAX_AGE_MS + 2 * DAY; // the clock went back: the entry now looks like it is from the future
  assert.strictEqual(c.readWave(), null, 'from the future');
  t += 2 * DAY;
  assert.ok(c.readWave(), 'sane again');
  s.setItem(KEY_WAVE, '{not json');
  assert.strictEqual(c.readWave(), null, 'damaged');
  s.setItem(KEY_WAVE, JSON.stringify({ v: VERSION + 1, at: t, data: { tracks: [track(1)] } }));
  assert.strictEqual(c.readWave(), null, 'other version');
  s.setItem(KEY_WAVE, JSON.stringify({ v: VERSION, at: t, data: { tracks: 'no' } }));
  assert.strictEqual(c.readWave(), null, 'wrong shape');
});

test('home cache: For you keeps genres, artists and song rows, and drops what is empty or broken', () => {
  const c = createHomeCache({ storage: memStorage() });
  const data = {
    success: true,
    genres: ['Rock', '', 5, 'Pop'],
    sections: [
      { type: 'artists', title: 'Similar artists', items: [{ name: 'Band', picture: 'p.jpg' }, { picture: 'no-name' }, null] },
      { type: 'tracks', title: 'Picks', tracks: [track(1), null, { nothing: true }] },
      { type: 'tracks', title: 'Empty', tracks: [] },
      { type: 'tracks', tracks: [track(2)] },
      'junk',
    ],
  };
  assert.strictEqual(c.writeForYou(data), true);
  const got = c.readForYou();
  assert.strictEqual(got.success, true);
  assert.deepStrictEqual(got.genres, ['Rock', 'Pop']);
  assert.strictEqual(got.sections.length, 2);
  assert.deepStrictEqual(got.sections[0].items, [{ name: 'Band', picture: 'p.jpg' }]);
  assert.deepStrictEqual(got.sections[1].tracks, [track(1)]);
  assert.strictEqual(c.writeForYou({ success: true, genres: [], sections: [] }), false, 'nothing to show is not worth keeping');
  assert.ok(c.readForYou(), 'and does not wipe the good copy');
});

test('home cache: switched off it neither reads nor writes', () => {
  let on = true;
  const s = memStorage();
  const c = createHomeCache({ storage: s, enabled: () => on });
  c.writeWave({ tracks: [track(1)] });
  on = false;
  assert.strictEqual(c.readWave(), null);
  assert.strictEqual(c.writeWave({ tracks: [track(2)] }), false);
  on = true;
  assert.strictEqual(c.readWave().tracks[0].id, 'id1');
});

test('home cache: a full or blocked storage is not an error, and an oversized entry is not stored', () => {
  const full = { getItem: () => null, setItem() { throw new Error('QuotaExceededError'); }, removeItem() {} };
  assert.strictEqual(createHomeCache({ storage: full }).writeWave({ tracks: [track(1)] }), false);
  const s = memStorage();
  const c = createHomeCache({ storage: s });
  const fat = { ...track(1), blob: 'x'.repeat(300 * 1024) };
  assert.strictEqual(c.writeWave({ tracks: [fat] }), false);
  assert.strictEqual(s.m.size, 0);
  assert.strictEqual(createHomeCache({}).readWave(), null, 'no storage at all');
});

test('home cache: clear() and bytes()', () => {
  const s = memStorage();
  const c = createHomeCache({ storage: s });
  assert.strictEqual(c.bytes(), 0);
  c.writeWave({ tracks: [track(1)] });
  c.writeForYou({ genres: ['Rock'], sections: [] });
  assert.ok(c.bytes() > 50);
  c.clear();
  assert.strictEqual(c.bytes(), 0);
  assert.strictEqual(s.m.has(KEY_WAVE) || s.m.has(KEY_FOR_YOU), false);
});
