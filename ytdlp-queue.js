// One queue for every yt-dlp run (#16). Each yt-dlp call for a YouTube song can start a JavaScript
// runtime (deno/node) that solves YouTube's player challenge at full CPU, so the app must never run
// many of them at once or repeat them needlessly:
// - at most `limit` runs at a time (background work: at most `backgroundLimit`), the rest wait in line;
//   a song the listener pressed play on goes first and always gets a slot of its own; while one is waiting
//   or running nothing else starts, so its lookup has the CPU to itself (#17: on a 6-core PC a lookup
//   that takes 4 s alone took far longer next to search, recommendation and caching runs)
// - two callers asking for the same thing share one run
// - a result can be remembered for a while (`cacheMs`)
// - a background run that failed is not tried again until its backoff has passed (it doubles per failure)

const PRIORITY = { play: 0, normal: 1, background: 2 };

function createTaskQueue({ limit = 2, backgroundLimit = 1, now = () => Date.now(), backoffBaseMs = 60 * 1000, backoffMaxMs = 30 * 60 * 1000, maxEntries = 500, playExclusive = true } = {}) {
  const pending = [];
  const inflight = new Map(); // key -> job
  const cache = new Map(); // key -> { value, expires }
  const failures = new Map(); // key -> { count, until }
  const running = { total: 0, play: 0, background: 0 };
  let seq = 0;

  const trim = (map) => { while (map.size > maxEntries) map.delete(map.keys().next().value); };

  function canStart(job, playWaiting) {
    if (job.priority === 'play') return running.total < limit || running.play === 0;
    if (playExclusive && (running.play > 0 || playWaiting)) return false;
    if (running.total >= limit) return false;
    return job.priority !== 'background' || running.background < backgroundLimit;
  }

  function pump() {
    pending.sort((a, b) => (PRIORITY[a.priority] - PRIORITY[b.priority]) || (a.seq - b.seq));
    for (let i = 0; i < pending.length;) {
      const job = pending[i];
      const playWaiting = pending.some((p) => p.priority === 'play');
      if (!canStart(job, playWaiting)) { i++; continue; }
      pending.splice(i, 1);
      start(job);
    }
  }

  function start(job) {
    const p = job.priority;
    running.total++;
    if (p === 'play') running.play++;
    if (p === 'background') running.background++;
    let result;
    try { result = Promise.resolve(job.task({ priority: p })); } catch (e) { result = Promise.reject(e); }
    // the slot and the in-flight entry are released before callers hear back, so whatever they do next
    // (ask again, queue more) sees the queue as it is now
    const finish = () => {
      running.total--;
      if (p === 'play') running.play--;
      if (p === 'background') running.background--;
      if (job.key && inflight.get(job.key) === job) inflight.delete(job.key);
    };
    result.then((value) => {
      finish();
      if (job.key) failures.delete(job.key);
      if (job.key && job.cacheMs > 0) { cache.set(job.key, { value, expires: now() + job.cacheMs }); trim(cache); }
      job.resolve(value);
      pump();
    }, (err) => {
      finish();
      if (job.key) {
        const count = ((failures.get(job.key) || {}).count || 0) + 1;
        failures.set(job.key, { count, until: now() + Math.min(backoffMaxMs, backoffBaseMs * 2 ** (count - 1)) });
        trim(failures);
      }
      job.reject(err);
      pump();
    });
  }

  // task: () => Promise. opts: { key, priority: 'play' | 'normal' | 'background', cacheMs, noRetry }
  function run(task, opts = {}) {
    const key = opts.key || null;
    const priority = PRIORITY[opts.priority] !== undefined ? opts.priority : 'normal';
    if (key) {
      const hit = cache.get(key);
      if (hit && hit.expires > now()) return Promise.resolve(hit.value);
      if (hit) cache.delete(key);
      const same = inflight.get(key);
      if (same) {
        // still waiting in line: someone who needs it sooner moves it up
        if (pending.includes(same) && PRIORITY[priority] < PRIORITY[same.priority]) { same.priority = priority; pump(); }
        // a song the listener pressed play on never inherits a failure from someone else's run (a next-song
        // prefetch, a cache download, another caller): it gets one fresh run of its own, as Retry would
        if (priority === 'play' && !opts.noRetry) {
          return same.promise.catch(() => run(task, { ...opts, noRetry: true }));
        }
        return same.promise;
      }
      if (priority === 'background' && backingOff(key)) {
        return Promise.reject(Object.assign(new Error('yt-dlp: backing off after a failure'), { code: 'BACKOFF' }));
      }
    }
    const job = { key, priority, task, cacheMs: Number(opts.cacheMs) || 0, seq: seq++ };
    job.promise = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
    if (key) inflight.set(key, job);
    pending.push(job);
    pump();
    return job.promise;
  }

  function backingOff(key) {
    const f = key && failures.get(key);
    return !!(f && f.until > now());
  }

  function forget(key) { cache.delete(key); failures.delete(key); }

  function stats() { return { running: { ...running }, pending: pending.length, cached: cache.size, failing: failures.size }; }

  return { run, backingOff, forget, stats };
}

// yt-dlp (and the JS runtime it starts, which inherits it) runs below the app and the desktop
function lowerPriority(pid, os = require('os')) {
  if (!pid) return false;
  try {
    const level = process.platform === 'win32' ? os.constants.priority.PRIORITY_BELOW_NORMAL : 10;
    os.setPriority(pid, level);
    return true;
  } catch (e) {
    return false;
  }
}

module.exports = { createTaskQueue, lowerPriority, PRIORITY };
