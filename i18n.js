// Muriel in other languages (Settings → Interface → Language). Muriel's own words (menus, buttons, settings,
// messages) are machine-translated through server.js (/api/i18n-batch, the service the lyrics translation uses)
// the first time each one is needed, and then kept: on disk per language (the data dir; on phones the app's
// storage), in memory here, and a copy of the open language's words in localStorage, so a restart shows them
// translated straight away instead of flashing English first. English costs nothing: no requests, nothing watched.
//
// Only text Muriel itself wrote is ever sent, never anything from the library (song titles, artists, playlist
// names) or typed by someone:
//  - the page as index.html has it, before app.js fills anything in: every text node, and the title, placeholder
//    and aria-label attributes. A node or attribute app.js changes later is app.js's from then on.
//  - elements marked data-i18n: their own text, also when app.js changes it later (labels it updates), and the
//    attributes named in data-i18n-attr="title aria-label". Only for elements whose text is always Muriel's own.
//  - T('English') and Tf('{0} songs in {1}', n, name) in code: what goes into {0}, {1} is filled in after
//    translating, so it never reaches the translator. Tm(...) is the same kept as a message: a toast (or
//    MurielI18n.text) shows it and updates it when the words come in or the language changes.
// Translations only ever go into text nodes and attribute values; Th(...), for HTML built as a string, escapes them.
// data-no-i18n (or translate="no") keeps a whole subtree as it is: the language list, brand names, user content.
//
// Right-to-left languages keep Muriel's layout as it is (mirroring a layout built left to right breaks more than
// it fixes); the translated text itself is laid out right to left (unicode-bidi: plaintext, styles.css), so
// punctuation lands where it belongs. test/i18n.test.js runs the pure part in Node.
(function (root) {
  'use strict';

  // ---------- pure part ----------
  const KEY = 'muriel_ui_lang'; // per profile, like every other setting
  const SNAP = 'muriel_i18n_snap'; // device-wide (profiles-core DEVICE): the open language's words, for a quick start
  const LANG_RE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/;
  const RTL = new Set(['ar', 'he', 'iw', 'fa', 'ur', 'ps', 'sd', 'ug', 'yi', 'dv', 'ckb']);
  const MAX_LEN = 500;
  // names that stay as they are in every language
  const KEEP = new Set(['muriel', 'encore', 'youtube', 'youtube music', 'soundcloud', 'spotify', 'apple music', 'deezer', 'itunes',
    'last.fm', 'lrclib', 'musixmatch', 'genius', 'netease', 'google sans', 'sf pro', 'peerjs', 'yt-dlp', 'ffmpeg', 'github',
    'android', 'ios', 'iphone', 'windows', 'macos', 'linux', 'electron', 'material 3', 'material you', 'riff', 'muriel encore',
    'rootscripts', 'cloverscripts', 'ctrl', 'shift', 'alt', 'esc', 'cmd', 'tab', 'enter']);
  const UNIT = /^[\d\s.,:;/+\-–—×x%°]*(ms|s|sec|min|h|x|db|hz|khz|px|kb|mb|gb|kbps|bpm|fps|lufs)?[\d\s.,:;/+\-–—×x%°]*$/i;

  const normLang = (code) => (LANG_RE.test(String(code || '')) ? String(code) : 'en');
  const isRtl = (code) => RTL.has(String(code || '').split('-')[0]);
  // the key a string is cached under: HTML collapses whitespace anyway
  const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

  // is this worth sending to the translator? (numbers, times, codes, links and names: no)
  function translatable(s) {
    if (typeof s !== 'string') return false;
    s = norm(s).replace(/\{\d\}/g, '0');
    if (s.length < 2 || s.length > MAX_LEN) return false;
    const letters = s.match(/\p{L}/gu);
    if (!letters || letters.length < 2) return false;
    if (UNIT.test(s)) return false;
    if (/^(https?:\/\/|www\.|mailto:)|:\/\/|^[\w.+-]+@[\w-]+\.[\w.]+$/i.test(s)) return false;
    if (/^v?\d+(\.\d+)+\S*$/i.test(s)) return false; // versions
    if (/^[A-Z0-9]{2,5}$/.test(s)) return false; // HQ, FLAC, AAC, EQ, LRC
    if (/^(ctrl|cmd|alt|shift|meta|⌘|⌥|⇧)\s*[+-]/i.test(s)) return false; // shortcuts
    if (/^[\w-]+\.(js|json|css|html|lrc|mp3|m4a|txt)$/i.test(s)) return false; // file names
    if (KEEP.has(s.toLowerCase())) return false;
    return true;
  }

  // page text with numbers in it ('12 tracks', '0 / 0 lines synced') is translated as '{0} tracks' and the numbers
  // put back: one entry for every count, and the numbers never leave the device
  function numbered(s) {
    if (/\{\d\}/.test(s)) return null;
    const args = [];
    const template = s.replace(/\d+(?:[.,:]\d+)*/g, (m) => (args.length < 10 ? `{${args.push(m) - 1}}` : m));
    return args.length ? { template, args } : null;
  }

  const slots = (s) => (String(s).match(/\{\d\}/g) || []).sort().join('');
  // a translation is used only when it is a real string that kept every {n} of the English one
  function pick(src, tr) {
    if (typeof tr !== 'string') return null;
    const out = norm(tr.replace(/\{\s*(\d)\s*\}/g, '{$1}'));
    if (!out || out.length > src.length * 4 + 60) return null;
    return slots(out) === slots(src) ? out : null;
  }
  // '{0} songs' + [12] -> '12 songs'; a missing argument leaves its slot empty
  const fill = (template, args) => String(template).replace(/\{(\d)\}/g, (_, i) => (args && args[i] != null ? String(args[i]) : ''));
  // keeps the spaces around a string the way the page had them
  function keepSpace(orig, tr) {
    const lead = /^\s*/.exec(orig)[0];
    const trail = orig.length > lead.length ? /\s*$/.exec(orig)[0] : '';
    return lead + tr + trail;
  }

  const core = { KEY, SNAP, RTL, normLang, isRtl, norm, translatable, pick, fill, keepSpace, numbered };
  if (typeof module !== 'undefined' && module.exports) module.exports = core;
  if (typeof document === 'undefined' || !root.localStorage) return;

  // ---------- in the app ----------
  const read = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  let lang = normLang(read(KEY) || 'en');
  let dict = new Map(); // English (normalised) -> translation, for `lang`
  let back = new Map(); // translation -> English: text code put in already translated
  let prevBack = new Map(); // the same for the language before a switch: its words on the page go back to English
  const asked = new Set(); // asked for this language and session; a failure takes them out again
  const queue = new Set();
  let base = ''; // the local server, once app.js knows its port
  let flushTimer = null, busy = false, failUntil = 0;
  let observer = null;
  const settled = []; // resolve() of setLang/ready waiting for the queue to empty
  const statics = []; // { n: Text, src, cur }: the page as index.html had it
  const staticAttrs = []; // { el, a, src, cur }
  const nodeRec = new WeakMap(); // Text inside [data-i18n] -> { src, cur }
  const attrRec = new WeakMap(); // [data-i18n-attr] element -> { [attr]: { src, cur } }
  const liveRec = new WeakMap(); // element -> { ref, template, args, cur }: MurielI18n.text / toasts
  const liveRefs = new Set(); // WeakRef(element) of those, to go through on a switch
  const known = new Set(); // words code shows often that the page doesn't have (menus, messages): asked for up front
  const ATTRS = ['title', 'placeholder', 'aria-label'];
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'CODE', 'PRE', 'KBD', 'TEMPLATE', 'svg', 'SVG', 'math', 'CANVAS', 'VIDEO', 'AUDIO']);
  const optedOut = (el) => el.hasAttribute('data-no-i18n') || el.getAttribute('translate') === 'no' || el.isContentEditable;

  function lookup(key) {
    if (!translatable(key)) return undefined;
    const tr = dict.get(key);
    if (tr === undefined) want(key);
    return tr;
  }
  // text found on the page: numbers in it become slots
  function render(src) {
    if (lang === 'en') return src;
    const key = norm(src);
    const n = numbered(key);
    const tr = n ? lookup(n.template) : lookup(key);
    return tr === undefined ? src : keepSpace(src, n ? fill(tr, n.args) : tr);
  }
  // a string from code, taken as it is
  function plain(s) {
    if (lang === 'en') return s;
    const tr = lookup(norm(s));
    return tr === undefined ? s : keepSpace(s, tr);
  }
  const T = (s) => (typeof s === 'string' && lang !== 'en' ? plain(s) : s);
  const Tf = (template, ...args) => fill(T(template), args);
  // a message that remembers what it was made of: showToast and text() translate it when it is shown and again
  // when a missing translation comes in; as a string it is Tf's result
  const Tm = (template, ...args) => ({ i18n: String(template), args, toString() { return Tf(this.i18n, ...this.args); } });
  // for HTML built as a string: the translation is escaped, the {n} slots take HTML the caller built and escaped
  const escHtml = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const Th = (template, ...argsHtml) => escHtml(T(String(template))).replace(/\{(\d)\}/g, (_, i) => (argsHtml[i] != null ? String(argsHtml[i]) : ''));

  // the first look at the page: index.html as it is, before app.js puts anything from the library in it.
  // Only noted here (a few ms); what is worth translating is worked out when there is something to translate.
  const BLANK = /^\s*$/;
  function capture() {
    if (!document.body) return;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (n.nodeType === 3) return BLANK.test(n.data) ? NodeFilter.FILTER_SKIP : NodeFilter.FILTER_ACCEPT;
        if (SKIP.has(n.tagName) || optedOut(n)) return NodeFilter.FILTER_REJECT;
        if (n.hasAttribute('title') || n.hasAttribute('placeholder') || n.hasAttribute('aria-label')) {
          for (const a of ATTRS) {
            const v = n.getAttribute(a);
            if (v && !n.hasAttribute('data-i18n-attr')) staticAttrs.push({ el: n, a, src: v, cur: v });
          }
        }
        // [data-i18n] elements look after their own text (also when app.js changes it)
        return n.hasAttribute('data-i18n') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
      },
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) statics.push({ n, src: n.data, cur: n.data });
  }

  function applyStatics(visibleFirst) {
    // what is on screen goes into the first request, so a language switch shows there first
    let order = statics.keys();
    if (visibleFirst) { const vis = statics.map(visible); order = [...statics.keys()].sort((a, b) => vis[b] - vis[a]); }
    for (const i of order) {
      const r = statics[i];
      if (!r) continue;
      if (r.n.data !== r.cur) { statics[i] = null; continue; } // app.js took this one over
      const v = render(r.src);
      if (v !== r.cur) { r.n.data = v; r.cur = v; mark(r.n.parentElement); }
    }
    for (let i = 0; i < staticAttrs.length; i++) {
      const r = staticAttrs[i];
      if (!r) continue;
      if (r.el.getAttribute(r.a) !== r.cur) { staticAttrs[i] = null; continue; }
      const v = render(r.src);
      if (v !== r.cur) { r.el.setAttribute(r.a, v); r.cur = v; }
    }
  }
  function visible(r) {
    const el = r && r.n.parentElement;
    if (!el) return 0;
    try { return el.checkVisibility ? (el.checkVisibility() ? 1 : 0) : (el.offsetParent ? 1 : 0); } catch (e) { return 0; }
  }
  // right to left: the element's text runs that way, the layout around it stays
  function mark(el) { if (el && isRtl(lang) && !el.hasAttribute('data-i18n-bidi')) el.setAttribute('data-i18n-bidi', ''); }

  // text that is English, or a translation code put in itself (T()), or ours from before
  function sourceOf(text, rec) {
    if (rec && text === rec.cur) return rec.src;
    const key = norm(text);
    if (dict.has(key)) return text;
    if (back.has(key)) return keepSpace(text, back.get(key));
    if (prevBack.has(key) && !dict.has(prevBack.get(key))) return keepSpace(text, prevBack.get(key));
    const n = numbered(key);
    if (n && back.has(n.template) && !dict.has(n.template)) return keepSpace(text, fill(back.get(n.template), n.args));
    return text;
  }
  function doText(n) {
    if (!n.data.trim()) return;
    const rec = nodeRec.get(n);
    const src = sourceOf(n.data, rec);
    const v = render(src);
    if (v !== n.data) { n.data = v; mark(n.parentElement); }
    nodeRec.set(n, { src, cur: v });
  }
  function doAttrs(el) {
    const names = (el.getAttribute('data-i18n-attr') || 'title').split(/[\s,]+/).filter(Boolean);
    let recs = attrRec.get(el);
    if (!recs) attrRec.set(el, (recs = {}));
    for (const a of names) {
      const cur = el.getAttribute(a);
      if (!cur) continue;
      const src = sourceOf(cur, recs[a]);
      const v = render(src);
      if (v !== cur) el.setAttribute(a, v);
      recs[a] = { src, cur: v };
    }
  }
  function doEl(el) {
    if (el.hasAttribute('data-i18n')) for (const n of el.childNodes) if (n.nodeType === 3) doText(n);
    if (el.hasAttribute('data-i18n-attr')) doAttrs(el);
  }
  const doAll = (rootEl) => { if (rootEl && rootEl.querySelectorAll) for (const el of rootEl.querySelectorAll('[data-i18n],[data-i18n-attr]')) doEl(el); };

  // text set from code with text(): kept translated, also after a language switch
  function text(el, template, ...args) {
    if (!el) return;
    if (template && typeof template === 'object' && template.i18n) { args = template.args || []; template = template.i18n; }
    const v = Tf(String(template), ...args);
    el.textContent = v;
    if (lang !== 'en') mark(el);
    if (typeof WeakRef !== 'function') return;
    let rec = liveRec.get(el);
    if (!rec) liveRec.set(el, (rec = { ref: new WeakRef(el) }));
    Object.assign(rec, { template: String(template), args, cur: v });
    liveRefs.add(rec.ref);
  }
  function applyLive() {
    for (const ref of liveRefs) {
      const el = ref.deref();
      const rec = el && liveRec.get(el);
      // gone, or app.js wrote something else there since
      if (!rec || !el.isConnected || el.textContent !== rec.cur) { liveRefs.delete(ref); continue; }
      const v = Tf(rec.template, ...rec.args);
      if (v !== rec.cur) { el.textContent = v; rec.cur = v; mark(el); }
    }
  }

  function refresh(visibleFirst) {
    applyStatics(visibleFirst);
    doAll(document.body);
    applyLive();
    try { root.dispatchEvent(new CustomEvent('muriel:i18n', { detail: { lang } })); } catch (e) {}
  }

  // ---------- watching the page (other languages only) ----------
  function onMutations(list) {
    for (const m of list) {
      const tg = m.target;
      if (m.type === 'characterData') { const p = tg.parentElement; if (p && p.hasAttribute('data-i18n')) doText(tg); continue; }
      if (m.type === 'attributes') { if (tg.hasAttribute('data-i18n-attr')) doAttrs(tg); continue; }
      if (tg.nodeType === 1 && tg.hasAttribute('data-i18n')) doEl(tg);
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.hasAttribute('data-i18n') || n.hasAttribute('data-i18n-attr')) doEl(n);
        if (n.firstElementChild) doAll(n);
      }
    }
  }
  function watch(on) {
    if (on && !observer && typeof MutationObserver === 'function' && document.body) {
      observer = new MutationObserver(onMutations);
      observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
    } else if (!on && observer) { observer.disconnect(); observer = null; }
  }

  // ---------- asking the server ----------
  function want(key) {
    if (asked.has(key) || queue.has(key)) return;
    queue.add(key);
    schedule(40);
  }
  function schedule(ms) {
    if (flushTimer || busy || !base) return;
    flushTimer = setTimeout(flush, Math.max(ms, failUntil - Date.now()));
  }
  function settle() {
    if ((queue.size || busy) && base && Date.now() >= failUntil) return;
    while (settled.length) settled.shift()();
  }
  function learn(src, tr) {
    const ok = pick(src, tr);
    if (!ok) return false;
    dict.set(src, ok);
    back.set(ok, src);
    return true;
  }
  async function flush() {
    flushTimer = null;
    if (!base || lang === 'en' || !queue.size) return settle();
    if (Date.now() < failUntil) { schedule(0); return settle(); }
    busy = true;
    const forLang = lang;
    const texts = [...queue].slice(0, 250);
    texts.forEach((s) => { queue.delete(s); asked.add(s); });
    let got = 0, failed = false;
    try {
      const res = await fetch(`${base}/api/i18n-batch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target: forLang, texts }) });
      const data = await res.json();
      if (!data || !data.success || !Array.isArray(data.translations)) throw new Error((data && data.error) || `HTTP ${res.status}`);
      if (forLang === lang) {
        failed = data.complete === false;
        // not answered: asked again later; answered with nothing usable: not again this session
        texts.forEach((s, i) => { if (learn(s, data.translations[i])) got++; else if (failed && data.translations[i] == null) asked.delete(s); });
      }
    } catch (e) {
      failed = true;
      if (forLang === lang) texts.forEach((s) => asked.delete(s));
      console.warn('[i18n]', e && e.message ? e.message : e);
    }
    busy = false;
    if (forLang !== lang) { schedule(0); return settle(); } // switched meanwhile: the server kept them anyway
    // the service did not answer: English for now, again in a minute (or when the network is back)
    if (failed) failUntil = Date.now() + 60000;
    if (got) { refresh(false); saveSnapSoon(); }
    if (failed) { while (settled.length) settled.shift()(); }
    if (queue.size) schedule(0);
    settle();
  }

  // everything this device translated before, in one go: the server's copy of the disk cache
  async function loadAll(forLang) {
    if (!base) return;
    try {
      const res = await fetch(`${base}/api/i18n-batch?target=${encodeURIComponent(forLang)}`);
      const data = await res.json();
      if (forLang !== lang || !data || !data.success || !data.translations || typeof data.translations !== 'object') return;
      for (const [src, tr] of Object.entries(data.translations)) if (!dict.has(src)) learn(src, tr);
    } catch (e) {}
  }

  let snapTimer = null;
  function saveSnapSoon() {
    clearTimeout(snapTimer);
    snapTimer = setTimeout(() => {
      if (lang === 'en' || !dict.size) return;
      try {
        const s = JSON.stringify({ lang, dict: Object.fromEntries(dict) });
        // a rebuildable copy: never worth crowding out the library (app.js drops it first when storage is full)
        if (s.length < 600000) localStorage.setItem(SNAP, s);
      } catch (e) {}
    }, 1500);
  }
  function loadSnap() {
    try {
      const s = JSON.parse(read(SNAP) || 'null');
      if (s && s.lang === lang && s.dict && typeof s.dict === 'object') for (const [src, tr] of Object.entries(s.dict)) learn(src, tr);
    } catch (e) {}
  }

  function setRootAttrs() {
    const html = document.documentElement;
    html.lang = lang;
    html.classList.toggle('ui-rtl', isRtl(lang));
  }

  // ---------- switching ----------
  // resolves once what was missing has come in, or the service gave up for now
  async function setLang(code) {
    code = normLang(code);
    try { localStorage.setItem(KEY, code); } catch (e) {}
    if (code === lang && (code === 'en' || dict.size)) return true;
    lang = code;
    prevBack = back;
    dict = new Map(); back = new Map(); asked.clear(); queue.clear(); failUntil = 0;
    clearTimeout(flushTimer); flushTimer = null;
    setRootAttrs();
    if (lang === 'en') { watch(false); refresh(false); return true; }
    loadSnap();
    await loadAll(lang);
    if (lang !== code) return false;
    const done = new Promise((resolve) => settled.push(resolve));
    refresh(true);
    for (const k of known) lookup(norm(k));
    watch(true);
    schedule(0);
    settle();
    await done;
    return failUntil === 0;
  }

  // app.js tells where the server is (its port is known only after startup); until then nothing is asked
  async function connect(url) {
    if (!url || base) return;
    base = String(url).replace(/\/+$/, '');
    if (lang === 'en') return;
    const before = dict.size;
    await loadAll(lang);
    if (dict.size !== before) { refresh(false); saveSnapSoon(); }
    for (const k of known) if (!dict.has(norm(k))) lookup(norm(k));
    // what the first pass found missing, minus what the server had
    for (const s of [...queue]) if (dict.has(s)) queue.delete(s);
    if (queue.size) schedule(0);
  }

  // a toast can wait a moment for its words instead of showing English
  function ready(template, ms = 700) {
    if (lang === 'en' || !base || Date.now() < failUntil) return Promise.resolve();
    const key = norm(template);
    if (!translatable(key) || dict.has(key)) return Promise.resolve();
    T(template);
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      settled.push(() => { clearTimeout(timer); resolve(); });
    });
  }

  if (root.addEventListener) root.addEventListener('online', () => { if (failUntil) { failUntil = 0; asked.clear(); refresh(false); } });

  // ---------- start: before app.js, so the first paint is already in the right language ----------
  setRootAttrs();
  capture();
  if (lang !== 'en') {
    loadSnap();
    refresh(false);
    watch(true);
  }

  // the getter is defined, not copied: Object.assign would read it once and freeze the language at startup, so
  // the language picker thought English was still on and ignored picking it again (#20)
  root.MurielI18n = Object.defineProperty(Object.assign({}, core, {
    T, Tf, Tm, Th, text, setLang, connect, ready,
    known: (list) => { for (const k of list || []) if (typeof k === 'string') known.add(k); },
    refresh: () => refresh(false),
    // the page's own words as index.html has them (what a switch asks for), for checking what is sent
    strings: () => [...new Set(statics.filter(Boolean).map((r) => norm(r.src)).concat(staticAttrs.filter(Boolean).map((r) => norm(r.src)))
      .map((s) => { const n = numbered(s); return n ? n.template : s; }))].filter(translatable),
  }), 'lang', { get: () => lang, enumerable: true });
})(typeof window !== 'undefined' ? window : globalThis);
