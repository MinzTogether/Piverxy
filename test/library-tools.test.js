'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { dedupeTracks, linkFolderSongs } = require('../library-tools');

const sameById = (a, b) => a.id === b.id;

test('dedupe keeps the first copy and the original order', () => {
  const list = [{ id: 'b' }, { id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'a' }];
  assert.deepStrictEqual(dedupeTracks(list, sameById).map((t) => t.id), ['b', 'a', 'c']);
});

test('dedupe uses the comparator, not raw ids', () => {
  const same = (a, b) => a.title.toLowerCase() === b.title.toLowerCase();
  const list = [{ title: 'Song' }, { title: 'SONG' }, { title: 'Other' }];
  assert.deepStrictEqual(dedupeTracks(list, same).map((t) => t.title), ['Song', 'Other']);
});

test('dedupe returns an empty list for non-arrays', () => {
  assert.deepStrictEqual(dedupeTracks(null, sameById), []);
});

test('dedupe with a key function keeps the same copies without comparing pairs', () => {
  const list = Array.from({ length: 6000 }, (_, i) => ({ id: `t${i % 4000}` }));
  const noPairs = () => { throw new Error('compared a pair'); };
  const kept = dedupeTracks(list, noPairs, (t) => t.id);
  assert.strictEqual(kept.length, 4000);
  assert.deepStrictEqual(kept.slice(0, 3).map((t) => t.id), ['t0', 't1', 't2']);
  assert.deepStrictEqual(kept.map((t) => t.id), dedupeTracks(list.slice(0, 4000), sameById).map((t) => t.id));
});

// ---- linking the songs next to the download folder (phones) ----
const item = (n) => ({ id: `local_${String(n).padStart(12, '0')}`, path: `/data/LocalMusic/${n}.mp3`, name: String(n) });
const groups = (count) => [{ folder: 'A', items: Array.from({ length: count }, (_, i) => item(i)) }];

function fakeServer({ failOn } = {}) {
  const calls = [];
  const post = async (route, body) => {
    calls.push({ route, body });
    if (failOn && failOn(route, calls.length)) return failOn.result ? failOn.result(route) : Promise.reject(new Error('HTTP 500'));
    return route === '/api/library-unlink' ? { success: true, ids: ['local_gone'] } : { success: true, count: body.items.length };
  };
  return { post, calls };
}

test('linking sends the songs in batches, then forgets the ones that are gone', async () => {
  const { post, calls } = fakeServer();
  const r = await linkFolderSongs(post, groups(650), true);
  assert.deepEqual(calls.map((c) => [c.route, (c.body.items || c.body.keep).length]), [['/api/library-link', 300], ['/api/library-link', 300], ['/api/library-link', 50], ['/api/library-unlink', 650]]);
  assert.equal(r.ids.length, 650);
  assert.deepEqual(r.forgotten, ['local_gone']);
});

test('nothing is forgotten when a link request fails, whichever way it fails', async () => {
  for (const failOn of [
    (route, n) => route === '/api/library-link' && n === 2,                        // the request itself breaks (HTTP error)
  ]) {
    const { post, calls } = fakeServer({ failOn });
    await assert.rejects(linkFolderSongs(post, groups(650), true));
    assert.equal(calls.some((c) => c.route === '/api/library-unlink'), false);
  }
  // the server answers, but says it did not work
  const calls = [];
  const post = async (route, body) => { calls.push(route); return route === '/api/library-link' ? { success: false, error: 'bad' } : { success: true, ids: ['x'] }; };
  await assert.rejects(linkFolderSongs(post, groups(5), true));
  assert.deepEqual(calls, ['/api/library-link']);
});

test('nothing is forgotten after a scan that did not see everything', async () => {
  const { post, calls } = fakeServer();
  const r = await linkFolderSongs(post, groups(5), false);
  assert.deepEqual(calls.map((c) => c.route), ['/api/library-link']);
  assert.deepEqual(r.forgotten, []);
});

test('an empty but complete scan clears what was linked before', async () => {
  const { post, calls } = fakeServer();
  const r = await linkFolderSongs(post, [], true);
  assert.deepEqual(calls.map((c) => c.route), ['/api/library-unlink']);
  assert.deepEqual(calls[0].body, { keep: [] });
  assert.deepEqual(r.forgotten, ['local_gone']);
});

test('a failing forget request is reported, not hidden', async () => {
  const { post } = fakeServer({ failOn: (route) => route === '/api/library-unlink' });
  await assert.rejects(linkFolderSongs(post, groups(3), true), /HTTP 500/);
});
