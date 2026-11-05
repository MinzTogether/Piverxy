'use strict';

// The server side of the library pages: an album's songs (by iTunes id, Deezer id, or title and artist when the
// id finds nothing), Trending now, and what the redesigned artist page shows (banner, subscribers, [E]).
// Nothing here touches the network: every outbound https request goes to a local fake.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'muriel-library-'));
for (const key of ['HOME', 'USERPROFILE', 'LOCALAPPDATA', 'XDG_CONFIG_HOME']) process.env[key] = tmp;
process.env.MURIEL_DATA_DIR = path.join(tmp, 'data');

const ARTIST = 'UCbandbandbandbandband01';
const json = (res, data, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
const song = (collectionId, trackNumber, trackName, extra = {}) => ({ wrapperType: 'track', collectionId, trackNumber, discNumber: 1, trackName, artistName: 'Nirvana', trackTimeMillis: 200000, ...extra });
const nevermind = [
  { wrapperType: 'collection', collectionId: 11, collectionName: 'Nevermind', artistName: 'Nirvana', releaseDate: '1991-09-24T07:00:00Z', trackCount: 3, artworkUrl100: 'https://is1.mzstatic.com/nevermind/100x100bb.jpg' },
  song(11, 2, 'In Bloom'),
  song(11, 1, 'Smells Like Teen Spirit', { trackExplicitness: 'notExplicit' }),
  song(11, 3, 'Come as You Are (Explicit)'),
];
const run = (text, browseId) => (browseId ? { text, navigationEndpoint: { browseEndpoint: { browseId } } } : { text });
const explicitBadge = [{ musicInlineBadgeRenderer: { icon: { iconType: 'MUSIC_EXPLICIT_BADGE' }, accessibilityData: { accessibilityData: { label: 'Explicit' } } } }];
const songRow = (videoId, title, badges) => ({ musicResponsiveListItemRenderer: {
  playlistItemData: { videoId },
  badges,
  flexColumns: [[run(title)], [run('The Band', ARTIST)]].map((runs) => ({ musicResponsiveListItemFlexColumnRenderer: { text: { runs } } })),
  fixedColumns: [{ musicResponsiveListItemFixedColumnRenderer: { text: { runs: [{ text: '3:05' }] } } }],
} });
const bandPage = {
  header: { musicImmersiveHeaderRenderer: {
    title: { runs: [{ text: 'The Band' }] },
    description: { runs: [{ text: 'The Band plays.' }] },
    subscriptionButton: { subscribeButtonRenderer: { channelId: ARTIST, subscriberCountText: { runs: [{ text: '2.4M' }] }, longSubscriberCountText: { runs: [{ text: '2.4M subscribers' }] } } },
    thumbnail: { musicThumbnailRenderer: { thumbnail: { thumbnails: [{ url: `https://yt3.googleusercontent.com/${ARTIST}=w540-h225-p-l90-rj` }] } } },
  } },
  contents: { singleColumnBrowseResultsRenderer: { tabs: [{ tabRenderer: { content: { sectionListRenderer: { contents: [
    { musicShelfRenderer: { title: { runs: [{ text: 'Top songs' }] }, contents: [songRow('bandsong001', 'Loud Song', explicitBadge), songRow('bandsong002', 'Quiet Song')] } },
  ] } } } }] } },
};

const seen = [];
const internet = http.createServer((req, res) => {
  const target = new URL(new URL(req.url, 'http://x').searchParams.get('u'));
  seen.push(target.hostname + target.pathname);
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const q = target.searchParams;
    if (target.hostname === 'rss.marketingtools.apple.com' && target.pathname === '/api/v2/us/music/most-played/25/songs.json') {
      return json(res, { feed: { results: [
        { id: '1', name: 'Housewife', artistName: 'Tate McRae', artworkUrl100: 'https://is1.mzstatic.com/a/100x100bb.jpg' },
        { id: '2', name: 'Ain\'t In LA', artistName: 'ADÉLA', contentAdvisoryRating: 'Explict', artworkUrl100: 'https://is1.mzstatic.com/b/100x100bb.jpg' },
      ] } });
    }
    if (target.hostname === 'itunes.apple.com' && target.pathname === '/lookup') {
      return json(res, { results: q.get('id') === '11' ? nevermind : [] });
    }
    if (target.hostname === 'itunes.apple.com' && target.pathname === '/search' && q.get('entity') === 'album') {
      return json(res, { results: [
        { collectionId: 12, collectionName: 'Nevermind (Deluxe)', artistName: 'Someone Else' },
        { collectionId: 11, collectionName: 'Nevermind (Remastered)', artistName: 'Nirvana' },
      ] });
    }
    if (target.hostname === 'api.deezer.com' && target.pathname === '/album/302127') {
      return json(res, { id: 302127, title: 'Discovery', artist: { name: 'Daft Punk' }, release_date: '2001-03-07', nb_tracks: 2, cover_xl: 'https://cdn/discovery.jpg', tracks: { data: [
        { title: 'Aerodynamic', track_position: 2, disk_number: 1, duration: 212, artist: { name: 'Daft Punk' } },
        { title: 'One More Time', track_position: 1, disk_number: 1, duration: 320, explicit_lyrics: false, artist: { name: 'Daft Punk' } },
      ] } });
    }
    if (target.hostname === 'music.youtube.com' && target.pathname.endsWith('/browse')) {
      return json(res, JSON.parse(body).browseId === ARTIST ? bandPage : {});
    }
    if (target.hostname === 'api.deezer.com' && target.pathname === '/search/artist') {
      return json(res, { data: [
        { id: 1, name: 'Queen(Ares)', nb_fan: 197, picture_xl: 'https://cdn/ares.jpg', tracklist: 'https://api.deezer.com/artist/1/top?limit=50' },
        { id: 2, name: 'Queen', nb_fan: 5000000, picture_xl: 'https://cdn/queen.jpg', tracklist: 'https://api.deezer.com/artist/2/top?limit=50' },
        { id: 3, name: 'QUEEN', nb_fan: 12, picture_xl: 'https://cdn/tribute.jpg', tracklist: 'https://api.deezer.com/artist/3/top?limit=50' },
      ] });
    }
    if (target.hostname === 'api.deezer.com' && target.pathname === '/artist/2/top') {
      return json(res, { data: [{ id: 21, title: 'Bohemian Rhapsody', duration: 354, artist: { name: 'Queen' }, album: { cover_medium: 'https://cdn/opera.jpg' } }, { id: 22, title: 'Fat Bottomed Girls', duration: 256, explicit_lyrics: true, artist: { name: 'Queen' } }] });
    }
    if (target.hostname === 'en.wikipedia.org') {
      return json(res, { type: 'disambiguation', extract: 'Queen most commonly refers to: Queen regnant, ...' });
    }
    json(res, {}, 404);
  });
});
const toInternet = (target) => `http://127.0.0.1:${internet.address().port}/?u=${encodeURIComponent(String(target))}`;
https.get = (target, opts, cb) => {
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  return http.get(toInternet(target), opts || {}, cb);
};
https.request = (target, opts, cb) => {
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  if (typeof target === 'object' && !(target instanceof URL)) {
    const { hostname, host, path: urlPath, protocol, port: _port, ...rest } = target;
    return http.request(toInternet(`https://${hostname || host}${urlPath || '/'}`), rest, cb);
  }
  return http.request(toInternet(target), opts || {}, cb);
};

const { startServer, stopServer, getServerToken } = require('../server');
let port;

before(async () => {
  await new Promise((resolve) => internet.listen(0, '127.0.0.1', resolve));
  port = await startServer(0);
});

after(async () => {
  await stopServer();
  internet.closeAllConnections();
  await new Promise((resolve) => internet.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
});

const call = (route) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: route, headers: { 'x-muriel-token': getServerToken() } }, (res) => {
    let b = '';
    res.on('data', (c) => { b += c; });
    res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(b) }));
  }).on('error', reject);
});

test('an album by its iTunes id: its songs in order, explicit ones marked', async () => {
  const { status, body } = await call('/api/album?id=11');
  assert.equal(status, 200);
  assert.deepEqual(body.album, { id: '11', title: 'Nevermind', artist: 'Nirvana', year: '1991', trackCount: 3, cover: 'https://is1.mzstatic.com/nevermind/600x600bb.jpg' });
  assert.deepEqual(body.tracks.map((t) => [t.no, t.title, !!t.isExplicit]), [[1, 'Smells Like Teen Spirit', false], [2, 'In Bloom', false], [3, 'Come as You Are (Explicit)', true]]);
  // the old route still answers
  assert.equal((await call('/api/albums/tracks?id=11')).body.tracks.length, 3);
});

test('an id that finds nothing (another country) falls back to the title and artist', async () => {
  const { status, body } = await call('/api/album-tracks?id=99&title=Nevermind&artist=Nirvana');
  assert.equal(status, 200);
  // "Nevermind (Deluxe)" by someone else is not it; "Nevermind (Remastered)" by Nirvana is
  assert.equal(body.album.id, '11');
  assert.equal(body.tracks.length, 3);
});

test('an album from Deezer, and albums that are not there', async () => {
  const { body } = await call('/api/album?id=302127&source=deezer');
  assert.equal(body.album.title, 'Discovery');
  assert.equal(body.album.source, 'deezer');
  assert.deepEqual(body.tracks.map((t) => [t.no, t.title, t.durationMs]), [[1, 'One More Time', 320000], [2, 'Aerodynamic', 212000]]);
  assert.equal((await call('/api/album?title=Nothing%20Like%20It&artist=Nobody')).status, 404);
  assert.equal((await call('/api/album?id=abc')).status, 400);
  assert.equal((await call('/api/album')).status, 400);
});

test('Trending now: the most played songs, played by YouTube search', async () => {
  const { body } = await call('/api/trending');
  assert.equal(body.success, true);
  assert.deepEqual(body.tracks.map((t) => [t.title, t.artist, !!t.isExplicit]), [['Housewife', 'Tate McRae', false], ['Ain\'t In LA', 'ADÉLA', true]]);
  assert.equal(body.tracks[0].thumbnail, 'https://is1.mzstatic.com/a/600x600bb.jpg');
  assert.equal(body.tracks[0].searchQuery, 'Tate McRae - Housewife official audio');
  // asked again, it comes from memory
  const before = seen.length;
  assert.equal((await call('/api/trending')).body.tracks.length, 2);
  assert.equal(seen.length, before);
});

test('the artist page has a banner, a subscriber count and [E] on explicit songs', async () => {
  const { body } = await call(`/api/artist?name=The%20Band&id=${ARTIST}`);
  const a = body.artist;
  assert.equal(a.banner, `https://yt3.googleusercontent.com/${ARTIST}=w1920-h800-p-l90-rj`);
  assert.equal(a.fans, 2400000);
  assert.equal(a.fansText, '2.4M subscribers');
  assert.deepEqual(a.tracks.map((t) => [t.title, !!t.isExplicit]), [['Loud Song', true], ['Quiet Song', false]]);
});

test('an artist page by name is the best-known artist of exactly that name, without a disambiguation page for a bio', async () => {
  const { body } = await call('/api/artist?name=Queen');
  const a = body.artist;
  assert.equal(a.name, 'Queen');
  assert.equal(a.fans, 5000000);
  assert.equal(a.avatar, 'https://cdn/queen.jpg');
  assert.equal(a.bio, '');
  assert.deepEqual(a.tracks.map((t) => [t.title, !!t.isExplicit]), [['Bohemian Rhapsody', false], ['Fat Bottomed Girls', true]]);
});
