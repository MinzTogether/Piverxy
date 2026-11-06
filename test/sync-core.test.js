'use strict';

// sync-core.js: how two devices' libraries, histories and settings come together.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const C = require('../sync-core.js');

const byId = (x) => x && x.id;
const side = (items, prev, now, base) => ({ items, meta: C.stampList(prev, items, byId, now, base) });

test('sha256 matches Node', () => {
  for (const s of ['', 'abc', 'muriel:' + 'x'.repeat(1000), 'ünïcødé ✓']) {
    assert.strictEqual(C.sha256(s), crypto.createHash('sha256').update(s, 'utf8').digest('hex'));
  }
});

test('first link: both libraries are kept, nothing is lost', () => {
  const a = side([{ id: 'p1', name: 'Gym' }, { id: 'p2', name: 'Chill' }], null, 1000);
  const b = side([{ id: 'p3', name: 'Road' }], null, 2000);
  const onA = C.mergeList(a, b, byId);
  const onB = C.mergeList(b, a, byId);
  assert.deepStrictEqual(onA.items.map(byId), ['p1', 'p2', 'p3']);
  assert.deepStrictEqual(onB.items.map(byId).sort(), ['p1', 'p2', 'p3']);
  assert.strictEqual(onA.changed, true);
});

test('an edit made later wins over the older copy', () => {
  const base = side([{ id: 'p1', name: 'Gym' }], null, 1000);
  const edited = { items: [{ id: 'p1', name: 'Gym 2' }], meta: C.stampList(base.meta, [{ id: 'p1', name: 'Gym 2' }], byId, 5000) };
  const r = C.mergeList(base, edited, byId);
  assert.strictEqual(r.items[0].name, 'Gym 2');
  // and the other way round the device keeps its own newer edit
  assert.strictEqual(C.mergeList(edited, base, byId).changed, false);
});

test('a removal spreads, and a removed item is not brought back by a device that still has it', () => {
  const both = side([{ id: 'p1' }, { id: 'p2' }], null, 1000);
  const afterDelete = { items: [{ id: 'p1' }], meta: C.stampList(both.meta, [{ id: 'p1' }], byId, 9000) };
  assert.ok(C.isGone(afterDelete.meta.p2));
  const onOther = C.mergeList(both, afterDelete, byId);
  assert.deepStrictEqual(onOther.items.map(byId), ['p1']);
  const back = C.mergeList(afterDelete, both, byId);
  assert.deepStrictEqual(back.items.map(byId), ['p1']);
  assert.strictEqual(back.changed, false);
});

test('adding it again after the removal brings it back everywhere', () => {
  const both = side([{ id: 'p1' }, { id: 'p2' }], null, 1000);
  const deleted = { items: [{ id: 'p1' }], meta: C.stampList(both.meta, [{ id: 'p1' }], byId, 9000) };
  const readded = { items: [{ id: 'p1' }, { id: 'p2', v: 2 }], meta: C.stampList(deleted.meta, [{ id: 'p1' }, { id: 'p2', v: 2 }], byId, 12000) };
  assert.deepStrictEqual(C.mergeList(deleted, readded, byId).items.map(byId), ['p1', 'p2']);
});

test('data from before linking never overrides a real edit', () => {
  const old = side([{ id: 'p1', name: 'old copy' }], null, 99999); // first look: dated long ago
  const fresh = { items: [{ id: 'p1', name: 'renamed' }], meta: { p1: [5000, C.fingerprint({ id: 'p1', name: 'renamed' })] } };
  assert.strictEqual(C.mergeList(old, fresh, byId).items[0].name, 'renamed');
});

test('ties pick the same winner on both devices', () => {
  const a = { items: [{ id: 'x', v: 'a' }], meta: { x: [5, C.fingerprint({ id: 'x', v: 'a' })] } };
  const b = { items: [{ id: 'x', v: 'b' }], meta: { x: [5, C.fingerprint({ id: 'x', v: 'b' })] } };
  assert.deepStrictEqual(C.mergeList(a, b, byId).items, C.mergeList(b, a, byId).items);
});

test('history stays sorted and capped', () => {
  const key = (t) => `${t.id}@${t.playedAt}`;
  const mk = (n, at) => Array.from({ length: n }, (_, i) => ({ id: `t${at + i}`, playedAt: at + i }));
  const a = { items: mk(80, 0), meta: C.stampList(null, mk(80, 0), key, 1) };
  const b = { items: mk(80, 1000), meta: C.stampList(null, mk(80, 1000), key, 1) };
  const r = C.mergeList(a, b, key, { sort: (x, y) => y.playedAt - x.playedAt, cap: 100 });
  assert.strictEqual(r.items.length, 100);
  assert.strictEqual(r.items[0].playedAt, 1079);
  assert.ok(r.items.every((t, i) => i === 0 || r.items[i - 1].playedAt >= t.playedAt));
});

test('settings: the newest value of each key wins', () => {
  const a = { values: { theme: 'dark', font: 'google' }, meta: C.stampMap(null, { theme: 'dark', font: 'google' }, 0) };
  const bVals = { theme: 'light', font: 'google' };
  const b = { values: bVals, meta: C.stampMap(a.meta, bVals, 7000) };
  const r = C.mergeMap(a, b);
  assert.deepStrictEqual(r.values, { theme: 'light', font: 'google' });
  assert.deepStrictEqual(r.changedKeys, ['theme']);
  assert.deepStrictEqual(C.mergeMap(b, a).changedKeys, []);
});

test('per-device records keep the newest copy and never take over this device', () => {
  const mine = { me: { t: 5, name: 'Phone' }, pc: { t: 10, name: 'PC' } };
  const theirs = { me: { t: 99, name: 'fake' }, pc: { t: 20, name: 'PC (new)' }, mac: { t: 1, name: 'Mac' } };
  const r = C.mergeById(mine, theirs, 'me');
  assert.strictEqual(r.value.me.name, 'Phone');
  assert.strictEqual(r.value.pc.name, 'PC (new)');
  assert.ok(r.value.mac);
});

test('old removals are forgotten, recent ones kept', () => {
  const m = { a: [100, 'f'], b: [100, '', 1], c: [9000, '', 1] };
  assert.deepStrictEqual(Object.keys(C.pruneMeta(m, 10000, 5000)).sort(), ['a', 'c']);
});
