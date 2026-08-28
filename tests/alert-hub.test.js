'use strict';
const assert=require('node:assert/strict');
const hub=require('../js/alerts/alert-hub.js');
const alerts=[
  {id:'bin-high',status:'active',marketId:'binance:BTCUSDT',exchange:'binance',symbol:'BTCUSDT',baseAsset:'BTC',quoteAsset:'USDT',createdAt:3,condition:{type:'price',operator:'above',value:81000}},
  {id:'bin-low',status:'active',marketId:'binance:BTCUSDT',exchange:'binance',symbol:'BTCUSDT',baseAsset:'BTC',quoteAsset:'USDT',createdAt:2,condition:{type:'price',operator:'below',value:75000}},
  {id:'bybit',status:'paused',marketId:'bybit:BTCUSDT',exchange:'bybit',symbol:'BTCUSDT',baseAsset:'BTC',quoteAsset:'USDT',createdAt:5,condition:{type:'price',operator:'above',value:82000}},
  {id:'okx',status:'active',marketId:'okx:BTC-USDT',exchange:'okx',symbol:'BTC-USDT',baseAsset:'BTC',quoteAsset:'USDT',createdAt:4,condition:{type:'price',operator:'above',value:83000}},
  {id:'triggered',status:'triggered',marketId:'binance:ETHUSDT',exchange:'binance',symbol:'ETHUSDT',baseAsset:'ETH',quoteAsset:'USDT',createdAt:6,condition:{type:'price',operator:'above',value:3000}}
];
assert.deepEqual(hub.visibleAlerts(alerts,'all').map(alert=>alert.id),['okx','bin-high','bin-low','bybit']);
assert.deepEqual(hub.visibleAlerts(alerts,'active').map(alert=>alert.id),['okx','bin-high','bin-low']);
assert.deepEqual(hub.visibleAlerts(alerts,'paused').map(alert=>alert.id),['bybit']);
assert.equal(new Set(hub.visibleAlerts(alerts).map(alert=>alert.id)).size,4);
assert.deepEqual(hub.visibleAlerts(alerts).filter(alert=>alert.symbol.includes('BTC')).map(alert=>alert.marketId),['okx:BTC-USDT','binance:BTCUSDT','binance:BTCUSDT','bybit:BTCUSDT']);
assert.equal(hub.marketText(alerts[0]),'BINANCE · BTC/USDT');assert.equal(hub.marketText(alerts[3]),'OKX · BTC/USDT');
assert.deepEqual(hub.openContext(alerts[2]),{id:'bybit',exchange:'bybit',marketType:'spot',marketId:'bybit:spot:BTCUSDT',symbol:'BTCUSDT',timeframe:'',eventTimestamp:null});assert.deepEqual(hub.openContext(alerts[3]),{id:'okx',exchange:'okx',marketType:'spot',marketId:'okx:spot:BTC-USDT',symbol:'BTC-USDT',timeframe:'',eventTimestamp:null});
console.log('alert hub tests: PASS');
