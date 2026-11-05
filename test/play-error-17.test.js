'use strict';

// #17: the first click on a song failed with "Could not play this song" and the log only said
// "Play error: [object DOMException]". The play() rejection now says which DOMException it was, our own
// interruptions (AbortError) are not failures, and anything else gets one fresh lookup first.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

function fnSource(name) {
  const start = app.indexOf(`function ${name}(`);
  assert.ok(start >= 0, name);
  let depth = 0;
  for (let i = app.indexOf('{', start); i < app.length; i++) {
    if (app[i] === '{') depth++;
    else if (app[i] === '}' && --depth === 0) return app.slice(start, i + 1);
  }
  throw new Error('unbalanced ' + name);
}

function loadLogger(audio) {
  const logged = [];
  const ctx = {
    el: { nativeAudio: audio }, state: { loadToken: 7 }, hlsInstance: null, URL,
    console: { warn: (l) => logged.push(['console', l]) },
    window: { __riffLogError: (level, line) => logged.push([level, line]) },
  };
  vm.runInNewContext(`${fnSource('describeMediaState')}\n${fnSource('logPlaybackIssue')}\nthis.log = logPlaybackIssue;`, ctx);
  return { log: ctx.log, logged };
}

test('a play() rejection is logged with its name, message and the element state, also to the app log', () => {
  const audio = { currentSrc: 'https://rr3---sn.googlevideo.com/videoplayback?x=1', src: '', error: { code: 4, message: 'Format error' }, readyState: 0, networkState: 3, paused: true };
  const { log, logged } = loadLogger(audio);
  const err = { name: 'NotSupportedError', message: 'Failed to load because no supported source was found.' };
  const line = log('Play error', err);
  assert.match(line, /^Play error: NotSupportedError: Failed to load because no supported source was found\./);
  assert.match(line, /mediaError=4 Format error readyState=0 networkState=3 paused=true src=rr3---sn\.googlevideo\.com \| load=7/);
  assert.doesNotMatch(line, /videoplayback/, 'only the host, not the signed URL');
  assert.deepEqual(logged.map((l) => l[0]), ['console', 'WARN']);
});

test('no source and no error still log cleanly', () => {
  const { log } = loadLogger({ currentSrc: '', src: '', error: null, readyState: 0, networkState: 0, paused: true });
  assert.match(log('Play error', null), /no details \| mediaError=none .*src=\(none\)/);
});

test('the play() catch ignores our own interruptions and superseded loads, and retries others once', () => {
  const body = fnSource('playSmooth');
  const c = body.slice(body.indexOf('.play().catch('));
  const at = (s) => { const i = c.indexOf(s); assert.ok(i >= 0, s); return i; };
  assert.ok(body.indexOf('const loadTok = state.loadToken') < body.indexOf('.play().catch('), 'load token taken before play()');
  const logged = at("logPlaybackIssue('Play error', e)");
  const abort = at("e.name === 'AbortError') return");
  const stale = at('loadTok !== state.loadToken');
  const mediaErr = at('el.nativeAudio.error) return');
  const retry = at('retryFresh(loadTok, state.currentTrack)');
  const reset = at('updatePlayPauseButton(false, false)');
  assert.ok(logged < abort && abort < stale && stale < mediaErr && mediaErr < retry && retry < reset);
  assert.doesNotMatch(c.slice(0, reset), /showToast/);
});

test('the window lets songs start without a fresh click', () => {
  assert.match(main, /autoplayPolicy:\s*'no-user-gesture-required'/);
});
