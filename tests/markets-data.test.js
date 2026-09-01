'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const instruments=require('../js/services/instrument-search.js');
const marketsData=require('../js/services/markets-data.js');
global.ZychInstruments=instruments;
const exchanges=require('../js/exchanges/browser-exchange-adapters.js');
delete global.ZychInstruments;

const response=value=>Promise.resolve({ok:true,json:async()=>value});

test('Markets model retains canonical identity and exposes only honest market metrics',()=>{
  const fixtures=[
    {exchange:'binance',symbol:'BTCUSDT',baseAsset:'BTC',quoteAsset:'USDT'},
    {exchange:'bybit',symbol:'BTCUSDT',baseAsset:'BTC',quoteAsset:'USDT'},
    {exchange:'okx',symbol:'BTC-USDT',baseAsset:'BTC',quoteAsset:'USDT'}
  ];
  const rows=fixtures.map(value=>marketsData.item(instruments.normalize({...value,marketType:'spot'}),{price:10,change24h:0,quoteVolume24h:20,snapshotTimestamp:30}));
  assert.deepEqual(rows.map(row=>row.marketId),['binance:spot:BTCUSDT','bybit:spot:BTCUSDT','okx:spot:BTC-USDT']);
  assert.deepEqual(rows[2],{marketId:'okx:spot:BTC-USDT',exchange:'okx',marketType:'spot',symbol:'BTC-USDT',nativeSymbol:'BTC-USDT',baseAsset:'BTC',quoteAsset:'USDT',displaySymbol:'BTC/USDT',price:10,change24h:0,quoteVolume24h:20,snapshotTimestamp:30,watchlisted:false});
  assert.equal('marketCap' in rows[0],false);assert.equal('sparkline' in rows[0],false);assert.equal('history' in rows[0],false);assert.equal('eventChangePct' in rows[0],false);assert.equal('eventVolume' in rows[0],false);
});

test('numeric normalization preserves genuine zero and rejects missing or invalid values',()=>{
  assert.equal(marketsData.number(0),0);assert.equal(marketsData.number('0'),0);
  for(const value of ['',null,undefined,NaN,'invalid'])assert.equal(marketsData.number(value),null);
});

test('Binance normalizes real 24h metrics, receipt timestamps, and canonical targeted keys',async()=>{
  const payload=[{symbol:'BTCUSDT',lastPrice:'60000',priceChangePercent:'2.5',priceChange:'1500',highPrice:'61000',lowPrice:'58000',quoteVolume:'123456',closeTime:'1700000000000'}];
  const adapter=new exchanges.BinanceBrowserAdapter({fetchImpl:()=>response(payload),now:()=>1700000009999});
  const all=await adapter.allSnapshots();assert.equal(all[0].marketId,'binance:spot:BTCUSDT');assert.deepEqual([all[0].price,all[0].change24h,all[0].quoteVolume24h,all[0].snapshotTimestamp],[60000,2.5,123456,1700000000000]);
  const targeted=await adapter.snapshots([{id:'binance:spot:BTCUSDT',symbol:'BTCUSDT'}]);assert.deepEqual(Object.keys(targeted),['binance:spot:BTCUSDT']);assert.equal(targeted['binance:spot:BTCUSDT'].price,60000);
});

test('Bybit uses genuine 24h percentage or derives it without manufacturing zero',()=>{
  const adapter=new exchanges.BybitBrowserAdapter({now:()=>111});
  assert.deepEqual([adapter.normalizeTicker({lastPrice:'110',price24hPcnt:'0.1',prevPrice24h:'100',turnover24h:'500'},222).change24h,adapter.normalizeTicker({lastPrice:'110',prevPrice24h:'100',turnover24h:'500'},222).change24h],[10,10]);
  assert.equal(adapter.normalizeTicker({lastPrice:'110',prevPrice24h:'',turnover24h:''},222).change24h,null);
  assert.equal(adapter.normalizeTicker({lastPrice:'110',price24hPcnt:'0',turnover24h:'0'},222).change24h,0);
  assert.equal(adapter.normalizeTicker({lastPrice:'110',prevPrice24h:null},222).change24h,null);
});

test('Bybit preserves the exchange response timestamp',async()=>{
  const value={retCode:0,time:777,result:{list:[{symbol:'BTCUSDT',lastPrice:'10',price24hPcnt:'0',turnover24h:'0'}]}},adapter=new exchanges.BybitBrowserAdapter({fetchImpl:()=>response(value),now:()=>999});
  assert.equal((await adapter.allSnapshots())[0].snapshotTimestamp,777);
});

test('OKX retains native symbol, open24h semantics, quote turnover, and source timestamp',()=>{
  const adapter=new exchanges.OkxBrowserAdapter({now:()=>999}),row=adapter.normalizeTicker({last:'120',open24h:'100',volCcy24h:'700',ts:'888'});
  assert.deepEqual([row.price,row.change24h,row.quoteVolume24h,row.snapshotTimestamp],[120,20,700,888]);
  assert.equal(exchanges.market('okx','BTC-USDT','BTC','USDT','live').id,'okx:spot:BTC-USDT');
});

test('search is separator-insensitive, includes USDC base and quote results, and preserves exchanges',()=>{
  const rows=[
    {exchange:'binance',marketType:'spot',symbol:'BTCUSDT',baseAsset:'BTC',quoteAsset:'USDT'},
    {exchange:'bybit',marketType:'spot',symbol:'BTCUSDT',baseAsset:'BTC',quoteAsset:'USDT'},
    {exchange:'okx',marketType:'spot',symbol:'BTC-USDT',baseAsset:'BTC',quoteAsset:'USDT'},
    {exchange:'binance',marketType:'spot',symbol:'USDCUSDT',baseAsset:'USDC',quoteAsset:'USDT'},
    {exchange:'okx',marketType:'spot',symbol:'BTC-USDC',baseAsset:'BTC',quoteAsset:'USDC'}
  ];
  for(const query of ['BTC','BTCUSDT','BTC-USDT','BTC/USDT'])assert.deepEqual(instruments.search(rows,query).slice(0,3).map(row=>row.exchange),['binance','bybit','okx']);
  const usdc=instruments.search(rows,'USDC');assert.equal(usdc.some(row=>row.baseAsset==='USDC'),true);assert.equal(usdc.some(row=>row.quoteAsset==='USDC'),true);
  assert.equal(new Set(instruments.search(rows,'BTC').map(row=>row.id)).size,instruments.search(rows,'BTC').length);
});

test('Markets rankings and breadth use only real finite 24h metrics',()=>{
  const rows=[
    {marketId:'a',change24h:3,quoteVolume24h:10},{marketId:'b',change24h:-2,quoteVolume24h:30},{marketId:'c',change24h:0,quoteVolume24h:null},{marketId:'d',change24h:null,quoteVolume24h:20}
  ];
  const breadth=marketsData.breadth(rows);assert.deepEqual({rising:breadth.rising,falling:breadth.falling,flat:breadth.flat,total:breadth.total},{rising:1,falling:1,flat:1,total:3});assert.ok(Math.abs(breadth.risingPct-100/3)<1e-12);assert.ok(Math.abs(breadth.fallingPct-100/3)<1e-12);
  assert.deepEqual(marketsData.rank(rows,'change24h','desc').map(row=>row.marketId),['a','c','b']);
  assert.deepEqual(marketsData.rank(rows,'change24h','asc').map(row=>row.marketId),['b','c','a']);
  assert.deepEqual(marketsData.rank(rows,'quoteVolume24h','desc').map(row=>row.marketId),['b','d','a']);
});
