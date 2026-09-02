'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const chart=require('../js/exchanges/coinbase-chart.js'),{CoinbaseBrowserAdapter}=require('../js/exchanges/browser-exchange-adapters.js');
const {candleQuery}=require('../server/coinbase-public-proxy.js');
const market={id:'coinbase:spot:BTC-USD',symbol:'BTC-USD',exchange:'coinbase',marketType:'spot',baseAsset:'BTC',quoteAsset:'USD'};
const now=Date.UTC(2026,8,2,12,0,30),row=time=>({start:String(time),open:'100',high:'110',low:'90',close:'101',volume:'10'});
function adapter(options={}){const a=new CoinbaseBrowserAdapter({now:()=>now,...options});a.catalogMetadata=[{productId:'BTC-USD',unsupportedReason:null}];return a;}
function response(candles){return new Response(JSON.stringify({candles}),{headers:{'content-type':'application/json'}});}
class Socket{readyState=0;listeners={};sent=[];addEventListener(k,fn){(this.listeners[k]??=[]).push(fn);}emit(k,value){for(const fn of this.listeners[k]||[])fn(value);}send(s){this.sent.push(JSON.parse(s));}open(){this.readyState=1;this.emit('open');}close(){this.readyState=3;this.emit('close',{});}message(value){this.emit('message',{data:JSON.stringify(value)});}}
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const trade=(id,time=now,extra={})=>({trade_id:String(id),product_id:'BTC-USD',time:new Date(time).toISOString(),price:'105',size:'2',...extra});
function stream(t){let ws;const candles=[],statuses=[],repairs=[],a=adapter({socketFactory:()=>ws=new Socket(),fetchImpl:async url=>{const p=new URL(url,'http://local').searchParams;return response([row(chart.bucket(now/1000,'1m'))].filter(r=>Number(r.start)>=Number(p.get('start'))&&Number(r.start)<=Number(p.get('end'))));}});a.socket(market,'1m',{candle:c=>candles.push(c),status:s=>statuses.push(s),reconcile:r=>repairs.push(r),error:()=>{}});t.after(()=>ws.close());return{a,ws,candles,statuses,repairs};}
test('all eight exact buckets, Monday week and calendar month',()=>{
  for(const [frame,granularity] of Object.entries(chart.intervals)){assert.ok(granularity);const b=chart.bucket(now/1000,frame);assert.ok(b<=now/1000);assert.ok(chart.shift(b,frame,1)>now/1000);}
  assert.equal(chart.bucket(Date.UTC(2026,7,30,23,59)/1000,'1w'),Date.UTC(2026,7,24)/1000);
  assert.equal(chart.bucket(Date.UTC(2026,7,31)/1000,'1M'),Date.UTC(2026,7,1)/1000);
  assert.equal(chart.shift(Date.UTC(2026,0,1)/1000,'1M',1),Date.UTC(2026,1,1)/1000);
});
for(const frame of Object.keys(chart.intervals))test(`REST ${frame} bounded multi-request page, ascending exact dedup`,async()=>{
  const calls=[],a=adapter({fetchImpl:async(url,options)=>{const p=new URL(url,'http://local').searchParams;candleQuery(p);calls.push(p);assert.equal(options.credentials,'omit');let time=chart.bucket(Number(p.get('end')),frame),rows=[];while(time>=Number(p.get('start'))){rows.push(row(time));time=chart.shift(time,frame,-1);}return response(rows);}});
  const rows=await a.candles(market,frame,null,frame==='1M'?100:1000);if(frame==='1w')assert.ok(rows.length>350&&rows.length<1000);else assert.equal(rows.length,frame==='1M'?100:1000);assert.equal(new Set(rows.map(r=>r.time)).size,rows.length);assert.deepEqual(rows.map(r=>r.time),rows.map(r=>r.time).sort((a,b)=>a-b));assert.ok(calls.every(p=>p.get('limit')==='350'));
});
test('sparse and empty windows retain bounded continuation; abort and undocumented rejection honest',async()=>{
  let calls=0;const a=adapter({fetchImpl:async()=>{calls++;return response([]);}});const rows=await a.candles(market,'1m',null,1000);assert.equal(calls,20);assert.equal(rows.exhausted,false);assert.ok(rows.nextEndTime<now);
  const abort=new AbortController();abort.abort();await assert.rejects(a.candles(market,'1m',null,1000,abort.signal),{name:'AbortError'});
  a.fetchImpl=async()=>new Response('',{status:400});await assert.rejects(a.candles(market,'1M',null,1),/undocumented/);
  await assert.rejects(a.candles({...market,symbol:'BTC-USDC'},'1m',null,1),/admitted/);
});
test('narrow query rejects unknown, duplicated, unbounded and arbitrary upstream inputs',()=>{
 const good=new URLSearchParams({product_id:'BTC-USD',granularity:'ONE_MINUTE',start:'1788350400',end:'1788350459',limit:'350'});assert.equal(candleQuery(good).product,'BTC-USD');
 for(const [key,value] of [['url','https://example.com'],['limit','1000'],['end','999999999999'],['product_id','../BTC-USD']]){const p=new URLSearchParams(good);p.set(key,value);assert.throws(()=>candleQuery(p));}
 const p=new URLSearchParams(good);p.append('start','1');assert.throws(()=>candleQuery(p));
});
test('socket open and heartbeat are not LIVE; exact ACK stays separate from data before ACK',async t=>{
 const s=stream(t);s.ws.open();await flush();assert.equal(s.ws.sent.length,2);assert.deepEqual(s.ws.sent[0].product_ids,['BTC-USD']);assert.ok(!s.statuses.includes('LIVE'));
 s.ws.message({channel:'heartbeats',sequence_num:0,events:[]});assert.ok(s.ws.coinbaseState.lastHeartbeat);assert.ok(!s.statuses.includes('LIVE'));
 s.ws.message({channel:'market_trades',sequence_num:1,events:[{type:'update',trades:[trade(1)]}]});assert.equal(s.ws.coinbaseState.confirmed.length,0);assert.equal(s.statuses.at(-1),'LIVE');
 s.ws.message({channel:'subscriptions',sequence_num:2,events:[{subscriptions:{market_trades:['BTC-USD'],heartbeats:['heartbeats']}}]});assert.equal(s.ws.coinbaseState.confirmed.length,2);
});
test('snapshot, wrong product, trade ID replays and same-timestamp legitimate trades',async t=>{
 const s=stream(t);s.ws.open();await flush();
 s.ws.message({channel:'market_trades',sequence_num:0,events:[{type:'snapshot',trades:[trade(1)]}]});assert.equal(s.candles.length,0);
 s.ws.message({channel:'market_trades',sequence_num:1,events:[{type:'update',trades:[trade(1),trade(2,now,{product_id:'BTC-USDT'}),trade(3),trade(4)]}]});assert.equal(s.candles.length,2);assert.equal(s.candles.at(-1).volume,null);assert.equal(s.candles.at(-1).provisional,true);
});
test('sequence duplicate/out of order suppressed, gap recovers, stale messages ignored',async t=>{
 const s=stream(t);s.ws.open();await flush();const message=seq=>({channel:'market_trades',sequence_num:seq,events:[{type:'update',trades:[trade(seq+1)]}]});
 s.ws.message(message(5));s.ws.message(message(5));s.ws.message(message(4));assert.equal(s.candles.length,1);assert.equal(s.ws.coinbaseState.duplicates,2);
 s.ws.message(message(7));assert.equal(s.statuses.at(-1),'RECOVERING');assert.equal(s.ws.readyState,3);s.ws.message(message(8));assert.equal(s.candles.length,1);
 const fresh=s.a.socket(market,'1m',{});assert.equal(fresh.coinbaseState.sequence,null);assert.deepEqual(fresh.coinbaseState.confirmed,[]);fresh.close();
});
test('rollover builds real OHLC and base volume without REST overlap',async t=>{
 const s=stream(t);s.ws.open();await flush();const next=chart.shift(chart.bucket(now/1000,'1m'),'1m',1)*1000;
 s.ws.message({channel:'market_trades',sequence_num:0,events:[{type:'update',trades:[trade(3,next,{price:'103'}),trade(1,next,{price:'101'}),trade(2,next,{price:'109'})]}]});
 const c=s.candles.at(-1);assert.deepEqual([c.open,c.high,c.low,c.close,c.volume],[101,109,101,103,6]);assert.equal(c.provisional,true);
});
for(const frame of Object.keys(chart.intervals))test(`trade aggregation ${frame}, cross-message source order and rollover`,async t=>{
 let ws;const updates=[],a=adapter({socketFactory:()=>ws=new Socket(),fetchImpl:async()=>response([])});
 a.socket(market,frame,{candle:c=>updates.push(c),error:()=>{}});t.after(()=>ws.close());ws.open();await flush();
 const next=chart.shift(chart.bucket(now/1000,frame),frame,1)*1000;
 ws.message({channel:'market_trades',sequence_num:0,events:[{type:'update',trades:[trade(3,next,{price:'103'})]}]});
 ws.message({channel:'market_trades',sequence_num:1,events:[{type:'update',trades:[trade(1,next,{price:'101'}),trade(2,next,{price:'109'})]}]});
 const c=updates.at(-1);assert.deepEqual([c.time,c.open,c.high,c.low,c.close,c.volume],[next/1000,101,109,101,103,6]);
});
test('Watchlist persistence keeps native quote identities and never resolves excluded alias',()=>{
 const watch=require('../js/services/watchlist-markets.js'),context=require('../js/services/market-context.js');
 const markets=['USD','USDC','USDT'].map(quoteAsset=>({...market,id:`coinbase:spot:BTC-${quoteAsset}`,symbol:`BTC-${quoteAsset}`,quoteAsset}));
 let items=[];for(const m of markets)items=watch.toggle(items,m);assert.equal(items.length,3);
 items=watch.migrate(JSON.parse(JSON.stringify([...items,items[0]])),{markets});assert.equal(items.length,3);
 assert.equal(watch.resolve(items[1],markets.filter(m=>m.quoteAsset!=='USDC')),null);assert.equal(watch.resolve(items[0],markets).id,market.id);
 assert.equal(watch.toggle(items,market).length,2);assert.ok(context);
});
test('history continuation handles bounded empty scans without ending other exchanges early',async()=>{
 const fs=require('node:fs'),vm=require('node:vm'),sandbox={window:{},Date};vm.runInNewContext(fs.readFileSync(require.resolve('../js/services/chart-history.js'),'utf8'),sandbox);
 let calls=0;const a={candles:async()=>{calls++;const rows=calls===1?[]:[{time:10,open:1,high:1,low:1,close:1,volume:1}];rows.nextEndTime=calls===1?1000:0;rows.exhausted=calls!==1;return rows;}};
 const service=new sandbox.window.ZychChartHistory.ChartHistoryService({adapters:{coinbase:a}}),result=await service.initial(market,'1m');assert.equal(calls,2);assert.equal(result.data.length,1);assert.equal(result.endReached,true);
 const other=new sandbox.window.ZychChartHistory.ChartHistoryService({adapters:{binance:{candles:async()=>[]}}});assert.equal((await other.initial({...market,exchange:'binance'},'1m')).endReached,true);
});
test('aborted repair cannot publish after socket close',async()=>{
 let resolve,ws;const updates=[],a=adapter({socketFactory:()=>ws=new Socket(),fetchImpl:()=>new Promise(r=>resolve=r)});
 a.socket(market,'1m',{candle:c=>updates.push(c),reconcile:c=>updates.push(c)});ws.open();ws.close();resolve(response([row(now/1000|0)]));await flush();assert.equal(updates.length,0);
});
test('fractional timestamp precision preserves source order and equal-time trade IDs',()=>{
 const a=trade(1,now,{time:'2026-09-02T12:00:00.1Z'}),b=trade(2,now,{time:'2026-09-02T12:00:00.100000000Z'}),c=trade(3,now,{time:'2026-09-02T12:00:00.100000001Z'});
 assert.ok(chart.compareTrades(a,b)<0);assert.ok(chart.compareTrades(b,c)<0);assert.equal(chart.compareTrades(a,a),0);
});
test('REST page overlap is deduplicated and the next logical page excludes retained candles',async()=>{
 const a=adapter({fetchImpl:async url=>{const p=new URL(url,'http://local').searchParams;let end=chart.bucket(Number(p.get('end')),'1m');return response(Array.from({length:350},(_,i)=>row(end-i*60)));}});
 const first=await a.candles(market,'1m',null,1000),second=await a.candles(market,'1m',first.nextEndTime,1000);
 assert.equal(first.length,1000);assert.equal(second.length,1000);assert.equal(second.at(-1).time,first[0].time-60);
});
test('malformed exact trades degrade instead of silently losing candle coverage',async t=>{
 const s=stream(t);s.ws.open();await flush();s.ws.message({channel:'market_trades',sequence_num:0,events:[{type:'update',trades:[trade(1,now,{price:'Infinity'})]}]});assert.equal(s.statuses.at(-1),'RECOVERING');assert.equal(s.candles.length,0);
});
test('initial sparse scan budget yields usable continuation without fabricated exhaustion',async()=>{
 const fs=require('node:fs'),vm=require('node:vm'),sandbox={window:{},Date};vm.runInNewContext(fs.readFileSync(require.resolve('../js/services/chart-history.js'),'utf8'),sandbox);
 let calls=0;const a={initialPageBudget:2,candles:async()=>{calls++;const rows=[];rows.nextEndTime=now-calls*1000;rows.exhausted=false;return rows;}};
 const service=new sandbox.window.ZychChartHistory.ChartHistoryService({adapters:{coinbase:a}});const first=await service.initial(market,'1m');assert.equal(calls,2);assert.equal(first.endReached,false);await service.older(market,'1m');assert.equal(calls,3);
});
test('confirmed quiet feed waits for trades instead of claiming LIVE from heartbeats',async t=>{
 const s=stream(t);s.ws.open();await flush();s.ws.message({channel:'subscriptions',sequence_num:0,events:[{subscriptions:{market_trades:['BTC-USD'],heartbeats:['heartbeats']}}]});s.ws.message({channel:'heartbeats',sequence_num:1,events:[]});assert.equal(s.statuses.at(-1),'WAITING');assert.equal(s.ws.coinbaseState.lastTrade,null);
});
