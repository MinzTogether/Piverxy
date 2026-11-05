'use strict';

// Several artists can share a name (issue #7: "NobodyKnows"). Tracks keep their artist's YouTube Music channel
// (artistId) and the artist page opens by it: that artist's songs, and only that artist's albums.
// Nothing here touches the network: every outbound https request goes to a local fake.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');

const ytm = require('../ytm-artist');

const FAMOUS = 'UCfamousfamousfamous0001';
const SMALL = 'UCsmallsmallsmallsmall01';
const SMALL_CHANNEL = 'UCsmallofficialchannel01';

const run = (text, browseId) => (browseId ? { text, navigationEndpoint: { browseEndpoint: { browseId } } } : { text });
const songRow = (videoId, title, artistRuns, length) => ({ musicResponsiveListItemRenderer: {
  playlistItemData: { videoId },
  thumbnail: { musicThumbnailRenderer: { thumbnail: { thumbnails: [{ url: `https://lh3.googleusercontent.com/${videoId}=w60-h60-l90-rj` }] } } },
  flexColumns: [[run(title)], artistRuns].map((runs) => ({ musicResponsiveListItemFlexColumnRenderer: { text: { runs } } })),
  fixedColumns: length ? [{ musicResponsiveListItemFixedColumnRenderer: { text: { runs: [{ text: length }] } } }] : undefined,
} });
const card = (title, navigationEndpoint, subtitle = []) => ({ musicTwoRowItemRenderer: { title: { runs: [{ text: title }] }, subtitle: { runs: subtitle }, navigationEndpoint } });
const artistPage = ({ name, channelId, subscribers, songs, albums, songsList }) => ({
  header: { musicImmersiveHeaderRenderer: {
    title: { runs: [{ text: name }] },
    description: { runs: [{ text: `${name} makes music.` }] },
    subscriptionButton: { subscribeButtonRenderer: { channelId, subscriberCountText: { runs: [{ text: subscribers }] } } },
    thumbnail: { musicThumbnailRenderer: { thumbnail: { thumbnails: [{ url: `https://yt3.googleusercontent.com/${channelId}=w540-h225-p-l90-rj` }] } } },
  } },
  contents: { singleColumnBrowseResultsRenderer: { tabs: [{ tabRenderer: { content: { sectionListRenderer: { contents: [
    { musicShelfRenderer: { title: { runs: [{ text: 'Top songs', navigationEndpoint: songsList ? { browseEndpoint: { browseId: songsList } } : undefined }] }, contents: songs } },
    { musicCarouselShelfRenderer: { contents: albums.map((t, i) => card(t, { browseEndpoint: { browseId: `MPREb_${channelId}${i}` } }, [run('Album'), run(' • '), run('2019')])) } },
    { musicCarouselShelfRenderer: { contents: [card('Fan favourite', { browseEndpoint: { browseId: 'UCsomeoneelsesomeone0001' } })] } },
  ] } } } }] } },
});

// the small NobodyKnows: an artist page with five songs (no lengths) and a playlist with all of them
const smallPage = artistPage({
  name: 'NobodyKnows', channelId: SMALL_CHANNEL, subscribers: '1.2K', songsList: 'VLsmallsongs',
  songs: [songRow('smallsong01', 'Quiet Streets', [run('NobodyKnows', SMALL)])],
  albums: ['Basement Tapes'],
});
const smallSongs = { contents: { twoColumnBrowseResultsRenderer: { secondaryContents: { sectionListRenderer: { contents: [{ musicPlaylistShelfRenderer: { contents: [
  songRow('smallsong01', 'Quiet Streets', [run('NobodyKnows', SMALL)], '3:05'),
  songRow('smallsong02', 'Night Bus', [run('NobodyKnows', SMALL), run(' & '), run('Friend', 'UCfriendfriendfriendfr01')], '2:41'),
] } }] } } } } };
const famousPage = artistPage({
  name: 'NobodyKnows', channelId: FAMOUS, subscribers: '2.4M',
  songs: [songRow('famous00001', 'Stadium Anthem', [run('NobodyKnows', FAMOUS)])],
  albums: ['Greatest Hits'],
});
const watchNext = (videoId, artistRuns) => ({ contents: { singleColumnMusicWatchNextResultsRenderer: { tabbedRenderer: { watchNextTabbedResultsRenderer: { tabs: [{ tabRenderer: { content: { musicQueueRenderer: { content: { playlistPanelRenderer: { contents: [
  { playlistPanelVideoWrapperRenderer: { primaryRenderer: { playlistPanelVideoRenderer: { videoId, longBylineText: { runs: [...artistRuns, run(' • '), run('1.2K views')] } } },
    counterpart: [{ counterpartRenderer: { playlistPanelVideoRenderer: { videoId: 'counterpart', longBylineText: { runs: [run('Somebody', 'UCsomebodysomebodysome01')] } } } }] } },
] } } } } } }] } } } } });
const artistResults = { contents: { tabbedSearchResultsRenderer: { tabs: [{ tabRenderer: { content: { sectionListRenderer: { contents: [{ musicShelfRenderer: { contents: [
  [FAMOUS, 'NobodyKnows', '2.4M subscribers'], [SMALL, 'NobodyKnows', '1.2K subscribers'], ['UCotherotherotherother01', 'Nobody Knows Band', '50 subscribers'],
].map(([id, name, subs]) => ({ musicResponsiveListItemRenderer: {
  navigationEndpoint: { browseEndpoint: { browseId: id } },
  thumbnail: { musicThumbnailRenderer: { thumbnail: { thumbnails: [{ url: `https://yt3.googleusercontent.com/${id}=w60-h60-p-l90-rj` }] } } },
  flexColumns: [[run(name)], [run('Artist'), run(' • '), run(subs)]].map((runs) => ({ musicResponsiveListItemFlexColumnRenderer: { text: { runs } } })),
} })) } }] } } } }] } } };

test('an artist page reads who it is, its songs, releases and the ids it answers to', () => {
  const page = ytm.parseArtistPage(smallPage, SMALL);
  assert.equal(page.name, 'NobodyKnows');
  assert.equal(page.bio, 'NobodyKnows makes music.');
  // the wide header picture, cropped square for the avatar
  assert.equal(page.avatar, `https://yt3.googleusercontent.com/${SMALL_CHANNEL}=w544-h544-p-l90-rj`);
  assert.equal(page.isVerified, false);
  assert.equal(ytm.parseArtistPage(famousPage, FAMOUS).isVerified, true);
  assert.deepEqual(page.ids, [SMALL, SMALL_CHANNEL]);
  assert.deepEqual(page.releases, ['Basement Tapes']);
  assert.equal(page.playlist, 'VLsmallsongs');
  assert.deepEqual(page.songs.map((t) => [t.id, t.title, t.artist, t.artistId]), [['smallsong01', 'Quiet Streets', 'NobodyKnows', SMALL]]);

  const all = ytm.parseSongRows(smallSongs);
  assert.deepEqual(all.map((t) => [t.id, t.artist, t.artistId, t.duration]), [
    ['smallsong01', 'NobodyKnows', SMALL, 185],
    ['smallsong02', 'NobodyKnows & Friend', SMALL, 161],
  ]);
  assert.equal(ytm.parseArtistPage({ header: {} }, SMALL), null);
});

test('namesakes, credits and shared releases', () => {
  assert.equal(ytm.nameKey('NobodyKnows'), ytm.nameKey('NOBODYKNOWS - Topic'));
  assert.equal(ytm.nameKey('NobodyKnows'), ytm.nameKey('Nobodyknows+'));
  assert.equal(ytm.channelId('UCx'), undefined);
  assert.equal(ytm.channelId(SMALL), SMALL);

  const credits = ytm.parseWatchArtists(watchNext('smallsong02', [run('NobodyKnows', SMALL), run(' & '), run('Friend', 'UCfriendfriendfriendfr01')]), 'smallsong02');
  assert.deepEqual(credits.map((a) => a.id), [SMALL, 'UCfriendfriendfriendfr01']);
  assert.equal(ytm.pickArtist(credits, 'NobodyKnows').id, SMALL);
  assert.equal(ytm.pickArtist(credits, 'NobodyKnows & Friend').id, SMALL);
  assert.equal(ytm.pickArtist(credits, 'Friend').id, 'UCfriendfriendfriendfr01');
  // the track says someone else (renamed, or a different upload): no credited artist is that
  assert.equal(ytm.pickArtist(credits, 'Somebody Else'), null);

  assert.equal(ytm.sharedTitles(['Nevermind', 'Lithium'], ['Nevermind (Remastered)', 'Lithium - Single', 'In Utero']), 2);
  assert.equal(ytm.sharedTitles(['Basement Tapes'], ['Greatest Hits']), 0);

  const found = ytm.parseArtistResults(artistResults);
  assert.deepEqual(found.map((a) => [a.id, a.subtitle]), [[FAMOUS, '2.4M subscribers'], [SMALL, '1.2K subscribers'], ['UCotherotherotherother01', '50 subscribers']]);
  assert.equal(found[0].thumbnail, `https://yt3.googleusercontent.com/${FAMOUS}=w240-h240-p-l90-rj`);
});

// ---- the server, against a fake YouTube Music and iTunes ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'muriel-namesakes-'));
for (const key of ['HOME', 'USERPROFILE', 'LOCALAPPDATA', 'XDG_CONFIG_HOME']) process.env[key] = tmp;
process.env.MURIEL_DATA_DIR = path.join(tmp, 'data');

const json = (res, data, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
const itunesArtist = (artistId, artistName) => ({ wrapperType: 'artist', artistId, artistName });
const itunesAlbum = (artistId, collectionId, collectionName) => ({ wrapperType: 'collection', artistId, artistName: 'NobodyKnows', collectionId, collectionName, trackCount: 10, releaseDate: '2019-01-01T00:00:00Z' });
const internet = http.createServer((req, res) => {
  const target = new URL(new URL(req.url, 'http://x').searchParams.get('u'));
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (target.hostname === 'music.youtube.com') {
      const q = JSON.parse(body);
      if (target.pathname.endsWith('/browse')) return json(res, { [SMALL]: smallPage, [FAMOUS]: famousPage, VLsmallsongs: smallSongs }[q.browseId] || {});
      if (target.pathname.endsWith('/next')) return json(res, watchNext(q.videoId, [run('NobodyKnows', SMALL)]));
      if (target.pathname.endsWith('/search')) return json(res, artistResults);
    }
    if (target.hostname === 'itunes.apple.com' && target.pathname === '/search') {
      return json(res, { results: [itunesArtist(1, 'NobodyKnows'), itunesArtist(2, 'Nobody Knows'), itunesArtist(3, 'NobodyKnows Tribute')] });
    }
    if (target.hostname === 'itunes.apple.com' && target.pathname === '/lookup') {
      const lists = {
        1: [itunesArtist(1, 'NobodyKnows'), itunesAlbum(1, 11, 'Greatest Hits'), itunesAlbum(1, 12, 'Stadium Anthem - Single')],
        2: [itunesArtist(2, 'Nobody Knows'), itunesAlbum(2, 21, 'Basement Tapes'), itunesAlbum(2, 22, 'Night Bus - EP')],
      };
      return json(res, { results: target.searchParams.get('id').split(',').flatMap((id) => lists[id] || []) });
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
    res.on('end', () => resolve(JSON.parse(b)));
  }).on('error', reject);
});

test('opened by channel id, the page is that artist: its songs and only its own albums', async () => {
  const { artist } = await call(`/api/artist?name=NobodyKnows&id=${SMALL}`);
  assert.equal(artist.id, SMALL);
  assert.deepEqual(artist.tracks.map((t) => [t.id, t.artistId, t.duration]), [['smallsong01', SMALL, 185], ['smallsong02', SMALL, 161]]);
  // iTunes lists the famous NobodyKnows first; the albums are the ones of the namesake that put out these songs
  const { albums } = await call(`/api/artist-albums?name=NobodyKnows&id=${SMALL}`);
  assert.deepEqual(albums.map((a) => a.title), ['Basement Tapes', 'Night Bus - EP']);
  const famous = await call(`/api/artist-albums?name=NobodyKnows&id=${FAMOUS}`);
  assert.deepEqual(famous.albums.map((a) => a.title), ['Greatest Hits']);
});

test('a track saved without artistId finds its artist through the video it plays', async () => {
  const { artist } = await call('/api/artist?name=NobodyKnows&video=smallsong02');
  assert.equal(artist.id, SMALL);
  assert.equal(artist.name, 'NobodyKnows');
});

test('the chooser lists only artists with the same name', async () => {
  const { artists } = await call('/api/artist-matches?name=NobodyKnows');
  assert.deepEqual(artists.map((a) => a.id), [FAMOUS, SMALL]);
});
