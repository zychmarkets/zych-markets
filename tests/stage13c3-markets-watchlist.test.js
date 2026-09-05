'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const adapters=require('../js/exchanges/exchange-adapter-v2'),instruments=require('../js/services/instrument-search'),context=require('../js/services/market-context'),watch=require('../js/services/watchlist-markets');
const app=fs.readFileSync(require.resolve('../app.js'),'utf8'),html=fs.readFileSync(require.resolve('../index.html'),'utf8');
const market=(exchange,symbol,baseAsset='BTC',quoteAsset='USDT')=>instruments.normalize({exchange,marketType:'spot',symbol,baseAsset,quoteAsset,enabled:true,status:'TRADING'});
const markets=[market('binance','BTCUSDT'),market('bybit','BTCUSDT'),market('okx','BTC-USDT'),market('bingx','BTC-USDT'),market('coinbase','BTC-USD','BTC','USD'),market('kraken','XBTUSDT')];

test('13C.3 Markets participation and exact-volume authority are Adapter v2 capability based',()=>{
  assert.equal(adapters.get('binance').capabilities.markets.state,'SUPPORTED');assert.equal(adapters.get('coinbase').capabilities.markets.state,'LIMITED');
  assert.equal(watch.capabilityAdmitted(adapters.supported()),true);assert.equal(watch.capabilityAdmitted(adapters.limited('TEST_LIMIT')),true);assert.equal(watch.capabilityAdmitted(adapters.unsupported('TEST_UNSUPPORTED')),false);
  assert.match(app,/marketsAdmitted=market=>capabilityAdmitted\(marketCapability\(market,'markets'\)\)/);assert.match(app,/capabilities\.metrics\.exactQuoteVolume24h\.state!=='SUPPORTED'/);assert.doesNotMatch(app,/capabilities\?\.exactQuoteVolume24h===false/);
});

test('13C.3 Markets and Chart navigation retain exact native identities without fallback',()=>{
  for(const row of markets){const id=adapters.canonicalId(row.exchange,row.marketType,row.symbol);assert.equal(row.id,id);assert.equal(context.fromMarket(row).marketId,id);assert.equal(markets.find(candidate=>candidate.id===id),row);}
  assert.equal(markets.find(candidate=>candidate.id==='kraken:spot:BTCUSDT'),undefined);assert.match(app,/function selectMarketId\(id\)\{const market=MARKETS\.find\(item=>item\.id===id&&item\.enabled\)/);
});

test('13C.3 Watchlist structural validity uses registered Adapter v2 native identity',()=>{
  for(const row of markets){assert.equal(watch.structurallyValid(row),true);assert.equal(watch.identity(row),row.id);}
  assert.equal(watch.structurallyValid({...markets[0],exchange:'unknown',id:'unknown:spot:BTCUSDT'}),false);assert.equal(watch.structurallyValid({...markets[0],marketType:'perpetual',id:'binance:perpetual:BTCUSDT'}),false);assert.equal(watch.structurallyValid({...markets[2],symbol:'BTCUSDT',id:'okx:spot:BTCUSDT'}),false);
});

test('13C.3 contradictory persisted identity fails closed',()=>{const saved={...watch.entry(markets[2]),marketId:markets[0].id};assert.equal(watch.structurallyValid(saved),false);assert.equal(watch.resolve(saved,markets),null);assert.deepEqual(watch.migrate([saved],{markets}),[])});

test('13C.3 Watchlist preserves exchange-distinct native symbols through persistence and restore',()=>{
  let saved=[];for(const row of markets)saved=watch.toggle(saved,row);const restored=watch.migrate(JSON.parse(JSON.stringify(saved)),{markets});assert.equal(restored.length,6);assert.equal(new Set(restored.map(item=>item.key)).size,6);assert.deepEqual(restored.map(item=>item.symbol),['BTCUSDT','BTCUSDT','BTC-USDT','BTC-USDT','BTC-USD','XBTUSDT']);for(const item of restored)assert.equal(watch.resolve(item,markets).id,item.marketId);
});

test('13C.3 unresolved valid entries persist unresolved with no fallback',()=>{const missing={key:'kraken:spot:XXBTZUSD',marketId:'kraken:spot:XXBTZUSD',exchange:'kraken',marketType:'spot',symbol:'XXBTZUSD',asset:'BTC',baseAsset:'BTC',quoteAsset:'USD'},persisted=watch.migrate([missing],{markets});assert.deepEqual(persisted,[missing]);assert.equal(watch.resolve(persisted[0],markets),null)});

test('13C.3 Watchlist capability admits SUPPORTED and LIMITED but rejects UNSUPPORTED',()=>{assert.equal(watch.capabilityAdmitted(adapters.supported()),true);assert.equal(watch.capabilityAdmitted(adapters.limited('TEST_LIMIT')),true);assert.equal(watch.capabilityAdmitted(adapters.unsupported('TEST_UNSUPPORTED')),false);assert.equal(markets.every(watch.watchlistAdmitted),true);assert.match(app,/!watchlistAdmitted\(market\)/);assert.doesNotMatch(app,/capabilities\?\.watchlist===false/)});

test('13C.3 Watchlist exchange filter is registry/capability generated',()=>{const select=html.match(/id="watchlist-exchange-filter"[\s\S]*?<\/select>/)[0];assert.deepEqual([...select.matchAll(/value="([^"]+)"/g)].map(match=>match[1]),['all']);assert.match(app,/ZychExchangeAdapterV2\.registry\.filter\(adapter=>capabilityAdmitted\(adapter\.marketTypes\.spot\.capabilities\.watchlist\)\)/);assert.doesNotMatch(app,/manualExchangeIds[^\n]*watchlist-exchange-filter|watchlist-exchange-filter[^\n]*manualExchangeIds/)});

test('13C.3 legacy asset migration keeps active exchange policy and canonical identity',()=>{const migrated=watch.migrate(['BTC'],{markets,exchange:'okx'});assert.equal(migrated[0].marketId,'okx:spot:BTC-USDT');assert.equal(migrated[0].symbol,'BTC-USDT')});

test('13C.3 Watchlist exact Chart context rejects corrupted and cross-exchange identity',()=>{const saved=watch.entry(markets[4]),resolved=watch.resolve(saved,markets);assert.equal(context.fromMarket(resolved).marketId,'coinbase:spot:BTC-USD');assert.equal(watch.resolve({...saved,key:'binance:spot:BTCUSDT'},markets),null);assert.equal(context.create({marketId:saved.marketId,exchange:'binance',marketType:'spot',symbol:'BTC-USD'}),null)});

test('13C.3 historical two-part Watchlist IDs survive migration for all six exchanges',()=>{
  const saved=markets.map(row=>({...watch.entry(row),marketId:`${row.exchange}:${row.symbol}`}));
  const before=JSON.stringify(saved);
  const restored=watch.migrate(JSON.parse(before),{markets,exchange:'okx'});
  assert.equal(restored.length,6);
  for(let i=0;i<markets.length;i++){
    assert.equal(restored[i].marketId,markets[i].id);
    assert.equal(restored[i].symbol,markets[i].symbol);
    assert.equal(watch.resolve(restored[i],markets),markets[i]);
    assert.equal(context.fromMarket(watch.resolve(restored[i],markets)).marketId,markets[i].id);
    assert.equal(watch.structurallyValid(saved[i]),false);
    assert.equal(watch.resolve(saved[i],markets),null);
  }
  assert.equal(JSON.stringify(saved),before);
  assert.deepEqual(watch.migrate(restored,{markets}),restored);
});

test('13C.3 legacy saved IDs persist before catalog loading and resolve later without fallback',()=>{
  const row=market('kraken','XXBTZUSD','BTC','USD');
  const legacy={...watch.entry(row),marketId:'kraken:XXBTZUSD',id:'kraken:XXBTZUSD'};
  delete legacy.marketType;
  const restored=watch.migrate([legacy],{markets:[],exchange:'binance'});
  assert.equal(restored.length,1);
  assert.equal(restored[0].marketId,'kraken:spot:XXBTZUSD');
  assert.equal(restored[0].quoteAsset,'USD');
  assert.equal(watch.resolve(restored[0],markets),null);
  const reloaded=watch.migrate(JSON.parse(JSON.stringify(restored)),{markets:[...markets,row]});
  assert.equal(watch.resolve(reloaded[0],[...markets,row]),row);
});

test('13C.3 legacy migration deduplicates old and new IDs only within the exact exchange',()=>{
  const entries=markets.slice(0,3).flatMap(row=>[watch.entry(row),{...watch.entry(row),marketId:`${row.exchange}:${row.symbol}`}]);
  const restored=watch.migrate(entries,{markets});
  assert.deepEqual(restored.map(item=>item.marketId),markets.slice(0,3).map(row=>row.id));
  const removed=watch.toggle(restored,markets[1]);
  assert.deepEqual(removed.map(item=>item.exchange),['binance','okx']);
});

test('13C.3 legacy migration still rejects contradictory IDs, keys, market types and aliases',()=>{
  const legacy={...watch.entry(markets[2]),marketId:'okx:BTC-USDT'};
  const invalid=[
    {...legacy,marketId:'bingx:BTC-USDT'},
    {...legacy,marketId:'okx:ETH-USDT'},
    {...legacy,marketId:'okx:BTCUSDT'},
    {...legacy,id:'binance:BTCUSDT'},
    {...legacy,key:'bingx:spot:BTC-USDT'},
    {...legacy,marketType:'perpetual'},
    {...legacy,nativeSymbol:'ETH-USDT'},
    {...legacy,exchange:'unknown'},
    {...watch.entry(markets[5]),marketId:'kraken:BTCUSDT'}
  ];
  assert.deepEqual(watch.migrate(invalid,{markets}),[]);
});
