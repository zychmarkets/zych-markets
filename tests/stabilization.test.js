'use strict';
const assert = require('node:assert/strict');
global.window = global;
class MemoryStorage { constructor() { this.values = new Map(); } getItem(key) { return this.values.has(key) ? this.values.get(key) : null; } setItem(key, value) { this.values.set(key, String(value)); } }
global.localStorage = new MemoryStorage();
const core = require('../js/alerts/alert-core.js');
require('../js/alerts/alert-storage.js');
const AlertEngine = require('../js/alerts/alert-engine.js');
require('../js/alerts/binance-browser-transport.js');
require('../js/services/chart-history.js');

const baseDefinition = (overrides = {}) => ({ marketId: 'binance:BTCUSDT', exchange: 'binance', symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', condition: { type: 'price', operator: 'above', value: 100 }, mode: 'once', ...overrides });
const baseAlert = (id = 'a1', overrides = {}) => core.createAlert(baseDefinition(overrides), { id, now: 1 });

async function run() {
  const storage = new ZychAlerts.BrowserLocalStorageAdapter({ core });
  localStorage.setItem(ZychAlerts.ALERTS_KEY, '{broken'); assert.deepEqual(storage.loadAlerts(), []);
  const valid = baseAlert(), legacy = { ...valid, version: undefined, baseAsset: undefined, asset: 'BTC' };
  localStorage.setItem(ZychAlerts.ALERTS_KEY, JSON.stringify([legacy, legacy, { id: 'bad' }]));
  const loaded = storage.loadAlerts(); assert.equal(loaded.length, 1); assert.equal(loaded[0].version, core.ALERT_SCHEMA_VERSION); assert.equal(loaded[0].baseAsset, 'BTC');
  const events = Array.from({ length: 550 }, (_, index) => ({ id: `e${index}`, alertId: 'a1', marketId: valid.marketId, asset: 'BTC', triggeredAt: index + 1, condition: valid.condition }));
  storage.saveHistory(events); assert.equal(storage.loadTriggerHistory().length, ZychAlerts.MAX_HISTORY);

  class FakeTransport {
    constructor() { this.starts = 0; this.stops = 0; this.alerts = []; this.handlers = null; }
    start(alerts, handlers) { this.starts += 1; this.alerts = alerts; this.handlers = handlers; handlers.onStatus('LIVE'); return Promise.resolve(); }
    stop() { this.stops += 1; }
    emit(event) { this.handlers?.onEvent(event); }
  }
  const many = Array.from({ length: 100 }, (_, index) => baseAlert(`p${index}`, { marketId: `binance:A${index}USDT`, symbol: `A${index}USDT`, baseAsset: `A${index}` }));
  const manyStorage = { maxHistory: 500, loadAlerts: () => many, loadTriggerHistory: () => [], saveAlerts() {}, saveHistory() {} }, sharedTransport = new FakeTransport();
  const scaled = new AlertEngine({ storage: manyStorage, core, transport: sharedTransport }); scaled.start();
  assert.equal(sharedTransport.starts, 1); assert.equal(sharedTransport.alerts.length, 100); scaled.stop();

  let sockets = 0;
  class FakeSocket { static CLOSING = 2; constructor() { this.readyState = 0; this.listeners = {}; sockets += 1; } addEventListener(type, handler) { this.listeners[type] = handler; } send() {} close() { this.readyState = 3; this.listeners.close?.(); sockets -= 1; } }
  global.WebSocket = FakeSocket;
  global.fetch = (_url, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
  const browserTransport = new ZychAlerts.BinanceBrowserTransport();
  const pendingStart = browserTransport.start([baseAlert('v1', { condition: { type: 'volume', multiplier: 2, timeframe: '15m' } })], { onStatus() {}, onEvent() {} }); browserTransport.stop(); await pendingStart;
  assert.equal(sockets, 0);

  const recurringStorage = { maxHistory: 500, loadAlerts: () => [baseAlert('r1', { mode: 'recurring' })], loadTriggerHistory: () => [], saveAlerts() {}, saveHistory() {} }, recurringTransport = new FakeTransport(); let notifications = 0;
  const recurring = new AlertEngine({ storage: recurringStorage, core, transport: recurringTransport, notifier: { notify: () => { notifications += 1; } }, idFactory: prefix => `${prefix}-${notifications}` }); recurring.start();
  const tick = price => ({ exchange: 'binance', symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', eventType: 'ticker', price, timestamp: Date.now() });
  recurringTransport.emit(tick(101)); recurringTransport.emit(tick(102)); assert.equal(notifications, 1); recurringTransport.emit(tick(99)); recurring.alerts[0].lastTriggeredAt = 0; recurringTransport.emit(tick(101)); assert.equal(notifications, 2);

  let historyRequest = 0;
  global.fetch = (_url, { signal }) => { historyRequest += 1; if (historyRequest === 1) return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })); return Promise.resolve({ ok: true, json: async () => [[1000, '1', '2', '.5', '1.5', '10'], [2000, '1.5', '2.5', '1', '2', '12']] }); };
  const history = new ZychChartHistory.ChartHistoryService(), market = { id: 'binance:BTCUSDT', symbol: 'BTCUSDT' }, oldRequest = new AbortController(), newRequest = new AbortController();
  const first = history.initial(market, '1w', oldRequest.signal); oldRequest.abort(); const second = history.initial(market, '1w', newRequest.signal); await Promise.allSettled([first]); assert.equal((await second).data.length, 2);
  console.log('stabilization tests: PASS');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
