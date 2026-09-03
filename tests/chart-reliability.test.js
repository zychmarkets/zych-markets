'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const adapters=require('../js/exchanges/browser-exchange-adapters'),coinbase=require('../js/exchanges/coinbase-chart'),kraken=require('../js/exchanges/kraken-chart');
const reliability=require('../js/services/chart-reliability'),reducer=require('../js/services/reliability-reducer');
const exchanges=['binance','bybit','okx','bingx','coinbase','kraken'];
const flush=()=>new Promise(r=>setImmediate(r));
class Socket{
  constructor(){this.readyState=0;this.listeners={};this.sent=[];}
  addEventListener(name,fn){this.listeners[name]=fn;}
  send(frame){try{this.sent.push(JSON.parse(frame));}catch{this.sent.push(frame);}}
  open(){this.readyState=1;this.listeners.open?.();}
  message(p){this.listeners.message?.({data:typeof p==='string'?p:JSON.stringify(p)});}
  close(){this.readyState=3;this.listeners.close?.({reason:'test disconnect'});}
}
function setup(t,exchange,frame='1m'){
  let clock=Date.UTC(2026,8,3,12,0,20),sequence=0,tradeId=0,ws;
  const symbol=exchange==='kraken'?'XXBTZUSD':exchange==='coinbase'?'BTC-USD':['okx','bingx'].includes(exchange)?'BTC-USDT':'BTCUSDT';
  const market={exchange,symbol,id:`${exchange}:spot:${symbol}`,marketType:'spot',baseAsset:'BTC',quoteAsset:exchange==='kraken'||exchange==='coinbase'?'USD':'USDT',enabled:true};
  const states=[],errors=[],values=[],repairs=[],now=()=>clock,bucket=()=>Math.floor(clock/60000)*60;
  const output={status:s=>states.push(s),candle:c=>values.push(c),reconcile:r=>repairs.push(r),error:e=>errors.push(e)};
  const original=global.WebSocket;global.WebSocket=Socket;t.after(()=>{global.WebSocket=original;});
  const simple={binance:adapters.BinanceBrowserAdapter,bybit:adapters.BybitBrowserAdapter,okx:adapters.OkxBrowserAdapter,bingx:adapters.BingxBrowserAdapter};
  let adapter;
  if(simple[exchange])adapter=new simple[exchange]({now,socketFactory:()=>new Socket()});
  else if(exchange==='coinbase')adapter={now,catalogMetadata:[{productId:symbol}],socketFactory:()=>new Socket(),fetchImpl:async()=>({ok:true,json:async()=>({candles:[{start:String(bucket()),open:'100',high:'110',low:'90',close:'105',volume:'2'}]})})};
  else adapter={now,mapping:{byNative:new Map([[symbol,{nativeSymbol:symbol,wsSymbol:'BTC/USD',baseAsset:'BTC',quoteAsset:'USD'}]])},socketFactory:()=>new Socket(),request:async()=>({[symbol]:[[bucket(),100,110,90,105,102,2,2]],last:bucket()})};
  const sockets=[];
  function connect(){sequence=0;ws=simple[exchange]?adapter.socket(market,frame,output):(exchange==='coinbase'?coinbase:kraken).socket(adapter,market,frame,output);sockets.push(ws);return ws;}
  t.after(()=>sockets.forEach(s=>s.close()));connect();
  function ack(){
    if(exchange==='bybit')ws.message({op:'subscribe',req_id:ws.sent[0].req_id,success:true});
    if(exchange==='okx')ws.message({event:'subscribe',arg:{channel:`candle${frame}`,instId:symbol}});
    if(exchange==='bingx')ws.message({id:ws.sent[0].id,code:0});
    if(exchange==='coinbase')ws.message({channel:'subscriptions',sequence_num:sequence++,events:[{subscriptions:{market_trades:[symbol],heartbeats:['heartbeats']}}]});
    if(exchange==='kraken')ws.message({method:'subscribe',req_id:1,success:true,result:{channel:'ohlc',symbol:'BTC/USD',interval:kraken.intervals[frame],snapshot:true}});
  }
  function packet(){
    if(exchange==='binance')return {e:'kline',s:symbol,E:clock,k:{s:symbol,i:frame,t:bucket()*1000,o:'100',h:'110',l:'90',c:'105',v:'3'}};
    if(exchange==='bybit')return {topic:`kline.${adapters.bybitInterval[frame]}.${symbol}`,ts:clock,data:[{interval:adapters.bybitInterval[frame],start:bucket()*1000,open:'100',high:'110',low:'90',close:'105',volume:'3'}]};
    if(exchange==='okx')return {arg:{channel:`candle${frame}`,instId:symbol},data:[[String(bucket()*1000),'100','110','90','105','3','300','300','0']]};
    if(exchange==='bingx')return {dataType:`${symbol}@kline_1min`,data:{s:symbol,K:{t:bucket()*1000,o:'100',h:'110',l:'90',c:'105',v:'3'}}};
    if(exchange==='coinbase')return {channel:'market_trades',sequence_num:sequence++,events:[{type:'update',trades:[{product_id:symbol,trade_id:String(++tradeId),time:new Date(clock).toISOString(),price:'105',size:'1'}]}]};
    return {channel:'ohlc',type:'update',data:[{symbol:'BTC/USD',interval:kraken.intervals[frame],interval_begin:new Date(bucket()*1000).toISOString(),open:100,high:110,low:90,close:105,volume:3,vwap:102,trades:3}]};
  }
  function heartbeat(){
    if(exchange==='bybit')ws.message({op:'ping',ret_msg:'pong'});
    if(exchange==='okx')ws.message('pong');
    if(exchange==='bingx')ws.message('Ping');
    if(exchange==='coinbase')ws.message({channel:'heartbeats',sequence_num:sequence++,events:[]});
    if(exchange==='kraken')ws.message({channel:'heartbeat'});
  }
  return {market,adapter,states,errors,values,repairs,connect,ack,packet,heartbeat,now,advance:ms=>{clock+=ms;},get ws(){return ws;},snapshot:()=>ws.chartReliability.snapshot(),data:async()=>{ws.message(packet());await flush();await flush();}};
}
for(const exchange of exchanges){
  test(`${exchange}: open / ACK / heartbeat / REST do not establish LIVE`,async t=>{
    const s=setup(t,exchange);s.ws.open();await flush();assert.notEqual(s.snapshot().state,'LIVE');s.ack();await flush();s.heartbeat();await flush();
    assert.equal(s.snapshot().state,'WAITING_FOR_DATA');assert.equal(s.snapshot().evidence.data.firstDataAt,null);
    await s.data();assert.equal(s.snapshot().state,'LIVE');assert.equal(s.snapshot().evidence.identity.domain,'chart');
    if(exchange==='kraken')assert.equal(s.snapshot().capability.state,'LIMITED');
    assert.deepEqual(s.snapshot(),reducer.reduceFeed(s.snapshot().evidence,{now:s.now(),current:s.snapshot().evidence.identity,policy:reliability.policy(exchange,'1m')}));
  });
  test(`${exchange}: stale market data survives heartbeat; fresh data restores LIVE without reconnect`,async t=>{
    const s=setup(t,exchange);s.ws.open();s.ack();await flush();await s.data();assert.equal(s.snapshot().state,'LIVE');const receipt=s.snapshot().evidence.data.lastMarketDataAt;
    s.advance(reliability.policy(exchange,'1m').maxReceiptAgeMs+1);s.heartbeat();await flush();s.ws.chartReliability.tick();
    assert.equal(s.snapshot().state,'STALE');assert.equal(s.snapshot().evidence.connection.state,'OPEN');assert.equal(s.snapshot().evidence.data.lastMarketDataAt,receipt);
    await s.data();assert.equal(s.snapshot().state,'LIVE');
  });
  test(`${exchange}: replacement generation independently requires connection, confirmation and data`,async t=>{
    const s=setup(t,exchange);s.ws.open();s.ack();await flush();await s.data();assert.equal(s.snapshot().state,'LIVE');
    const old=s.ws,late=s.packet(),generation=s.snapshot().evidence.identity.generation;old.close();assert.equal(old.chartReliability.snapshot().state,'RECONNECTING');
    s.connect();old.message(late);s.ws.open();assert.notEqual(s.snapshot().state,'LIVE');s.ack();await flush();assert.notEqual(s.snapshot().state,'LIVE');
    assert.equal(s.snapshot().evidence.data.firstDataAt,null);assert.notEqual(s.snapshot().evidence.identity.generation,generation);await s.data();assert.equal(s.snapshot().state,'LIVE');
  });
  test(`${exchange}: wrong exact market cannot qualify current data`,async t=>{
    const s=setup(t,exchange);s.ws.open();s.ack();await flush();const p=s.packet();
    if(exchange==='binance')p.s='ETHUSDT';if(exchange==='bybit')p.topic='kline.1.ETHUSDT';if(exchange==='okx')p.arg.instId='ETH-USDT';if(exchange==='bingx')p.data.s='ETH-USDT';if(exchange==='coinbase')p.events[0].trades[0].product_id='ETH-USD';if(exchange==='kraken')p.data[0].symbol='ETH/USD';
    s.ws.message(p);await flush();assert.notEqual(s.snapshot().state,'LIVE');assert.equal(s.snapshot().evidence.data.firstDataAt,null);
  });
}
for(const exchange of ['bybit','okx','bingx','coinbase'])test(`${exchange}: data before ACK never fabricates confirmation`,async t=>{
  const s=setup(t,exchange);s.ws.open();await flush();await s.data();assert.equal(s.snapshot().evidence.subscription.acknowledgement,'pending');assert.ok(s.snapshot().evidence.data.firstDataAt);assert.equal(s.snapshot().state,'SUBSCRIBING');s.ack();await flush();assert.equal(s.snapshot().state,'LIVE');
});
for(const exchange of ['bybit','okx'])test(`${exchange}: unrelated ACK ignored and relevant NACK rejected`,async t=>{
  const s=setup(t,exchange);s.ws.open();s.ws.message(exchange==='bybit'?{op:'subscribe',req_id:'other',success:true}:{event:'subscribe',arg:{channel:'candle1m',instId:'ETH-USDT'}});assert.equal(s.snapshot().evidence.subscription.acknowledgement,'pending');
  s.ws.message(exchange==='bybit'?{op:'subscribe',req_id:s.ws.sent[0].req_id,success:false}:{event:'error',id:s.ws.sent[0].id,code:'60012'});assert.equal(s.snapshot().state,'FAILED');
});
test('Binance raw and combined configured streams qualify, wrong combined stream does not',async t=>{
  const s=setup(t,'binance');s.ws.open();s.ws.message({stream:'ethusdt@kline_1m',data:s.packet()});assert.notEqual(s.snapshot().state,'LIVE');s.ws.message({stream:'btcusdt@kline_1m',data:s.packet()});assert.equal(s.snapshot().state,'LIVE');assert.equal(s.snapshot().evidence.subscription.acknowledgement,'not-applicable');
});
for(const exchange of ['binance','bybit','okx','bingx'])test(`${exchange}: malformed or historical candle cannot qualify LIVE`,async t=>{
  const s=setup(t,exchange);s.ws.open();s.ack();await flush();const old=s.packet();s.advance(600000);s.ws.message(old);await flush();assert.notEqual(s.snapshot().state,'LIVE');
});
test('Source and receipt timestamps are separate; candle boundaries are never event time',async t=>{
  for(const exchange of exchanges){const s=setup(t,exchange);s.ws.open();s.ack();await flush();await s.data();const d=s.snapshot().evidence.data;assert.equal(d.lastReceiptAt,s.now());assert.equal(d.sourceTimestamp,['binance','bybit','coinbase'].includes(exchange)?s.now():null);}
});
test('Capability distinguishes Kraken unsupported interval, limited history and missing market',()=>{
  const m={exchange:'kraken',id:'kraken:spot:XXBTZUSD',symbol:'XXBTZUSD'};
  for(const [market,frame,state,reason]of [[m,'1M','UNSUPPORTED','UNSUPPORTED_INTERVAL'],[m,'1m','LIMITED','HISTORY_LIMITED'],[{...m,unavailable:true},'1m','UNSUPPORTED','MARKET_UNAVAILABLE']])assert.deepEqual(reliability.capability(market,frame),{state,reasonCode:reason});
  const result=reducer.reduceFeed({identity:{domain:'chart'},capability:reliability.capability(m,'1M')},{now:10000});assert.equal(result.state,'UNSUPPORTED');assert.notEqual(result.state,'OFFLINE');
});
test('Activity policy considers timeframe and never substitutes heartbeat age for market age',()=>{
  assert.ok(reliability.policy('kraken','1h').maxReceiptAgeMs>reliability.policy('kraken','1m').maxReceiptAgeMs);assert.notEqual(reliability.policy('bybit','1m').maxReceiptAgeMs,reliability.policy('binance','1m').maxReceiptAgeMs);
});
for(const exchange of ['coinbase','kraken'])test(`${exchange}: unresolved REST repair cannot inherit healthy continuity`,async t=>{
  const s=setup(t,exchange);let release;
  if(exchange==='kraken')s.adapter.request=()=>new Promise(resolve=>{release=resolve;});
  else s.adapter.fetchImpl=()=>new Promise(resolve=>{release=resolve;});
  s.ws.open();s.ack();await flush();await s.data();assert.notEqual(s.snapshot().state,'LIVE');assert.equal(s.snapshot().evidence.continuity.state,'RECOVERING');
  s.ws.close();
  if(exchange==='kraken')release({XXBTZUSD:[[Math.floor(s.now()/60000)*60,100,110,90,105,102,2,2]],last:0});
  else release({ok:true,json:async()=>({candles:[]})});
  await flush();assert.equal(s.repairs.length,0);assert.equal(s.snapshot().state,'RECONNECTING');
});
test('Chart cache timestamps do not turn cached REST into current-generation market evidence',async t=>{
  const fs=require('node:fs'),vm=require('node:vm'),sandbox={window:{},Date,AbortController,setTimeout,clearTimeout};
  vm.runInNewContext(fs.readFileSync(require.resolve('../js/services/chart-history'),'utf8'),sandbox);
  const service=new sandbox.window.ZychChartHistory.ChartHistoryService({adapters:{binance:{candles:async()=>[{time:100,open:1,high:1,low:1,close:1,volume:1}]}}}),market={id:'binance:spot:BTCUSDT',exchange:'binance',symbol:'BTCUSDT'};
  const first=await service.initial(market,'1m'),cached=await service.initial(market,'1m');assert.equal(cached.cached,true);assert.equal(cached.cacheStoredAt,first.cacheStoredAt);
  const s=setup(t,'binance');s.ws.open();assert.equal(s.snapshot().state,'WAITING_FOR_DATA');assert.equal(s.snapshot().evidence.data.lastMarketDataAt,null);
});
test('A generation guard fences late ACK, heartbeat, error, data and reconciliation',()=>{
  let current=true;const observed=[];
  const bound=reliability.bind({exchange:'bybit',id:'bybit:spot:BTCUSDT',symbol:'BTCUSDT'},'1m',{isCurrent:()=>current,status:s=>observed.push(s),reconcile:()=>observed.push('repair')},()=>10000),socket=bound.attach(new Socket());
  bound.handlers.open();bound.handlers.requested();const before=socket.chartReliability.snapshot();current=false;
  bound.handlers.acknowledged();bound.handlers.heartbeat();bound.handlers.marketData();bound.handlers.error(new Error('old'));bound.handlers.reconcile([]);
  assert.deepEqual(socket.chartReliability.snapshot(),before);assert.ok(!observed.includes('repair'));socket.close();
});
test('BingX preserves genuine data.E event time and rejects inner candle identity mismatch',async t=>{
  const s=setup(t,'bingx');s.ws.open();s.ack();await flush();let p=s.packet();p.data.K.s='ETH-USDT';s.ws.message(p);await flush();assert.equal(s.snapshot().evidence.data.firstDataAt,null);
  p=s.packet();p.data.E=s.now()-2000;s.ws.message(p);await flush();assert.equal(s.snapshot().state,'LIVE');assert.equal(s.snapshot().evidence.data.sourceTimestamp,s.now()-2000);assert.equal(s.snapshot().freshness.sourceAgeMs,2000);
});
for(const [frame,wire]of Object.entries({'1h':'60min','4h':'4hour','1d':'1day','1w':'1week','1M':'1mon'}))test(`BingX Spot ${frame} uses verified ${wire} subscription and exact data`,async t=>{
  const now=Date.UTC(2026,8,3,12,0,20),market={id:'bingx:spot:BTC-USDT',exchange:'bingx',marketType:'spot',symbol:'BTC-USDT'},ws=new Socket(),adapter=new adapters.BingxBrowserAdapter({now:()=>now,socketFactory:()=>ws});
  adapter.socket(market,frame,{});t.after(()=>ws.close());ws.open();assert.equal(ws.sent[0].dataType,`BTC-USDT@kline_${wire}`);
  ws.message({id:ws.sent[0].id,code:0});await flush();assert.equal(ws.chartReliability.snapshot().state,'WAITING_FOR_DATA');
  ws.message({dataType:`BTC-USDT@kline_${wire}`,data:{E:now,K:{s:'BTC-USDT',i:wire,t:now-20000,o:'100',h:'110',l:'90',c:'105',v:'3'}}});await flush();assert.equal(ws.chartReliability.snapshot().state,'LIVE');
});
test('BingX delayed decompression keeps original receipt age instead of claiming newly fresh data',async t=>{
  let now=Date.UTC(2026,8,3,12,0,20),release;const receipt=now,ws=new Socket(),adapter=new adapters.BingxBrowserAdapter({now:()=>now,socketFactory:()=>ws,decodeFrame:()=>new Promise(resolve=>{release=resolve;})});
  adapter.socket({id:'bingx:spot:BTC-USDT',exchange:'bingx',marketType:'spot',symbol:'BTC-USDT'},'1m',{});t.after(()=>ws.close());ws.open();ws.message('compressed');await flush();
  release(JSON.stringify({id:ws.sent[0].id,code:0}));await flush();ws.message('compressed');await flush();now+=100000;
  release(JSON.stringify({dataType:'BTC-USDT@kline_1min',data:{K:{t:receipt-20000,o:'100',h:'110',l:'90',c:'105',v:'3'}}}));await flush();
  const result=ws.chartReliability.snapshot();assert.equal(result.evidence.data.lastReceiptAt,receipt);assert.equal(result.state,'STALE');
});
for(const exchange of ['coinbase','kraken'])test(`${exchange}: empty REST repair cannot prove live candle continuity`,async t=>{
  const s=setup(t,exchange);
  if(exchange==='kraken')s.adapter.request=async()=>({XXBTZUSD:[],last:0});
  else s.adapter.fetchImpl=async()=>({ok:true,json:async()=>({candles:[]})});
  s.ws.open();s.ack();await flush();await s.data();assert.equal(s.snapshot().state,'DEGRADED');assert.equal(s.snapshot().evidence.continuity.state,'RECOVERING');
});
