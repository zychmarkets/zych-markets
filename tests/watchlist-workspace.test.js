'use strict';
const assert=require('node:assert/strict');
const test=require('node:test');
const watch=require('../js/services/watchlist-markets.js');
const markets=[
  {id:'binance:SOLUSDT',exchange:'binance',symbol:'SOLUSDT',asset:'SOL',baseAsset:'SOL',quoteAsset:'USDT',enabled:true},
  {id:'bybit:SOLUSDT',exchange:'bybit',symbol:'SOLUSDT',asset:'SOL',baseAsset:'SOL',quoteAsset:'USDT',enabled:true},
  {id:'okx:SOL-USDT',exchange:'okx',symbol:'SOL-USDT',asset:'SOL',baseAsset:'SOL',quoteAsset:'USDT',enabled:true},
  {id:'binance:BTCUSDT',exchange:'binance',symbol:'BTCUSDT',asset:'BTC',baseAsset:'BTC',quoteAsset:'USDT',enabled:true},
  {id:'bybit:BTCUSDT',exchange:'bybit',symbol:'BTCUSDT',asset:'BTC',baseAsset:'BTC',quoteAsset:'USDT',enabled:true},
  {id:'okx:BTC-USDT',exchange:'okx',symbol:'BTC-USDT',asset:'BTC',baseAsset:'BTC',quoteAsset:'USDT',enabled:true}
];
test('legacy asset entries migrate to the active exchange',()=>{const items=watch.migrate(['SOL','BTC'],{markets,exchange:'okx'});assert.deepEqual(items.map(item=>item.marketId),['okx:SOL-USDT','okx:BTC-USDT']);assert.equal(items.every(item=>item.exchange==='okx'),true)});
test('same symbol is independently keyed across exchanges',()=>{let items=[];for(const market of markets)items=watch.toggle(items,market);assert.equal(items.length,6);assert.equal(new Set(items.map(item=>item.key)).size,6);items=watch.toggle(items,markets[2]);assert.equal(items.some(item=>item.marketId==='okx:SOL-USDT'),false);assert.equal(items.some(item=>item.marketId==='binance:SOLUSDT'),true)});
test('saved item resolves its own exchange and never current-workspace fallback',()=>{const item=watch.entry(markets[2]);assert.equal(watch.resolve(item,markets).exchange,'okx');assert.equal(watch.resolve({...item,marketId:'missing',key:'okx:spot:MISSING'},markets),null)});
test('canonical key rejects a contradictory persisted market id',()=>{const item={...watch.entry(markets[1]),marketId:markets[0].id};assert.equal(item.key,'bybit:spot:SOLUSDT');assert.equal(watch.resolve(item,markets).id,markets[1].id);const migrated=watch.migrate([item],{markets});assert.equal(migrated[0].id,undefined);assert.equal(migrated[0].marketId,markets[1].id);assert.equal(migrated[0].exchange,'bybit')});
test('migration deduplicates only identical canonical entries and preserves native OKX symbols',()=>{const binance=watch.entry(markets[3]),bybit=watch.entry(markets[4]),okx=watch.entry(markets[5]),items=watch.migrate([binance,binance,bybit,okx],{markets});assert.deepEqual(items.map(item=>item.key),['binance:spot:BTCUSDT','bybit:spot:BTCUSDT','okx:spot:BTC-USDT']);assert.equal(items[2].symbol,'BTC-USDT')});
