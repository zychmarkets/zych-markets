'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
const core = require('../js/alerts/alert-core');
const { ServerAlertRunner } = require('../server/alert-runner');
const { JsonStorageAdapter } = require('../server/storage/json-storage');
const { readiness } = require('../server/alert-reliability');
const { BybitMarketTransport } = require('../server/transports/bybit-market-transport');
const silent = { info(){}, warn(){}, error(){}, debug(){} };
const definition = (symbol='BTCUSDT', condition={type:'price',operator:'above',value:100}) => ({ exchange:'binance',marketType:'spot',marketId:`binance:spot:${symbol}`,symbol,baseAsset:symbol.slice(0,-4),quoteAsset:'USDT',condition,mode:'recurring' });
async function fixture(t, notify=async()=>({outcome:'ACCEPTED'})) {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'zych-12c-'));
  const storage=new JsonStorageAdapter({directory,core,logger:silent});await storage.init();
  let now=1800000000000;
  const transport={socket:{readyState:1},status:'live',topicEvidence:new Map(),async start(){},async stop(){},diagnostics(){return {status:'live',connections:1,subscriptions:2};}};
  const runner=new ServerAlertRunner({core,storage,transport,notifier:{notify},logger:silent,now:()=>now});await runner.start();
  t.after(async()=>{await runner.stop();assert.equal(path.dirname(directory),os.tmpdir());await fs.rm(directory,{recursive:true,force:true});});
  const add=async(symbol,condition)=>{const {alert}=await runner.create(definition(symbol,condition));transport.topicEvidence.set(`${alert.symbol.toLowerCase()}@ticker`,{socket:transport.socket,requestedAt:now,acknowledgement:'acknowledged',lastAckAt:now});return alert;};
  const tick=(price=99,symbol='BTCUSDT')=>runner.enqueue({exchange:'binance',symbol,marketId:`binance:spot:${symbol}`,eventType:'ticker',price,timestamp:now,sourceTimestamp:now});
  return {runner,storage,transport,add,tick,directory,advance:ms=>now+=ms};
}
test('socket, heartbeat and ACK alone never make an alert READY; lifecycle is authoritative',async t=>{
  const f=await fixture(t),a=await f.add();
  assert.notEqual(readiness(f.runner,a).state,'READY');f.transport.lastHeartbeatAt=f.runner.now();assert.notEqual(readiness(f.runner,a).state,'READY');
  await f.tick();assert.equal(readiness(f.runner,a).state,'READY');
  f.runner.status='stopped';assert.notEqual(readiness(f.runner,a).state,'READY');assert.equal(f.runner.diagnostics().status,'stopped');f.runner.status='running';
});
test('one fresh symbol never renews another; heartbeat cannot renew stale price',async t=>{
  const f=await fixture(t),a=await f.add(),b=await f.add('ETHUSDT');await f.tick();await f.tick(99,'ETHUSDT');f.advance(30001);await f.tick();
  assert.equal(readiness(f.runner,a).state,'READY');assert.equal(readiness(f.runner,b).state,'STALE');f.transport.lastHeartbeatAt=f.runner.now();assert.equal(readiness(f.runner,b).state,'STALE');
});
test('fresh data without successful baseline evaluation is WAITING_FOR_BASELINE; exception is FAILED',async t=>{
  const f=await fixture(t),a=await f.add();await f.tick();f.runner.evaluations.delete(a.id);assert.equal(readiness(f.runner,a).state,'WAITING_FOR_BASELINE');
  f.runner.core={...core,processMarketEvent(){throw Error('detector failed');}};await f.tick();assert.equal(readiness(f.runner,a).state,'FAILED');assert.equal(f.runner.processing.lastError.code,'ALERT_PROCESSING_FAILED');
});
test('new socket invalidates previous data and safely re-establishes price baseline',async t=>{
  const f=await fixture(t),a=await f.add();await f.tick();f.transport.socket={readyState:1};f.transport.topicEvidence.set('btcusdt@ticker',{socket:f.transport.socket,requestedAt:f.runner.now(),acknowledgement:'acknowledged',lastAckAt:f.runner.now()});
  assert.notEqual(readiness(f.runner,a).state,'READY');await f.tick(101);assert.equal(f.runner.events().length,0);assert.equal(readiness(f.runner,a).state,'READY');
});

test('replacing the last alert cannot carry an old socket baseline into the new alert ID',async t=>{
  const f=await fixture(t),a=await f.add();await f.tick(99);await f.runner.remove(a.id);const b=await f.add();f.transport.socket={readyState:1};f.transport.topicEvidence.set('btcusdt@ticker',{socket:f.transport.socket,requestedAt:f.runner.now(),acknowledgement:'acknowledged',lastAckAt:f.runner.now()});await f.tick(101);assert.equal(f.runner.events().length,0);assert.equal(readiness(f.runner,b).state,'READY');
});
test('missing movement/volume baseline stays waiting and unsupported is not runtime failure',async t=>{
  const f=await fixture(t),a=await f.add('BTCUSDT',{type:'volume',timeframe:'1h',multiplier:5});
  f.transport.topicEvidence.set('btcusdt@kline_1h',{socket:f.transport.socket,requestedAt:f.runner.now(),acknowledgement:'acknowledged',lastAckAt:f.runner.now()});
  await f.runner.enqueue({exchange:'binance',symbol:'BTCUSDT',eventType:'candle',interval:'1h',price:100,open:100,volume:1,averageVolume:null,timestamp:f.runner.now()});assert.equal(readiness(f.runner,a).state,'WAITING_FOR_BASELINE');
  const unsupported={...a,exchange:'kraken',marketId:'kraken:spot:XXBTZUSD',symbol:'XXBTZUSD'};assert.equal(readiness(f.runner,unsupported).state,'UNSUPPORTED');
});
test('hanging Push cannot delay persistence or subsequent evaluation',async t=>{
  let invoked=0;const f=await fixture(t,()=>{invoked++;return new Promise(()=>{});});await f.add();await f.tick(99);await f.tick(101);await f.tick(102);
  assert.equal(f.storage.loadTriggerHistory().length,1);assert.equal(invoked,1);const delivery=f.runner.diagnostics().notificationDelivery.latest[0];assert.equal(delivery.execution,'SUCCESS');assert.equal(delivery.push,'PENDING');
});
test('Push failure happens after durable write and never changes execution success',async t=>{
  let f;f=await fixture(t,async event=>{const disk=JSON.parse(await fs.readFile(f.storage.file,'utf8'));assert.ok(disk.history.some(e=>e.id===event.id));throw Error('push failure');});await f.add();await f.tick(99);await f.tick(101);await new Promise(resolve=>setTimeout(resolve,20));
  const delivery=f.runner.diagnostics().notificationDelivery.latest[0];assert.equal(delivery.trigger,'PERSISTED');assert.equal(delivery.execution,'SUCCESS');assert.equal(delivery.push,'FAILED');
});
test('failed write is truthful, suppresses Push, and subsequent write chain recovers',async t=>{
  let sent=0;const f=await fixture(t,async()=>{sent++;return {outcome:'ACCEPTED'};});const a=await f.add();await f.tick(99);
  const original=f.storage.file;f.storage.file=path.join(f.directory,'missing','alerts.json');await f.tick(101);
  assert.equal(f.storage.status().initialized,true);assert.equal(f.storage.status().healthy,false);assert.equal(f.storage.status().lastWriteSucceeded,false);assert.equal(readiness(f.runner,a).state,'FAILED');assert.equal(sent,0);assert.equal(f.runner.diagnostics().notificationDelivery.latest[0].execution,'FAILED');
  f.storage.file=original;await f.tick(102);assert.equal(f.storage.status().healthy,true);assert.equal(f.storage.loadTriggerHistory().length,1);assert.equal(sent,1);
});
test('restart reloads alert/history but does not replay notifications or historical baseline',async t=>{
  const f=await fixture(t);await f.add();await f.tick(99);await f.tick(101);await f.runner.stop();
  let sent=0;const storage=new JsonStorageAdapter({directory:f.directory,core,logger:silent});await storage.init();const runner=new ServerAlertRunner({core,storage,transport:f.transport,notifier:{notify(){sent++;}},logger:silent,now:f.runner.now});await runner.start();
  assert.equal(runner.events().length,1);assert.equal(runner.previousPrices.size,0);assert.equal(sent,0);assert.equal(runner.diagnostics().notificationDelivery.latest.length,0);await runner.stop();
});
test('Bybit ACK is correlated per batch; data never fabricates missing ACK',async t=>{
  class Socket { constructor(){this.readyState=1;this.handlers={};this.sent=[];}addEventListener(k,fn){this.handlers[k]=fn;}send(s){this.sent.push(JSON.parse(s));}close(){this.readyState=3;} }
  const transport=new BybitMarketTransport({logger:silent,WebSocketImpl:Socket,now:()=>1800000000000});t.after(()=>transport.stop());
  const alerts=Array.from({length:11},(_,i)=>core.createAlert({...definition(`A${i}USDT`),exchange:'bybit',marketId:`bybit:spot:A${i}USDT`},{id:`a${i}`}));await transport.start(alerts);const s=transport.socket;s.handlers.open();const batches=s.sent.filter(x=>x.op==='subscribe');assert.equal(batches.length,2);
  s.handlers.message({data:JSON.stringify({op:'subscribe',success:true,req_id:batches[0].req_id})});
  assert.equal(transport.topicEvidence.get(batches[0].args[0]).acknowledgement,'acknowledged');assert.equal(transport.topicEvidence.get(batches[1].args[0]).acknowledgement,'pending');
  s.handlers.message({data:JSON.stringify({op:'subscribe',success:false,req_id:batches[1].req_id})});assert.equal(transport.topicEvidence.get(batches[1].args[0]).acknowledgement,'rejected');
});

test('volume diagnostics require all 20 prior candles; detector semantics remain unchanged',async t=>{
  const f=await fixture(t),a=await f.add('BTCUSDT',{type:'volume',timeframe:'1h',multiplier:5});f.transport.baselines=new Map([['BTCUSDT:1h',Array(19).fill(10)]]);
  f.transport.topicEvidence.set('btcusdt@kline_1h',{socket:f.transport.socket,requestedAt:f.runner.now(),acknowledgement:'acknowledged',lastAckAt:f.runner.now()});
  const e={exchange:'binance',symbol:'BTCUSDT',eventType:'candle',interval:'1h',price:100,open:100,volume:1,averageVolume:10,timestamp:f.runner.now()};await f.runner.enqueue(e);assert.equal(readiness(f.runner,a).state,'WAITING_FOR_BASELINE');f.transport.baselines.get('BTCUSDT:1h').push(10);await f.runner.enqueue(e);assert.equal(readiness(f.runner,a).state,'READY');
});
test('processing queue delay cannot refresh receipt time and old-socket queued events are discarded',async t=>{
  const f=await fixture(t),a=await f.add();let release;f.runner.queue=new Promise(resolve=>release=resolve);const pending=f.tick();f.advance(30001);release();await pending;assert.equal(readiness(f.runner,a).state,'STALE');
  f.runner.queue=new Promise(resolve=>release=resolve);const old=f.tick(101);f.transport.socket={readyState:1};release();await old;assert.equal(f.runner.events().length,0);assert.notEqual(readiness(f.runner,a).state,'READY');
});
test('a second detector exception cannot discard the first alert TriggerEvent',async t=>{
  const f=await fixture(t);await f.add();const b=await f.add('BTCUSDT',{type:'price',operator:'above',value:100.5});await f.tick(99);
  f.runner.core={...core,processMarketEvent(a,...args){if(a.id===b.id)throw Error('isolated detector');return core.processMarketEvent(a,...args);}};await f.tick(101);assert.equal(f.storage.loadTriggerHistory().length,1);assert.equal(f.runner.events().length,1);assert.equal(readiness(f.runner,b).state,'FAILED');
});
test('paused/unsupported are separate, detail arrays are bounded and do not expose conditions',async t=>{
  const f=await fixture(t),a=await f.add();f.runner.alerts=Array.from({length:205},(_,i)=>({...a,id:`a${i}`,status:i===0?'paused':'active'}));const d=f.runner.diagnostics().reliability;assert.equal(d.details.length,200);assert.equal(d.omittedDetails,5);assert.equal(d.counts.total,204);assert.equal(d.details[0].state,'PAUSED');assert.equal(JSON.stringify(d).includes('"condition"'),false);
});

for(const exchange of ['binance','bybit','okx','bingx','coinbase','kraken'])test(`${exchange} real adapter: socket/ACK-only not READY; exact usable data establishes baseline and readiness`,async t=>{
  class Socket {constructor(){this.readyState=0;this.handlers={};this.sent=[];}addEventListener(k,f){this.handlers[k]=f;}send(s){try{this.sent.push(JSON.parse(s));}catch{}}close(){this.readyState=3;}open(){this.readyState=1;this.handlers.open();}frame(p){this.handlers.message({data:typeof p==='string'?p:JSON.stringify(p)});}}
  const symbol=({binance:'BTCUSDT',bybit:'BTCUSDT',okx:'BTC-USDT',bingx:'BTC-USDT',coinbase:'BTC-USD',kraken:'XXBTZUSD'})[exchange],quoteAsset=['coinbase','kraken'].includes(exchange)?'USD':'USDT';
  const product={product_id:symbol,base_currency_id:'BTC',quote_currency_id:quoteAsset,product_type:'SPOT',status:'online',alias:'',is_disabled:false,trading_disabled:false,cancel_only:false,post_only:false,auction_mode:false,limit_only:false};
  const row={nativeSymbol:symbol,wsSymbol:'BTC/USD',baseAsset:'BTC',quoteAsset};
  const names={binance:'BinanceMarketTransport',bybit:'BybitMarketTransport',okx:'OkxMarketTransport',bingx:'BingxMarketTransport',coinbase:'CoinbaseMarketTransport',kraken:'KrakenMarketTransport'};
  const Constructor=require(`../server/transports/${exchange}-market-transport`)[names[exchange]];
  const transport=new Constructor({logger:silent,WebSocketImpl:Socket,products:async()=>({products:[product]}),registry:{catalog:async()=>({byNative:new Map([[symbol,row]])})}});
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'zych-12c-protocol-')),storage=new JsonStorageAdapter({directory,core,logger:silent});await storage.init();
  const alert=core.createAlert({...definition(),exchange,marketId:`${exchange}:spot:${symbol}`,symbol,quoteAsset},{id:'exact'});await storage.save([alert],[]);
  const runner=new ServerAlertRunner({core,storage,transport,logger:silent,notifier:{notify:async()=>{}}});t.after(async()=>{await runner.stop();if(path.dirname(directory)!==os.tmpdir())throw Error('unsafe cleanup');await fs.rm(directory,{recursive:true,force:true});});await runner.start();
  const leaf=exchange==='kraken'?transport.channels[0]:transport,socket=exchange==='okx'?transport.sockets.get('public'):leaf.socket;socket.open();assert.notEqual(readiness(runner,alert).state,'READY');
  if(exchange==='binance')socket.frame({id:socket.sent[0].id,result:null});
  if(exchange==='bybit')socket.frame({op:'subscribe',success:true,req_id:socket.sent[0].req_id});
  if(exchange==='okx')socket.frame({event:'subscribe',arg:socket.sent[0].args[0]});
  if(exchange==='bingx')socket.frame({id:socket.sent[0].id,code:0});
  if(exchange==='coinbase')socket.frame({channel:'subscriptions',sequence_num:0,events:[{subscriptions:{market_trades:[symbol],heartbeats:['heartbeats']}}]});
  if(exchange==='kraken')socket.frame({method:'subscribe',req_id:socket.sent[0].req_id,success:true,result:{...socket.sent[0].params,symbol:'BTC/USD'}});
  await leaf.context?.queue;assert.notEqual(readiness(runner,alert).state,'READY');const now=Date.now();
  if(exchange==='binance')socket.frame({e:'24hrTicker',s:symbol,c:'99',E:now});
  if(exchange==='bybit')socket.frame({topic:`tickers.${symbol}`,ts:now,data:{symbol,lastPrice:'99'}});
  if(exchange==='okx')socket.frame({arg:{channel:'tickers',instId:symbol},data:[{last:'99',ts:String(now)}]});
  if(exchange==='bingx')socket.frame({dataType:`${symbol}@lastPrice`,data:{s:symbol,c:'99',T:now}});
  if(exchange==='coinbase')socket.frame({channel:'market_trades',sequence_num:1,events:[{type:'update',trades:[{trade_id:'1',product_id:symbol,price:'99',size:'0.1',time:new Date(now).toISOString()}]}]});
  if(exchange==='kraken')socket.frame({channel:'trade',type:'update',data:[{symbol:'BTC/USD',trade_id:1,price:99,qty:0.1,timestamp:new Date(now).toISOString()}]});
  await leaf.context?.queue;await runner.queue;const detail=readiness(runner,alert);assert.equal(detail.state,'READY');assert.equal(detail.baseline,'READY');assert.equal(runner.events().length,0);
});
