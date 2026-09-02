'use strict';
const assert=require('node:assert/strict');
const workspace=require('../js/services/exchange-workspace.js');
const markets=[
  {id:'binance:BTCUSDT',asset:'BTC',quoteAsset:'USDT',exchange:'binance',enabled:true},
  {id:'bybit:BTCUSDT',asset:'BTC',quoteAsset:'USDT',exchange:'bybit',enabled:true},
  {id:'okx:BTC-USDT',asset:'BTC',quoteAsset:'USDT',exchange:'okx',enabled:true},
  {id:'bingx:spot:BTC-USDT',asset:'BTC',quoteAsset:'USDT',exchange:'bingx',enabled:true},
  {id:'binance:ADAUSDT',asset:'ADA',quoteAsset:'USDT',exchange:'binance',enabled:true},
  {id:'bybit:ADAUSDT',asset:'ADA',quoteAsset:'USDT',exchange:'bybit',enabled:true},
  {id:'binance:BTCUSDC',asset:'BTC',quoteAsset:'USDC',exchange:'binance',enabled:true}
];
assert.deepEqual(workspace.exchanges,['binance','bybit','okx','bingx']);assert.equal(workspace.validExchange('bad'),'binance');
assert.equal(workspace.marketForAsset(markets,'BTC','bingx').id,'bingx:spot:BTC-USDT');
assert.equal(workspace.marketForAsset(markets,'BTC','bybit').id,'bybit:BTCUSDT');assert.equal(workspace.marketForAsset(markets,'BTC','okx').id,'okx:BTC-USDT');assert.equal(workspace.marketForAsset(markets,'ADA','okx'),null);
assert.equal(workspace.equivalentMarket(markets,markets.find(market=>market.id==='binance:BTCUSDC'),'bybit').id,'bybit:BTCUSDT');
const unavailable=workspace.unavailableMarket('ADA','okx');assert.equal(unavailable.exchange,'okx');assert.equal(unavailable.asset,'ADA');assert.equal(unavailable.unavailable,true);assert.notEqual(unavailable.exchange,'binance');
assert.deepEqual(workspace.preference({activeExchange:'bybit',selectedMarket:markets.find(market=>market.id==='bybit:ADAUSDT'),selectedTimeframe:'4h'}),{exchange:'bybit',marketId:'bybit:ADAUSDT',asset:'ADA',quoteAsset:'USDT',timeframe:'4h'});
console.log('exchange workspace tests: PASS');
