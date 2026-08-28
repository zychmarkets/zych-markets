'use strict';
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const SENSITIVE = /(password|secret|token|authorization|cookie|api[_-]?key|private[_-]?key|vapid.*private)/i;
const sanitizeMessage = value => String(value || 'Unknown error').replace(/([?&](?:token|secret|password|api[_-]?key|authorization)=)[^&\s]+/gi,'$1[REDACTED]').replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]+/gi,'$1[REDACTED]');
function redact(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map(item => redact(item, seen));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SENSITIVE.test(key) ? '[REDACTED]' : redact(item, seen)]));
}
function createLogger(level = 'info', sink = console) {
  const threshold = LEVELS[level] || LEVELS.info;
  const write = (name, event, fields = {}) => {
    if (LEVELS[name] < threshold) return;
    const record = JSON.stringify(redact({ timestamp: new Date().toISOString(), level: name, event, ...fields }));
    (sink[name] || sink.log).call(sink, record);
  };
  return Object.freeze({ debug: (e, f) => write('debug', e, f), info: (e, f) => write('info', e, f), warn: (e, f) => write('warn', e, f), error: (e, f) => write('error', e, f) });
}
module.exports = { createLogger, redact, sanitizeMessage };
