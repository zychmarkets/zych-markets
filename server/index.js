'use strict';
const { createServerApp } = require('./app.js');

let app;
async function shutdown(signal) {
  if (!app) return;
  app.logger.info('shutdown_requested', { signal });
  try { await app.stop(); process.exitCode = 0; } catch (error) { console.error(JSON.stringify({ level: 'error', event: 'shutdown_failed', message: error.message })); process.exitCode = 1; }
}
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', error => { console.error(JSON.stringify({ level: 'error', event: 'unhandled_rejection', message: error?.message || String(error) })); shutdown('unhandledRejection'); });
process.on('uncaughtException', error => { console.error(JSON.stringify({ level: 'error', event: 'uncaught_exception', message: error.message })); shutdown('uncaughtException'); });

createServerApp().then(instance => { app = instance; return app.listen(); }).catch(error => { console.error(JSON.stringify({ level: 'error', event: 'startup_failed', message: error.message })); process.exitCode = 1; });
