'use strict';
const { createServerApp } = require('./app.js');
const { createLogger, sanitizeMessage } = require('./logger.js');

let app, shuttingDown, fallbackLogger=createLogger(process.env.ZYCH_LOG_LEVEL||'info');
async function shutdown(signal) {
  if(shuttingDown)return shuttingDown;
  if (!app) return;
  app.logger.info('shutdown_requested', { signal });
  shuttingDown=(async()=>{try { await app.stop(signal); process.exitCode = 0; } catch (error) { app.logger.error('shutdown_failed',{name:error.name,code:error.code,message:sanitizeMessage(error.message)}); process.exitCode = 1; }})();return shuttingDown;
}
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', error => { (app?.logger||fallbackLogger).error('unhandled_rejection',{name:error?.name,code:error?.code,message:sanitizeMessage(error?.message||error)}); shutdown('unhandledRejection'); });
process.on('uncaughtException', error => { (app?.logger||fallbackLogger).error('uncaught_exception',{name:error.name,code:error.code,message:sanitizeMessage(error.message)}); shutdown('uncaughtException'); });

createServerApp().then(instance => { app = instance; return app.listen(); }).catch(error => { fallbackLogger.error('startup_failed',{name:error.name,code:error.code,reasonCodes:error.reasonCodes,message:sanitizeMessage(error.message)}); process.exitCode = 1; });
