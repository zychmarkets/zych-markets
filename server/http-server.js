'use strict';
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };
const send = (res, status, value) => { const body = JSON.stringify(value); res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' }); res.end(body); };
const error = (res, status, code, message) => send(res, status, { error: { code, message } });

async function body(req, limit = 32768) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > limit) { const failure = new Error('Payload too large'); failure.code = 'PAYLOAD_TOO_LARGE'; throw failure; } chunks.push(chunk); }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { const failure = new Error('Malformed JSON'); failure.code = 'MALFORMED_JSON'; throw failure; }
}

function createHttpServer({ runner, storage, notifier, config, logger, startedAt = Date.now() }) {
  let accepting = true;
  const server = http.createServer(async (req, res) => {
    res.setTimeout(15000);
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`), pathname = url.pathname;
      if (pathname.startsWith('/api/')) {
        if (!accepting) return error(res, 503, 'SHUTTING_DOWN', 'Server is shutting down.');
        if (pathname === '/api/health' && req.method === 'GET') return send(res, 200, { status: 'ok', uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000), storage: storage.status(), alerts: runner.diagnostics(), push: notifier.status?.() || { pushEnabled: false, pushSubscriptionsCount: 0 } });
        if (pathname === '/api/push/public-key' && req.method === 'GET') return config.vapidPublicKey ? send(res, 200, { publicKey: config.vapidPublicKey }) : error(res, 503, 'PUSH_NOT_CONFIGURED', 'Web Push is not configured.');
        if (pathname === '/api/push/status' && req.method === 'GET') return send(res, 200, notifier.status?.() || { pushEnabled: false, pushSubscriptionsCount: 0 });
        if (pathname === '/api/push/subscribe' && req.method === 'POST') { const record = await storage.savePushSubscription(await body(req)); if (!record) return error(res, 422, 'INVALID_SUBSCRIPTION', 'Invalid push subscription.'); logger.info('push_subscription_created', { endpointHost: new URL(record.endpoint).host }); return send(res, 201, { subscribed: true }); }
        if (pathname === '/api/push/unsubscribe' && req.method === 'DELETE') { const payload = await body(req), removed = typeof payload.endpoint === 'string' && await storage.removePushSubscription(payload.endpoint); if (removed) logger.info('push_subscription_removed', { endpointHost: new URL(payload.endpoint).host }); return send(res, 200, { subscribed: false, removed: Boolean(removed) }); }
        if (pathname === '/api/alerts' && req.method === 'GET') return send(res, 200, { alerts: runner.list() });
        if (pathname === '/api/alerts' && req.method === 'POST') { const result = await runner.create(await body(req)); return result.error ? error(res, result.error === 'DUPLICATE_ALERT' ? 409 : 422, result.error, result.message) : send(res, 201, result); }
        if (pathname === '/api/triggers' && req.method === 'GET') return send(res, 200, { triggers: runner.events() });
        const alertMatch = pathname.match(/^\/api\/alerts\/([^/]+)(?:\/(pause|resume))?$/);
        if (alertMatch && req.method === 'POST' && alertMatch[2]) { const result = alertMatch[2] === 'pause' ? await runner.pause(alertMatch[1]) : await runner.resume(alertMatch[1]); return result ? send(res, 200, { alert: result }) : error(res, 404, 'NOT_FOUND', 'Alert not found.'); }
        if (alertMatch && req.method === 'DELETE' && !alertMatch[2]) { const result = await runner.remove(alertMatch[1]); return result ? send(res, 204, {}) : error(res, 404, 'NOT_FOUND', 'Alert not found.'); }
        const triggerMatch = pathname.match(/^\/api\/triggers\/([^/]+)$/);
        if (triggerMatch && req.method === 'DELETE') { const result = await runner.removeEvent(triggerMatch[1]); return result ? send(res, 204, {}) : error(res, 404, 'NOT_FOUND', 'Trigger not found.'); }
        return error(res, 404, 'NOT_FOUND', 'Endpoint not found.');
      }
      if (!['GET', 'HEAD'].includes(req.method)) return error(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
      const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
      const file = path.resolve(config.root, relative);
      if (!file.startsWith(`${config.root}${path.sep}`) && file !== path.join(config.root, 'index.html')) return error(res, 403, 'FORBIDDEN', 'Forbidden.');
      const content = await fs.readFile(file); res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'content-length': content.length }); if (req.method === 'HEAD') res.end(); else res.end(content);
    } catch (failure) {
      if (failure.code === 'ENOENT') return error(res, 404, 'NOT_FOUND', 'File not found.');
      if (failure.code === 'PAYLOAD_TOO_LARGE') return error(res, 413, failure.code, failure.message);
      if (failure.code === 'MALFORMED_JSON') return error(res, 400, failure.code, failure.message);
      logger.error('request_error', { method: req.method, path: req.url, message: failure.message }); error(res, 500, 'INTERNAL_ERROR', 'Internal server error.');
    }
  });
  return { server, stopAccepting: () => { accepting = false; } };
}
module.exports = { createHttpServer };
