const test = require('node:test');
const assert = require('node:assert');
const TA = require('../track-audio');

const G = { speed: 1.0, speedPitch: 1.0, pitch: 0, volume: 1.0, reverb: 30, echo: 0 };

test('tracks without settings follow the global values', () => {
  assert.deepStrictEqual(TA.effectiveSettings(G, null, false), G);
  const g2 = { ...G, speed: 1.5 };
  assert.strictEqual(TA.effectiveSettings(g2, undefined, false).speed, 1.5);
});

test('a track keeps its own values when the global ones change', () => {
  const store = TA.setEntry({}, 'yt:abc', { speed: 1, speedPitch: 0.8, pitch: -2, volume: 1.3 }, 5);
  const e = store['yt:abc'];
  const g2 = { ...G, speed: 1.75, volume: 0.5 };
  const eff = TA.effectiveSettings(g2, e, false);
  assert.strictEqual(eff.speedPitch, 0.8);
  assert.strictEqual(eff.pitch, -2);
  assert.strictEqual(eff.volume, 1.3);
  assert.strictEqual(eff.speed, 1);
  assert.strictEqual(eff.reverb, 30, 'other effects stay global');
});

test('ignore switch uses global only and leaves the store untouched', () => {
  const store = TA.setEntry({}, 'k', { speed: 1.4 }, 1);
  const before = JSON.stringify(store);
  assert.strictEqual(TA.effectiveSettings(G, store.k, true).speed, 1.0);
  assert.strictEqual(JSON.stringify(store), before);
  assert.strictEqual(TA.effectiveSettings(G, store.k, false).speed, 1.4);
});

test('setEntry with null removes, values are clamped', () => {
  let s = TA.setEntry({}, 'a', { speed: 9, pitch: 3.6, volume: -1 }, 1);
  assert.deepStrictEqual({ ...s.a, updatedAt: 0 }, { speed: 2, speedPitch: 1, pitch: 4, volume: 0, updatedAt: 0 });
  s = TA.setEntry(s, 'a', null);
  assert.deepStrictEqual(s, {});
  assert.deepStrictEqual(TA.setEntry({ x: 1 }, '', { speed: 1 }), { x: 1 });
});

test('cleanStore drops junk and keeps the newest', () => {
  const s = TA.cleanStore({ a: { speed: 1.2, updatedAt: 1 }, b: 'bad', c: { speed: 0.9, updatedAt: 3 }, d: { updatedAt: 2 } }, 2);
  assert.deepStrictEqual(Object.keys(s).sort(), ['c', 'd']);
  assert.deepStrictEqual(TA.cleanStore([1, 2]), {});
  assert.deepStrictEqual(TA.cleanStore(null), {});
});

test('speed/pitch presets', () => {
  assert.ok(TA.BUILTIN_PRESETS.length >= 4);
  const night = TA.BUILTIN_PRESETS.find(p => p.id === 'tp_nightcore');
  assert.ok(TA.presetMatches(night, { speed: 1, speedPitch: 1.25, pitch: 0, volume: 0.4 }));
  assert.ok(!TA.presetMatches(night, G));
  const p = TA.makePreset('  My   slow ', { speed: 0.9, speedPitch: 1, pitch: 2, volume: 2 }, 100);
  assert.strictEqual(p.name, 'My slow');
  assert.deepStrictEqual(p.values, { speed: 0.9, speedPitch: 1, pitch: 2 });
  assert.strictEqual(TA.makePreset('   ', G), null);
  assert.deepStrictEqual(TA.cleanPresets([p, null, { id: 'x' }, { id: 'y', name: 'Y', values: { speed: 5 } }]).map(x => x.values.speed), [0.9, 2]);
});
