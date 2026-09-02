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
    {exchange:'okx',symbol:'BTC-USDT',baseAsset:'BTC',quoteAsset:'USDT'},
    {exchange:'bingx',symbol:'BTC-USDT',baseAsset:'BTC',quoteAsset:'USDT'}
  ];
  const rows=fixtures.map(value=>marketsData.item(instruments.normalize({...value,marketType:'spot'}),{price:10,change24h:0,quoteVolume24h:20,snapshotTimestamp:30}));
  assert.deepEqual(rows.map(row=>row.marketId),['binance:spot:BTCUSDT','bybit:spot:BTCUSDT','okx:spot:BTC-USDT','bingx:spot:BTC-USDT']);
  assert.deepEqual(rows[2],{marketId:'okx:spot:BTC-USDT',exchange:'okx',marketType:'spot',symbol:'BTC-USDT',nativeSymbol:'BTC-USDT',baseAsset:'BTC',quoteAsset:'USDT',displaySymbol:'BTC/USDT',price:10,change24h:0,quoteVolume24h:20,snapshotTimestamp:30,receivedAt:null,sourceTimestamp:null,high24h:null,low24h:null,baseVolume24h:null,availability:null,provenance:null,watchlisted:false});
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

test('BingX catalog validates the envelope, preserves native pairs, and admits only verified tradable status',async()=>{
  const payload={code:0,msg:'',data:{symbols:[
    {symbol:'BTC-USDT',status:1,apiStateBuy:true,apiStateSell:true},
    {symbol:'ETH-USDC',status:1,apiStateBuy:true,apiStateSell:true,baseAsset:'ETH',quoteAsset:'USDC'},
    {symbol:'OFF-USDT',status:0,apiStateBuy:true,apiStateSell:true},
    {symbol:'ACCESS-USDT',status:10,apiStateBuy:true,apiStateSell:true},
    {symbol:'SUSPENDED-USDT',status:25,apiStateBuy:true,apiStateSell:true},
    {symbol:'BUYOFF-USDT',status:1,apiStateBuy:false,apiStateSell:true},
    {symbol:'SELLOFF-USDT',status:1,apiStateBuy:true,apiStateSell:false},
    {symbol:'MALFORMED',status:1,apiStateBuy:true,apiStateSell:true},
    {symbol:'BTC-USDT',status:1,apiStateBuy:true,apiStateSell:true}
  ]}},adapter=new exchanges.BingxBrowserAdapter({fetchImpl:()=>response(payload)}),rows=await adapter.discover();
  assert.deepEqual(rows.map(row=>row.id),['bingx:spot:BTC-USDT','bingx:spot:ETH-USDC']);
  assert.deepEqual([rows[0].symbol,rows[0].baseAsset,rows[0].quoteAsset],['BTC-USDT','BTC','USDT']);
  assert.deepEqual([rows[1].baseAsset,rows[1].quoteAsset],['ETH','USDC']);
  await assert.rejects(()=>new exchanges.BingxBrowserAdapter({fetchImpl:()=>response({code:100500,msg:'busy',data:null})}).discover(),/BingX API 100500/);
  for(const malformed of [{code:0,data:null},{code:0,data:{}},{code:0,data:{symbols:{}}}])await assert.rejects(()=>new exchanges.BingxBrowserAdapter({fetchImpl:()=>response(malformed)}).discover(),/malformed response/);
});

test('BingX tickers preserve percent semantics, quote turnover, source time, nulls, zeros, and canonical deduplication',async()=>{
  const payload={code:0,msg:null,data:[
    {symbol:'BTC-USDT',lastPrice:'77219.37',priceChange:'-1695.89',priceChangePercent:'-2.15%',volume:'2099.82',quoteVolume:'163998535.51',closeTime:'1788292453278'},
    {symbol:'ZERO-USDT',lastPrice:'0',priceChange:'0',priceChangePercent:'0.00%',volume:'999',quoteVolume:'0',closeTime:'0'},
    {symbol:'NULL-USDT',lastPrice:'',priceChangePercent:'',volume:'777',quoteVolume:'',closeTime:''},
    {symbol:'BTC-USDT',lastPrice:'77219.37',priceChangePercent:'-2.15%',quoteVolume:'163998535.51',closeTime:'1788292453278'}
  ]},adapter=new exchanges.BingxBrowserAdapter({fetchImpl:()=>response(payload),now:()=>444}),rows=await adapter.allSnapshots();
  assert.equal(rows.length,3);assert.equal(rows[0].marketId,'bingx:spot:BTC-USDT');
  assert.deepEqual([rows[0].price,rows[0].change24h,rows[0].quoteVolume24h,rows[0].snapshotTimestamp],[77219.37,-2.15,163998535.51,1788292453278]);
  assert.deepEqual([rows[1].price,rows[1].change24h,rows[1].quoteVolume24h,rows[1].snapshotTimestamp],[0,0,0,0]);
  assert.deepEqual([rows[2].price,rows[2].change24h,rows[2].quoteVolume24h,rows[2].snapshotTimestamp],[null,null,null,444]);
  assert.notEqual(rows[2].quoteVolume24h,777);
  const targeted=await adapter.snapshots([{id:'bingx:spot:BTC-USDT',symbol:'BTC-USDT'}]);assert.deepEqual(Object.keys(targeted),['bingx:spot:BTC-USDT']);
  await assert.rejects(()=>new exchanges.BingxBrowserAdapter({fetchImpl:()=>response({code:0,data:{}})}).allSnapshots(),/malformed response/);
});

test('BingX Chart transport rejects missing exact Spot identity',async()=>{
  const adapter=new exchanges.BingxBrowserAdapter();
  await assert.rejects(()=>adapter.candles(),/Invalid BingX Spot market/);
  assert.throws(()=>adapter.socket(),/Invalid BingX Spot market/);
});

test('BingX browser transport can target the two narrow same-origin proxy routes',async()=>{
  const urls=[],adapter=new exchanges.BingxBrowserAdapter({restBase:'/api/markets/bingx',catalogPath:'/catalog',tickerPath:'/tickers',fetchImpl:async url=>{urls.push(url);return response(url.endsWith('/catalog')?{code:0,data:{symbols:[]}}:{code:0,data:[]})}});
  await adapter.discover();
  await adapter.allSnapshots();
  assert.deepEqual(urls,['/api/markets/bingx/catalog','/api/markets/bingx/tickers']);
});

test('search is separator-insensitive, includes USDC base and quote results, and preserves exchanges',()=>{
  const rows=[
    {exchange:'binance',marketType:'spot',symbol:'BTCUSDT',baseAsset:'BTC',quoteAsset:'USDT'},
    {exchange:'bybit',marketType:'spot',symbol:'BTCUSDT',baseAsset:'BTC',quoteAsset:'USDT'},
    {exchange:'okx',marketType:'spot',symbol:'BTC-USDT',baseAsset:'BTC',quoteAsset:'USDT'},
    {exchange:'bingx',marketType:'spot',symbol:'BTC-USDT',baseAsset:'BTC',quoteAsset:'USDT'},
    {exchange:'binance',marketType:'spot',symbol:'USDCUSDT',baseAsset:'USDC',quoteAsset:'USDT'},
    {exchange:'okx',marketType:'spot',symbol:'BTC-USDC',baseAsset:'BTC',quoteAsset:'USDC'}
  ];
  for(const query of ['BTC','BTCUSDT','BTC-USDT','BTC/USDT'])assert.deepEqual(instruments.search(rows,query).slice(0,4).map(row=>row.exchange),['binance','bingx','bybit','okx']);
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
