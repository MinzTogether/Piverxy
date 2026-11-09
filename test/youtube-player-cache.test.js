// The app cache against the real youtubei.js: the YouTube player script (~2.5 MB) is fetched and analysed on the
// first start only; later starts ask YouTube which player is current (a new one is picked up) and reuse the rest.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { IDBFactory } = require('fake-indexeddb');

globalThis.indexedDB = new IDBFactory();
const setStorage = (value) => Object.defineProperty(globalThis, 'localStorage', { value, configurable: true, writable: true });

let playerId = 'abcd1234';
let requests = [];
globalThis.__murielFetch = async (input) => {
  const url = typeof input === 'string' ? input : input.url || String(input);
  requests.push(url.replace('https://www.youtube.com', ''));
  if (url.includes('/youtubei/v1/config')) return new Response(JSON.stringify({ responseContext: { visitorData: 'V' }, configData: 'cfg' }), { status: 200, headers: { 'content-type': 'application/json' } });
  if (url.includes('iframe_api')) return new Response(`var s = "https:\\/\\/www.youtube.com\\/s\\/player\\/${playerId}\\/www-widgetapi.vflset\\/www-widgetapi.js";`, { status: 200 });
  if (url.includes('base.js')) return new Response('(function(g){var window=this;signatureTimestamp:20000;})(_yt_player);', { status: 200 });
  return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
};

// a new launch: fresh modules (yt() starts from nothing), same IndexedDB
async function launch() {
  for (const k of Object.keys(require.cache)) if (/[\\/]mobile[\\/](extract|app-cache)\.js$/.test(k)) delete require.cache[k];
  requests = [];
  const { youtubeSearch } = require('../mobile/extract.js');
  await youtubeSearch('anything', 1).catch(() => {}); // the search itself is not what is tested: creating the client is
  return { players: requests.filter((r) => /base\.js/.test(r)), iframe: requests.filter((r) => /iframe_api/.test(r)), configs: requests.filter((r) => /v1\/config/.test(r)) };
}

test('player cache: the player script is downloaded on the first start only', async () => {
  setStorage(undefined);
  const first = await launch();
  assert.equal(first.players.length, 1);
  const second = await launch();
  assert.equal(second.players.length, 0, 'not downloaded again');
  assert.equal(second.iframe.length, 1, 'but YouTube is still asked which player is current');
  assert.equal(second.configs.length, 1, 'and the session is made fresh as before');
  const third = await launch();
  assert.equal(third.players.length, 0);
});

test('player cache: a new YouTube player is picked up and downloaded once', async () => {
  setStorage(undefined);
  playerId = 'ffff0000';
  const a = await launch();
  assert.equal(a.players.length, 1);
  assert.match(a.players[0], /ffff0000/);
  const b = await launch();
  assert.equal(b.players.length, 0);
  playerId = 'abcd1234'; // the earlier one is still kept
  const c = await launch();
  assert.equal(c.players.length, 0);
});

test('player cache: switched off, the player is downloaded at every start, as before', async () => {
  const off = { getItem: (k) => (k === 'muriel_app_cache' ? '0' : null), setItem() {}, removeItem() {} };
  setStorage(off);
  playerId = '12345678';
  assert.equal((await launch()).players.length, 1);
  assert.equal((await launch()).players.length, 1);
  setStorage(undefined);
});

test('player cache: a cache that fails does not stop the client from being created', async () => {
  setStorage(undefined);
  const real = globalThis.indexedDB;
  globalThis.indexedDB = { open() { throw new Error('no storage'); } };
  try {
    playerId = '87654321';
    const r = await launch();
    assert.equal(r.players.length, 1);
    assert.equal((await launch()).players.length, 1);
  } finally { globalThis.indexedDB = real; }
});
