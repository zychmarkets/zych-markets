'use strict';
const assert = require('node:assert/strict');
global.window = global;

class MemoryStorage {
  constructor() { this.values = new Map(); }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}
global.localStorage = new MemoryStorage();
require('../js/alerts/alert-storage.js');
require('../js/alerts/alert-evaluator.js');
require('../js/alerts/alert-engine.js');
require('../js/services/chart-history.js');

const baseAlert = (overrides = {}) => ({ id: 'a1', type: 'price', marketId: 'binance:BTCUSDT', asset: 'BTC', symbol: 'BTCUSDT', exchange: 'binance', quoteAsset: 'USDT', timeframe: null, condition: { type: 'price', operator: 'above', value: 100 }, mode: 'once', createdAt: 1, status: 'active', lastTriggeredAt: null, triggerCount: 0, armed: true, ...overrides });

async function run() {
  assert.equal(ZychAlerts.evaluateAlert(baseAlert(), { price: 101 }).met, true);
  assert.equal(ZychAlerts.evaluateAlert(baseAlert({ condition: { type: 'price', operator: 'below', value: 100 } }), { price: 99 }).met, true);
  assert.equal(ZychAlerts.evaluateAlert(baseAlert({ condition: { type: 'movement', direction: 'up', percent: 5, window: '1h' } }), { price: 105, referencePrice: 100 }).met, true);
  assert.equal(ZychAlerts.evaluateAlert(baseAlert({ condition: { type: 'volume', multiplier: 2, timeframe: '15m' } }), { currentVolume: 201, averageVolume: 100 }).met, true);

  const storage = new ZychAlerts.AlertStorage();
  localStorage.setItem(ZychAlerts.ALERTS_KEY, '{broken');
  assert.deepEqual(storage.loadAlerts(), []);
  const valid = baseAlert(), duplicate = { ...valid };
  localStorage.setItem(ZychAlerts.ALERTS_KEY, JSON.stringify([valid, duplicate, { id: 'bad' }]));
  assert.equal(storage.loadAlerts().length, 1);
  const events = Array.from({ length: 550 }, (_, index) => ({ id: `e${index}`, alertId: 'a1', marketId: valid.marketId, asset: 'BTC', triggeredAt: index + 1, condition: valid.condition }));
  storage.saveHistory(events); assert.equal(storage.loadHistory().length, ZychAlerts.MAX_HISTORY);

  let sockets = 0;
  class FakeSocket {
    static CLOSING = 2;
    constructor(url) { this.url = url; this.readyState = 0; this.listeners = {}; this.sent = []; sockets += 1; }
    addEventListener(type, handler) { this.listeners[type] = handler; if (type === 'open') queueMicrotask(() => { this.readyState = 1; handler(); }); }
    send(message) { this.sent.push(JSON.parse(message)); }
    close() { this.readyState = 3; this.listeners.close?.(); }
  }
  global.WebSocket = FakeSocket;

  const volumeAlert = baseAlert({ type: 'volume', condition: { type: 'volume', multiplier: 2, timeframe: '15m' }, timeframe: '15m' });
  const delayedStorage = { loadAlerts: () => [volumeAlert], loadHistory: () => [], saveAlerts() {}, saveHistory() {} };
  global.fetch = (_url, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
  const stopped = new ZychAlerts.AlertEngine({ storage: delayedStorage, evaluate: ZychAlerts.evaluateAlert });
  stopped.start(); stopped.stop(); await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(sockets, 0); assert.equal(stopped.status, 'OFFLINE');

  const many = Array.from({ length: 100 }, (_, index) => baseAlert({ id: `p${index}`, marketId: `binance:A${index}USDT`, asset: `A${index}`, symbol: `A${index}USDT` }));
  const manyStorage = { loadAlerts: () => many, loadHistory: () => [], saveAlerts() {}, saveHistory() {} };
  const scaled = new ZychAlerts.AlertEngine({ storage: manyStorage, evaluate: ZychAlerts.evaluateAlert });
  scaled.start(); await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(sockets, 1); assert.equal(scaled.socket.url.endsWith('/ws'), true); assert.equal(scaled.socket.sent[0].params.length, 100); scaled.stop();

  let triggers = 0;
  const recurringAlert = baseAlert({ mode: 'recurring' });
  const recurringStorage = { loadAlerts: () => [recurringAlert], loadHistory: () => [], saveAlerts() {}, saveHistory() {} };
  const recurring = new ZychAlerts.AlertEngine({ storage: recurringStorage, evaluate: ZychAlerts.evaluateAlert, onTrigger: () => { triggers += 1; } });
  recurring.check(recurring.alerts[0], { price: 101 }); recurring.check(recurring.alerts[0], { price: 102 }); assert.equal(triggers, 1);
  recurring.check(recurring.alerts[0], { price: 99 }); recurring.alerts[0].lastTriggeredAt = 0; recurring.check(recurring.alerts[0], { price: 101 }); assert.equal(triggers, 2);

  let historyRequest = 0;
  global.fetch = (_url, { signal }) => {
    historyRequest += 1;
    if (historyRequest === 1) return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
    return Promise.resolve({ ok: true, json: async () => [[1000, '1', '2', '0.5', '1.5', '10'], [2000, '1.5', '2.5', '1', '2', '12']] });
  };
  const history = new ZychChartHistory.ChartHistoryService(), historyMarket = { id: 'binance:BTCUSDT', symbol: 'BTCUSDT' }, oldRequest = new AbortController(), newRequest = new AbortController();
  const firstHistory = history.initial(historyMarket, '1w', oldRequest.signal); oldRequest.abort();
  const secondHistory = history.initial(historyMarket, '1w', newRequest.signal); await Promise.allSettled([firstHistory]);
  assert.equal((await secondHistory).data.length, 2);
  console.log('stabilization tests: PASS');
}

run().catch(error => { console.error(error); process.exitCode = 1; });
