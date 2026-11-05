'use strict';

// #10: one song favourited from the album page, the player bar and a search was kept once per place
const test = require('node:test');
const assert = require('node:assert');

const { favoriteTrackKey, isSameSong, dedupeFavoriteTracks } = require('../track-sort');

const yt = { id: 'dQw4w9WgXcQ', title: 'Never Gonna Give You Up (Official Video)', artist: 'Rick Astley', duration: 213, platform: 'youtube' };

test('youtube, ytmusic, no platform and a watch url are the same video', () => {
  const k = favoriteTrackKey(yt);
  assert.strictEqual(favoriteTrackKey({ ...yt, platform: 'ytmusic' }), k);
  assert.strictEqual(favoriteTrackKey({ ...yt, platform: undefined }), k);
  assert.strictEqual(favoriteTrackKey({ id: 'yt:dQw4w9WgXcQ' }), k);
  assert.strictEqual(favoriteTrackKey({ url: 'https://music.youtube.com/watch?v=dQw4w9WgXcQ&list=x' }), k);
  assert.strictEqual(favoriteTrackKey({ url: 'https://youtu.be/dQw4w9WgXcQ' }), k);
  assert.notStrictEqual(favoriteTrackKey({ id: 'dQw4w9WgXcQ', platform: 'soundcloud' }), k);
});

test('an album row is the same song as the video it plays', () => {
  const albumRow = { id: '1440_1_1', title: 'Never Gonna Give You Up', artist: 'Rick Astley', duration: 214 };
  assert.ok(isSameSong(albumRow, yt));
  assert.ok(isSameSong({ ...albumRow, artist: 'Rick Astley - Topic' }, yt));
  assert.ok(isSameSong({ ...albumRow, artist: 'Rick Astley feat. Someone' }, yt));
});

test('other songs, versions and lengths stay apart', () => {
  assert.ok(!isSameSong({ id: 'a', title: 'Never Gonna Give You Up (Live)', artist: 'Rick Astley', duration: 260 }, yt));
  assert.ok(!isSameSong({ id: 'b', title: 'Never Gonna Give You Up', artist: 'Rick Astley', duration: 400 }, yt));
  assert.ok(!isSameSong({ id: 'c', title: 'Never Gonna Give You Up', artist: 'Cover Band', duration: 213 }, yt));
  assert.ok(!isSameSong({ id: 'local1', title: 'Never Gonna Give You Up', artist: 'Rick Astley', duration: 213, platform: 'local' }, yt));
  assert.ok(!isSameSong({ id: 'x1', title: '', artist: '' }, { id: 'x2', title: '', artist: '' }));
});

test('dedupe keeps the first copy and the order, and returns the same array when clean', () => {
  const list = [
    yt,
    { id: 'zzzzzzzzzzz', title: 'Other', artist: 'Someone', duration: 100, platform: 'youtube' },
    { id: '1440_1_1', title: 'Never Gonna Give You Up', artist: 'Rick Astley', duration: 214 },
    { ...yt, platform: 'ytmusic' },
  ];
  const out = dedupeFavoriteTracks(list);
  assert.deepStrictEqual(out.map((t) => t.id), ['dQw4w9WgXcQ', 'zzzzzzzzzzz']);
  assert.strictEqual(out[0], yt);
  const clean = [yt, list[1]];
  assert.strictEqual(dedupeFavoriteTracks(clean), clean);
  assert.deepStrictEqual(dedupeFavoriteTracks([null, yt]), [yt]);
});
