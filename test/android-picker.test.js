'use strict';

// The sheet that picks the download folder (mobile/electron-api.js), run against a small stand-in for the DOM:
// what it returns for each choice, that a bad folder name is refused with a message, and which of its words go to the
// translation system (i18n.js) and which are left out (folder names and paths would only be sent to the translator).

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

class El {
  constructor(tag) { this.tag = tag; this.style = {}; this.attrs = new Map(); this.children = []; this.listeners = {}; this.className = ''; this.textContent = ''; this.value = ''; this.checked = false; this.classes = new Set(); }
  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  hasAttribute(k) { return this.attrs.has(k); }
  appendChild(c) { this.children.push(c); c.parent = this; return c; }
  append(...cs) { for (const c of cs) this.appendChild(c); }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  click() { for (const fn of this.listeners.click || []) fn({ target: this }); }
  remove() { this.removed = true; }
  get classList() { return { add: (c) => this.classes.add(c), remove: (c) => this.classes.delete(c) }; }
  all() { return [this, ...this.children.flatMap((c) => c.all())]; }
}
class Option extends El { constructor(text, value) { super('option'); this.textContent = text; this.value = value; } }

const realLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === '@capacitor/core') return { Capacitor: { getPlatform: () => 'android', isNativePlatform: () => true, Plugins: {}, convertFileSrc: (u) => u } };
  if (request === '@capacitor/filesystem') return { Filesystem: {}, Directory: { Data: 'DATA', Documents: 'DOCUMENTS', External: 'EXTERNAL', ExternalStorage: 'EXTERNAL_STORAGE', Cache: 'CACHE' }, Encoding: { UTF8: 'utf8' } };
  if (request === '@capacitor/share') return { Share: {} };
  return realLoad.call(this, request, ...rest);
};
const { chooseDownloadFolder } = require('../mobile/electron-api.js');

let body;
let said; // what went through text()
beforeEach(() => {
  body = new El('body');
  said = [];
  global.document = { body, createElement: (t) => new El(t) };
  global.Option = Option;
  global.requestAnimationFrame = (fn) => fn();
  global.window = { PiverxyI18n: { Tm: (s) => ({ i18n: s }), text: (el, s) => { said.push(s); el.textContent = s; } } };
});

const open = (current) => {
  const p = chooseDownloadFolder(current);
  const sheet = body.children[body.children.length - 1];
  const els = sheet.all();
  const byId = (id) => els.find((e) => e.id === id);
  const radios = els.filter((e) => e.tag === 'input' && e.type === 'radio');
  return {
    p, sheet, els, radios,
    save: els.find((e) => e.tag === 'button' && e.textContent === 'Use this folder'),
    cancel: byId('btn-cancel-download-folder'),
    select: els.find((e) => e.tag === 'select'),
    name: els.find((e) => e.tag === 'input' && e.type === 'text'),
    move: els.find((e) => e.tag === 'input' && e.type === 'checkbox'),
    err: els.find((e) => e.style.cssText && String(e.style.cssText).includes('min-height:16px')),
  };
};
const pick = (ui, value) => { for (const r of ui.radios) r.checked = r.value === value; };

test('the current folder is preselected; "Use this folder" returns it, with the move answer', async () => {
  const ui = open('Download/Piverxy');
  assert.equal(ui.radios.find((r) => r.checked).value, 'Download/Piverxy');
  ui.move.checked = false;
  ui.save.click();
  assert.deepEqual(await ui.p, { text: 'Download/Piverxy', move: false });
  assert.equal(ui.sheet.classes.has('visible'), false);
});

test('the app folder and a folder of your own inside Music, Download, ... are returned as Settings shows them', async () => {
  let ui = open('Music/Piverxy');
  pick(ui, ui.radios.find((r) => r.value.startsWith('Android/data/')).value);
  ui.save.click();
  const app = await ui.p;
  assert.match(app.text, /^Android\/data\/[^/]+\/files\/download$/);
  assert.equal(app.move, true);

  ui = open('Music/Piverxy');
  pick(ui, '__custom');
  ui.select.value = 'Podcasts';
  ui.name.value = '  Road trip ';
  ui.save.click();
  assert.deepEqual(await ui.p, { text: 'Podcasts/Road trip', move: true });
});

test('a folder of your own that is already the current one opens preselected with its parts filled in', () => {
  const ui = open('Documents/My songs');
  assert.equal(ui.radios.find((r) => r.checked).value, '__custom');
  assert.equal(ui.select.value, 'Documents');
  assert.equal(ui.name.value, 'My songs');
});

test('a folder name that cannot be used is refused with a message (translated), and Cancel still works', async () => {
  const ui = open('Music/Piverxy');
  pick(ui, '__custom');
  for (const bad of ['', 'a:b', '../x', '.hidden', 'a/../b']) {
    ui.name.value = bad;
    ui.save.click();
  }
  assert.equal(said.length, 5);
  assert.match(said[0], /special characters/);
  assert.equal(ui.err.textContent, said[0]);
  let settled = false;
  ui.p.then(() => { settled = true; });
  await new Promise((r) => setImmediate(r));
  assert.equal(settled, false, 'nothing was saved');
  ui.cancel.click();
  assert.equal(await ui.p, null);
});

test('Piverxy\'s own words are marked for translation; folder names and paths are not', () => {
  const ui = open('Music/Piverxy');
  const words = ui.els.filter((e) => e.hasAttribute('data-i18n')).map((e) => e.textContent).sort();
  assert.deepEqual(words, [
    'Another folder', 'App folder', 'Cancel', 'Download folder',
    "Needs no permission. File managers on Android 11+ can't open it",
    'Move the songs I already downloaded', 'Music apps and file managers find it', 'Next to your other downloads', 'Use this folder',
  ].sort());
  for (const e of ui.els) {
    if (!e.textContent) continue;
    if (/\/|Piverxy|^(Music|Download|Documents|Podcasts|Audiobooks)$/.test(e.textContent)) {
      assert.equal(e.hasAttribute('data-i18n'), false, `"${e.textContent}" would be sent to the translator`);
    }
  }
  assert.equal(ui.name.getAttribute('data-i18n-attr'), 'placeholder');
  assert.equal(ui.name.hasAttribute('data-i18n'), false, 'what someone types is never translated');
});

test('the Android back button can close the sheet (its Cancel button id starts with btn-cancel)', () => {
  assert.match(open('Music/Piverxy').cancel.id, /^btn-cancel/);
});
