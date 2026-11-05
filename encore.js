// Muriel Encore: counts what you actually listen to (a play counts after 30s, or half of a short song) and
// plays it back: the "On repeat" top 3 on the home page and a story-style recap you can open any time.
// Everything stays on the device (localStorage). Listening older than ~13 months is folded into one
// all-time total per song (compact below), so the data stays small however long Muriel is used.
(() => {
  const KEY = 'muriel_listens_v1';
  const COUNT_AFTER = 30;
  const PERIODS = { week: 'This week', month: 'This month', year: 'This year', all: 'All time' };

  // ---------- storage ----------
  // { v, tracks: { key: {t,a,th,id,p,u,d} }, days: { 'YYYY-MM-DD': { k: { key: [plays, seconds] }, h: [24] } },
  //   old: { k: { key: [plays, seconds] }, h: [24], days, secs } }  (days folded away by compact)
  let db;
  try { db = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { db = null; }
  if (!db || db.v !== 1 || typeof db.days !== 'object') db = { v: 1, tracks: {}, days: {} };
  let saveTimer = null;
  const save = () => { clearTimeout(saveTimer); saveTimer = null; try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) {} };
  const saveSoon = () => { if (!saveTimer) saveTimer = setTimeout(save, 5000); };

  const pad = (n) => String(n).padStart(2, '0');

  // Days were kept forever (up to ~1 MB a year for a heavy listener) in the ~5 MB of browser storage that
  // favorites, playlists and the queue share; once full, saving anything failed. Days older than keepDays
  // fold into db.old (only "All time" reads it), songs nothing refers to are dropped, and songs in the
  // folded bucket that were never fully played keep only their minutes.
  const KEEP_DAYS = 400;
  function compact(keepDays = KEEP_DAYS) {
    const d0 = new Date(Date.now() - keepDays * 864e5);
    const cutoff = `${d0.getFullYear()}-${pad(d0.getMonth() + 1)}-${pad(d0.getDate())}`;
    let changed = false;
    for (const [d, b] of Object.entries(db.days)) {
      if (d >= cutoff) continue;
      const old = db.old || (db.old = { k: {}, h: new Array(24).fill(0), days: 0, secs: 0 });
      let any = false;
      for (const [k, [n, sec]] of Object.entries(b.k || {})) {
        if (n || sec > 20) any = true;
        if (!n) { old.secs += sec; continue; }
        const e = old.k[k] || (old.k[k] = [0, 0]);
        e[0] += n; e[1] += sec;
      }
      (b.h || []).forEach((n, i) => { old.h[i] += n; });
      if (any) old.days += 1;
      delete db.days[d];
      changed = true;
    }
    const used = new Set(Object.keys((db.old && db.old.k) || {}));
    for (const b of Object.values(db.days)) for (const k of Object.keys(b.k || {})) used.add(k);
    for (const k of Object.keys(db.tracks)) if (!used.has(k)) { delete db.tracks[k]; changed = true; }
    if (changed) save();
    return changed;
  }
  const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const keyOf = (t) => {
    if (!t) return '';
    const p = t.platform || 'youtube';
    if (t.id) return `${p}:${t.id}`;
    if (t.url) return `${p}:${t.url}`;
    return `${p}:${(t.title || '').trim().toLowerCase()}|${(t.artist || '').trim().toLowerCase()}`;
  };
  const remember = (t) => {
    const k = keyOf(t);
    if (k) db.tracks[k] = { t: t.title || '', a: t.artist || '', th: t.thumbnail || '', id: t.id || '', p: t.platform || 'youtube', u: t.url || '', d: Math.round(Number(t.duration) || 0) };
    return k;
  };
  const bucket = (date) => {
    const k = dayKey(date);
    return db.days[k] || (db.days[k] = { k: {}, h: new Array(24).fill(0) });
  };
  const add = (key, plays, secs, date = new Date()) => {
    if (!key) return;
    const b = bucket(date);
    const e = b.k[key] || (b.k[key] = [0, 0]);
    e[0] += plays; e[1] = Math.round(e[1] + secs);
    if (plays) b.h[date.getHours()] += plays;
    saveSoon();
  };

  // first run: what's already in History counts as one play each, so the home card isn't empty
  function importHistory() {
    if (db.imported) return;
    const C = window.MurielCore;
    const hist = (C && C.state && C.state.history) || [];
    hist.forEach((t) => { if (t && t.playedAt) add(remember(t), 1, 0, new Date(t.playedAt)); });
    db.imported = true;
    save();
  }

  // ---------- tracking ----------
  let cur = null; // { key, track, secs, pending, counted, last, ended }
  function commit() {
    if (cur && cur.pending > 0) { add(cur.key, 0, cur.pending); cur.pending = 0; }
  }
  function start(track) {
    commit();
    const audio = window.MurielCore && window.MurielCore.audio;
    cur = track ? { key: remember(track), track, secs: 0, pending: 0, counted: false, last: audio ? audio.currentTime || 0 : 0, ended: false } : null;
  }
  function needed() {
    const d = Number(cur.track.duration) || 0;
    return d > 0 ? Math.min(COUNT_AFTER, d * 0.5) : COUNT_AFTER;
  }
  function hook() {
    const C = window.MurielCore;
    const audio = C && C.audio;
    if (!audio) return;
    importHistory();
    if (C.state.currentTrack) start(C.state.currentTrack);
    window.addEventListener('muriel:track', (e) => { if (!cur || cur.ended || keyOf(e.detail) !== cur.key) start(e.detail); });
    audio.addEventListener('timeupdate', () => {
      if (!cur) return;
      const t = audio.currentTime || 0, d = t - cur.last;
      cur.last = t;
      if (audio.paused || !(d > 0 && d < 3)) return; // seeks and pauses don't count as listening
      cur.secs += d; cur.pending += d;
      if (!cur.counted && cur.secs >= needed()) { cur.counted = true; add(cur.key, 1, 0); renderHome(); }
      if (cur.pending >= 15) commit();
    });
    audio.addEventListener('seeked', () => { if (cur) cur.last = audio.currentTime || 0; });
    audio.addEventListener('ended', () => { if (cur) { commit(); cur.ended = true; } });
    audio.addEventListener('play', () => { if (cur && cur.ended) start(cur.track); });
    const flush = () => { commit(); save(); };
    document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });
    window.addEventListener('pagehide', flush);
    renderHome();
  }

  // ---------- stats ----------
  const cleanTitle = (t, a) => {
    const M = window.MurielLyricsMatch;
    if (!M) return { title: t, artist: a };
    const p = M.parseForLyrics(t, a);
    return { title: p.titles[0] || t, artist: p.artists[0] || a };
  };
  function rangeStart(period) {
    const now = new Date();
    if (period === 'week') return new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6);
    if (period === 'month') return new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29);
    if (period === 'year') return new Date(now.getFullYear(), 0, 1);
    return new Date(0);
  }
  // this device's listening plus what linked devices sent (sync.js); each device only ever counts its own plays
  const sources = () => [db, ...((window.MurielSync && window.MurielSync.listenDbs && window.MurielSync.listenDbs()) || [])];
  function stats(period) {
    commit();
    const from = dayKey(rangeStart(period));
    const per = {}, hours = new Array(24).fill(0), activeDays = new Set();
    let plays = 0, secs = 0, foldedDays = 0;
    const srcs = sources();
    for (const src of srcs) {
      for (const [d, b] of Object.entries(src.days || {})) {
        if (d < from) continue;
        let any = false;
        for (const [k, [n, s]] of Object.entries(b.k || {})) {
          const e = per[k] || (per[k] = { key: k, plays: 0, secs: 0 });
          e.plays += n; e.secs += s; plays += n; secs += s;
          if (n || s > 20) any = true;
        }
        (b.h || []).forEach((n, i) => { hours[i] += n; });
        if (any) activeDays.add(d);
      }
      if (period === 'all' && src.old) {
        for (const [k, [n, sec]] of Object.entries(src.old.k || {})) {
          const e = per[k] || (per[k] = { key: k, plays: 0, secs: 0 });
          e.plays += n; e.secs += sec; plays += n; secs += sec;
        }
        secs += src.old.secs || 0;
        (src.old.h || []).forEach((n, i) => { hours[i] += n; });
        foldedDays = Math.max(foldedDays, src.old.days || 0);
      }
    }
    const trackOf = (k) => { for (const src of srcs) if (src.tracks && src.tracks[k]) return src.tracks[k]; return null; };
    const songs = Object.values(per).filter((e) => e.plays > 0 && trackOf(e.key))
      .sort((x, y) => y.plays - x.plays || y.secs - x.secs)
      .map((e) => { const t = trackOf(e.key); return { ...e, ...cleanTitle(t.t, t.a), raw: t }; });
    const artists = {};
    songs.forEach((s) => {
      const name = String(s.artist || '').split(/\s*(?:,|&|\bx\b|\bfeat\.?|\bft\.?)\s*/i)[0].trim();
      if (!name) return;
      const k = name.toLowerCase();
      const a = artists[k] || (artists[k] = { name, plays: 0, secs: 0, thumb: s.raw.th });
      a.plays += s.plays; a.secs += s.secs;
    });
    const days = [...activeDays].sort();
    let streak = 0, run = 0, prev = null;
    days.forEach((d) => { const t = Date.parse(d); run = prev !== null && t - prev <= 26 * 3600e3 ? run + 1 : 1; streak = Math.max(streak, run); prev = t; });
    return { period, plays, minutes: Math.round(secs / 60), songs, artists: Object.values(artists).sort((x, y) => y.plays - x.plays), hours, days: days.length + foldedDays, streak };
  }
  const toTrack = (s) => ({ id: s.raw.id, title: s.raw.t, artist: s.raw.a, thumbnail: s.raw.th, platform: s.raw.p, url: s.raw.u, duration: s.raw.d });
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // UI language (i18n.js): Th() gives escaped HTML with the {n} slots filled; titles and names only go into slots
  const I18n = window.MurielI18n || (() => { const f = (s, ...a) => String(s).replace(/\{(\d)\}/g, (_, i) => (a[i] != null ? a[i] : '')); return { T: (s) => s, Tf: f, Tm: f, Th: (s, ...a) => f(esc(s), ...a) }; })();
  const Th = (s, ...a) => I18n.Th(s, ...a);
  // the word that goes with a number ('plays', 'days'), translated together with the number so it reads as a count
  const unit = (n, one, many) => esc(I18n.Tf(n === 1 ? `{0} ${one}` : `{0} ${many}`, '\u2063').replace('\u2063', '').trim());
  const thumb = (s) => esc((window.MurielCore && window.MurielCore.thumb ? window.MurielCore.thumb(toTrack(s)) : '') || s.raw.th || '');

  // ---------- home: "On repeat" ----------
  let homePeriod = (() => { try { return localStorage.getItem('muriel_onrepeat_period') || 'month'; } catch (e) { return 'month'; } })();
  let renderTimer = null;
  function renderHome() {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(() => {
      const box = document.getElementById('section-on-repeat');
      if (!box) return;
      const st = stats(homePeriod);
      const top = st.songs.slice(0, 3);
      const chips = ['week', 'month', 'all'].map((p) => `<button type="button" class="onrepeat-chip${p === homePeriod ? ' active' : ''}" data-p="${p}">${Th(p === 'all' ? 'All time' : p === 'week' ? 'Week' : 'Month')}</button>`).join('');
      box.innerHTML = `
        <div class="onrepeat-head">
          <h3 class="section-title">${Th('On repeat')}</h3>
          <div class="onrepeat-chips">${chips}</div>
          <button type="button" class="onrepeat-encore"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 20V11M12 20V4M18 20v-6"/></svg>Encore</button>
        </div>
        ${top.length ? `<div class="onrepeat-list">${top.map((s, i) => `
          <button type="button" class="onrepeat-row" data-i="${i}">
            <span class="onrepeat-rank">${i + 1}</span>
            <img src="${thumb(s)}" alt="" loading="lazy" decoding="async">
            <span class="onrepeat-meta"><b>${esc(s.title)}</b><span>${esc(s.artist)}</span></span>
            <span class="onrepeat-count">${s.plays}<small>${unit(s.plays, 'play', 'plays')}</small></span>
          </button>`).join('')}</div>` : `<div class="onrepeat-empty">${Th("Your most played songs show up here once you've listened for a bit.")}</div>`}`;
      box.querySelectorAll('.onrepeat-chip').forEach((b) => b.addEventListener('click', () => {
        homePeriod = b.dataset.p;
        try { localStorage.setItem('muriel_onrepeat_period', homePeriod); } catch (e) {}
        renderHome();
      }));
      box.querySelector('.onrepeat-encore').addEventListener('click', () => open(homePeriod === 'all' ? 'all' : homePeriod));
      box.querySelectorAll('.onrepeat-row').forEach((r) => r.addEventListener('click', () => {
        const list = top.map(toTrack);
        window.MurielCore.playTrack(list[+r.dataset.i], list, +r.dataset.i);
      }));
    }, 60);
  }

  // ---------- Encore: the story ----------
  let overlay = null, slide = 0, slides = [], timer = null, raf = 0, current = null;
  const SLIDE_MS = 6500;

  function persona(hours) {
    const sum = (a, b) => hours.slice(a, b).reduce((x, y) => x + y, 0);
    const parts = [
      ['Night owl', 'Most of your listening happens after 10pm.', sum(22, 24) + sum(0, 5)],
      ['Early bird', 'You start the day with music.', sum(5, 10)],
      ['Daytime regular', 'Music keeps your days moving.', sum(10, 18)],
      ['Evening wind-down', 'Your evenings have a soundtrack.', sum(18, 22)],
    ].sort((a, b) => b[2] - a[2]);
    return parts[0];
  }

  function build(st) {
    const label = I18n.T(PERIODS[st.period]);
    if (!st.songs.length) {
      return [`<div class="enc-slide enc-center"><h1 class="enc-big">${Th('Not much yet')}</h1><p class="enc-sub">${Th('Play some songs and come back: Encore fills up as you listen.')}</p>${pickers(st.period)}</div>`];
    }
    const s1 = st.songs[0];
    const a1 = st.artists[0];
    const [pName, pText] = persona(st.hours).map((x) => (typeof x === 'string' ? I18n.T(x) : x));
    const maxH = Math.max(1, ...st.hours);
    const list = (items, fn) => `<ol class="enc-list">${items.map(fn).join('')}</ol>`;
    return [
      `<div class="enc-slide enc-center"><p class="enc-kicker">Muriel Encore</p><h1 class="enc-big">${Th('{0}, played back.', esc(label)).replace(`${esc(label)},`, `${esc(label)},<br>`)}</h1>${pickers(st.period)}<button type="button" class="enc-go" data-next>${Th('Start')}</button></div>`,
      `<div class="enc-slide enc-center"><p class="enc-kicker">${Th('You listened for')}</p><h1 class="enc-num" data-count="${st.minutes}">0</h1><p class="enc-big enc-sm">${unit(st.minutes, 'minute', 'minutes')}</p><p class="enc-sub">${Th('{0} plays of {1} different songs', st.plays.toLocaleString(), st.songs.length.toLocaleString())}</p></div>`,
      `<div class="enc-slide enc-center"><p class="enc-kicker">${Th('Your #1 song')}</p><img class="enc-cover" src="${thumb(s1)}" alt=""><h1 class="enc-big enc-title">${esc(s1.title)}</h1><p class="enc-sub">${esc(s1.artist)}</p><p class="enc-pill">${Th(s1.plays === 1 ? '{0} play' : '{0} plays', s1.plays)}</p></div>`,
      `<div class="enc-slide"><p class="enc-kicker">${Th('Your top songs')}</p>${list(st.songs.slice(0, 5), (s, i) => `<li style="--i:${i}"><span class="enc-rank">${i + 1}</span><img src="${thumb(s)}" alt=""><span><b>${esc(s.title)}</b><small>${esc(s.artist)}</small></span><em>${s.plays}</em></li>`)}</div>`,
      a1 ? `<div class="enc-slide enc-center"><p class="enc-kicker">${Th('Your top artist')}</p><img class="enc-cover enc-round" src="${esc(a1.thumb)}" alt=""><h1 class="enc-big enc-title">${esc(a1.name)}</h1><p class="enc-sub">${Th('{0} plays · {1} min', a1.plays, Math.max(1, Math.round(a1.secs / 60)))}</p>${st.artists.length > 1 ? `<p class="enc-also">${Th('Also: {0}', st.artists.slice(1, 4).map((a) => esc(a.name)).join(', '))}</p>` : ''}</div>` : '',
      `<div class="enc-slide enc-center"><p class="enc-kicker">${Th("You're a")}</p><h1 class="enc-big">${esc(pName)}</h1><p class="enc-sub">${esc(pText)}</p><div class="enc-hours">${st.hours.map((n, i) => `<i style="--h:${(n / maxH).toFixed(3)};--i:${i}" title="${i}:00"></i>`).join('')}</div><div class="enc-hours-axis"><span>0</span><span>6</span><span>12</span><span>18</span><span>24</span></div></div>`,
      `<div class="enc-slide enc-center"><p class="enc-kicker">${Th('You listened on')}</p><h1 class="enc-num" data-count="${st.days}">0</h1><p class="enc-big enc-sm">${unit(st.days, 'day', 'days')}</p><p class="enc-sub">${Th(st.streak === 1 ? 'Longest streak: {0} day in a row' : 'Longest streak: {0} days in a row', st.streak)}</p></div>`,
      `<div class="enc-slide enc-summary"><div class="enc-card"><div class="enc-card-head"><b>Muriel Encore</b><span>${esc(label)}</span></div>
        <div class="enc-card-cols"><div><small>${Th('Top songs')}</small>${st.songs.slice(0, 5).map((s, i) => `<p>${i + 1}. ${esc(s.title)}</p>`).join('')}</div><div><small>${Th('Top artists')}</small>${st.artists.slice(0, 5).map((a, i) => `<p>${i + 1}. ${esc(a.name)}</p>`).join('')}</div></div>
        <div class="enc-card-foot"><div><small>${Th('Minutes')}</small><b>${st.minutes.toLocaleString()}</b></div><div><small>${Th("You're a")}</small><b>${esc(pName)}</b></div></div></div>
        <div class="enc-actions"><button type="button" class="enc-go" data-play>${Th('Play my top songs')}</button><button type="button" class="enc-ghost" data-share>${Th('Share')}</button></div></div>`,
    ].filter(Boolean);
  }
  // big titles shrink until their longest word fits, so "PinkPantheress" doesn't break mid-word on a phone
  function fitTitles(root) {
    root.querySelectorAll('.enc-title').forEach((el) => {
      el.style.maxWidth = '100%'; el.style.overflowWrap = 'normal';
      let size = parseFloat(getComputedStyle(el).fontSize) || 48;
      for (let i = 0; i < 30 && el.scrollWidth > el.clientWidth + 1 && size > 22; i++) { size -= 2; el.style.fontSize = `${size}px`; }
      el.style.overflowWrap = '';
    });
  }
  const pickers = (p) => `<div class="enc-periods">${Object.entries(PERIODS).map(([k, v]) => `<button type="button" data-period="${k}" class="${k === p ? 'active' : ''}">${Th(v)}</button>`).join('')}</div>`;

  function countUp(el) {
    const to = +el.dataset.count || 0, t0 = performance.now();
    const step = (now) => {
      const k = Math.min(1, (now - t0) / 1200), e = 1 - Math.pow(1 - k, 3);
      el.textContent = Math.round(to * e).toLocaleString();
      if (k < 1 && overlay) raf = requestAnimationFrame(step);
    };
    cancelAnimationFrame(raf); raf = requestAnimationFrame(step);
  }

  function show(i) {
    if (!overlay) return;
    slide = Math.max(0, Math.min(slides.length - 1, i));
    const els = overlay.querySelectorAll('.enc-slide');
    els.forEach((el, n) => el.classList.toggle('on', n === slide));
    overlay.querySelectorAll('.enc-bar i').forEach((b, n) => { b.className = n < slide ? 'done' : n === slide ? 'run' : ''; });
    const num = els[slide].querySelector('[data-count]');
    if (num) countUp(num);
    clearTimeout(timer);
    // the intro and the summary wait for you; the rest move on by themselves
    if (slide > 0 && slide < slides.length - 1) timer = setTimeout(() => show(slide + 1), SLIDE_MS);
  }

  function shareText(st) {
    const lines = [I18n.Tf('My Muriel Encore ({0})', I18n.T(PERIODS[st.period])), I18n.Tf('{0} minutes of music', st.minutes.toLocaleString())];
    st.songs.slice(0, 5).forEach((s, i) => lines.push(`${i + 1}. ${s.title} - ${s.artist}`));
    lines.push('', `${I18n.T('Muriel: free music app, no ads, no login.')} github.com/cloverscripts/riff-muriel`);
    return lines.join('\n');
  }
  async function share(st) {
    const text = shareText(st);
    const api = window.electronAPI;
    if (api && api.shareText) { await api.shareText(I18n.T('My Muriel Encore'), text); return; }
    if (navigator.share) { try { await navigator.share({ title: I18n.T('My Muriel Encore'), text }); return; } catch (e) { if (e && e.name === 'AbortError') return; } }
    try { await navigator.clipboard.writeText(text); if (window.MurielCore) window.MurielCore.toast(I18n.Tm('Copied your Encore')); } catch (e) {}
  }

  function render(period) {
    current = stats(period);
    slides = build(current);
    overlay.innerHTML = `<div class="enc-bar">${slides.map(() => '<i></i>').join('')}</div>
      <button type="button" class="enc-close" aria-label="${Th('Close')}"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
      ${slides.join('')}`;
    overlay.style.setProperty('--slide-ms', `${SLIDE_MS}ms`);
    fitTitles(overlay);
    show(0);
  }

  function open(period = 'month') {
    if (overlay) return;
    overlay = document.createElement('div');
    overlay.className = 'encore';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Muriel Encore');
    overlay.tabIndex = -1;
    returnFocus = document.activeElement;
    document.body.appendChild(overlay);
    render(period);
    // focus inside, so Space/Enter and Tab don't land on the page behind
    try { overlay.focus({ preventScroll: true }); } catch (e) {}
    requestAnimationFrame(() => overlay && overlay.classList.add('open'));
    overlay.addEventListener('click', (e) => {
      const t = e.target;
      if (t.closest('.enc-close')) return close();
      const p = t.closest('[data-period]');
      if (p) return render(p.dataset.period);
      if (t.closest('[data-next]')) return show(1);
      if (t.closest('[data-play]')) { const list = current.songs.slice(0, 25).map(toTrack); if (list.length) window.MurielCore.playTrack(list[0], list, 0); return close(); }
      if (t.closest('[data-share]')) return share(current);
      if (t.closest('button, a')) return;
      if (slide === 0) return; // the intro waits for "Start"
      if (e.clientX < window.innerWidth * 0.3) show(slide - 1); else show(slide + 1);
    });
    document.addEventListener('keydown', onKey, true);
  }
  function onKey(e) {
    if (!overlay) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); show(slide + 1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); show(slide - 1); }
  }
  let returnFocus = null;
  function close() {
    if (!overlay) return;
    clearTimeout(timer); cancelAnimationFrame(raf);
    document.removeEventListener('keydown', onKey, true);
    const o = overlay; overlay = null;
    if (returnFocus && returnFocus.focus && document.contains(returnFocus)) { try { returnFocus.focus({ preventScroll: true }); } catch (e) {} }
    returnFocus = null;
    o.classList.remove('open');
    setTimeout(() => o.remove(), 300);
  }

  // sync.js: this device's own listening (sent to linked devices), and a redraw when theirs arrives
  const own = () => { commit(); return db; };
  window.MurielEncore = { open, stats, close, compact, own, refresh: () => renderHome() };
  // another language, or its words just came in: the story too, on the slide it is on
  window.addEventListener('muriel:i18n', () => {
    renderHome();
    if (overlay && current) { const at = slide; render(current.period); show(at); }
  });
  try { compact(); } catch (e) {}
  const histBtn = document.getElementById('btn-open-encore');
  if (histBtn) histBtn.addEventListener('click', () => open('month'));
  if (window.MurielCore) hook(); else window.addEventListener('muriel:ready', hook, { once: true });
})();
