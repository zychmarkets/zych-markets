'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const contract=require('../js/exchanges/coinbase-public.js');
const {CoinbaseBrowserAdapter}=require('../js/exchanges/browser-exchange-adapters.js');
const {createCoinbasePublicProxy}=require('../server/coinbase-public-proxy.js');
const {createHttpServer}=require('../server/http-server.js');
const instruments=require('../js/services/instrument-search.js'),data=require('../js/services/markets-data.js'),watch=require('../js/services/watchlist-markets.js'),context=require('../js/services/market-context.js'),workspace=require('../js/services/exchange-workspace.js'),core=require('../js/alerts/alert-core.js');
const product=(id='BTC-USD',extra={})=>({product_id:id,base_currency_id:id.split('-')[0],quote_currency_id:id.split('-')[1],product_type:'SPOT',status:'online',alias:'',is_disabled:false,trading_disabled:false,cancel_only:false,post_only:false,auction_mode:false,limit_only:false,price:'100',price_percentage_change_24h:'2.5',high_24h:'110',low_24h:'90',volume_24h:'42',approximate_quote_24h_volume:'4200',...extra});
const envelope=(products,has_next=false)=>({products,num_products:products.length,pagination:{has_next}});
const response=value=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
const adapterFor=products=>new CoinbaseBrowserAdapter({fetchImpl:async()=>response({products,receivedAt:1000})});

test('Coinbase complete catalog follows pages, not num_products; deduplicates native IDs',async()=>{
  const calls=[],pages=[envelope([product()],true),envelope([product(),product('BTC-USDT')])];
  const proxy=createCoinbasePublicProxy({fetchImpl:async(url,options)=>{calls.push({url,options});return response(pages.shift())},now:()=>1000});
  const result=await proxy();assert.deepEqual(result.products.map(p=>p.product_id),['BTC-USD','BTC-USDT']);
  assert.equal(new URL(calls[1].url).searchParams.get('offset'),'1');
  for(const {url,options} of calls){assert.equal(new URL(url).origin,'https://api.coinbase.com');assert.equal(new URL(url).pathname,'/api/v3/brokerage/market/products');assert.equal(new URL(url).searchParams.get('product_type'),'SPOT');assert.equal(options.redirect,'error');assert.equal(options.credentials,'omit');assert.equal(options.headers,undefined);}
});
test('Coinbase proxy coalesces requests, expires cache, preserves original receipt time',async()=>{
  let calls=0,now=1000;const proxy=createCoinbasePublicProxy({fetchImpl:async()=>{calls++;return response(envelope([product()]))},now:()=>now});
  const [a,b]=await Promise.all([proxy(),proxy()]);assert.equal(calls,1);assert.equal(a,b);now=2000;assert.equal((await proxy()).receivedAt,1000);now=6001;assert.equal((await proxy()).receivedAt,6001);assert.equal(calls,2);
});
test('Coinbase proxy fails closed on malformed envelopes, flags, pagination, and repeated pages',async()=>{
  for(const value of [{},envelope([{product_id:'BTC-USD'}]),{products:[product()],pagination:{}},envelope([product('BTC-USD',{limit_only:'false'})])]){
    await assert.rejects(createCoinbasePublicProxy({fetchImpl:async()=>response(value)})());
  }
  await assert.rejects(createCoinbasePublicProxy({fetchImpl:async()=>response(envelope([product()],true))})(),/progress/);
});
test('Coinbase proxy timeout and upstream failures are retriable without poisoned cache',async()=>{
  let calls=0;const proxy=createCoinbasePublicProxy({fetchImpl:async()=>++calls===1?new Response('unavailable',{status:503}):response(envelope([product()]))});
  await assert.rejects(proxy(),/HTTP 503/);assert.equal((await proxy()).products.length,1);
  await assert.rejects(createCoinbasePublicProxy({timeoutMs:5,fetchImpl:(_url,{signal})=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('timeout'))))})(),/timeout/);
});
test('Coinbase proxy rejects oversized and non-JSON upstream responses',async()=>{
  await assert.rejects(createCoinbasePublicProxy({fetchImpl:async()=>new Response('x',{headers:{'content-type':'text/html'}})})(),/content type/);
  await assert.rejects(createCoinbasePublicProxy({fetchImpl:async()=>new Response('{}',{headers:{'content-type':'application/json','content-length':'9000000'}})})(),/too large/);
});
test('Coinbase HTTP route accepts only its fixed GET without arbitrary query forwarding',async t=>{
  let calls=0;const instance=createHttpServer({coinbaseProxy:async()=>{calls++;return{products:[product()],receivedAt:1000}},config:{production:false},logger:{warn(){},error(){}}});
  await new Promise(resolve=>instance.server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>instance.server.close(resolve)));
  const base=`http://127.0.0.1:${instance.server.address().port}`;
  for(const [path,method,status] of [['/products','GET',200],['/products?url=https://example.com','GET',400],['/products?limit=1','GET',400],['/products','POST',405],['/products','OPTIONS',405],['/products','HEAD',405],['/candles','GET',400],['/ticker','GET',404]]){
    assert.equal((await fetch(base+'/api/markets/coinbase'+path,{method})).status,status);
  }
  assert.equal(calls,1);assert.equal((await fetch(base+'/api/radar/events?exchange=coinbase')).status,503);
});
test('Coinbase admits only unrestricted online Spot products and excludes every unsafe flag',async()=>{
  const rejected=[product('FUT-USD',{product_type:'FUTURE'}),product('OFF-USD',{status:'offline'}),product('UNK-USD',{status:'unknown'}),...contract.flags.map((flag,i)=>product(`FLAG${i}-USD`,{[flag]:true})),product('VIEW-USD',{view_only:true})];
  const adapter=adapterFor([product(),...rejected]);assert.deepEqual((await adapter.discover()).map(m=>m.id),['coinbase:spot:BTC-USD']);assert.equal(adapter.catalogMetadata.filter(m=>m.unsupportedReason).length,rejected.length);
});
test('Coinbase aliases never enter snapshots, discovery, or exact targeted lookup',async()=>{
  const adapter=adapterFor([product(),product('BTC-USDC',{alias:'BTC-USD',quote_display_symbol:'USD'})]);
  assert.equal((await adapter.discover()).length,1);assert.equal((await adapter.allSnapshots()).length,1);
  assert.equal(adapter.catalogMetadata.find(p=>p.productId==='BTC-USDC').unsupportedReason,'UNIFIED_BOOK_ALIAS');
  assert.deepEqual(await adapter.snapshots([{id:'coinbase:spot:BTC-USDC',exchange:'coinbase',marketType:'spot',symbol:'BTC-USDC'}]),{});
});
test('Coinbase uses native product ID and explicit base/quote, never a display symbol',async()=>{
  const markets=await adapterFor([product('BTC-USD',{quote_display_symbol:'USDT'}),product('BTC-USDT')]).discover();
  assert.deepEqual(markets.map(m=>[m.id,m.symbol,m.quoteAsset]),[['coinbase:spot:BTC-USD','BTC-USD','USD'],['coinbase:spot:BTC-USDT','BTC-USDT','USDT']]);
  assert.equal(contract.unsupportedReason(product('BTCUSD')),'INVALID_NATIVE_IDENTITY');
  const entries=watch.migrate(markets.map(watch.entry),{markets});assert.equal(entries[0].quoteAsset,'USD');assert.equal(watch.resolve(entries[0],markets).id,markets[0].id);assert.equal(context.fromMarket(markets[0]).marketId,markets[0].id);
});
test('Coinbase exact price/change/high/low/base volume retain semantics and receipt provenance',()=>{
  const value=contract.snapshot(product(),1000);
  assert.deepEqual([value.price,value.change24h,value.high24h,value.low24h,value.baseVolume24h],[100,2.5,110,90,42]);
  assert.equal(value.quoteVolume24h,null);assert.equal(value.volume,null);assert.equal(value.sourceTimestamp,null);assert.equal(value.snapshotTimestamp,null);assert.equal(value.receivedAt,1000);assert.equal(value.availability.quoteVolume24h,false);assert.equal(value.provenance.timestampKind,'receipt');
});
test('Coinbase percentage points accept numeric and percent strings without multiplying by 100',()=>{
  for(const value of ['2.5','2.5%',2.5,' 2.5% '])assert.equal(contract.percent(value),2.5);
  for(const value of [0,'0','0%'])assert.equal(contract.percent(value),0);
  for(const value of [null,undefined,'',' ','bad','1%%',true,{},'Infinity','0x10'])assert.equal(contract.percent(value),null);
});
test('Coinbase missing fields remain null and real zero remains zero; approximate turnover is never exact',()=>{
  for(const raw of ['',null,undefined,'bad',true]){
    const value=contract.snapshot(product('BTC-USD',{price:raw,high_24h:raw,low_24h:raw,volume_24h:raw}),1000);
    assert.deepEqual([value.price,value.high,value.low,value.baseVolume24h,value.quoteVolume24h],[null,null,null,null,null]);
  }
  const value=contract.snapshot(product('BTC-USD',{price:'0',high_24h:'0',low_24h:'0',volume_24h:'0',approximate_quote_24h_volume:'999999999'}),1000);
  assert.deepEqual([value.price,value.high,value.low,value.baseVolume24h,value.quoteVolume24h],[0,0,0,0,null]);assert.equal(data.item(contract.instrument(product()),value).quoteVolume24h,null);
});
test('Coinbase global search preserves five exchanges and exact USD/USDT queries',async()=>{
  const cb=await adapterFor([product(),product('BTC-USDT'),product('USDT-USDC')]).discover();
  const old=['binance','bybit','okx','bingx'].map(exchange=>instruments.normalize({exchange,marketType:'spot',symbol:['okx','bingx'].includes(exchange)?'BTC-USDT':'BTCUSDT',baseAsset:'BTC',quoteAsset:'USDT'}));
  const all=[...old,...cb];assert.equal(new Set(instruments.search(all,'BTC').map(m=>m.exchange)).size,5);
  for(const query of ['BTCUSD','BTC-USD','BTC/USD'])assert.equal(instruments.search(all,query)[0].id,'coinbase:spot:BTC-USD');
  for(const query of ['BTCUSDT','BTC-USDT','BTC/USDT'])assert.ok(instruments.search(all,query).some(m=>m.id==='coinbase:spot:BTC-USDT'));
  for(const query of ['USD','USDC','USDT'])assert.ok(instruments.search(all,query).some(m=>m.exchange==='coinbase'&&m.quoteAsset===query));
});
test('Coinbase Markets rows, breadth and gainers/losers work while exact volume rankings remain empty',()=>{
  const rows=[product(),product('ETH-USD',{price_percentage_change_24h:'-1'}),product('SOL-USD',{price_percentage_change_24h:'0'})].map(p=>data.item(contract.instrument(p),contract.snapshot(p,1000)));
  assert.equal(rows.length,3);const breadth=data.breadth(rows);assert.deepEqual([breadth.rising,breadth.falling,breadth.flat,breadth.total],[1,1,1,3]);assert.ok(Math.abs(breadth.risingPct-100/3)<1e-10);assert.ok(Math.abs(breadth.fallingPct-100/3)<1e-10);
  assert.equal(data.rank(rows,'change24h','desc')[0].marketId,'coinbase:spot:BTC-USD');assert.equal(data.rank(rows,'change24h','asc')[0].marketId,'coinbase:spot:ETH-USD');assert.deepEqual(data.rank(rows,'quoteVolume24h'),[]);assert.equal(rows[0].high24h,110);
});
test('Coinbase invalid Chart requests fail without network calls; Alerts admit Coinbase while Radar remains four-exchange',async()=>{
  let calls=0;const adapter=new CoinbaseBrowserAdapter({fetchImpl:()=>{calls++;throw Error('unexpected request')}});
  await assert.rejects(adapter.candles(),/Unsupported Coinbase interval/);assert.throws(()=>adapter.socket(),/Unsupported Coinbase interval/);assert.equal(calls,0);
  assert.deepEqual(core.SUPPORTED_EXCHANGES,['binance','bybit','okx','bingx','coinbase','kraken']);assert.ok(core.createAlert({exchange:'coinbase',marketType:'spot',symbol:'BTC-USD',baseAsset:'BTC',quoteAsset:'USD',condition:{type:'price',operator:'above',value:101}},{id:'coinbase-allowed'}));
  const schema=require('../server/radar/event-schema.js');assert.deepEqual(schema.EXCHANGES,['binance','bybit','okx','bingx']);
  assert.deepEqual(workspace.exchanges,['binance','bybit','okx','bingx','coinbase','kraken']);
});
test('Coinbase UI keeps one global selector and visibly guards metrics and Chart boundaries',()=>{
  const html=fs.readFileSync(require.resolve('../index.html'),'utf8'),app=fs.readFileSync(require.resolve('../app.js'),'utf8');
  assert.equal((html.match(/id="active-exchange-selector"/g)||[]).length,1);assert.equal((html.match(/data-active-exchange-option=/g)||[]).length,0);
  assert.match(app,/ZychExchangeAdapterV2\.manualExchangeIds\.map/);assert.match(app,/adapter\.label/);assert.doesNotMatch(html.match(/id="radar-exchange-filter"[\s\S]*?<\/select>/)[0],/coinbase/);
  assert.match(app,/Exact 24h quote volume unavailable/);assert.match(app,/Snapshot received/);assert.match(app,/Partial metrics/);assert.match(app,/24h High/);assert.match(app,/24h Low/);assert.match(app,/capabilities\?\.chart===false/);
});
