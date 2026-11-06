// Muriel Web Player. The whole playlist travels in the link (#p=<payload>, see share-link.js); this page decodes
// it and plays it with the official YouTube IFrame Player API, plus the SoundCloud widget for SoundCloud songs.
// Every string from the link goes into the page with textContent, never innerHTML.
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const YT_ID = /^[A-Za-z0-9_-]{11}$/;
  const SC_URL = /^https:\/\/(?:www\.|m\.)?soundcloud\.com\/[^\s]+$/;
  const SVGNS = 'http://www.w3.org/2000/svg';
  const UA = navigator.userAgent || '';
  const IPADOS = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  const IS_PHONE = /iPhone|iPad|iPod|Android/i.test(UA) || IPADOS;
  const IS_IOS = /iPhone|iPad|iPod/i.test(UA) || IPADOS;
  const REPEAT_TITLES = { off: 'Repeat', all: 'Repeat: playlist', one: 'Repeat: this song' };

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } },
  };

  const savedVol = Number(store.get('muriel_web_volume'));
  const S = {
    payload: '', name: '', tracks: [], kinds: [], bad: new Map(), // bad: index -> YouTube error code
    order: [], pos: -1, cur: -1, started: false,
    shuffle: false,
    repeat: REPEAT_TITLES[store.get('muriel_web_repeat')] ? store.get('muriel_web_repeat') : 'off',
    vol: Number.isFinite(savedVol) && store.get('muriel_web_volume') !== null ? Math.min(100, Math.max(0, savedVol)) : 100,
    muted: store.get('muriel_web_muted') === '1',
    engine: '', playing: false, buffering: false, wantPlay: false,
    time: 0, dur: 0, seeking: false, gen: 0,
    hold: { until: 0, to: 0 }, // right after a seek, players still report the old position for a moment
  };
  // a position reported by a player, unless it's stale news from before our last seek
  const fresh = (pos) => Date.now() > S.hold.until || Math.abs(pos - S.hold.to) < 1.5;
  let rows = [];

  // ---------- small helpers ----------
  function h(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function icon(name, cls) {
    const s = document.createElementNS(SVGNS, 'svg');
    s.setAttribute('class', cls || 'ico');
    s.setAttribute('aria-hidden', 'true');
    const u = document.createElementNS(SVGNS, 'use');
    u.setAttribute('href', '#i-' + name);
    s.appendChild(u);
    return s;
  }
  const pad = (n) => String(n).padStart(2, '0');
  function fmt(sec) {
    const s = Math.max(0, Math.floor(Number(sec) || 0));
    const hr = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return hr ? `${hr}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
  }
  function totalText(sec) {
    const s = Math.round(sec);
    if (s <= 0) return '';
    if (s < 60) return `${s} sec`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m} min`;
    return `${Math.floor(m / 60)} hr` + (m % 60 ? ` ${m % 60} min` : '');
  }
  const kindOf = (t) => (t && t.platform === 'youtube' && YT_ID.test(String(t.id)) ? 'yt'
    : t && t.platform === 'soundcloud' && SC_URL.test(String(t.url)) ? 'sc' : 'web');
  // thumbnails only ever come from i.ytimg.com, built from a checked 11-character video id
  const ytThumb = (t, q) => (kindOf(t) === 'yt' ? `https://i.ytimg.com/vi/${t.id}/${q || 'mqdefault'}.jpg` : '');
  const safeHttps = (u) => (/^https:\/\/[^\s"'<>\\]+$/.test(String(u)) ? String(u) : '');
  const watchUrl = (t) => (kindOf(t) === 'yt' ? `https://www.youtube.com/watch?v=${t.id}` : safeHttps(t.url));

  function img(src, lazy) {
    const i = new Image();
    i.alt = '';
    i.decoding = 'async';
    if (lazy) i.loading = 'lazy';
    // a missing YouTube thumbnail comes back as a 120x90 gray placeholder
    i.addEventListener('load', () => { if (i.naturalWidth && i.naturalWidth <= 120) i.remove(); else i.classList.add('ok'); });
    i.addEventListener('error', () => i.remove());
    i.src = src;
    return i;
  }
  function eq() {
    const e = h('span', 'eq');
    e.setAttribute('aria-hidden', 'true');
    e.append(h('i'), h('i'), h('i'));
    return e;
  }
  function thumb(t, k, cls) {
    const box = h('span', (cls || 'thumb') + (k === 'yt' ? '' : ' ' + k));
    if (k === 'yt') box.append(img(ytThumb(t, 'mqdefault'), true));
    else box.append(icon(k === 'sc' ? 'cloud' : 'note'));
    return box;
  }

  let toastTimer = 0, toastHide = 0;
  function toast(msg, ms) {
    const t = $('toast');
    t.textContent = msg;
    clearTimeout(toastTimer); clearTimeout(toastHide);
    t.classList.remove('out');
    t.hidden = false;
    toastTimer = setTimeout(() => {
      t.classList.add('out');
      toastHide = setTimeout(() => { t.hidden = true; }, 320);
    }, ms || 3400);
  }

  // ---------- queue ----------
  const playable = (i) => i >= 0 && i < S.tracks.length && !S.bad.has(i)
    && (S.kinds[i] === 'yt' || (S.kinds[i] === 'sc' && !SCP.failed));

  function shuffled(list) {
    const a = list.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
  // the play order: natural, or shuffled with `first` (or the current song) up front
  function rebuildOrder(first) {
    const lead = first != null ? first : S.cur;
    const all = S.tracks.map((_, i) => i);
    if (S.shuffle) {
      const rest = shuffled(all.filter((i) => i !== lead));
      S.order = lead >= 0 ? [lead, ...rest] : rest;
    } else S.order = all;
    S.pos = S.cur >= 0 ? S.order.indexOf(S.cur) : -1;
  }
  // next playable position in the order from `pos`, or -1
  function stepFrom(pos, dir, wrap) {
    const n = S.order.length;
    for (let k = 1; k <= n; k++) {
      let p = pos + dir * k;
      if (p < 0 || p >= n) {
        if (!wrap) return -1;
        p = ((p % n) + n) % n;
      }
      if (playable(S.order[p])) return p;
    }
    return -1;
  }
  const firstPlayable = () => stepFrom(-1, 1, false);

  // ---------- YouTube ----------
  const YTP = {
    api: null, player: null, ready: false, failed: false, state: -1, vid: '', boot: null,
    loadApi() {
      if (window.YT && window.YT.Player) return Promise.resolve();
      if (this.api) return this.api;
      this.api = new Promise((resolve, reject) => {
        const prev = window.onYouTubeIframeAPIReady;
        window.onYouTubeIframeAPIReady = function () {
          if (typeof prev === 'function') { try { prev(); } catch (e) { /* not ours */ } }
          resolve();
        };
        const s = document.createElement('script');
        s.src = 'https://www.youtube.com/iframe_api';
        s.async = true;
        s.onerror = () => { s.remove(); reject(new Error('YouTube is not reachable')); };
        document.head.appendChild(s);
        setTimeout(() => reject(new Error('YouTube took too long')), 20000);
      });
      this.api.catch(() => { this.api = null; });
      return this.api;
    },
    create(videoId) {
      return new Promise((resolve, reject) => {
        const host = $('np-yt');
        host.textContent = '';
        const div = h('div');
        div.id = 'yt-host';
        host.append(div);
        const vars = { playsinline: 1, rel: 0, iv_load_policy: 3, modestbranding: 1, enablejsapi: 1, autoplay: 0, fs: 1 };
        if (/^https?:/.test(location.protocol)) vars.origin = location.origin;
        this.vid = videoId;
        // the API copies location.href (playlist included) into the embed URL; the playlist stays after the #
        // and off every server, so hide it for the moment the player is built
        const hash = location.hash;
        let hid = false;
        try { if (hash) { history.replaceState(history.state, '', location.pathname + location.search); hid = true; } } catch (e) { /* sandboxed */ }
        try {
          this.player = new window.YT.Player('yt-host', {
            width: '100%', height: '100%', videoId, playerVars: vars,
            events: {
              onReady: () => { this.ready = true; resolve(); },
              onStateChange: (e) => onYtState(e.data),
              onError: (e) => onYtError(e.data),
            },
          });
        } finally {
          if (hid) { try { history.replaceState(history.state, '', location.pathname + location.search + hash); } catch (e) { /* sandboxed */ } }
        }
        setTimeout(() => { if (!this.ready) reject(new Error('YouTube took too long')); }, 20000);
      });
    },
    call(fn, ...args) {
      if (!this.ready || !this.player || typeof this.player[fn] !== 'function') return undefined;
      try { return this.player[fn](...args); } catch (e) { return undefined; }
    },
  };

  function ensureYt(videoId) {
    if (YTP.ready) return Promise.resolve();
    if (YTP.boot) return YTP.boot;
    YTP.failed = false;
    syncStage();
    YTP.boot = YTP.loadApi().then(() => YTP.create(videoId)).then(() => {
      applyVolume();
      syncStage();
    }, (err) => {
      YTP.boot = null;
      YTP.failed = true;
      syncStage();
      throw err;
    });
    return YTP.boot;
  }

  function onYtState(s) {
    YTP.state = s;
    if (S.engine !== 'yt') { if (s === 1) YTP.call('pauseVideo'); return; }
    if (s === 1) { S.wantPlay = false; setBuffering(false); setPlaying(true); hint(false); }
    else if (s === 2) { setBuffering(false); setPlaying(false); }
    else if (s === 3) setBuffering(true);
    else if (s === 5) setBuffering(S.wantPlay);
    else if (s === 0) { setPlaying(false); setBuffering(false); onEnded(); }
    tick();
  }

  function onYtError(code) {
    if (S.engine !== 'yt' || S.cur < 0) return;
    const i = S.cur;
    const keepGoing = S.wantPlay || S.playing || S.started;
    markBad(i, code);
    if (S.started) toast(`Skipped “${S.tracks[i].title}”: it can't play here.`);
    skipAfterError(keepGoing);
  }

  // ---------- SoundCloud ----------
  const SCP = {
    api: null, widget: null, booted: false, failed: false, boot: null, url: '', pos: 0, dur: 0, playing: false,
    opts: { visual: true, hide_related: true, show_comments: false, show_reposts: false, show_teaser: false, show_user: true, buying: false, sharing: false, download: false, show_playcount: false, single_active: false, color: '#ff5fa8' },
    loadApi() {
      if (window.SC && window.SC.Widget) return Promise.resolve();
      if (this.api) return this.api;
      this.api = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://w.soundcloud.com/player/api.js';
        s.async = true;
        s.onload = () => (window.SC && window.SC.Widget ? resolve() : reject(new Error('SoundCloud widget missing')));
        s.onerror = () => { s.remove(); reject(new Error('SoundCloud is not reachable')); };
        document.head.appendChild(s);
        setTimeout(() => reject(new Error('SoundCloud took too long')), 20000);
      });
      this.api.catch(() => { this.api = null; });
      return this.api;
    },
    src(url, autoplay) {
      const q = new URLSearchParams({ url, auto_play: String(!!autoplay) });
      Object.keys(this.opts).forEach((k) => q.set(k, String(this.opts[k])));
      return 'https://w.soundcloud.com/player/?' + q.toString();
    },
    start(url, autoplay) {
      if (this.boot) return this.boot;
      syncStage();
      this.boot = this.loadApi().then(() => new Promise((resolve, reject) => {
        const f = document.createElement('iframe');
        f.title = 'SoundCloud player';
        f.allow = 'autoplay; encrypted-media';
        f.setAttribute('scrolling', 'no');
        f.src = this.src(url, autoplay);
        $('np-sc').textContent = '';
        $('np-sc').append(f);
        const w = window.SC.Widget(f);
        const E = window.SC.Widget.Events;
        this.widget = w;
        this.url = url;
        w.bind(E.READY, () => {
          if (this.booted) return;
          this.booted = true;
          this.readDuration();
          applyVolume();
          resolve();
        });
        w.bind(E.PLAY, () => { this.playing = true; onScState('play'); });
        w.bind(E.PAUSE, () => { this.playing = false; onScState('pause'); });
        w.bind(E.FINISH, () => { this.playing = false; onScState('finish'); });
        w.bind(E.PLAY_PROGRESS, (d) => {
          this.pos = (Number(d && d.currentPosition) || 0) / 1000;
          if (S.engine === 'sc' && !S.seeking && fresh(this.pos)) { S.time = this.pos; renderTime(); }
        });
        w.bind(E.ERROR, () => onScError());
        setTimeout(() => { if (!this.booted) reject(new Error('SoundCloud took too long')); }, 20000);
      })).then(() => syncStage(), (err) => {
        this.failed = true;
        syncStage();
        throw err;
      });
      return this.boot;
    },
    load(url, autoplay) {
      if (!this.widget) return;
      this.url = url;
      this.dur = 0;
      this.pos = 0;
      const opts = Object.assign({}, this.opts, {
        auto_play: !!autoplay,
        callback: () => {
          if (this.url !== url) return;
          this.readDuration();
          applyVolume();
          if (autoplay && S.wantPlay) this.call('play');
        },
      });
      this.call('load', url, opts);
    },
    readDuration() {
      this.call('getDuration', (ms) => {
        this.dur = (Number(ms) || 0) / 1000;
        if (S.engine === 'sc' && this.dur > 0) { S.dur = this.dur; renderTime(); }
      });
    },
    call(fn, ...args) {
      if (!this.widget || typeof this.widget[fn] !== 'function') return;
      try { this.widget[fn](...args); } catch (e) { /* widget gone */ }
    },
  };

  function onScState(what) {
    if (S.engine !== 'sc') { if (what === 'play') SCP.call('pause'); return; }
    if (what === 'play') { S.wantPlay = false; setBuffering(false); setPlaying(true); hint(false); }
    else if (what === 'pause') { setBuffering(false); setPlaying(false); }
    else if (what === 'finish') { setPlaying(false); onEnded(); }
  }
  function onScError() {
    if (S.engine !== 'sc' || S.cur < 0) return;
    const i = S.cur;
    const keepGoing = S.wantPlay || S.playing || S.started;
    markBad(i, 0);
    if (S.started) toast(`Skipped “${S.tracks[i].title}”: it can't play here.`);
    skipAfterError(keepGoing);
  }
  // SoundCloud can't load at all: its songs become plain links and the queue skips them
  function soundCloudOff() {
    if (!SCP.failed) SCP.failed = true;
    renderList();
    renderUpNext();
    if (S.tracks.some((t, i) => S.kinds[i] === 'sc')) toast('SoundCloud isn’t reachable right now, so its songs open on SoundCloud.');
  }

  // ---------- playback ----------
  function load(i, autoplay) {
    const t = S.tracks[i];
    const k = S.kinds[i];
    if (!t || !playable(i)) return;
    S.cur = i;
    S.pos = S.order.indexOf(i);
    S.engine = k;
    S.time = 0;
    S.dur = t.duration || 0;
    S.wantPlay = !!autoplay;
    setPlaying(false);
    setBuffering(!!autoplay);
    hint(false);
    showTrack(i);
    $('np-yt').classList.toggle('off', k !== 'yt');
    $('np-sc').classList.toggle('off', k !== 'sc');
    if (k === 'yt') {
      SCP.call('pause');
      if (YTP.ready) {
        YTP.vid = t.id;
        YTP.call(autoplay ? 'loadVideoById' : 'cueVideoById', t.id);
      } else {
        ensureYt(t.id).then(() => {
          if (S.cur !== i || S.engine !== 'yt') return;
          if (YTP.vid !== t.id) { YTP.vid = t.id; YTP.call(S.wantPlay ? 'loadVideoById' : 'cueVideoById', t.id); }
          else if (S.wantPlay) YTP.call('playVideo');
        }).catch(() => {
          if (S.cur !== i) return;
          setBuffering(false);
          if (S.wantPlay) toast('Couldn’t reach YouTube. Check your connection and try again.');
          S.wantPlay = false;
        });
      }
    } else if (k === 'sc') {
      YTP.call('pauseVideo');
      if (SCP.booted) SCP.load(t.url, autoplay);
      else {
        SCP.start(t.url, autoplay).then(() => {
          if (S.cur !== i || S.engine !== 'sc') return;
          if (SCP.url !== t.url) SCP.load(t.url, S.wantPlay);
          else if (S.wantPlay) SCP.call('play');
        }).catch(() => {
          setBuffering(false);
          S.wantPlay = false;
          soundCloudOff();
          if (S.cur === i) {
            const n = stepFrom(S.pos, 1, S.repeat === 'all');
            if (n >= 0) load(S.order[n], autoplay); else stopAtEnd();
          }
        });
      }
    }
    syncStage();
    if (autoplay) armHint();
    renderTime();
  }

  function playFrom(i) {
    if (!playable(i)) return;
    S.started = true;
    if (S.shuffle) { S.cur = i; rebuildOrder(i); }
    load(i, true);
  }

  function play() {
    if (S.cur < 0 || !playable(S.cur)) {
      const f = firstPlayable();
      if (f >= 0) playFrom(S.order[f]);
      return;
    }
    S.started = true;
    S.wantPlay = true;
    showTrack(S.cur);
    setBuffering(true);
    if (S.engine === 'yt') {
      if (YTP.ready) {
        if (YTP.state === 0) YTP.call('seekTo', 0, true);
        // a cued video that never started gets a fresh load, so an error YouTube kept quiet about shows up now
        if (YTP.state === 5 || YTP.state === -1) { YTP.vid = S.tracks[S.cur].id; YTP.call('loadVideoById', YTP.vid); }
        else YTP.call('playVideo');
      } else load(S.cur, true);
    } else if (S.engine === 'sc') {
      if (SCP.booted) SCP.call('play'); else load(S.cur, true);
    }
    armHint();
  }

  function pause() {
    S.wantPlay = false;
    setBuffering(false);
    if (S.engine === 'yt') YTP.call('pauseVideo');
    else if (S.engine === 'sc') SCP.call('pause');
    setPlaying(false);
    hint(false);
  }

  const togglePlay = () => (S.playing || S.wantPlay ? pause() : play());

  function next() {
    if (S.cur < 0) return play();
    const keep = S.playing || S.wantPlay || S.started;
    const n = stepFrom(S.pos, 1, S.repeat === 'all');
    if (n < 0) return stopAtEnd();
    S.started = S.started || keep;
    load(S.order[n], keep);
  }

  function prev() {
    if (S.cur < 0) return play();
    if (S.time > 3) return seekTo(0);
    const p = stepFrom(S.pos, -1, S.repeat === 'all');
    if (p < 0) return seekTo(0);
    load(S.order[p], S.playing || S.wantPlay || S.started);
  }

  function onEnded() {
    if (S.repeat === 'one' && playable(S.cur)) {
      seekTo(0);
      play();
      return;
    }
    const n = stepFrom(S.pos, 1, S.repeat === 'all');
    if (n < 0) return stopAtEnd();
    load(S.order[n], true);
  }

  function skipAfterError(keepGoing) {
    const n = stepFrom(S.pos, 1, S.repeat === 'all');
    if (n < 0 || S.order[n] === S.cur) return stopAtEnd();
    load(S.order[n], keepGoing);
  }

  // end of the list (repeat off): stop and line the first song up again
  function stopAtEnd() {
    S.wantPlay = false;
    setPlaying(false);
    setBuffering(false);
    hint(false);
    const f = firstPlayable();
    if (f < 0) {
      S.engine = '';
      syncStage();
      updateControls();
      return;
    }
    load(S.order[f], false);
  }

  function seekTo(sec) {
    if (S.cur < 0) return;
    const d = S.dur || 0;
    const t = Math.max(0, d ? Math.min(sec, Math.max(0, d - 0.25)) : sec);
    if (S.engine === 'yt') YTP.call('seekTo', t, true);
    else if (S.engine === 'sc') SCP.call('seekTo', Math.round(t * 1000));
    S.time = t;
    S.hold = { until: Date.now() + 1200, to: t };
    renderTime();
    positionState();
  }
  const seekBy = (d) => seekTo((S.time || 0) + d);

  // ---------- volume ----------
  function applyVolume() {
    const v = Math.round(S.vol);
    YTP.call('setVolume', v);
    YTP.call(S.muted ? 'mute' : 'unMute');
    SCP.call('setVolume', S.muted ? 0 : v);
    const shown = S.muted ? 0 : v;
    const range = $('vol');
    range.value = String(shown);
    range.style.setProperty('--p', shown + '%');
    range.setAttribute('aria-valuetext', S.muted ? 'Muted' : `${v}%`);
    const b = $('b-mute');
    b.classList.toggle('muted', S.muted || v === 0);
    b.classList.toggle('low', !S.muted && v > 0 && v < 50);
    b.setAttribute('aria-label', S.muted || v === 0 ? 'Unmute' : 'Mute');
    b.title = b.getAttribute('aria-label');
  }

  // ---------- UI ----------
  function setPlaying(on) {
    S.playing = on;
    document.body.classList.toggle('is-playing', on);
    const b = $('b-play');
    b.setAttribute('aria-label', on ? 'Pause' : 'Play');
    b.title = (on ? 'Pause' : 'Play') + ' (Space)';
    kicker();
    if ('mediaSession' in navigator) {
      try { navigator.mediaSession.playbackState = on ? 'playing' : (S.cur >= 0 ? 'paused' : 'none'); } catch (e) { /* old browser */ }
    }
    positionState();
  }
  function setBuffering(on) {
    S.buffering = on;
    document.body.classList.toggle('is-buffering', on);
    kicker();
  }
  function kicker() {
    $('np-kicker').textContent = !S.started ? 'Up first' : S.playing ? 'Now playing' : S.wantPlay ? 'Loading…' : 'Paused';
  }

  let hintTimer = 0;
  function armHint() {
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => {
      if (!S.wantPlay || S.playing) return;
      if (S.engine === 'yt' && YTP.ready && YTP.state !== 3 && YTP.state !== 1) hint(true, 'Tap the video to start playing.');
      else if (S.engine === 'sc' && SCP.booted && !SCP.playing) hint(true, 'Tap the player to start playing.');
    }, 3500);
  }
  function hint(on, text) {
    if (!on) clearTimeout(hintTimer);
    const el = $('np-hint');
    if (text) el.textContent = text;
    el.hidden = !on;
    if (on) setBuffering(false);
  }

  // what covers the player area: nothing once the current player is ready
  function syncStage() {
    const ph = $('np-ph');
    const txt = $('np-ph-text');
    const retry = $('np-retry');
    const t = S.tracks[S.cur];
    const eng = S.engine === 'yt' ? YTP : S.engine === 'sc' ? SCP : null;
    const ready = S.engine === 'yt' ? YTP.ready : SCP.booted;
    const art = t && S.kinds[S.cur] === 'yt' ? ytThumb(t, 'hqdefault') : '';
    $('np-ph-art').style.backgroundImage = art ? `url("${art}")` : 'none';
    retry.hidden = true;
    ph.classList.remove('loading');
    if (!eng) {
      ph.hidden = false;
      txt.textContent = S.tracks.length ? 'None of these songs can play here. Tap one to open it on its own site.' : '';
      return;
    }
    if (eng.failed) {
      ph.hidden = false;
      txt.textContent = S.engine === 'yt' ? 'Couldn’t reach YouTube. Check your connection, then try again.' : 'Couldn’t reach SoundCloud.';
      retry.hidden = S.engine !== 'yt';
      return;
    }
    if (!ready) {
      ph.hidden = false;
      ph.classList.add('loading');
      txt.textContent = 'Loading the player…';
      return;
    }
    ph.hidden = true;
  }

  function updateControls() {
    const any = firstPlayable() >= 0;
    ['b-prev', 'b-play', 'b-next', 'b-shuffle', 'b-repeat', 'btn-play-all', 'btn-shuffle-all'].forEach((id) => { $(id).disabled = !any; });
    $('seek').disabled = !any || S.cur < 0;
  }

  let bdFlip = false, bdUrl = null;
  function setBackdrop(url) {
    if (url === bdUrl) return;
    bdUrl = url;
    const a = $('bd-a'), b = $('bd-b');
    if (!url) { a.classList.remove('on'); b.classList.remove('on'); return; }
    const pre = new Image();
    pre.onload = () => {
      if (bdUrl !== url) return;
      const [on, off] = bdFlip ? [a, b] : [b, a];
      bdFlip = !bdFlip;
      on.style.backgroundImage = `url("${url}")`;
      on.classList.add('on');
      off.classList.remove('on');
    };
    pre.src = url;
  }

  function artInto(box, t, k) {
    box.textContent = '';
    box.className = 'bar-art' + (k === 'sc' ? ' sc' : '');
    if (k === 'yt') box.append(img(ytThumb(t, 'mqdefault')));
    else box.append(icon(k === 'sc' ? 'cloud' : 'note'));
  }

  function showTrack(i) {
    const t = S.tracks[i];
    const k = S.kinds[i];
    rows.forEach((r, j) => {
      const on = S.started && j === i;
      r.classList.toggle('cur', on);
      if (on) r.setAttribute('aria-current', 'true'); else r.removeAttribute('aria-current');
    });
    $('bar-title').textContent = t.title;
    $('bar-artist').textContent = t.artist || (k === 'sc' ? 'SoundCloud' : '');
    artInto($('bar-art'), t, k);
    $('np-title').textContent = t.title;
    $('np-artist').textContent = t.artist || '';
    kicker();
    const src = $('np-src');
    const href = watchUrl(t);
    src.hidden = !href;
    if (href) {
      src.href = href;
      $('np-src-text').textContent = k === 'sc' ? 'Open on SoundCloud' : 'Open on YouTube';
    }
    setBackdrop(k === 'yt' ? ytThumb(t, 'mqdefault') : (S.tracks.map((x) => ytThumb(x, 'mqdefault')).find(Boolean) || ''));
    renderUpNext();
    updateControls();
    mediaMeta(t, k);
  }

  let lastTime = '', lastDur = '';
  function renderTime() {
    const d = S.dur || 0;
    const t = Math.min(S.time || 0, d || Infinity);
    const seek = $('seek');
    if (!S.seeking) {
      const v = d ? Math.round((t / d) * 1000) : 0;
      seek.value = String(v);
      seek.style.setProperty('--p', v / 10 + '%');
    }
    const ct = fmt(S.seeking ? (Number(seek.value) / 1000) * d : t), cd = fmt(d);
    if (ct !== lastTime) { $('t-cur').textContent = ct; lastTime = ct; }
    if (cd !== lastDur) { $('t-dur').textContent = cd; lastDur = cd; }
    seek.setAttribute('aria-valuetext', `${ct} of ${cd}`);
  }

  let lastPos = 0;
  function tick() {
    if (S.engine === 'yt' && YTP.ready && !S.seeking && String(YTP.call('getVideoUrl') || '').includes(YTP.vid)) {
      const t = Number(YTP.call('getCurrentTime'));
      const d = Number(YTP.call('getDuration'));
      if (Number.isFinite(t) && fresh(t)) S.time = t;
      if (Number.isFinite(d) && d > 0) S.dur = d;
    }
    renderTime();
    const now = Date.now();
    if (S.playing && now - lastPos > 4000) { lastPos = now; positionState(); }
  }

  function renderUpNext() {
    const ol = $('np-next');
    ol.textContent = '';
    const items = [];
    let p = S.pos;
    while (items.length < 3) {
      p = stepFrom(p, 1, S.repeat === 'all');
      if (p < 0 || S.order[p] === S.cur || items.includes(S.order[p])) break;
      items.push(S.order[p]);
    }
    items.forEach((i) => {
      const t = S.tracks[i];
      const k = S.kinds[i];
      const li = h('li');
      const b = h('button', 'song');
      b.type = 'button';
      b.dataset.i = String(i);
      const txt = h('span', 'txt');
      const a = h('span', 'a');
      a.append(h('span', 'an', t.artist || (k === 'sc' ? 'SoundCloud' : '')));
      txt.append(h('span', 't', t.title), a);
      b.append(thumb(t, k), txt, h('span', 'dur', t.duration ? fmt(t.duration) : ''));
      li.append(b);
      ol.append(li);
    });
    $('np-next-wrap').hidden = !items.length || !S.started;
  }

  function renderCover() {
    const c = $('cover');
    c.textContent = '';
    c.className = 'cover';
    const ids = [];
    for (const t of S.tracks) {
      if (kindOf(t) === 'yt' && !ids.includes(t.id)) ids.push(t.id);
      if (ids.length === 4) break;
    }
    const tile = (id) => {
      const s = h('span', 'tile');
      s.append(img(`https://i.ytimg.com/vi/${id}/hqdefault.jpg`));
      return s;
    };
    if (ids.length >= 4) { c.classList.add('grid4'); ids.forEach((id) => c.append(tile(id))); }
    else if (ids.length) c.append(tile(ids[0]));
    else { c.classList.add('cover-blank'); c.append(icon('note')); }
  }

  function renderList() {
    const ol = $('songs');
    ol.textContent = '';
    rows = S.tracks.map((t, i) => {
      const k = S.kinds[i];
      const li = h('li');
      const link = k === 'web' || (k === 'sc' && SCP.failed);
      let el;
      if (link) {
        el = h('a', 'song ext');
        el.href = safeHttps(t.url) || '#';
        el.target = '_blank';
        el.rel = 'noopener noreferrer';
      } else {
        el = h('button', 'song');
        el.type = 'button';
        el.dataset.i = String(i);
      }
      const idx = h('span', 'idx');
      const hov = h('span', 'hov');
      hov.append(icon(link ? 'out' : 'play'));
      idx.append(h('span', 'n', String(i + 1)), hov, eq());
      const th = thumb(t, k);
      th.append(eq());
      const txt = h('span', 'txt');
      const a = h('span', 'a');
      if (k === 'sc') a.append(h('span', 'badge sc', 'SoundCloud'));
      a.append(h('span', 'an', t.artist || (k === 'sc' ? '' : 'Unknown artist')));
      txt.append(h('span', 't', t.title), a);
      const dur = h('span', 'dur');
      if (link) {
        dur.textContent = k === 'sc' ? 'Opens on SoundCloud' : 'Opens in a new tab';
        dur.append(icon('out'));
      } else dur.textContent = t.duration ? fmt(t.duration) : '';
      el.append(idx, th, txt, dur);
      if (S.bad.has(i)) setBadRow(el, S.bad.get(i));
      if (S.started && i === S.cur) { el.classList.add('cur'); el.setAttribute('aria-current', 'true'); }
      li.append(el);
      ol.append(li);
      return el;
    });
  }

  const embedOff = (code) => code === 101 || code === 150;
  function setBadRow(el, code) {
    el.classList.add('bad');
    el.classList.toggle('yt-only', embedOff(code));
    el.classList.remove('cur');
    el.removeAttribute('aria-current');
    const d = el.querySelector('.dur');
    if (embedOff(code)) {
      el.title = 'The owner only allows this video on YouTube.';
      if (d) { d.textContent = 'Play on YouTube'; d.append(icon('out')); }
    } else {
      el.setAttribute('aria-disabled', 'true');
      el.title = 'This song isn’t available anymore.';
      if (d) d.textContent = 'Unavailable';
    }
  }
  function markBad(i, code) {
    S.bad.set(i, code);
    if (rows[i]) setBadRow(rows[i], code);
    renderUpNext();
  }

  // ---------- Media Session (lock screen, headset buttons) ----------
  function mediaMeta(t, k) {
    if (!('mediaSession' in navigator) || typeof window.MediaMetadata !== 'function') return;
    const artwork = k === 'yt'
      ? [{ src: ytThumb(t, 'mqdefault'), sizes: '320x180', type: 'image/jpeg' }, { src: ytThumb(t, 'hqdefault'), sizes: '480x360', type: 'image/jpeg' }]
      : [{ src: new URL('../icon.png', location.href).href, sizes: '1024x1024', type: 'image/png' }];
    try { navigator.mediaSession.metadata = new window.MediaMetadata({ title: t.title, artist: t.artist || '', album: S.name, artwork }); } catch (e) { /* unsupported */ }
  }
  function positionState() {
    if (!('mediaSession' in navigator) || typeof navigator.mediaSession.setPositionState !== 'function') return;
    try {
      if (S.dur > 0) navigator.mediaSession.setPositionState({ duration: S.dur, position: Math.min(Math.max(0, S.time || 0), S.dur), playbackRate: 1 });
    } catch (e) { /* bad values */ }
  }
  function setupMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const set = (action, fn) => { try { navigator.mediaSession.setActionHandler(action, fn); } catch (e) { /* unsupported action */ } };
    set('play', () => play());
    set('pause', () => pause());
    set('stop', () => pause());
    set('previoustrack', () => prev());
    set('nexttrack', () => next());
    set('seekbackward', (d) => seekBy(-((d && d.seekOffset) || 10)));
    set('seekforward', (d) => seekBy((d && d.seekOffset) || 10));
    set('seekto', (d) => { if (d && Number.isFinite(d.seekTime)) seekTo(d.seekTime); });
  }

  // ---------- Add to Muriel ----------
  let addTimer = 0, addReset = 0;
  function note(parts, ok) {
    const n = $('add-note');
    n.textContent = '';
    if (ok) n.append(icon('check'));
    const span = h('span');
    parts.forEach((p) => span.append(p));
    n.append(span);
    n.hidden = false;
  }
  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
    } catch (e) { /* fall back below */ }
    try {
      const ta = h('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
      document.body.append(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e) { return false; }
  }
  function setupAdd() {
    const a = $('btn-add');
    const share = window.MurielShare;
    a.href = IS_PHONE ? share.appLink(S.payload) : share.webLink(S.payload);
    a.classList.remove('done');
    a.querySelector('use').setAttribute('href', '#i-plus');
    a.querySelector('span').textContent = 'Add to Muriel';
    $('add-note').hidden = true;
  }
  async function onAdd(e) {
    const share = window.MurielShare;
    if (!share || !S.payload) return;
    if (IS_PHONE) {
      // the muriel:// link opens the app, which imports the playlist; if nothing opens, point to the download
      clearTimeout(addTimer);
      addTimer = setTimeout(() => {
        if (document.visibilityState !== 'visible') return;
        const get = h('a', '', 'Get Muriel');
        get.href = '../#download';
        note(['Nothing opened? ', get, ' first, then tap Add to Muriel again.']);
      }, 2500);
      return;
    }
    e.preventDefault();
    const link = share.webLink(S.payload);
    const a = $('btn-add');
    if (await copyText(link)) {
      note(['Link copied. Paste it into Muriel’s search bar to add the playlist.'], true);
      a.classList.add('done');
      a.querySelector('use').setAttribute('href', '#i-check');
      a.querySelector('span').textContent = 'Copied';
      clearTimeout(addReset);
      addReset = setTimeout(() => {
        a.classList.remove('done');
        a.querySelector('use').setAttribute('href', '#i-plus');
        a.querySelector('span').textContent = 'Add to Muriel';
      }, 2600);
    } else {
      const box = h('input');
      box.type = 'text';
      box.readOnly = true;
      box.value = link;
      box.setAttribute('aria-label', 'Playlist link');
      note(['Copy this link, then paste it into Muriel’s search bar: ', box]);
      box.focus();
      box.select();
    }
  }
  const cancelAddTimer = () => clearTimeout(addTimer);

  // ---------- views ----------
  function stopEverything() {
    YTP.call('pauseVideo');
    SCP.call('pause');
    S.wantPlay = false;
    setPlaying(false);
    setBuffering(false);
    hint(false);
  }

  function showLanding(err) {
    stopEverything();
    S.payload = '';
    S.gen++;
    document.title = 'Muriel Web Player';
    document.body.classList.add('on-landing');
    $('view').hidden = true;
    $('bar').hidden = true;
    $('landing').hidden = false;
    $('paste-hint').textContent = '';
    const box = $('land-error');
    if (err) {
      $('land-error-title').textContent = err.title;
      $('land-error-text').textContent = err.text;
      box.hidden = false;
    } else box.hidden = true;
    setBackdrop('');
    if (!IS_PHONE) { try { $('paste-input').focus({ preventScroll: true }); } catch (e) { /* old browser */ } }
  }

  function openPlaylist(payload, pl) {
    stopEverything();
    S.payload = payload;
    S.name = pl.name;
    S.tracks = pl.tracks;
    S.kinds = pl.tracks.map(kindOf);
    S.bad = new Map();
    S.cur = -1;
    S.pos = -1;
    S.started = false;
    S.engine = '';
    S.time = 0;
    S.dur = 0;
    S.shuffle = false;
    $('b-shuffle').classList.remove('on');
    $('b-shuffle').setAttribute('aria-pressed', 'false');
    rebuildOrder();

    document.title = `${pl.name} · Muriel`;
    document.body.classList.remove('on-landing');
    $('landing').hidden = true;
    $('view').hidden = false;
    $('bar').hidden = false;

    $('pl-name').textContent = pl.name;
    const n = pl.tracks.length;
    const total = totalText(pl.tracks.reduce((s, t) => s + (Number(t.duration) || 0), 0));
    $('pl-meta').textContent = `${n} ${n === 1 ? 'song' : 'songs'}` + (total ? ` · ${total}` : '');
    renderCover();
    renderList();
    setupAdd();
    window.scrollTo(0, 0);

    const f = firstPlayable();
    if (f >= 0) load(S.order[f], false);
    else {
      const t = pl.tracks[0];
      $('bar-title').textContent = t.title;
      $('bar-artist').textContent = t.artist || '';
      artInto($('bar-art'), t, S.kinds[0]);
      $('np-title').textContent = t.title;
      $('np-artist').textContent = t.artist || '';
      $('np-src').hidden = true;
      syncStage();
      setBackdrop('');
    }
    updateControls();
    renderTime();
  }

  async function route() {
    const share = window.MurielShare;
    const raw = location.hash.replace(/^#/, '');
    if (!share) {
      showLanding({ title: 'The player didn’t load', text: 'Refresh the page to try again.' });
      return;
    }
    if (!raw) { showLanding(null); return; }
    const p = share.payloadFrom(location.hash) || share.payloadFrom(decodeHashSafe(raw));
    if (!p) {
      showLanding({ title: 'That link didn’t work', text: 'It doesn’t look like a Muriel playlist link. Check that you copied all of it.' });
      return;
    }
    if (p === S.payload) return;
    const gen = ++S.gen;
    let pl;
    try {
      pl = await share.decode(p);
    } catch (e) {
      if (gen !== S.gen) return;
      const old = /too old/i.test(String(e && e.message));
      showLanding({
        title: old ? 'This browser can’t open the link' : 'We couldn’t open this playlist',
        text: old ? 'Try a recent version of Safari, Chrome, Firefox or Edge.' : 'The link looks incomplete. Copy it again from Muriel and paste it below.',
      });
      return;
    }
    if (gen !== S.gen) return;
    if (!pl || !Array.isArray(pl.tracks) || !pl.tracks.length) {
      showLanding({ title: 'This playlist is empty', text: 'There are no songs in it that can play on the web.' });
      return;
    }
    openPlaylist(p, pl);
    if (pl.tracks.some((t) => t.needsInfo)) fillTitles(pl.tracks, gen);
  }

  // short links carry only video ids: titles and artists fill in as YouTube answers
  function fillTitles(tracks, gen) {
    window.MurielShare.fillInfo(tracks, {
      onUpdate: (t) => {
        if (gen !== S.gen) return;
        const i = S.tracks.indexOf(t);
        const row = rows[i];
        if (row) {
          row.querySelector('.t').textContent = t.title;
          row.querySelector('.an').textContent = t.artist || 'Unknown artist';
        }
        if (i === S.cur) showTrack(i); else renderUpNext();
      },
    });
  }
  function decodeHashSafe(s) { try { return decodeURIComponent(s); } catch (e) { return s; } }

  // ---------- wiring ----------
  function isTyping(el) {
    if (!el || el === document.body) return false;
    if (el.isContentEditable) return true;
    const tag = el.tagName;
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (tag === 'INPUT') return !/^(range|checkbox|radio|button|submit)$/i.test(el.type);
    return false;
  }

  function setRepeat(mode) {
    S.repeat = REPEAT_TITLES[mode] ? mode : 'off';
    store.set('muriel_web_repeat', S.repeat);
    const b = $('b-repeat');
    b.classList.toggle('on', S.repeat !== 'off');
    b.classList.toggle('one', S.repeat === 'one');
    b.setAttribute('aria-label', REPEAT_TITLES[S.repeat]);
    b.title = REPEAT_TITLES[S.repeat];
    renderUpNext();
  }
  function setShuffle(on, first) {
    S.shuffle = !!on;
    const b = $('b-shuffle');
    b.classList.toggle('on', S.shuffle);
    b.setAttribute('aria-pressed', String(S.shuffle));
    b.title = S.shuffle ? 'Shuffle: on' : 'Shuffle';
    rebuildOrder(first);
    renderUpNext();
  }

  // on phones and tablets the player sits in the page: bring it fully into view when playback starts
  function revealPlayer() {
    if (!window.matchMedia('(max-width: 1023px)').matches) return;
    const r = $('np-stage').getBoundingClientRect();
    const bar = $('bar').getBoundingClientRect();
    const bottom = (bar.height ? bar.top : window.innerHeight) - 12;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let dy = 0;
    if (r.top < 12) dy = r.top - 12;
    else if (r.bottom > bottom) dy = Math.min(r.bottom - bottom, r.top - 12);
    if (dy) window.scrollBy({ top: dy, behavior: reduce ? 'auto' : 'smooth' });
  }

  function rowClick(e) {
    const b = e.target.closest('button.song');
    if (!b || !e.currentTarget.contains(b)) return;
    const i = Number(b.dataset.i);
    if (!Number.isInteger(i)) return;
    if (S.bad.has(i)) {
      const t = S.tracks[i];
      if (embedOff(S.bad.get(i)) && S.kinds[i] === 'yt') window.open(watchUrl(t), '_blank', 'noopener');
      else toast('This song isn’t available anymore.');
      return;
    }
    playFrom(i);
  }

  function init() {
    if (IS_IOS) document.body.classList.add('no-vol');

    $('songs').addEventListener('click', rowClick);
    $('np-next').addEventListener('click', rowClick);

    $('btn-play-all').addEventListener('click', () => {
      setShuffle(false);
      const f = firstPlayable();
      if (f >= 0) { playFrom(S.order[f]); revealPlayer(); }
    });
    $('btn-shuffle-all').addEventListener('click', () => {
      const ok = S.tracks.map((_, i) => i).filter(playable);
      if (!ok.length) return;
      const pick = ok[Math.floor(Math.random() * ok.length)];
      setShuffle(true, pick);
      playFrom(pick);
      revealPlayer();
    });
    $('btn-add').addEventListener('click', onAdd);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') cancelAddTimer(); });
    window.addEventListener('pagehide', cancelAddTimer);

    $('b-play').addEventListener('click', togglePlay);
    $('b-next').addEventListener('click', next);
    $('b-prev').addEventListener('click', prev);
    $('b-shuffle').addEventListener('click', () => setShuffle(!S.shuffle));
    $('b-repeat').addEventListener('click', () => setRepeat(({ off: 'all', all: 'one', one: 'off' })[S.repeat]));
    $('np-retry').addEventListener('click', () => {
      const t = S.tracks[S.cur];
      if (!t || S.kinds[S.cur] !== 'yt') return;
      ensureYt(t.id).then(() => {
        if (S.cur >= 0 && S.tracks[S.cur] === t && YTP.vid !== t.id) { YTP.vid = t.id; YTP.call('cueVideoById', t.id); }
      }).catch(() => toast('Still can’t reach YouTube.'));
    });

    const seek = $('seek');
    seek.addEventListener('input', () => {
      S.seeking = true;
      seek.style.setProperty('--p', Number(seek.value) / 10 + '%');
      renderTime();
    });
    seek.addEventListener('change', () => {
      const t = (Number(seek.value) / 1000) * (S.dur || 0);
      S.seeking = false;
      seekTo(t);
    });
    seek.addEventListener('blur', () => { if (S.seeking) { S.seeking = false; renderTime(); } });

    const vol = $('vol');
    vol.addEventListener('input', () => {
      S.vol = Number(vol.value);
      S.muted = false;
      store.set('muriel_web_volume', String(S.vol));
      store.set('muriel_web_muted', '0');
      applyVolume();
    });
    $('b-mute').addEventListener('click', () => {
      if (S.muted || S.vol === 0) {
        S.muted = false;
        if (S.vol === 0) S.vol = 60;
      } else S.muted = true;
      store.set('muriel_web_volume', String(S.vol));
      store.set('muriel_web_muted', S.muted ? '1' : '0');
      applyVolume();
    });

    $('paste-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const share = window.MurielShare;
      const v = $('paste-input').value;
      const p = share ? share.payloadFrom(v) : '';
      if (!p) {
        $('paste-hint').textContent = v.trim() ? 'That doesn’t look like a Muriel playlist link.' : 'Paste a link that someone shared from Muriel.';
        return;
      }
      $('paste-hint').textContent = '';
      $('paste-input').value = '';
      if (location.hash === '#p=' + p) { S.payload = ''; route(); } else location.hash = 'p=' + p;
    });
    $('paste-input').addEventListener('input', () => { $('paste-hint').textContent = ''; });

    document.addEventListener('keydown', (e) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || $('view').hidden) return;
      if (isTyping(e.target)) return;
      if (e.key === ' ' || e.code === 'Space') {
        e.preventDefault();
        if (!e.repeat) togglePlay();
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        if (e.target && e.target.type === 'range') return; // the slider moves itself
        e.preventDefault();
        seekBy(e.key === 'ArrowRight' ? 5 : -5);
      }
    });
    // keep Space from also "clicking" whichever button has focus
    document.addEventListener('keyup', (e) => {
      if ((e.key === ' ' || e.code === 'Space') && !isTyping(e.target) && !$('view').hidden) e.preventDefault();
    });

    window.addEventListener('hashchange', route);
    setInterval(tick, 250);
    setupMediaSession();
    setRepeat(S.repeat);
    applyVolume();
    route().finally(() => document.body.classList.remove('is-booting'));
  }

  init();
})();
