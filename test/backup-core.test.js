'use strict';

// backup-core.js: playlist files (shared, so trusted for nothing) and profile backups (only Muriel's own data and
// settings keys get restored), plus upstream Riff's .rfacc account files.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const B = require('../backup-core.js');
const P = require('../profiles-core.js');

const YT = 'dQw4w9WgXcQ';

test('playlist files from Riff, from Muriel and bare song lists are read', () => {
  const riff = JSON.stringify({ app: 'Riff', appVersion: '43.0.0', playlists: [{ name: 'Mix', description: 'd', tracks: [
    { title: 'Song', artist: 'A', album: 'Al', duration: 212, source: 'youtube', id: YT, url: `https://www.youtube.com/watch?v=${YT}`, cover: 'https://i.ytimg.com/vi/x/hq.jpg' },
    { title: 'SC', artist: 'B', source: 'soundcloud', id: '123', url: 'https://soundcloud.com/b/sc' },
    { title: 'Mine', artist: 'C', source: 'local', id: 'local_abc123', url: 'C:\\Users\\me\\Music\\mine.mp3' },
    { title: 'Only a name', artist: 'D', durationMs: 180500 },
  ] }] });
  const [pl] = B.parsePlaylistFile(riff);
  assert.equal(pl.name, 'Mix');
  assert.equal(pl.description, 'd');
  assert.deepEqual(pl.tracks[0], { title: 'Song', artist: 'A', album: 'Al', duration: 212, id: YT, platform: 'youtube', url: `https://www.youtube.com/watch?v=${YT}`, thumbnail: 'https://i.ytimg.com/vi/x/hq.jpg' });
  assert.equal(pl.tracks[1].platform, 'soundcloud');
  assert.equal(pl.tracks[1].url, 'https://soundcloud.com/b/sc');
  assert.deepEqual(pl.tracks[2], { title: 'Mine', artist: 'C', id: 'local_abc123', platform: 'local' }, 'the path of the original file stays out');
  assert.deepEqual(pl.tracks[3], { title: 'Only a name', artist: 'D', duration: 181, needsMatch: true });

  const bare = B.parsePlaylistFile(JSON.stringify([{ title: 'x', url: `https://youtu.be/${YT}` }]));
  assert.equal(bare.length, 1);
  assert.equal(bare[0].tracks[0].id, YT);
  assert.equal(B.parsePlaylistFile(JSON.stringify({ name: 'One', tracks: [{ title: 't', id: YT }] }))[0].name, 'One');
  assert.deepEqual(B.parsePlaylistFile('not json'), []);
  assert.deepEqual(B.parsePlaylistFile(JSON.stringify({ hello: 1 })), []);
  assert.deepEqual(B.parsePlaylistFile('\uFEFF' + JSON.stringify({ tracks: [] })), [{ name: 'Imported playlist', tracks: [] }]);
});

test('a shared playlist file cannot smuggle in links, scripts or odd objects', () => {
  const evil = JSON.stringify({ playlists: [{ name: '<img src=x onerror=alert(1)>', cover: 'javascript:alert(1)', __proto__: { polluted: true }, tracks: [
    { title: 'a', id: YT, url: 'javascript:alert(1)', thumbnail: 'javascript:alert(2)' },
    { title: 'b', url: 'https://evil.example/stream.m3u8' },
    { title: 'c', url: 'http://127.0.0.1:38472/api/clear-offline-library', id: 'x' },
    { title: 'd', platform: 'soundcloud', url: 'https://soundcloud.com.evil.example/x' },
    { title: 'e', id: 'local_../../etc/passwd' },
    { title: { toString: 1 }, artist: ['x'] },
    'not a track',
    null,
  ] }] });
  const [pl] = B.parsePlaylistFile(evil);
  assert.equal(pl.cover, undefined);
  assert.equal(pl.name, '<img src=x onerror=alert(1)>', 'kept as text: the app escapes names when it shows them');
  assert.equal({}.polluted, undefined);
  assert.equal(pl.tracks[0].url, `https://www.youtube.com/watch?v=${YT}`);
  assert.equal(pl.tracks[0].thumbnail, `https://i.ytimg.com/vi/${YT}/hqdefault.jpg`);
  // anything that isn't YouTube or SoundCloud is only a title to look up
  for (const t of pl.tracks.slice(1, 4)) { assert.equal(t.needsMatch, true); assert.equal(t.url, undefined); }
  assert.equal(pl.tracks[4].id, undefined);
  assert.equal(pl.tracks.length, 5, 'non-objects and nameless entries are dropped');
  for (const t of pl.tracks) for (const v of Object.values(t)) assert.ok(['string', 'number', 'boolean'].includes(typeof v));
});

test('playlist files are capped', () => {
  const many = { playlists: Array.from({ length: B.LIMITS.playlists + 50 }, (_, i) => ({ name: `p${i}`, tracks: [{ title: 't', id: YT }] })) };
  assert.equal(B.parsePlaylistFile(JSON.stringify(many)).length, B.LIMITS.playlists);
  const long = { tracks: Array.from({ length: B.LIMITS.tracksPerPlaylist + 10 }, () => ({ title: 'x', id: YT })) };
  assert.equal(B.parsePlaylistFile(JSON.stringify(long))[0].tracks.length, B.LIMITS.tracksPerPlaylist);
  assert.equal(B.parsePlaylistFile(JSON.stringify({ tracks: [{ title: 'x'.repeat(5000), id: YT }] }))[0].tracks[0].title.length, 300);
  assert.deepEqual(B.parsePlaylistFile(' '.repeat(B.LIMITS.fileBytes + 1)), []);
});

test('exported playlists read back the same, without local addresses or tokens', () => {
  const pls = [{ id: 'pl_1', name: 'Mine', description: 'desc', cover: 'file:///home/me/cover.png', tracks: [
    { id: YT, title: 'Song', artist: 'A', duration: 200, platform: 'youtube', url: `https://www.youtube.com/watch?v=${YT}`, thumbnail: 'https://i.ytimg.com/vi/a/hq.jpg', addedAt: 5 },
    { id: 'local_abc', title: 'Local', artist: 'B', platform: 'local', thumbnail: 'http://127.0.0.1:38472/api/local-cover?id=local_abc&t=SECRETTOKEN' },
  ] }];
  const file = B.playlistFile(pls, { appVersion: '1.2.9' });
  const text = JSON.stringify(file);
  assert.equal(file.app, 'Muriel');
  assert.ok(!text.includes('SECRETTOKEN') && !text.includes('127.0.0.1') && !text.includes('file:'));
  const [back] = B.parsePlaylistFile(text);
  assert.equal(back.name, 'Mine');
  assert.equal(back.description, 'desc');
  assert.deepEqual(back.tracks.map((t) => [t.id, t.title, t.platform]), [[YT, 'Song', 'youtube'], ['local_abc', 'Local', 'local']]);
  assert.equal(B.fileName('a/b:c*?.', 'json'), 'a_b_c_..json');
  assert.equal(B.fileName('..', 'json'), 'muriel.json');
});

test('a backup holds the open profile\'s own data and settings, nothing of the device', () => {
  const entries = [
    ['devsize_playlists', '[]'], ['muriel_theme_mode', 'light'], ['muriel_listens_v1', '{}'],
    ['muriel_perf_mode', 'true'], ['muriel_audio_analysis_x', '{}'], ['muriel_secret_lastfm', '{"default":{"sk":"x"}}'],
    ['muriel_sync_group', 'g'], ['muriel_profiles', '[]'], ['muriel_custom_css', 'body{}'], ['muriel_debug_log', '[]'],
    ['someplugin_state', '1'],
  ];
  const b = B.makeBackup(entries, { profileName: 'Kid', appVersion: '1.2.9', isDevice: P.isDevice });
  assert.equal(b.kind, 'muriel-backup');
  assert.equal(b.profile.name, 'Kid');
  assert.deepEqual(Object.keys(b.data).sort(), ['devsize_playlists', 'muriel_listens_v1', 'muriel_theme_mode']);
});

test('a restore only writes Muriel keys, checks the playlists through, and keeps the sync link', () => {
  const backup = { kind: 'muriel-backup', version: 1, profile: { name: 'Me' }, data: {
    devsize_playlists: JSON.stringify([{ id: 'pl_a', name: 'A', cover: 'javascript:alert(1)', tracks: [{ id: YT, title: 't', thumbnail: 'javascript:x', url: 'https://www.youtube.com/watch?v=' + YT, nested: { a: 1 }, addedAt: 3 }] }, { id: 'pl_a', name: 'dup id' }, 'junk']),
    devsize_favorites: JSON.stringify([{ id: 'x', title: 'f', platform: 'evilnet' }, 5]),
    devsize_history: 'not json',
    muriel_theme_mode: 'dark',
    muriel_volume: 0.5,
    muriel_sync_group: 'attacker-group',
    muriel_profile_active: 'x',
    'muriel_p:abcd:devsize_playlists': '[]',
    muriel_perf_mode: 'true',
    muriel_custom_css: 'body{background:url(https://evil/)}',
    muriel_lastfm_sk: 'leaked',
    muriel_lastfm_enabled: 'false',
    evil_key: 'x',
    '__proto__': 'x',
  } };
  const r = B.readBackup(backup, { isDevice: P.isDevice });
  assert.equal(r.source, 'muriel');
  assert.deepEqual(Object.keys(r.entries).sort(), ['devsize_favorites', 'devsize_playlists', 'muriel_lastfm_enabled', 'muriel_theme_mode', 'muriel_volume']);
  assert.equal(r.entries.muriel_volume, '0.5');
  const pls = JSON.parse(r.entries.devsize_playlists);
  assert.equal(pls.length, 2);
  assert.notEqual(pls[0].id, pls[1].id, 'a repeated id gets a new one');
  assert.equal(pls[0].cover, undefined);
  assert.deepEqual(pls[0].tracks[0], { id: YT, title: 't', url: 'https://www.youtube.com/watch?v=' + YT, addedAt: 3 });
  assert.deepEqual(JSON.parse(r.entries.devsize_favorites), [{ id: 'x', title: 'f', platform: 'youtube' }]);
  assert.ok(r.skipped.includes('devsize_history') && r.skipped.includes('muriel_sync_group') && r.skipped.includes('muriel_custom_css'));
  assert.deepEqual(r.counts, { playlists: 2, favorites: 1, history: 0, keys: 5 });
  // what a restore leaves alone in the profile it replaces
  assert.equal(B.keepOnRestore('muriel_sync_group', P.isDevice), true);
  assert.equal(B.keepOnRestore('muriel_custom_css', P.isDevice), true);
  assert.equal(B.keepOnRestore('muriel_perf_mode', P.isDevice), true);
  assert.equal(B.keepOnRestore('someplugin_state', P.isDevice), true);
  assert.equal(B.keepOnRestore('devsize_playlists', P.isDevice), false);
  assert.throws(() => B.readBackup({ hello: 1 }), /isn't a Muriel backup/);
  assert.throws(() => B.readBackup(null), /isn't a Muriel backup/);
  const big = 'x'.repeat(B.LIMITS.keyBytes - 10);
  assert.throws(() => B.readBackup({ kind: 'muriel-backup', data: { muriel_a: big, muriel_b: big, muriel_c: big, muriel_d: big } }), /too big/);
  assert.ok(B.readBackup({ kind: 'muriel-backup', data: { muriel_a: big + 'x'.repeat(20) } }).skipped.includes('muriel_a'), 'one key over the cap is left out');
});

// how upstream Riff's main.js writes an account file
function rfacc(obj) {
  const key = crypto.createHash('sha256').update('riff-account-key-v1').digest();
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(zlib.deflateRawSync(Buffer.from(JSON.stringify(obj)))), c.final()]);
  return new Uint8Array(Buffer.concat([Buffer.from('RFAC'), iv, c.getAuthTag(), enc]));
}

test('Riff account files (.rfacc) open, and their riff_ keys become Muriel\'s', async () => {
  const file = rfacc({ app: 'Riff', version: '1.0', exportedAt: 1, localStorage: {
    devsize_playlists: JSON.stringify([{ id: 'pl_r', name: 'From Riff', tracks: [{ id: YT, title: 'x' }] }]),
    riff_theme_mode: 'light', riff_perf_mode: 'true', riff_lastfm_sk: 'secret', riff_lastfm_apisecret: 's', riff_lastfm_enabled: 'true',
    devsize_discord_rpc: 'true',
  } });
  assert.ok(B.isRiffAccount(file));
  const parsed = await B.parseBackupFile(file);
  const r = B.readBackup(parsed, { isDevice: P.isDevice });
  assert.equal(r.source, 'riff');
  assert.deepEqual(Object.keys(r.entries).sort(), ['devsize_discord_rpc', 'devsize_playlists', 'muriel_lastfm_enabled', 'muriel_theme_mode']);
  assert.equal(r.counts.playlists, 1);
  // a damaged file says so
  const broken = file.slice();
  broken[broken.length - 1] ^= 1;
  await assert.rejects(B.parseBackupFile(broken), /damaged/);
  await assert.rejects(B.parseBackupFile(new TextEncoder().encode('{nope')), /isn't a Muriel backup/);
  const own = await B.parseBackupFile(new TextEncoder().encode(JSON.stringify(B.makeBackup([['muriel_theme_mode', 'dark']]))));
  assert.equal(B.readBackup(own).entries.muriel_theme_mode, 'dark');
});

test('an .rfacc that inflates into something huge is refused', async () => {
  const key = crypto.createHash('sha256').update('riff-account-key-v1').digest();
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const bomb = zlib.deflateRawSync(Buffer.alloc(B.LIMITS.totalBytes * 2 + 10, 0x20));
  const enc = Buffer.concat([c.update(bomb), c.final()]);
  const file = new Uint8Array(Buffer.concat([Buffer.from('RFAC'), iv, c.getAuthTag(), enc]));
  await assert.rejects(B.parseBackupFile(file), /too big/);
});
