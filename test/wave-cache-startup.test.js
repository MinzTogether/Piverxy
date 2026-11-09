'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const appSource = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

function extractFn(source, name) {
  let at = source.indexOf(`function ${name}(`);
  assert.ok(at >= 0, `function ${name} not found`);
  if (source.slice(at - 6, at) === 'async ') at -= 6;
  const open = source.indexOf('{', at + source.slice(at).search(/\)\s*\{/));
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(at, i + 1);
  }
  throw new Error(`unbalanced ${name}`);
}

function createHarness({ isSpotify = false, advWave = true, advJump = true, cachedData = null, homePane = 'wave' } = {}) {
  const events = [];
  const marks = [];

  const domElements = {
    'section-jump-back': { style: {} },
    'section-my-wave': { style: {} },
    'home-vibe-grid': {
      style: {},
      innerHTML: '',
      scrollLeft: 0,
      _focusedIndex: 0,
      children: [],
      querySelector: () => null,
      querySelectorAll: () => [],
      appendChild: (frag) => {
        if (frag && Array.isArray(frag._children)) {
          domElements['home-vibe-grid'].children = frag._children;
        }
      },
    },
    'my-wave-focused-meta': { innerHTML: '' },
    'home-hero': { style: {} },
    'home-hero-dots': { style: {}, innerHTML: '' },
    'home-ambient': { style: {} },
    'sp-made-sec': { hidden: false },
    'sp-made': { innerHTML: '', appendChild: () => {} },
  };

  const document = {
    getElementById: (id) => domElements[id] || { style: {}, innerHTML: '' },
    querySelector: (sel) => {
      if (sel.includes('home-pane-label')) return { style: {}, addEventListener: () => {} };
      if (sel.includes('my-wave-actions')) return { style: {} };
      return null;
    },
    querySelectorAll: () => [],
    createDocumentFragment: () => {
      const frag = { _children: [], appendChild: (c) => frag._children.push(c) };
      return frag;
    },
    createElement: () => ({
      style: {},
      dataset: {},
      innerHTML: '',
      addEventListener: () => {},
      querySelector: () => ({
        complete: true,
        classList: { add: () => {} },
        addEventListener: () => {},
      }),
    }),
    activeElement: null,
  };

  const window = {
    MurielAppCache: {
      home: {
        readWave: () => cachedData,
        writeWave: (d) => { events.push({ type: 'writeWave', data: d }); return true; },
        readForYou: () => null,
        writeForYou: () => {},
      },
    },
    MurielLog: {
      add: (level, msg) => events.push({ type: 'log', level, msg }),
    },
  };

  const performance = {
    now: () => 100.0,
    mark: (name) => marks.push(name),
  };

  const state = {
    serverPort: 38472,
    history: [],
    favorites: [],
    isHotPicks: false,
    hotPicksTitle: '',
  };

  let renderedCarouselMode = null;
  let madeForYouRenderCount = 0;

  const ctx = {
    console,
    Promise,
    Set,
    Array,
    Date,
    JSON,
    document,
    window,
    performance,
    state,
    events,
    marks,
    myWaveCurrentTracks: [],
    jumpBackCurrentTracks: [],
    currentWaveFocusedIndex: -1,
    spHomeReady: true,
    homeMode: homePane,
    isSpotifyHome: () => isSpotify,
    getAdv: (key, def) => (key === 'my_wave' ? advWave : (key === 'jump_back' ? advJump : def)),
    isBlocked: (t) => t && t.blocked === true,
    availableModes: () => {
      const m = [];
      if (advWave) m.push('wave');
      if (advJump) m.push('recent');
      return m;
    },
    getJumpBackTracks: () => [],
    initHomeHero: () => events.push({ type: 'initHomeHero' }),
    renderMadeForYou: () => {
      madeForYouRenderCount++;
      events.push({ type: 'renderMadeForYou', tracks: ctx.myWaveCurrentTracks.length });
    },
    renderHomeCarousel: (mode) => {
      renderedCarouselMode = mode;
      events.push({ type: 'renderHomeCarousel', mode, count: ctx.myWaveCurrentTracks.length });
    },
    loadForYou: () => {
      events.push({ type: 'loadForYou' });
    },
    computeTasteProfile: async () => {
      events.push({ type: 'computeTasteProfile' });
      return { trackCount: 10, seeds: [] };
    },
    getWaveAvoid: () => [],
    getTrackCanonicalId: (t) => t.id || t.title,
    getTrackNormalizedKey: (artist, title) => `${artist}-${title}`,
    getWaveSpinnerHtml: () => '<spinner>',
    escapeHtml: (s) => String(s),
    I18N: { text: () => {} },
    updateAmbientLight: () => {},
    updateTextFade: () => {},
    updateCoverflowCards: () => {},
    getTrackThumbUrl: (t) => (t && t.thumbnail) || '',
    fetch: async () => ({ ok: true, json: async () => ({ success: true, tracks: [] }) }),
  };

  const markTimingFn = extractFn(appSource, 'markTiming');
  const restoreFn = extractFn(appSource, 'restoreCachedWave');
  const loadHomeFn = extractFn(appSource, 'loadHomePage');

  vm.createContext(ctx);
  vm.runInContext(`${markTimingFn}\n${restoreFn}\n${loadHomeFn}`, ctx);

  return { ctx, events, marks, domElements, getRenderedCarouselMode: () => renderedCarouselMode, getMadeForYouRenderCount: () => madeForYouRenderCount };
}

test('restoreCachedWave: renders Muriel carousel immediately when layout is Muriel and mode is wave', () => {
  const cachedData = {
    tracks: [
      { id: '1', title: 'Song 1', artist: 'Artist 1' },
      { id: '2', title: 'Song 2', artist: 'Artist 2' },
    ],
    hot: false,
    title: '',
  };

  const { ctx, events, marks } = createHarness({ isSpotify: false, cachedData, homePane: 'wave' });
  const restored = ctx.restoreCachedWave();

  assert.ok(restored, 'returns restored data');
  assert.equal(ctx.myWaveCurrentTracks.length, 2);
  assert.equal(ctx.currentWaveFocusedIndex, 0);

  // Verifies that renderHomeCarousel was called synchronously
  const renderEvt = events.find((e) => e.type === 'renderHomeCarousel');
  assert.ok(renderEvt, 'renderHomeCarousel must be called immediately');
  assert.equal(renderEvt.mode, 'wave');
  assert.equal(renderEvt.count, 2);

  // Verifies timing marks sequence
  assert.deepEqual(marks, ['wave-cache:read-start', 'wave-cache:read-end', 'wave-cache:rendered']);
});

test('restoreCachedWave: filters blocked tracks from cache before rendering', () => {
  const cachedData = {
    tracks: [
      { id: '1', title: 'Song 1', artist: 'Artist 1' },
      { id: '2', title: 'Blocked Song', artist: 'Artist 2', blocked: true },
      { id: '3', title: 'Song 3', artist: 'Artist 3' },
    ],
    hot: true,
    title: 'Hot picks 2026',
  };

  const { ctx } = createHarness({ isSpotify: false, cachedData, homePane: 'wave' });
  const restored = ctx.restoreCachedWave();

  assert.ok(restored);
  assert.equal(ctx.myWaveCurrentTracks.length, 2, 'blocked song must be filtered out');
  assert.equal(ctx.myWaveCurrentTracks[0].id, '1');
  assert.equal(ctx.myWaveCurrentTracks[1].id, '3');
  assert.equal(ctx.state.isHotPicks, true);
  assert.equal(ctx.state.hotPicksTitle, 'Hot picks 2026');
});

test('restoreCachedWave: renders Spotify layout when isSpotifyHome is true', () => {
  const cachedData = {
    tracks: [{ id: '1', title: 'Song 1', artist: 'Artist 1' }],
    hot: false,
    title: '',
  };

  const { ctx, events, marks, getMadeForYouRenderCount } = createHarness({ isSpotify: true, cachedData });
  const restored = ctx.restoreCachedWave();

  assert.ok(restored);
  assert.equal(getMadeForYouRenderCount(), 1);
  const carouselEvt = events.find((e) => e.type === 'renderHomeCarousel');
  assert.equal(carouselEvt, undefined, 'Muriel carousel should not be rendered in Spotify layout');
  assert.deepEqual(marks, ['wave-cache:read-start', 'wave-cache:read-end', 'wave-cache:rendered']);
});

test('restoreCachedWave: does not render wave carousel if homeMode is recent', () => {
  const cachedData = {
    tracks: [{ id: '1', title: 'Song 1', artist: 'Artist 1' }],
    hot: false,
    title: '',
  };

  const { ctx, events } = createHarness({ isSpotify: false, cachedData, homePane: 'recent' });
  const restored = ctx.restoreCachedWave();

  assert.ok(restored);
  assert.equal(ctx.myWaveCurrentTracks.length, 1);
  const carouselEvt = events.find((e) => e.type === 'renderHomeCarousel');
  assert.equal(carouselEvt, undefined, 'should not render wave carousel over recent');
});

test('restoreCachedWave: returns null and does not render when my_wave is disabled in settings', () => {
  const cachedData = {
    tracks: [{ id: '1', title: 'Song 1', artist: 'Artist 1' }],
    hot: false,
    title: '',
  };

  const { ctx, events } = createHarness({ isSpotify: false, advWave: false, cachedData });
  const restored = ctx.restoreCachedWave();

  assert.equal(restored, null);
  assert.equal(ctx.myWaveCurrentTracks.length, 0);
  assert.equal(events.length, 0);
});

test('loadHomePage: renders cached wave BEFORE loadForYou, computeTasteProfile, and network requests, without blanking opacity', async () => {
  const cachedData = {
    tracks: [{ id: 'cached1', title: 'Cached Song', artist: 'Cached Artist' }],
    hot: false,
    title: '',
  };

  let tasteProfileCalled = false;
  let renderBeforeTasteProfile = false;
  let opacityZeroSeen = false;

  const { ctx, events, marks, domElements } = createHarness({ isSpotify: false, cachedData, homePane: 'wave' });

  Object.defineProperty(domElements['home-vibe-grid'].style, 'opacity', {
    get() { return this._op; },
    set(v) {
      if (v === '0') opacityZeroSeen = true;
      this._op = v;
    },
  });

  ctx.renderHomeCarousel = (mode) => {
    if (!tasteProfileCalled) {
      renderBeforeTasteProfile = true;
    }
    events.push({ type: 'renderHomeCarousel', mode, count: ctx.myWaveCurrentTracks.length });
  };

  ctx.computeTasteProfile = async () => {
    tasteProfileCalled = true;
    events.push({ type: 'computeTasteProfile' });
    return { trackCount: 10, seeds: [] };
  };

  // Simulated vibe fetch returns fresh tracks
  ctx.fetch = async (url) => {
    if (url.includes('/api/vibe')) {
      events.push({ type: 'fetchVibe' });
      return {
        ok: true,
        json: async () => ({
          success: true,
          tracks: [
            { id: 'fresh1', title: 'Fresh 1', artist: 'Artist 1' },
            { id: 'fresh2', title: 'Fresh 2', artist: 'Artist 2' },
          ],
        }),
      };
    }
    return { ok: true, json: async () => ({ success: false }) };
  };

  await ctx.loadHomePage(false);

  assert.equal(renderBeforeTasteProfile, true, 'Cached carousel must be rendered BEFORE computeTasteProfile');
  assert.equal(opacityZeroSeen, false, 'vibeGrid must not be blanked to opacity 0 when cachedWave was already displayed');

  // Verify sequence of events: My Wave cache renders BEFORE loadForYou and computeTasteProfile
  const eventTypes = events.map((e) => e.type);
  const firstRenderIdx = eventTypes.indexOf('renderHomeCarousel');
  const loadForYouIdx = eventTypes.indexOf('loadForYou');
  const tasteProfileIdx = eventTypes.indexOf('computeTasteProfile');
  const fetchVibeIdx = eventTypes.indexOf('fetchVibe');

  assert.ok(firstRenderIdx < loadForYouIdx, 'My Wave cache renders before loadForYou');
  assert.ok(firstRenderIdx < tasteProfileIdx, 'first render before taste profile');
  assert.ok(tasteProfileIdx < fetchVibeIdx, 'taste profile before network fetch');

  // Verify timing marks order
  assert.ok(marks.indexOf('wave-cache:read-end') < marks.indexOf('wave-cache:rendered'));
  assert.ok(marks.indexOf('wave-cache:rendered') < marks.indexOf('vibe:request-start'));
  assert.ok(marks.indexOf('vibe:request-start') < marks.indexOf('vibe:request-end'));
  assert.ok(marks.indexOf('vibe:request-end') < marks.indexOf('wave:fresh-rendered'));
});

test('loadHomePage: offline or failed network request keeps cached wave visible without error', async () => {
  const cachedData = {
    tracks: [{ id: 'cached1', title: 'Cached Song', artist: 'Cached Artist' }],
    hot: false,
    title: '',
  };

  const { ctx, domElements } = createHarness({ isSpotify: false, cachedData, homePane: 'wave' });

  // Network fails
  ctx.fetch = async () => { throw new Error('Offline'); };

  const ok = await ctx.loadHomePage(false);

  // ok is false because fresh load didn't succeed, but cached wave remains
  assert.equal(ok, false);
  assert.equal(ctx.myWaveCurrentTracks.length, 1);
  assert.equal(ctx.myWaveCurrentTracks[0].id, 'cached1');
  // Spinner / retry container was NOT injected because cached wave was maintained
  assert.equal(domElements['home-vibe-grid'].innerHTML.includes('my-wave-retry-container'), false);
});

test('loadHomePage: does not jump carousel if user scrolled while network request was in flight', async () => {
  const cachedData = {
    tracks: [{ id: 'cached1', title: 'Cached 1', artist: 'Artist 1' }],
    hot: false,
    title: '',
  };

  const { ctx, domElements } = createHarness({ isSpotify: false, cachedData, homePane: 'wave' });

  ctx.fetch = async (url) => {
    if (url.includes('/api/vibe')) {
      // User scrolled while request was in-flight!
      domElements['home-vibe-grid'].scrollLeft = 120;
      return {
        ok: true,
        json: async () => ({
          success: true,
          tracks: [{ id: 'fresh1', title: 'Fresh 1', artist: 'Artist 1' }],
        }),
      };
    }
    return { ok: true, json: async () => ({ success: false }) };
  };

  await ctx.loadHomePage(false);

  // Cached track remains on screen so user experience does not jump under finger
  assert.equal(ctx.myWaveCurrentTracks[0].id, 'cached1');
  // Fresh tracks were written to cache for next launch
  const writeEvt = ctx.events.find((e) => e.type === 'writeWave');
  assert.ok(writeEvt, 'fresh tracks should be written to cache');
  assert.equal(writeEvt.data.tracks[0].id, 'fresh1');
});

test('renderHomeCarousel & buildHomeCard: skips redundant DOM wipe for identical source and sets eager loading + is-loaded on hero card', () => {
  const cachedData = {
    tracks: [
      { id: '1', title: 'Song 1', artist: 'Artist 1', thumbnail: 'https://img/1.jpg' },
      { id: '2', title: 'Song 2', artist: 'Artist 2', thumbnail: 'https://img/2.jpg' },
    ],
    hot: false,
    title: '',
  };

  const { ctx, domElements } = createHarness({ isSpotify: false, cachedData, homePane: 'wave' });
  const buildCardFn = extractFn(appSource, 'buildHomeCard');
  const renderCarouselFn = extractFn(appSource, 'renderHomeCarousel');

  let createdCount = 0;
  let lastCardHtml = '';
  let loadedClassAdded = false;
  ctx.document.createElement = () => {
    createdCount++;
    return {
      style: {},
      dataset: {},
      get innerHTML() { return lastCardHtml; },
      set innerHTML(v) { lastCardHtml = v; },
      addEventListener: () => {},
      querySelector: () => ({
        complete: true,
        classList: { add: (c) => { if (c === 'is-loaded') loadedClassAdded = true; } },
        addEventListener: () => {},
      }),
    };
  };

  vm.runInContext(`${buildCardFn}\n${renderCarouselFn}`, ctx);
  ctx.myWaveCurrentTracks = cachedData.tracks;

  // First call builds 2 cards
  ctx.renderHomeCarousel('wave');
  assert.equal(createdCount, 2);
  assert.equal(loadedClassAdded, true, 'completed image must immediately receive is-loaded class');
  assert.ok(lastCardHtml.includes('onload="this.classList.add(\'is-loaded\')"'), 'inline onload handler present');

  // Second call with identical source and mode does NOT wipe or recreate DOM cards
  ctx.renderHomeCarousel('wave');
  assert.equal(createdCount, 2, 'must not destroy and recreate DOM cards when called again with same source');
});

test('mobile electronAPI: getServerPort resolves immediately without blocking on ready (fs.init)', async () => {
  const electronApiSource = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'electron-api.js'), 'utf8');
  assert.ok(
    electronApiSource.includes('getServerPort: async () => port'),
    'getServerPort must return port immediately without waiting on ready'
  );
});
