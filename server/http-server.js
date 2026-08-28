'use strict';
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };
const send = (res, status, value) => { const body = JSON.stringify(value); res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' }); res.end(body); };
const error = (res, status, code, message) => send(res, status, { error: { code, message } });
const validRadarFilter=(key,value)=>({exchange:/^(binance|bybit|okx)$/,marketType:/^(spot|perpetual)$/,symbol:/^[A-Z0-9-]{1,30}$/,eventType:/^[A-Z0-9_-]{1,60}$/,timeframe:/^(1|3|5|15|30)m$|^(1|2|4|6|8|12)h$|^1d$|^1w$|^1M$/}[key].test(value));

async function body(req, limit = 32768) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > limit) { const failure = new Error('Payload too large'); failure.code = 'PAYLOAD_TOO_LARGE'; throw failure; } chunks.push(chunk); }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { const failure = new Error('Malformed JSON'); failure.code = 'MALFORMED_JSON'; throw failure; }
}

function createHttpServer({ runner, storage, notifier, universe = null, eventStore = null, eventPipeline = null, config, logger, startedAt = Date.now() }) {
  let accepting = true;
  const server = http.createServer(async (req, res) => {
    res.setTimeout(15000);
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`), pathname = url.pathname;
      if (pathname.startsWith('/api/')) {
        if (!accepting) return error(res, 503, 'SHUTTING_DOWN', 'Server is shutting down.');
        if (pathname === '/api/health' && req.method === 'GET') return send(res, 200, { status: 'ok', uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000), storage: storage.status(), alerts: runner.diagnostics(), push: notifier.status?.() || { pushEnabled: false, pushSubscriptionsCount: 0 } });
        if (pathname === '/api/radar/universe' && req.method === 'GET') {if(!universe)return error(res,503,'RADAR_UNAVAILABLE','Market Universe is not initialized.');const diagnostics=url.searchParams.get('diagnostics')==='true',includeExcluded=url.searchParams.get('includeExcluded')==='true';if(includeExcluded&&!diagnostics)return error(res,400,'DIAGNOSTICS_REQUIRED','Excluded markets require diagnostics=true.');const limit=Number(url.searchParams.get('excludedLimit')||100),offset=Number(url.searchParams.get('excludedOffset')||0);if(!Number.isInteger(limit)||limit<1||limit>200||!Number.isInteger(offset)||offset<0)return error(res,400,'INVALID_PAGINATION','excludedLimit must be 1..200 and excludedOffset must be non-negative.');return send(res,200,universe.getSnapshot({includeExcluded,excludedLimit:limit,excludedOffset:offset}))}
        if (pathname === '/api/radar/universe/health' && req.method === 'GET') return universe ? send(res,200,{...universe.health(),eventPipeline:eventPipeline?.diagnostics()||null}) : error(res,503,'RADAR_UNAVAILABLE','Market Universe is not initialized.');
        if (pathname === '/api/radar/events' && req.method === 'GET') {if(!eventStore)return error(res,503,'RADAR_EVENTS_UNAVAILABLE','Radar event store is unavailable.');const limit=Number(url.searchParams.get('limit')||50);if(!Number.isInteger(limit)||limit<1||limit>200)return error(res,400,'INVALID_LIMIT','limit must be an integer from 1 to 200.');const filters={limit};for(const key of ['exchange','marketType','symbol','eventType','timeframe'])if(url.searchParams.has(key)){const value=url.searchParams.get(key);if(!validRadarFilter(key,value))return error(res,400,'INVALID_FILTER',`Invalid ${key}.`);filters[key]=value}return send(res,200,{events:eventStore.listRecent(filters),limit})}
        const radarEventMatch=pathname.match(/^\/api\/radar\/events\/([A-Za-z0-9:_-]{1,120})$/);if(radarEventMatch&&req.method==='GET'){const radarEvent=eventStore?.getById(radarEventMatch[1]);return radarEvent?send(res,200,{event:radarEvent}):error(res,404,'EVENT_NOT_FOUND','Unified event not found.')}
        if (pathname === '/api/push/public-key' && req.method === 'GET') return config.vapidPublicKey ? send(res, 200, { publicKey: config.vapidPublicKey }) : error(res, 503, 'PUSH_NOT_CONFIGURED', 'Web Push is not configured.');
        if (pathname === '/api/push/status' && req.method === 'GET') return send(res, 200, notifier.status?.() || { pushEnabled: false, pushSubscriptionsCount: 0 });
        if (pathname === '/api/push/subscribe' && req.method === 'POST') { const record = await storage.savePushSubscription(await body(req)); if (!record) return error(res, 422, 'INVALID_SUBSCRIPTION', 'Invalid push subscription.'); logger.info('push_subscription_created', { endpointHost: new URL(record.endpoint).host }); return send(res, 201, { subscribed: true }); }
        if (pathname === '/api/push/unsubscribe' && req.method === 'DELETE') { const payload = await body(req), removed = typeof payload.endpoint === 'string' && await storage.removePushSubscription(payload.endpoint); if (removed) logger.info('push_subscription_removed', { endpointHost: new URL(payload.endpoint).host }); return send(res, 200, { subscribed: false, removed: Boolean(removed) }); }
        if (pathname === '/api/alerts' && req.method === 'GET') return send(res, 200, { alerts: runner.list() });
        if (pathname === '/api/alerts' && req.method === 'POST') { const result = await runner.create(await body(req)); return result.error ? error(res, result.error === 'DUPLICATE_ALERT' ? 409 : 422, result.error, result.message) : send(res, 201, result); }
        if (pathname === '/api/triggers' && req.method === 'GET') return send(res, 200, { triggers: runner.events() });
        const priceMatch = pathname.match(/^\/api\/alerts\/([^/]+)\/price$/);
        if (priceMatch && req.method === 'PATCH') { const result = await runner.updatePrice(priceMatch[1], (await body(req)).value); if (result.error === 'NOT_FOUND') return error(res, 404, result.error, result.message); return result.error ? error(res, result.error === 'DUPLICATE_ALERT' ? 409 : 422, result.error, result.message) : send(res, 200, result); }
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
