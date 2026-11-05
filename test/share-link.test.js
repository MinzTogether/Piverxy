const test = require('node:test');
const assert = require('node:assert');
const share = require('../share-link.js');

const yt = (id, title, artist, duration, platform = 'youtube') => ({ id, title, artist, duration, platform, url: `https://www.youtube.com/watch?v=${id}`, thumbnail: 'x' });

test('a playlist survives the trip through a link', async () => {
  const pl = { name: 'Night drive', tracks: [yt('nac6B__nFl0', 'Illegal', 'PinkPantheress', 150), yt('51zjlMhdSTE', 'Espresso', 'Sabrina Carpenter', 175.4, 'ytmusic'),
    { id: '123', title: 'Mix', artist: 'DJ', duration: 300, platform: 'soundcloud', url: 'https://soundcloud.com/dj/mix' }] };
  const { payload, count } = await share.encode(pl);
  assert.strictEqual(count, 3);
  assert.match(payload, /^z[A-Za-z0-9_-]+$/);
  const back = await share.decode(payload);
  assert.strictEqual(back.name, 'Night drive');
  assert.deepStrictEqual(back.tracks.map((t) => [t.platform, t.id, t.title, t.artist, t.duration]), [
    ['youtube', 'nac6B__nFl0', 'Illegal', 'PinkPantheress', 150],
    ['youtube', '51zjlMhdSTE', 'Espresso', 'Sabrina Carpenter', 175],
    ['soundcloud', 'https://soundcloud.com/dj/mix', 'Mix', 'DJ', 300],
  ]);
  assert.strictEqual(back.tracks[0].url, 'https://www.youtube.com/watch?v=nac6B__nFl0');
  assert.strictEqual(back.tracks[0].thumbnail, 'https://i.ytimg.com/vi/nac6B__nFl0/hqdefault.jpg');
});

test('songs from files on the device are left out', async () => {
  const { payload, count } = await share.encode({ name: 'Mixed', tracks: [yt('nac6B__nFl0', 'Illegal', 'P', 150), { id: 'abc', title: 'My recording', platform: 'local', url: 'file:///x.flac' }] });
  assert.strictEqual(count, 1);
  assert.strictEqual((await share.decode(payload)).tracks.length, 1);
});

test('the payload is found in every way a link gets pasted', async () => {
  const { payload } = await share.encode({ name: 'a', tracks: [yt('nac6B__nFl0', 'Illegal', 'P', 150)] });
  for (const s of [share.webLink(payload), share.appLink(payload), `  ${share.webLink(payload)}\n`, `Night drive on Muriel 🎧 ${share.webLink(payload)}`]) assert.strictEqual(share.payloadFrom(s), payload);
  assert.strictEqual(share.payloadFrom('https://www.youtube.com/playlist?list=PL123'), '');
  // searches that happen to look like a payload stay searches
  for (const q of ['juicewrld', 'justinbieber', 'zaralarsson', 'yungblud123']) assert.strictEqual(share.payloadFrom(q), '');
});

test('an all-YouTube playlist makes a short link, and titles are looked up afterwards', async () => {
  const ids = ['4NRXx6U8ABQ', 'fJ9rUzIMcZQ', 'hT_nvWreIhg', 'OPf0YbXqDm0', '60ItHLz5WEA', 'JGwWNGJdvx8', '09R8_2nJtjg', 'YQHsXMglC9A', 'nac6B__nFl0', '51zjlMhdSTE'];
  const { payload, count } = await share.encode({ name: 'Muriel Hits', tracks: ids.map((id) => yt(id, 'some title', 'someone', 200)) });
  assert.strictEqual(count, 10);
  assert.strictEqual(payload[0], 'y');
  assert.ok(share.webLink(payload).length < 180, `link ${share.webLink(payload).length} chars`);
  const back = await share.decode(payload);
  assert.strictEqual(back.name, 'Muriel Hits');
  assert.deepStrictEqual(back.tracks.map((t) => t.id), ids);
  assert.ok(back.tracks.every((t) => t.needsInfo && t.title === 'YouTube video' && t.platform === 'youtube'));

  const answers = {
    '4NRXx6U8ABQ': { title: 'The Weeknd - Blinding Lights (Official Video)', author_name: 'TheWeekndVEVO' },
    fJ9rUzIMcZQ: { title: 'Bohemian Rhapsody', author_name: 'Queen - Topic' },
  };
  const seen = [];
  await share.fillInfo(back.tracks, {
    fetch: async (url) => {
      const id = decodeURIComponent(url).match(/v=([\w-]{11})/)[1];
      return answers[id] ? { ok: true, json: async () => answers[id] } : { ok: false, status: 401 };
    },
    onUpdate: (t) => seen.push(t.id),
  });
  assert.deepStrictEqual([back.tracks[0].title, back.tracks[0].artist], ['Blinding Lights', 'The Weeknd']);
  assert.deepStrictEqual([back.tracks[1].title, back.tracks[1].artist], ['Bohemian Rhapsody', 'Queen']);
  assert.strictEqual(back.tracks[2].title, 'YouTube video'); // not found: placeholder stays
  assert.ok(back.tracks.every((t) => !('needsInfo' in t)));
  assert.strictEqual(seen.length, 10);
});

test('a playlist with SoundCloud songs keeps titles in the link', async () => {
  const { payload } = await share.encode({ name: 'Mix', tracks: [yt('4NRXx6U8ABQ', 'Blinding Lights', 'The Weeknd', 200), { id: '1', title: 'Set', artist: 'DJ', platform: 'soundcloud', url: 'https://soundcloud.com/dj/set' }] });
  assert.strictEqual(payload[0], 'z');
  assert.ok((await share.decode(payload)).tracks.every((t) => !t.needsInfo));
});

test('a big playlist still makes a reasonable link', async () => {
  const tracks = Array.from({ length: 200 }, (_, i) => yt(`abcdefghi${String(i).padStart(2, '0')}`.slice(0, 11), `Song number ${i}`, `Artist ${i % 20}`, 200 + i));
  const { payload } = await share.encode({ name: 'Big', tracks });
  assert.ok(payload.length < 9000, `payload ${payload.length} chars`);
  assert.strictEqual((await share.decode(payload)).tracks.length, 200);
});

test('junk is refused instead of half-imported', async () => {
  for (const bad of ['', 'zzzz', 'yAA', 'y' + Buffer.from([5, 1, 2, 3]).toString('base64url'), 'y' + Buffer.from([0, 1, 2, 3]).toString('base64url'), 'x' + Buffer.from('{}').toString('base64'), 'j' + Buffer.from(JSON.stringify({ v: 2, t: [] })).toString('base64url')]) {
    await assert.rejects(share.decode(bad));
  }
  // rows that aren't valid are dropped, the rest kept
  const p = 'j' + Buffer.from(JSON.stringify({ v: 1, n: 'x', t: [['y', 'nac6B__nFl0', 'ok', 'a', 1], ['y', 'not-an-id', 'bad', 'a', 1], ['u', 'javascript:alert(1)', 'bad', 'a', 1]] })).toString('base64url');
  assert.deepStrictEqual((await share.decode(p)).tracks.map((t) => t.title), ['ok']);
});
