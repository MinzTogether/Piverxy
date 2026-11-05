// Per-track speed / pitch / volume (issue #11) and speed & pitch presets. A song can keep its own speed, tape speed,
// pitch and volume gain ("For this track only" in Audio → Tempo); every other song follows the global values, and a
// song with its own settings keeps them when the global ones change. "Ignore per-track settings" plays everything
// with the global values without touching what is saved, so turning it off brings the songs' settings back.
// Saved per profile (localStorage, which profiles namespace). No DOM here: app.js wires it up,
// test/track-audio.test.js runs this.
(function () {
  const KEYS = ['speed', 'speedPitch', 'pitch', 'volume'];
  const DEFAULTS = { speed: 1.0, speedPitch: 1.0, pitch: 0, volume: 1.0 };
  const RANGE = { speed: [0.5, 2.0], speedPitch: [0.5, 2.0], pitch: [-12, 12], volume: [0, 2.0] };
  const round2 = (v) => Math.round(v * 100) / 100;

  function clampValue(key, v) {
    const n = Number(v);
    if (!Number.isFinite(n) || !RANGE[key]) return null;
    const [lo, hi] = RANGE[key];
    const c = Math.min(hi, Math.max(lo, n));
    return key === 'pitch' ? Math.round(c) : round2(c);
  }

  // the tempo values a saved entry (or anything shaped like one) holds, filled in from `base`
  function normalizeEntry(entry, base) {
    const b = base || DEFAULTS;
    const out = {};
    for (const k of KEYS) {
      const v = entry && entry[k] != null ? clampValue(k, entry[k]) : null;
      out[k] = v == null ? (b[k] != null ? b[k] : DEFAULTS[k]) : v;
    }
    return out;
  }

  // the settings to play with: the global settings, with the song's own tempo values over them unless ignored
  function effectiveSettings(globalSettings, entry, ignore) {
    const g = globalSettings || {};
    if (!entry || ignore) return { ...g };
    return { ...g, ...normalizeEntry(entry, normalizeEntry(g)) };
  }

  // the store with `values` saved for `key` (a new object; null values remove the song's entry)
  function setEntry(store, key, values, now) {
    const next = { ...(store || {}) };
    if (!key) return next;
    if (values == null) { delete next[key]; return next; }
    next[key] = { ...normalizeEntry(values), updatedAt: now || Date.now() };
    return next;
  }

  // drop entries that are not objects; keep at most `max` (the most recently changed)
  function cleanStore(store, max = 5000) {
    if (!store || typeof store !== 'object' || Array.isArray(store)) return {};
    const entries = Object.entries(store).filter(([k, v]) => k && v && typeof v === 'object');
    entries.sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0));
    const out = {};
    for (const [k, v] of entries.slice(0, max)) out[k] = { ...normalizeEntry(v), updatedAt: v.updatedAt || 0 };
    return out;
  }

  // speed & pitch presets: only these values, the rest of the sound stays as it is
  const BUILTIN_PRESETS = [
    { id: 'tp_normal', name: 'Normal', builtin: true, values: { speed: 1.0, speedPitch: 1.0, pitch: 0 } },
    { id: 'tp_slowed', name: 'Slowed', builtin: true, values: { speed: 1.0, speedPitch: 0.8, pitch: 0 } },
    { id: 'tp_daycore', name: 'Daycore', builtin: true, values: { speed: 1.0, speedPitch: 0.85, pitch: -1 } },
    { id: 'tp_sped', name: 'Sped up', builtin: true, values: { speed: 1.25, speedPitch: 1.0, pitch: 0 } },
    { id: 'tp_nightcore', name: 'Nightcore', builtin: true, values: { speed: 1.0, speedPitch: 1.25, pitch: 0 } },
    { id: 'tp_practice', name: 'Practice 0.75x', builtin: true, values: { speed: 0.75, speedPitch: 1.0, pitch: 0 } }
  ];
  const PRESET_KEYS = ['speed', 'speedPitch', 'pitch'];

  function presetValues(settings) {
    const n = normalizeEntry(settings);
    return { speed: n.speed, speedPitch: n.speedPitch, pitch: n.pitch };
  }

  function makePreset(name, settings, now) {
    const clean = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    if (!clean) return null;
    const t = now || Date.now();
    return { id: 'tpu_' + t.toString(36) + Math.floor(Math.random() * 1e4).toString(36), name: clean, values: presetValues(settings) };
  }

  function cleanPresets(list) {
    if (!Array.isArray(list)) return [];
    return list.filter(p => p && typeof p.id === 'string' && typeof p.name === 'string' && p.name.trim())
      .map(p => ({ id: p.id, name: p.name.trim().slice(0, 40), values: presetValues(p.values) }));
  }

  // does `settings` match the preset's values?
  function presetMatches(preset, settings) {
    if (!preset || !settings) return false;
    const s = normalizeEntry(settings);
    return PRESET_KEYS.every(k => Math.abs(s[k] - preset.values[k]) < 0.001);
  }

  const api = { KEYS, DEFAULTS, BUILTIN_PRESETS, clampValue, normalizeEntry, effectiveSettings, setEntry, cleanStore,
    presetValues, makePreset, cleanPresets, presetMatches };
  if (typeof module !== 'undefined') module.exports = api;
  else window.MurielTrackAudio = api;
})();
