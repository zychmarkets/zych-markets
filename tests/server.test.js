'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const core = require('../js/alerts/alert-core.js');
const { JsonStorageAdapter } = require('../server/storage/json-storage.js');
const { ServerAlertRunner } = require('../server/alert-runner.js');
const { createServerApp } = require('../server/app.js');
const { BinanceMarketTransport } = require('../server/transports/binance-market-transport.js');

const silent = { debug() {}, info() {}, warn() {}, error() {} };
class FakeTransport {
  constructor() { this.starts = 0; this.stops = 0; this.alerts = []; this.handlers = {}; this.connections = 0; }
  async start(alerts, handlers) { this.starts += 1; this.alerts = alerts; this.handlers = handlers; this.connections = alerts.length ? 1 : 0; }
  async stop() { this.stops += 1; this.connections = 0; }
  emit(event) { return this.handlers.onEvent?.(event); }
  diagnostics() { return { status: this.connections ? 'live' : 'idle', connections: this.connections, subscriptions: new Set(this.alerts.map(a => `${a.symbol}:${a.type}`)).size }; }
}
const definition = (condition = { type: 'price', operator: 'above', value: 100 }, mode = 'once', asset = 'BTC') => ({ marketId: `binance:${asset}USDT`, exchange: 'binance', symbol: `${asset}USDT`, baseAsset: asset, asset, quoteAsset: 'USDT', condition, mode });
const ticker = (price, asset = 'BTC') => ({ exchange: 'binance', symbol: `${asset}USDT`, baseAsset: asset, quoteAsset: 'USDT', eventType: 'ticker', price, timestamp: Date.now() });
const candle = values => ({ exchange: 'binance', symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', eventType: 'candle', interval: '1h', price: values.price, open: values.open ?? 100, high: 110, low: 90, volume: values.volume ?? 100, averageVolume: values.averageVolume ?? 50, timestamp: Date.now() });

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zych-server-'));
  const storage = new JsonStorageAdapter({ directory, core, logger: silent, historyLimit: 500 }); await storage.init();
  const transport = new FakeTransport(), notifications = [];
  const runner = new ServerAlertRunner({ core, storage, transport, notifier: { notify: event => notifications.push(event) }, logger: silent }); await runner.start();
  return { directory, storage, transport, notifications, runner, async close() { await runner.stop(); await fs.rm(directory, { recursive: true, force: true }); } };
}

test('durable storage survives restart, deduplicates records and recovers corruption', async () => {
  const f = await fixture(); const created = await f.runner.create(definition()); await f.runner.pause(created.alert.id); await f.runner.stop();
  const reopened = new JsonStorageAdapter({ directory: f.directory, core, logger: silent }); await reopened.init(); assert.equal(reopened.loadAlerts()[0].status, 'paused');
  const raw = JSON.parse(await fs.readFile(reopened.file, 'utf8')); raw.alerts.push(raw.alerts[0]); await fs.writeFile(reopened.file, JSON.stringify(raw)); const duplicate = new JsonStorageAdapter({ directory: f.directory, core, logger: silent }); await duplicate.init(); assert.equal(duplicate.loadAlerts().length, 1);
  await fs.writeFile(duplicate.file, '{broken'); const recovered = new JsonStorageAdapter({ directory: f.directory, core, logger: silent }); await recovered.init(); assert.deepEqual(recovered.loadAlerts(), []); await fs.rm(f.directory, { recursive: true, force: true });
});

test('runner supports lifecycle, once, recurring, re-arm and all conditions', async () => {
  const f = await fixture();
  const once = await f.runner.create(definition()); await f.runner.handle(ticker(101)); assert.equal(f.runner.list().find(a => a.id === once.alert.id).status, 'triggered');
  const recurring = await f.runner.create(definition({ type: 'price', operator: 'below', value: 100 }, 'recurring', 'ETH')); await f.runner.handle(ticker(99, 'ETH')); await f.runner.handle(ticker(98, 'ETH')); assert.equal(f.runner.list().find(a => a.id === recurring.alert.id).triggerCount, 1); await f.runner.handle(ticker(101, 'ETH')); f.runner.alerts.find(a => a.id === recurring.alert.id).lastTriggeredAt = 0; await f.runner.handle(ticker(99, 'ETH')); assert.equal(f.runner.list().find(a => a.id === recurring.alert.id).triggerCount, 2);
  await f.runner.create(definition({ type: 'movement', direction: 'up', percent: 5, window: '1h' })); await f.runner.handle(candle({ price: 106 }));
  await f.runner.create(definition({ type: 'movement', direction: 'down', percent: 5, window: '1h' })); await f.runner.handle(candle({ price: 94 }));
  await f.runner.create(definition({ type: 'volume', multiplier: 2, timeframe: '1h' })); await f.runner.handle(candle({ price: 100, volume: 201, averageVolume: 100 }));
  assert.equal(f.notifications.length, 6); await f.close();
});

test('100 alerts across BTC ETH SOL use one transport and unique subscriptions', async () => {
  const f = await fixture();
  for (let index = 0; index < 100; index += 1) { const asset = ['BTC', 'ETH', 'SOL'][index % 3]; await f.runner.create(definition({ type: 'price', operator: 'above', value: 100 + index }, 'once', asset)); }
  const diagnostics = f.runner.diagnostics(); assert.equal(diagnostics.activeAlerts, 100); assert.equal(diagnostics.activeMarkets, 3); assert.equal(diagnostics.connections, 1); assert.equal(diagnostics.subscriptions, 3); await f.close();
});

test('HTTP API health, CRUD, validation and malformed payload', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zych-api-')), transport = new FakeTransport();
  const config = { host: '127.0.0.1', port: 0, dataDir: directory, historyLimit: 500, logLevel: 'error', root: path.resolve(__dirname, '..'), binanceRestBase: '', binanceWsBase: '' };
  const app = await createServerApp({ config, logger: silent, transport }); const address = await app.listen(), base = `http://127.0.0.1:${address.port}/api`;
  let response = await fetch(`${base}/health`); assert.equal(response.status, 200); assert.equal((await response.json()).status, 'ok');
  response = await fetch(`${base}/alerts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(definition()) }); assert.equal(response.status, 201); const id = (await response.json()).alert.id;
  response = await fetch(`${base}/alerts`); assert.equal((await response.json()).alerts.length, 1);
  assert.equal((await fetch(`${base}/alerts/${id}/pause`, { method: 'POST' })).status, 200); assert.equal((await fetch(`${base}/alerts/${id}/resume`, { method: 'POST' })).status, 200);
  assert.equal((await fetch(`${base}/alerts`, { method: 'POST', body: '{}' })).status, 422); assert.equal((await fetch(`${base}/alerts`, { method: 'POST', body: '{' })).status, 400);
  assert.equal((await fetch(`${base}/push/public-key`)).status, 503);
  const pushRecord = { endpoint: 'https://push.example/device', keys: { p256dh: 'p'.repeat(65), auth: 'a'.repeat(16) } };
  assert.equal((await fetch(`${base}/push/subscribe`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(pushRecord) })).status, 201);
  assert.equal((await fetch(`${base}/push/subscribe`, { method: 'POST', body: '{}' })).status, 422);
  assert.equal((await fetch(`${base}/push/unsubscribe`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: pushRecord.endpoint }) })).status, 200);
  assert.equal((await fetch(`${base}/alerts/${id}`, { method: 'DELETE' })).status, 204); await app.stop(); await fs.rm(directory, { recursive: true, force: true });
});

test('Binance transport reconnects and resubscribes without duplicate streams', async () => {
  const sockets = [];
  class FakeSocket {
    constructor() { this.readyState = 0; this.listeners = {}; this.sent = []; sockets.push(this); }
    addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }
    emit(name, value = {}) { this.listeners[name]?.forEach(fn => fn(value)); }
    send(value) { this.sent.push(JSON.parse(value)); }
    close() { this.readyState = 3; }
  }
  const transport = new BinanceMarketTransport({ restBase: '', wsBase: 'ws://test', logger: silent, WebSocketImpl: FakeSocket, fetchImpl: async () => ({ ok: true, json: async () => [] }), reconnectBaseMs: 1, reconnectMaxMs: 1 });
  const alerts = [core.createAlert(definition(), { id: 'a', now: 1 }), core.createAlert(definition({ type: 'price', operator: 'above', value: 200 }), { id: 'b', now: 1 })];
  await transport.start(alerts, {}); sockets[0].emit('open'); assert.deepEqual(sockets[0].sent[0].params, ['btcusdt@ticker']); sockets[0].emit('close'); await new Promise(resolve => setTimeout(resolve, 5)); sockets[1].emit('open'); assert.deepEqual(sockets[1].sent[0].params, ['btcusdt@ticker']); await transport.stop(); assert.equal(transport.diagnostics().connections, 0);
});
