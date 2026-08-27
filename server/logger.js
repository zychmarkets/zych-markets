'use strict';
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
function createLogger(level = 'info', sink = console) {
  const threshold = LEVELS[level] || LEVELS.info;
  const write = (name, event, fields = {}) => {
    if (LEVELS[name] < threshold) return;
    const record = JSON.stringify({ timestamp: new Date().toISOString(), level: name, event, ...fields });
    (sink[name] || sink.log).call(sink, record);
  };
  return Object.freeze({ debug: (e, f) => write('debug', e, f), info: (e, f) => write('info', e, f), warn: (e, f) => write('warn', e, f), error: (e, f) => write('error', e, f) });
}
module.exports = { createLogger };
