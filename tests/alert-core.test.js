'use strict';
const assert = require('node:assert/strict');
const core = require('../js/alerts/alert-core.js');

const definition = (condition, mode = 'once') => ({ marketId: 'binance:BTCUSDT', exchange: 'binance', symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', condition, mode });
const alert = (condition, mode = 'once') => core.createAlert(definition(condition, mode), { id: 'alert-1', now: 1000 });
const ticker = price => ({ exchange: 'binance', symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', eventType: 'ticker', price, timestamp: 2000 });
const candle = values => ({ exchange: 'binance', symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', eventType: 'candle', interval: '1h', open: 100, high: 110, low: 90, price: 100, volume: 100, averageVolume: 100, timestamp: 2000, ...values });

assert.equal(typeof window, 'undefined');
assert.equal(typeof document, 'undefined');
assert.equal(core.evaluateAlert(alert({ type: 'price', operator: 'above', value: 100 }), ticker(101), { previousPrice: 99 }).met, true);
assert.equal(core.evaluateAlert(alert({ type: 'price', operator: 'below', value: 100 }), ticker(99), { previousPrice: 101 }).met, true);
assert.equal(core.evaluateAlert(alert({ type: 'price', operator: 'above', value: 100 }), ticker(101)).met, false);
assert.equal(core.evaluateAlert(alert({ type: 'price', operator: 'above', value: 100 }), ticker(101), { previousPrice: 101 }).met, false);
assert.equal(core.evaluateAlert(alert({ type: 'price', operator: 'below', value: 100 }), ticker(99), { previousPrice: 99 }).met, false);
assert.equal(core.evaluateAlert(alert({ type: 'movement', direction: 'up', percent: 5, window: '1h' }), candle({ price: 106 })).met, true);
assert.equal(core.evaluateAlert(alert({ type: 'movement', direction: 'down', percent: 5, window: '1h' }), candle({ price: 94 })).met, true);
assert.equal(core.evaluateAlert(alert({ type: 'volume', multiplier: 2, timeframe: '1h' }), candle({ volume: 201 })).met, true);

const once = alert({ type: 'price', operator: 'above', value: 100 });
const onceResult = core.processMarketEvent(once, ticker(101), { now: 3000, eventId: 'trigger-1', previousPrice: 99 });
assert.equal(onceResult.triggered, true);
assert.equal(onceResult.alert.status, 'triggered');
assert.equal(onceResult.triggerEvent.id, 'trigger-1');
assert.equal(onceResult.triggerEvent.reason, 'price_above');
assert.equal(onceResult.triggerEvent.triggerPrice, 101);
assert.equal(onceResult.triggerEvent.marketSnapshot.eventType, 'ticker');

let recurring = alert({ type: 'price', operator: 'above', value: 100 }, 'recurring');
let result = core.processMarketEvent(recurring, ticker(101), { now: 10000, eventId: 'r1', previousPrice: 99 }); recurring = result.alert; assert.equal(result.triggered, true);
result = core.processMarketEvent(recurring, ticker(102), { now: 16000, eventId: 'r2', previousPrice: 101 }); recurring = result.alert; assert.equal(result.triggered, false); assert.equal(recurring.armed, false);
result = core.processMarketEvent(recurring, ticker(99), { now: 17000, previousPrice: 102 }); recurring = result.alert; assert.equal(recurring.armed, true);
result = core.processMarketEvent(recurring, ticker(101), { now: 18000, eventId: 'r2', previousPrice: 99 }); assert.equal(result.triggered, true);

const invalidNumeric = core.processMarketEvent(alert({ type: 'price', operator: 'above', value: 100 }), ticker('not-a-number'), { previousPrice: 99 });
assert.equal(invalidNumeric.triggered, false); assert.equal(invalidNumeric.unavailable, true);
assert.notEqual(core.marketIdentity({ exchange: 'binance', symbol: 'BTCUSDT' }), core.marketIdentity({ exchange: 'bybit', symbol: 'BTCUSDT' }));

assert.equal(core.validateAlert({ id: 'broken' }), false);
assert.equal(core.validateCondition({ type: 'price', operator: 'sideways', value: 1 }), false);
assert.equal(core.validateMarketEvent({ eventType: 'ticker', symbol: '<script>', price: 1, timestamp: 1, exchange: 'binance' }), false);
const migrated = core.migrateAlert({ ...once, version: undefined, baseAsset: undefined, asset: 'BTC', updatedAt: undefined });
assert.equal(migrated.version, core.ALERT_SCHEMA_VERSION); assert.equal(migrated.baseAsset, 'BTC'); assert.equal(core.validateAlert(migrated), true);

console.log('alert core tests: PASS');
