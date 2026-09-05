'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),{gzipSync}=require('node:zlib');
const {BingxBrowserAdapter,bingxInterval,bingxWsInterval,decodeBingxFrame,bingxCandle}=require('../js/exchanges/browser-exchange-adapters');
const watch=require('../js/services/watchlist-markets'),core=require('../js/alerts/alert-core');
const market={id:'bingx:spot:BTC-USDT',exchange:'bingx',marketType:'spot',symbol:'BTC-USDT',baseAsset:'BTC',asset:'BTC',quoteAsset:'USDT',enabled:true};
const row=(time=1700000000000)=>[time,'10','12','9','11','2',time+59999,'22'];
const response=data=>({ok:true,json:async()=>({code:0,data})});
const history=()=>{const window={};vm.runInNewContext(fs.readFileSync(require.resolve('../js/services/chart-history'),'utf8'),{window,AbortController,DOMException,setTimeout,clearTimeout,fetch:()=>{throw Error('Unexpected fallback')}});return window.ZychChartHistory;};
class Socket {
  constructor(){this.events={};this.sent=[];this.readyState=0;}
  addEventListener(name,fn){(this.events[name]??=[]).push(fn);}
  emit(name,data){for(const fn of this.events[name]||[])fn(data);}
  open(){this.readyState=1;this.emit('open');}
  send(value){this.sent.push(value);}
  close(){this.readyState=3;this.emit('close',{});}
  message(value){this.emit('message',{data:typeof value==='string'?value:JSON.stringify(value)});}
}
const drain=()=>new Promise(resolve=>setImmediate(resolve));
const packet=(time=1700000000000)=>({code:0,success:true,dataType:'BTC-USDT@kline_1min',data:{s:'BTC-USDT',K:{t:time,T:time+59999,o:'10',h:'12',l:'9',c:'11',v:'2'}}});
function stream(options={}){const socket=new Socket(),states=[],candles=[],errors=[];const adapter=new BingxBrowserAdapter({socketFactory:()=>socket,now:()=>1700000001000,...options});adapter.socket(market,'1m',{open:()=>states.push('OPEN'),status:s=>states.push(s),candle:c=>candles.push(c),error:e=>errors.push(e.message),close:()=>states.push('CLOSE')});socket.open();return{socket,adapter,states,candles,errors,id:JSON.parse(socket.sent[0]).id};}

test('BingX Watchlist canonical add/remove, reload, dedup and four exchange distinction',()=>{
  const markets=['binance','bybit','okx','bingx'].map(exchange=>({...market,exchange,symbol:['binance','bybit'].includes(exchange)?'BTCUSDT':'BTC-USDT',id:`${exchange}:spot:${['binance','bybit'].includes(exchange)?'BTCUSDT':'BTC-USDT'}`}));
  let items=[];for(const item of markets)items=watch.toggle(items,item);
  assert.equal(items.length,4);assert.equal(items[3].key,market.id);assert.equal(items[3].marketId,market.id);
  const reloaded=watch.migrate(JSON.parse(JSON.stringify([...items,items[3]])),{markets});assert.deepEqual(reloaded,items);assert.equal(watch.resolve(reloaded[3],markets).symbol,'BTC-USDT');
  assert.equal(watch.toggle(reloaded,market).length,3);
});
test('BingX REST exact v2, native symbol, every interval, capped limit and timestamp parameters',async()=>{
  const urls=[],adapter=new BingxBrowserAdapter({fetchImpl:async url=>{urls.push(new URL(url));return response([row(1700000060000),row(),row()]);}});
  for(const interval of Object.keys(bingxInterval)){
    const rows=await adapter.candles(market,interval,1700000200000,2000,null,1699990000000),url=urls.at(-1);
    assert.equal(url.pathname,'/openApi/spot/v2/market/kline');assert.equal(url.searchParams.get('symbol'),'BTC-USDT');assert.equal(url.searchParams.get('interval'),interval);assert.equal(url.searchParams.get('limit'),'1440');assert.equal(url.searchParams.get('startTime'),'1699990000000');assert.equal(url.searchParams.get('endTime'),'1700000200000');assert.deepEqual(rows.map(c=>c.time),[1700000000,1700000060]);assert.equal(rows[0].quoteVolume,22);assert.equal(rows[0].closeTime,1700000059999);
  }
  await assert.rejects(adapter.candles(market,'2m'),/Unsupported BingX interval/);await assert.rejects(adapter.candles({...market,exchange:'binance'},'1m'),/Invalid BingX/);
});
test('BingX REST rejects missing prices, invalid candles and malformed envelopes without zero fabrication',async()=>{
  for(const invalid of [null,undefined,'','NaN',Infinity]){const value=row();value[1]=invalid;assert.equal(bingxCandle(value),null);}
  assert.equal(bingxCandle([1,1,0,2,1,1]),null);assert.equal(bingxCandle(row().slice(0,6)).quoteVolume,null);
  for(const body of [{code:1,data:[]},{code:0,data:{}},{code:0,data:[[1,null,1,1,1,1]]}]){const adapter=new BingxBrowserAdapter({fetchImpl:async()=>({ok:true,json:async()=>body})});await assert.rejects(adapter.candles(market,'1m'));}
});
test('BingX REST abort before/during fetch propagates cancellation',async()=>{
  for(const pre of [true,false]){const controller=new AbortController();if(pre)controller.abort();const adapter=new BingxBrowserAdapter({fetchImpl:async(url,{signal})=>new Promise((resolve,reject)=>{if(signal.aborted)return reject(signal.reason);signal.addEventListener('abort',()=>reject(signal.reason));})});const pending=adapter.candles(market,'1m',null,2,controller.signal);if(!pre)controller.abort();await assert.rejects(pending,{name:'AbortError'});}
});
test('BingX generic history pagination uses oldest-1; partial, empty, dedup and cancellation remain safe',async()=>{
  const {ChartHistoryService}=history(),ends=[];let count=0;
  const adapter=new BingxBrowserAdapter({fetchImpl:async url=>{const params=new URL(url).searchParams;ends.push(params.get('endTime'));const n=count++;return response(n===0?Array.from({length:1000},(_,i)=>row(1700000000000+i*60000)):n===1?[row(1699999940000)]:[]);}});
  const service=new ChartHistoryService({adapters:{bingx:adapter}}),result=await service.initial(market,'1w');assert.equal(result.data.length,1000);
  const older=await service.older(market,'1w');assert.equal(ends[1],'1699999999999');assert.equal(older.added,1);assert.equal(older.endReached,true);assert.equal(new Set(older.data.map(c=>c.time)).size,1001);
  const empty=new ChartHistoryService({adapters:{bingx:{candles:async()=>[]}}});assert.equal((await empty.initial(market,'1m')).endReached,true);
  const controller=new AbortController(),cancelled=new ChartHistoryService({adapters:{bingx:{candles:async()=>{controller.abort();return [bingxCandle(row())];}}}});await assert.rejects(cancelled.initial(market,'1m',controller.signal),{name:'AbortError'});assert.equal(cancelled.entry(market,'1m').candles.length,0);
  await assert.rejects(new ChartHistoryService().request(market,'1m'),/adapter unavailable/);
});
test('BingX initial chart history is one responsive native page and retains lazy backward pagination',async()=>{
  const {ChartHistoryService}=history(),urls=[];
  const adapter=new BingxBrowserAdapter({fetchImpl:async url=>{urls.push(new URL(url));return response(Array.from({length:1000},(_,i)=>row(1700000000000+i*3600000)));}});
  const result=await new ChartHistoryService({adapters:{bingx:adapter}}).initial(market,'1h');
  assert.equal(adapter.initialPageBudget,1);assert.equal(urls.length,1);assert.equal(urls[0].searchParams.get('symbol'),'BTC-USDT');assert.equal(urls[0].searchParams.get('interval'),'1h');assert.equal(urls[0].searchParams.get('limit'),'1000');
  assert.equal(result.data.length,1000);assert.equal(result.pages,1);assert.equal(result.endReached,false);
});
test('BingX successful initial history reaches chart delivery and live startup with exact identity',async()=>{
  const source=fs.readFileSync(require.resolve('../app.js'),'utf8'),start=source.indexOf('  async function selectMarketData('),end=source.indexOf('\n  const chartContainer=',start),calls=[],nodes={'chart':{dataset:{}},'chart-data-age':{textContent:''}};
  const scope={market,AbortController,document:{getElementById:id=>nodes[id]},historyService:{initial:async(value,timeframe,signal)=>{calls.push(['history',value.id,value.symbol,timeframe,signal.aborted]);return{data:[bingxCandle(row())],cached:false,cacheStoredAt:1};}},stopMarket(){},openLive:value=>calls.push(['live',value.market.id,value.market.symbol,value.timeframe])};
  vm.createContext(scope);vm.runInContext(`let generation=0,activeController=null;${source.slice(start,end)};this.selectMarketData=selectMarketData`,scope);
  const statuses=[],candles=[];await scope.selectMarketData(market,'1h',{onStatus:value=>statuses.push(value),onCandles:value=>candles.push(value),onCandle(){},onError:error=>assert.fail(error.message)});
  assert.deepEqual(calls.map(value=>value.slice(0,4)),[['history','bingx:spot:BTC-USDT','BTC-USDT','1h'],['live','bingx:spot:BTC-USDT','BTC-USDT','1h']]);assert.deepEqual(statuses,['CONNECTING']);assert.equal(candles[0].length,1);
});
test('BingX terminal history failure is timeout-bounded without retry storms',async()=>{
  let calls=0;const adapter=new BingxBrowserAdapter({historyTimeoutMs:5,fetchImpl:async(_url,{signal})=>{calls++;return new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});}});
  await assert.rejects(adapter.candles(market,'1h'),error=>error.name==='TimeoutError');assert.equal(calls,1);
});
test('BingX live cache replaces same candle, rolls forward and ignores older timestamps',()=>{
  const service=new (history().ChartHistoryService)(),first=bingxCandle(row());service.updateLive(market,'1m',first);service.updateLive(market,'1m',{...first,close:12});service.updateLive(market,'1m',{...first,time:first.time+60});service.updateLive(market,'1m',{...first,time:first.time-60});assert.equal(service.entry(market,'1m').candles.length,2);assert.equal(service.entry(market,'1m').candles[0].close,12);
});
test('BingX browser GZIP decoder handles ArrayBuffer/Blob, rejects corrupt and oversized frames',async()=>{
  const compressed=gzipSync(JSON.stringify(packet()));assert.deepEqual(JSON.parse(await decodeBingxFrame(compressed)),packet());assert.equal(await decodeBingxFrame(new Blob([gzipSync('Ping')])),'Ping');await assert.rejects(decodeBingxFrame(new Uint8Array([1,2,3])));await assert.rejects(decodeBingxFrame(gzipSync('x'.repeat(1048577))),/too large/);
});
test('BingX open is SUBSCRIBING, heartbeat sends Pong, matching zero ack still waits for data',async()=>{
  const s=stream();try{assert.equal(s.states.at(-1),'SUBSCRIBING');assert.equal(JSON.parse(s.socket.sent[0]).dataType,'BTC-USDT@kline_1min');s.socket.message('Ping');s.socket.message({id:'unrelated',code:0});await drain();assert.equal(s.socket.sent.at(-1),'Pong');assert.equal(s.states.includes('LIVE'),false);s.socket.message({id:s.id,code:0});await drain();assert.equal(s.states.at(-1),'WAITING_FOR_DATA');assert.equal(s.candles.length,0);}finally{s.socket.close();}
});
test('BingX negative ack and malformed subscribed payload fail closed',async()=>{
  for(const failure of ['ack','candle','gzip']){const s=stream();s.socket.message(failure==='ack'?{id:s.id,code:100400}:failure==='candle'?{dataType:'BTC-USDT@kline_1min',data:{K:{}}}:'{');await drain();assert.equal(s.errors.length,1);assert.equal(s.states.includes('LIVE'),false);assert.equal(s.socket.readyState,3);}
  for(const hadData of [false,true])for(const invalid of [{c:'13'},{o:null},{h:'8'},{l:'14'},{v:'-1'}]){
    let now=1700000001000;const s=stream({now:()=>now});
    try{
      s.socket.message({id:s.id,code:0});await drain();
      if(hadData){s.socket.message(packet());await drain();assert.equal(s.socket.chartReliability.snapshot().state,'LIVE');}
      const candles=structuredClone(s.candles),data=s.socket.chartReliability.snapshot().evidence.data;
      now+=5000;const malformed=packet();Object.assign(malformed.data.K,invalid);s.socket.message(malformed);await drain();
      assert.deepEqual(s.candles,candles);assert.deepEqual(s.socket.chartReliability.snapshot().evidence.data,data);
      assert.notEqual(s.socket.chartReliability.snapshot().state,'LIVE');assert.equal(s.errors.length,1);
      if(!hadData)assert.equal(s.states.includes('LIVE'),false);
    }finally{s.socket.close();}
  }
});
test('BingX lowercase and structured heartbeat never become candles or verify LIVE',async()=>{
  const s=stream();try{for(const message of ['ping',{ping:1700000000000}])s.socket.message(message);await drain();assert.deepEqual(s.socket.sent.slice(1),['Pong','Pong']);assert.equal(s.candles.length,0);assert.equal(s.states.includes('LIVE'),false);}finally{s.socket.close();}
});
test('BingX first valid exact data verifies LIVE, replaces same candle and ignores stale/wrong topics',async()=>{
  const s=stream();try{s.socket.message({id:s.id,code:0});s.socket.message({...packet(),dataType:'BTCUSDT@kline_1min'});s.socket.message(packet());s.socket.message(packet());s.socket.message(packet(1700000060000));s.socket.message(packet());await drain();assert.deepEqual(s.candles.map(c=>c.time),[1700000000,1700000000,1700000060]);assert.equal(s.states.filter(x=>x==='LIVE').length,1);assert.equal(s.candles[0].close,11);}finally{s.socket.close();}
});
test('BingX reconnect has fresh subscription/ack state and rejects pending decode after close',async()=>{
  let resolve;const s=stream({decodeFrame:()=>new Promise(r=>{resolve=r;})});s.socket.message(packet());await drain();s.socket.close();resolve(JSON.stringify(packet()));await drain();assert.equal(s.candles.length,0);assert.equal(s.states.includes('LIVE'),false);
  const second=stream();try{assert.notEqual(second.id,s.id);assert.equal(JSON.parse(second.socket.sent[0]).dataType,'BTC-USDT@kline_1min');assert.equal(second.states.includes('LIVE'),false);}finally{second.socket.close();}
});
test('BingX ack and heartbeat timeouts terminate unverified/dead streams',async()=>{
  const a=stream({ackTimeoutMs:5});await new Promise(r=>setTimeout(r,15));assert.match(a.errors[0],/subscription timeout/);
  const b=stream({heartbeatTimeoutMs:5});b.socket.message({id:b.id,code:0});await new Promise(r=>setTimeout(r,15));assert.match(b.errors[0],/heartbeat timeout/);
});
test('BingX UI shares watchlist table/tile identity and filter, keeps shared Alerts/Radar enablement',()=>{
  const app=fs.readFileSync(require.resolve('../app.js'),'utf8'),html=fs.readFileSync(require.resolve('../index.html'),'utf8');
  const filter=html.match(/id="watchlist-exchange-filter"[\s\S]*?<\/select>/)[0];assert.deepEqual([...filter.matchAll(/value="([^"]+)"/g)].map(m=>m[1]),['all']);assert.match(app,/ZychExchangeAdapterV2\.registry\.filter\(adapter=>capabilityAdmitted\(adapter\.marketTypes\.spot\.capabilities\.watchlist\)\)/);
  assert.match(app,/entries\.map\(watchTileMarkup\)/);assert.match(app,/entries\.map\(watchRowMarkup\)/);assert.match(app,/selectMarketId\(chartAction\.dataset\.watchChart\)/);assert.match(app,/token===generation&&activeSocket===socket/);
  assert.equal(core.SUPPORTED_EXCHANGES.includes('bingx'),true);assert.equal(core.createAlert({exchange:'bingx',symbol:'BTC-USDT',marketType:'spot',type:'price',targetPrice:10}),null); // malformed definitions remain rejected
  assert.match(html.match(/id="radar-exchange-filter"[\s\S]*?<\/select>/)[0],/bingx/);
  assert.equal(bingxWsInterval['5m'],'5min');assert.equal(bingxWsInterval['15m'],'15min');assert.equal(bingxWsInterval['1M'],'1mon');
});
test('BingX narrow history proxy validates inputs and forwards only the exact public v2 request',async()=>{
  const {createBingxPublicProxy}=require('../server/http-server'),urls=[],proxy=createBingxPublicProxy({fetchImpl:async url=>{urls.push(url);return response([row()]);}});
  const query=new URLSearchParams({symbol:'BTC-USDT',interval:'5m',limit:'1440',endTime:'1700000000000'});
  await proxy('candles',query);assert.equal(urls[0],'https://open-api.bingx.com/openApi/spot/v2/market/kline?'+query);
  for(const suffix of ['&symbol=ETH-USDT','&url=https://evil.test','&limit=1441','&signature=secret'])await assert.rejects(proxy('candles',new URLSearchParams(query+suffix)));
  await assert.rejects(proxy('candles',new URLSearchParams({symbol:'BTCUSDT',interval:'1m'})));assert.equal(urls.length,1);
});
test('Chart existing reconnect wrapper resubscribes current interval and rejects stale sockets/generations',()=>{
  const app=fs.readFileSync(require.resolve('../app.js'),'utf8'),source=app.slice(app.indexOf('  let activeController='),app.indexOf('  async function selectMarketData'));
  const sockets=[],states=[],candles=[],timers=[],retry={hidden:true},context={market,timeframe:'5m',token:1,onStatus:s=>states.push(s),onCandle:c=>candles.push(c)};
  const adapter={requiresSubscriptionAck:true,socket:(m,t,h)=>{const socket={readyState:1,close(){this.readyState=3;h.close();}};sockets.push({m,t,h,socket});return socket;}};
  const scope={exchangeAdapters:{bingx:adapter},marketSockets:new Set(),updateSocketDiagnostics(){},document:{getElementById:()=>retry},setTimeout:fn=>{timers.push(fn);return timers.length;},clearTimeout(){},WebSocket:{CLOSING:2}};
  vm.createContext(scope);vm.runInContext(source+';generation=1;this.start=openLive;this.stop=stopMarket;this.next=()=>generation++;',scope);
  scope.start(context);sockets[0].h.open();assert.notEqual(states.at(-1),'LIVE');sockets[0].h.status('LIVE');assert.equal(retry.hidden,true);
  sockets[0].h.close();assert.equal(states.at(-1),'RECONNECTING');timers[0]();assert.equal(sockets.length,2);assert.equal(sockets[1].m.symbol,'BTC-USDT');assert.equal(sockets[1].t,'5m');
  sockets[0].h.candle({old:true});sockets[0].h.status('LIVE');assert.equal(candles.length,0);sockets[1].h.candle({current:true});assert.equal(candles.length,1);
  scope.next();sockets[1].h.candle({stale:true});sockets[1].h.error();assert.equal(candles.length,1);scope.stop();assert.equal(sockets[1].socket.readyState,3);
});
test('BingX production HTTP candle route rejects invalid/private inputs and uses the existing proxy',async()=>{
  const {createHttpServer}=require('../server/http-server'),calls=[],fixture=createHttpServer({config:{production:false},logger:{warn(){},error(){}},bingxProxy:async(key,params)=>{calls.push([key,params.toString()]);return {code:0,data:[row()]};}});
  await new Promise(resolve=>fixture.server.listen(0,'127.0.0.1',resolve));
  try{
    const base=`http://127.0.0.1:${fixture.server.address().port}/api/markets/bingx/candles`,query='?symbol=BTC-USDT&interval=1m&limit=1000&endTime=1700000000000';
    assert.equal((await fetch(base+query)).status,200);assert.deepEqual(calls,[['candles',query.slice(1)]]);
    for(const invalid of ['?symbol=BTCUSDT&interval=1m',query+'&listenKey=secret',query+'&limit=1','?symbol=BTC-USDT&interval=2m'])assert.equal((await fetch(base+invalid)).status,400);
    assert.equal((await fetch(base+query,{method:'POST'})).status,404);assert.equal(calls.length,1);
  }finally{fixture.forceClose();await new Promise(resolve=>fixture.server.close(resolve));}
});
