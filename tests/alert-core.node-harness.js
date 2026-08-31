'use strict';
const core = require('../js/alerts/alert-core.js');

const alert = core.createAlert({ marketId: 'binance:ETHUSDT', exchange: 'binance', symbol: 'ETHUSDT', baseAsset: 'ETH', quoteAsset: 'USDT', condition: { type: 'price', operator: 'above', value: 2500 }, mode: 'once' }, { id: 'node-alert', now: 1000 });
const marketEvent = { exchange: 'binance', symbol: 'ETHUSDT', baseAsset: 'ETH', quoteAsset: 'USDT', eventType: 'ticker', price: 2501, timestamp: 2000 };
const result = core.processMarketEvent(alert, marketEvent, { now: 2000, eventId: 'node-trigger', previousPrice: 2499 });
if (!result.triggered || result.triggerEvent.alertId !== 'node-alert' || result.triggerEvent.triggerPrice !== 2501) throw new Error('Node alert-core harness failed');
console.log(JSON.stringify({ input: marketEvent, output: result.triggerEvent, status: 'PASS' }, null, 2));
