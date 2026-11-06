const test = require('node:test');
const assert = require('node:assert');
const { createTaskQueue, lowerPriority } = require('../ytdlp-queue');

// a task the test finishes by hand
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const tick = () => new Promise((r) => setImmediate(r));

test('runs at most `limit` tasks at once and starts the next when one ends', async () => {
  const q = createTaskQueue({ limit: 2, backgroundLimit: 2 });
  const d = [deferred(), deferred(), deferred()];
  let started = 0;
  const runs = d.map((x) => q.run(() => { started++; return x.promise; }));
  await tick();
  assert.strictEqual(started, 2);
  assert.strictEqual(q.stats().pending, 1);
  d[0].resolve('a');
  await runs[0];
  await tick();
  assert.strictEqual(started, 3);
  d[1].resolve('b'); d[2].resolve('c');
  assert.deepStrictEqual(await Promise.all(runs), ['a', 'b', 'c']);
  assert.strictEqual(q.stats().running.total, 0);
});

test('background work gets one slot; normal work is not held up by it', async () => {
  const q = createTaskQueue({ limit: 2, backgroundLimit: 1 });
  const started = [];
  const d = {};
  const mk = (name, priority) => q.run(() => { started.push(name); d[name] = deferred(); return d[name].promise; }, { priority });
  mk('bg1', 'background');
  mk('bg2', 'background');
  mk('n1', 'normal');
  await tick();
  assert.deepStrictEqual(started, ['bg1', 'n1']);
  d.n1.resolve();
  await tick(); await tick();
  assert.deepStrictEqual(started, ['bg1', 'n1'], 'the second background task still waits for the first');
  d.bg1.resolve();
  await tick(); await tick();
  assert.deepStrictEqual(started, ['bg1', 'n1', 'bg2']);
  d.bg2.resolve();
});

test('a song to play goes first and gets a slot even when the queue is full', async () => {
  const q = createTaskQueue({ limit: 2, backgroundLimit: 2 });
  const started = [];
  const d = {};
  const mk = (name, priority) => q.run(() => { started.push(name); d[name] = deferred(); return d[name].promise; }, { priority });
  mk('a', 'normal'); mk('b', 'normal'); mk('c', 'background'); mk('n', 'normal');
  mk('play', 'play');
  await tick();
  assert.deepStrictEqual(started, ['a', 'b', 'play']);
  // a second song waits for a slot, but ahead of everything else
  mk('play2', 'play');
  await tick();
  assert.deepStrictEqual(started, ['a', 'b', 'play']);
  d.a.resolve();
  await tick(); await tick();
  assert.deepStrictEqual(started, ['a', 'b', 'play'], 'three were running: back to the limit of two first');
  d.b.resolve();
  await tick(); await tick();
  assert.deepStrictEqual(started, ['a', 'b', 'play', 'play2']);
  d.play.resolve(); d.play2.resolve();
  await tick(); await tick();
  assert.deepStrictEqual(started, ['a', 'b', 'play', 'play2', 'n', 'c']);
  d.n.resolve(); d.c.resolve();
});

test('identical requests share one run', async () => {
  const q = createTaskQueue();
  let runs = 0;
  const d = deferred();
  const task = () => { runs++; return d.promise; };
  const a = q.run(task, { key: 'g:x' });
  const b = q.run(task, { key: 'g:x' });
  d.resolve('url');
  assert.deepStrictEqual(await Promise.all([a, b]), ['url', 'url']);
  assert.strictEqual(runs, 1);
});

test('asking to play a song that is queued as a prefetch moves it up', async () => {
  const q = createTaskQueue({ limit: 1, backgroundLimit: 1 });
  const order = [];
  const d = {};
  const mk = (name, priority, key) => q.run(() => { order.push(name); d[name] = deferred(); return d[name].promise; }, { priority, key });
  mk('busy', 'normal');
  mk('other', 'normal');
  const pre = mk('prefetch', 'background', 'g:song');
  const play = mk('ignored', 'play', 'g:song');
  await tick();
  assert.deepStrictEqual(order, ['busy', 'prefetch'], 'the play request takes the queued prefetch along');
  d.prefetch.resolve('u');
  assert.strictEqual(await play, 'u');
  assert.strictEqual(await pre, 'u');
  d.busy.resolve();
  await tick(); await tick();
  d.other.resolve();
});

test('results are remembered for cacheMs', async () => {
  let t = 1000;
  const q = createTaskQueue({ now: () => t });
  let runs = 0;
  const task = async () => ++runs;
  assert.strictEqual(await q.run(task, { key: 'k', cacheMs: 5000 }), 1);
  t += 4000;
  assert.strictEqual(await q.run(task, { key: 'k', cacheMs: 5000 }), 1);
  t += 2000;
  assert.strictEqual(await q.run(task, { key: 'k', cacheMs: 5000 }), 2);
  assert.strictEqual(await q.run(task, { key: 'other' }), 3, 'without cacheMs nothing is kept');
  assert.strictEqual(await q.run(task, { key: 'other' }), 4);
});

test('failed background work backs off, doubling, and never loops; playing still tries', async () => {
  let t = 0;
  const q = createTaskQueue({ now: () => t, backoffBaseMs: 1000, backoffMaxMs: 3000 });
  let runs = 0;
  const fail = async () => { runs++; throw new Error('nope'); };
  await assert.rejects(q.run(fail, { key: 'g:bad', priority: 'background' }), /nope/);
  await assert.rejects(q.run(fail, { key: 'g:bad', priority: 'background' }), (e) => e.code === 'BACKOFF');
  assert.strictEqual(runs, 1);
  assert.ok(q.backingOff('g:bad'));
  // the listener pressing play still gets a real attempt
  await assert.rejects(q.run(fail, { key: 'g:bad', priority: 'play' }), /nope/);
  assert.strictEqual(runs, 2);
  t += 1500; // second failure: 2 s backoff
  assert.ok(q.backingOff('g:bad'));
  t += 600;
  assert.ok(!q.backingOff('g:bad'));
  await assert.rejects(q.run(fail, { key: 'g:bad', priority: 'background' }), /nope/);
  t += 2999; // capped at backoffMaxMs
  assert.ok(q.backingOff('g:bad'));
  t += 2;
  assert.ok(!q.backingOff('g:bad'));
  // a success clears the record
  await q.run(async () => 'ok', { key: 'g:bad', priority: 'background' });
  assert.ok(!q.backingOff('g:bad'));
});

test('a task that throws synchronously frees its slot', async () => {
  const q = createTaskQueue({ limit: 1 });
  await assert.rejects(q.run(() => { throw new Error('boom'); }), /boom/);
  assert.strictEqual(await q.run(async () => 'next'), 'next');
  assert.strictEqual(q.stats().running.total, 0);
});

test('lowerPriority sets a lower priority on the process and tolerates failures', () => {
  const calls = [];
  const fakeOs = { constants: { priority: { PRIORITY_BELOW_NORMAL: 10 } }, setPriority: (pid, p) => calls.push([pid, p]) };
  assert.strictEqual(lowerPriority(1234, fakeOs), true);
  assert.deepStrictEqual(calls, [[1234, 10]]);
  assert.strictEqual(lowerPriority(undefined, fakeOs), false);
  assert.strictEqual(lowerPriority(5, { setPriority: () => { throw new Error('EPERM'); }, constants: { priority: {} } }), false);
});

test('while a song to play is looked up, nothing else starts (#17)', async () => {
  const q = createTaskQueue({ limit: 2, backgroundLimit: 1 });
  const started = [];
  const d = {};
  const mk = (name, priority) => q.run(() => { started.push(name); d[name] = deferred(); return d[name].promise; }, { priority });
  mk('play', 'play');
  mk('n1', 'normal'); mk('bg', 'background');
  await tick();
  assert.deepStrictEqual(started, ['play'], 'search/recommendation/cache runs wait while the click is resolved');
  d.play.resolve();
  await tick(); await tick();
  assert.deepStrictEqual(started, ['play', 'n1', 'bg']);
  d.n1.resolve(); d.bg.resolve();
});

test('a click overtakes the per-result lookups of a search that is still running (#17)', async () => {
  const q = createTaskQueue({ limit: 2, backgroundLimit: 1 });
  const started = [];
  const d = {};
  const mk = (name, priority) => q.run(() => { started.push(name); d[name] = deferred(); return d[name].promise; }, { priority });
  for (let i = 0; i < 6; i++) mk('artist' + i, 'normal');
  await tick();
  mk('play', 'play');
  await tick();
  assert.deepStrictEqual(started, ['artist0', 'artist1', 'play']);
  d.artist0.resolve(); d.artist1.resolve();
  await tick(); await tick();
  assert.deepStrictEqual(started, ['artist0', 'artist1', 'play'], 'the rest waits until the song has its stream');
  d.play.resolve();
  await tick(); await tick();
  assert.deepStrictEqual(started.slice(3), ['artist2', 'artist3']);
  for (let i = 2; i < 6; i++) { if (d['artist' + i]) d['artist' + i].resolve(); await tick(); await tick(); }
});

test('playExclusive: false keeps the old sharing', async () => {
  const q = createTaskQueue({ limit: 2, backgroundLimit: 1, playExclusive: false });
  const started = [];
  q.run(() => { started.push('play'); return new Promise(() => {}); }, { priority: 'play' });
  q.run(() => { started.push('n'); return new Promise(() => {}); }, { priority: 'normal' });
  await tick();
  assert.deepStrictEqual(started, ['play', 'n']);
});
