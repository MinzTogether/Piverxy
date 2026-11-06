// Phones keep no log file: writing one on every failed download only costs storage and battery. Errors and
// warnings from the in-app server go to the shareable error log (Settings → Share error log) instead of
// disappearing, so a failed download or import can still be diagnosed.
const describe = (message, err) => (err ? `${message}: ${(err && (err.message || err)) || err}` : message);
const toLog = (level, message) => {
  try { if (typeof window !== 'undefined' && window.MurielLog) window.MurielLog.add(level, `[server] ${message}`); } catch (e) {}
};
const log = (level, message) => { if (level === 'error' || level === 'warn') toLog(level, message); };
const error = (message, err) => toLog('error', describe(message, err));
const warn = (message, err) => toLog('warn', describe(message, err));
module.exports = { log, error, warn, info: () => {}, tail: () => [], LOG_DIR: '/data/logs' };
