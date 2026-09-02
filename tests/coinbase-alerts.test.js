'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {CoinbaseMarketTransport}=require('../server/transports/coinbase-market-transport'),{MultiExchangeMarketTransport}=require('../server/transports/multi-exchange-market-transport');
const {ServerAlertRunner}=require('../server/alert-runner'),{JsonStorageAdapter}=require('../server/storage/json-storage');
const core=require('../js/alerts/alert-core'),hub=require('../js/alerts/alert-hub'),quick=require('../js/alerts/quick-chart-alerts');
const silent={info(){},warn(){},error(){},debug(){}},now=Date.UTC(2026,8,2);
const definition=(operator='above',mode='once')=>({marketId:'coinbase:spot:BTC-USD',exchange:'coinbase',marketType:'spot',symbol:'BTC-USD',baseAsset:'BTC',quoteAsset:'USD',condition:{type:'price',operator,value:100},mode,cooldownMs:5000});
const product={product_id:'BTC-USD',base_currency_id:'BTC',quote_currency_id:'USD',product_type:'SPOT',status:'online',alias:'',is_disabled:false,trading_disabled:false,cancel_only:false,post_only:false,auction_mode:false,limit_only:false};
const products=async()=>({products:[product,{...product,product_id:'BTC-USDC',quote_currency_id:'USDC',alias:'BTC-USD'}]});
class Socket{static all=[];constructor(url){this.url=url;this.readyState=0;this.listeners={};this.sent=[];Socket.all.push(this);}addEventListener(k,f){(this.listeners[k]??=[]).push(f);}emit(k,event={}){if(k==='open')this.readyState=1;for(const f of this.listeners[k]||[])f(event);}send(value){this.sent.push(JSON.parse(value));}close(){this.readyState=3;}}
const trade=(id,price=100,extra={})=>({trade_id:String(id),product_id:'BTC-USD',price:String(price),size:'0.1',time:new Date(now).toISOString(),...extra});
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function frame(t,s,p){s.emit('message',{data:JSON.stringify(p)});await t.context?.queue;}
const priceFrame=(sequence_num,trades,type='update')=>({channel:'market_trades',sequence_num,events:[{type,trades}]});
async function setup(t,options={}){const events=[],resets=[],transport=new CoinbaseMarketTransport({WebSocketImpl:Socket,products,now:()=>now,reconnectBaseMs:5,reconnectMaxMs:5,...options});await transport.start([core.createAlert(definition(),{id:'alert'})],{onEvent:e=>events.push(e),onBaselineReset:e=>resets.push(e)});t.after(()=>transport.stop());const socket=Socket.all.at(-1);socket.emit('open');return{transport,socket,events,resets};}
test('public exact channels, heartbeat and ACK facts do not claim LIVE without trades',async t=>{
 const {transport,socket}=await setup(t);assert.equal(socket.url,'wss://advanced-trade-ws.coinbase.com');assert.deepEqual(socket.sent,[{type:'subscribe',channel:'market_trades',product_ids:['BTC-USD']},{type:'subscribe',channel:'heartbeats',product_ids:['BTC-USD']}]);
 await frame(transport,socket,{channel:'heartbeats',sequence_num:0,events:[]});assert.equal(transport.diagnostics().status,'subscribing');assert.equal(transport.diagnostics().lastTradeAt,null);
 await frame(transport,socket,{channel:'subscriptions',sequence_num:1,events:[{subscriptions:{market_trades:['BTC-USD'],heartbeats:['heartbeats']}}]});assert.equal(transport.diagnostics().confirmedSubscriptions.length,2);assert.equal(transport.diagnostics().status,'subscribing');
});
test('pre-ACK exact updates establish baseline while snapshots never execute',async t=>{
 const {transport,socket,events,resets}=await setup(t);await frame(transport,socket,priceFrame(0,[trade(1,200)],'snapshot'));assert.equal(events.length,0);
 await frame(transport,socket,priceFrame(1,[trade(2,101)]));assert.equal(events.length,1);assert.equal(resets.length,1);assert.equal(transport.diagnostics().status,'live');assert.deepEqual(transport.diagnostics().confirmedSubscriptions,[]);
 assert.deepEqual([events[0].marketId,events[0].symbol,events[0].tradeId,events[0].size,events[0].sequenceNum,events[0].sourceTimestamp],['coinbase:spot:BTC-USD','BTC-USD','2',0.1,1,new Date(now).toISOString()]);
});
test('same-timestamp legitimate trades retained, IDs deduplicated, wrong products rejected',async t=>{
 const {transport,socket,events}=await setup(t);await frame(transport,socket,priceFrame(0,[trade(2,102),trade(1,99),trade(3,200,{product_id:'BTC-USDT'})]));await frame(transport,socket,priceFrame(1,[trade(2,102),trade(4,104)]));assert.deepEqual(events.map(e=>e.tradeId),['1','2','4']);assert.equal(transport.diagnostics().duplicates,1);
});
test('sequence gaps recover, fresh state resubscribes, stale callbacks ignored',async t=>{
 const {transport,socket,events,resets}=await setup(t);await frame(transport,socket,priceFrame(0,[trade(1)]));await frame(transport,socket,priceFrame(2,[trade(2)]));assert.equal(transport.diagnostics().status,'reconnecting');assert.equal(transport.diagnostics().sequenceGaps,1);await wait(20);const fresh=Socket.all.at(-1);assert.notEqual(fresh,socket);fresh.emit('open');assert.equal(transport.diagnostics().sequenceNum,null);assert.equal(transport.diagnostics().confirmedSubscriptions.length,0);assert.deepEqual(fresh.sent,socket.sent);
 await frame(transport,socket,priceFrame(3,[trade(3)]));assert.equal(events.length,1);await frame(transport,fresh,priceFrame(0,[trade(1),trade(4)]));assert.equal(events.length,2);assert.equal(resets.length,2);assert.equal(transport.diagnostics().reconnectCount,1);
});
test('duplicate/out-of-order sequences and source trades are suppressed',async t=>{
 const {transport,socket,events}=await setup(t);await frame(transport,socket,priceFrame(3,[trade(3)]));await frame(transport,socket,priceFrame(3,[trade(4)]));await frame(transport,socket,priceFrame(2,[trade(5)]));await frame(transport,socket,priceFrame(4,[trade(1)]));assert.equal(events.length,1);assert.equal(transport.diagnostics().duplicates,1);assert.equal(transport.diagnostics().outOfOrder,2);
});
test('heartbeats cannot conceal stale prices or missing confirmations',async t=>{
 let clock=now;const {transport,socket}=await setup(t,{now:()=>clock,staleAfterMs:10,ackTimeoutMs:15,reconnectBaseMs:1000});await frame(transport,socket,priceFrame(0,[trade(1)]));clock+=20;await frame(transport,socket,{channel:'heartbeats',sequence_num:1,events:[]});assert.equal(transport.diagnostics().status,'stale');await wait(25);assert.equal(transport.diagnostics().lastError.code,'ACK_TIMEOUT');
});
test('heartbeat timeout reconnects after confirmed but silent socket',async t=>{
 const {transport,socket}=await setup(t,{heartbeatTimeoutMs:15,reconnectBaseMs:1000});await frame(transport,socket,{channel:'subscriptions',sequence_num:0,events:[{subscriptions:{market_trades:['BTC-USD'],heartbeats:['heartbeats']}}]});await wait(25);assert.equal(transport.diagnostics().lastError.code,'HEARTBEAT_TIMEOUT');
});
test('unsupported type, alias and malformed native identity fail before subscription',async()=>{
 const transport=new CoinbaseMarketTransport({products,WebSocketImpl:Socket});
 for(const change of [{type:'movement'},{symbol:'BTCUSDT'},{symbol:'BTC-USDC',marketId:'coinbase:spot:BTC-USDC',quoteAsset:'USDC'}])assert.ok(await transport.validateAlert({...core.createAlert(definition(),{id:'valid'}),...change}));await transport.stop();
});
async function fixture(t){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'zych-coinbase-unit-')),storage=new JsonStorageAdapter({directory,core,logger:silent});await storage.init();let clock=now;
 const transport=new CoinbaseMarketTransport({WebSocketImpl:Socket,products,now:()=>clock,reconnectBaseMs:5,reconnectMaxMs:5}),router=new MultiExchangeMarketTransport({transports:{coinbase:transport},logger:silent}),notifications=[],runner=new ServerAlertRunner({core,storage,transport:router,logger:silent,notifier:{notify:async e=>notifications.push(e)},now:()=>clock});await runner.start();
 t.after(async()=>{await runner.stop();assert.equal(path.dirname(directory),os.tmpdir());assert.ok(path.basename(directory).startsWith('zych-coinbase-unit-'));await fs.rm(directory,{recursive:true,force:true});});
 return{directory,storage,transport,runner,notifications,setNow:value=>clock=value,connect(){const s=Socket.all.at(-1);s.emit('open');return s;},async tick(s,seq,id,price){await frame(transport,s,priceFrame(seq,[trade(id,price,{time:new Date(clock).toISOString()})]));await runner.queue;}};
}
for(const operator of ['above','below'])test(`server ${operator}: already satisfied baseline, real recross, exactly one persisted TriggerEvent`,async t=>{
 const f=await fixture(t),created=await f.runner.create(definition(operator)),s=f.connect(),satisfied=operator==='above'?101:99,other=operator==='above'?99:101;
 await f.tick(s,0,1,satisfied);await f.tick(s,1,2,satisfied);assert.equal(f.runner.events().length,0);await f.tick(s,2,3,other);await f.tick(s,3,4,satisfied);await f.tick(s,3,4,satisfied);
 assert.equal(f.runner.events().length,1);assert.equal(f.notifications.length,1);assert.equal(f.runner.events()[0].alertId,created.alert.id);assert.equal(f.runner.events()[0].marketId,'coinbase:spot:BTC-USD');
 const reload=new JsonStorageAdapter({directory:f.directory,core,logger:silent});await reload.init();assert.equal(reload.loadAlerts()[0].symbol,'BTC-USD');assert.equal(reload.loadTriggerHistory().length,1);await reload.close();
});
test('recurring re-arm and cooldown preserve one trigger per valid recross',async t=>{
 const f=await fixture(t);await f.runner.create(definition('above','recurring'));const s=f.connect();await f.tick(s,0,1,99);await f.tick(s,1,2,101);await f.tick(s,2,3,102);assert.equal(f.runner.events().length,1);f.setNow(now+1000);await f.tick(s,3,4,99);await f.tick(s,4,5,101);assert.equal(f.runner.events().length,1);f.setNow(now+6000);await f.tick(s,5,6,99);await f.tick(s,6,7,101);assert.equal(f.runner.events().length,2);
});
test('gap resets baseline without fabricating missed crossing',async t=>{
 const f=await fixture(t);await f.runner.create(definition());const s=f.connect();await f.tick(s,0,1,99);await f.tick(s,2,2,101);await wait(20);const fresh=f.connect();await f.tick(fresh,0,3,102);assert.equal(f.runner.events().length,0);await f.tick(fresh,1,4,99);await f.tick(fresh,2,5,101);assert.equal(f.runner.events().length,1);
});
test('unsupported candle alerts and aliases cannot enter persistence',async t=>{
 const f=await fixture(t);for(const condition of [{type:'movement',window:'5m',direction:'up',percent:1},{type:'volume',timeframe:'5m',multiplier:2}])assert.equal((await f.runner.create({...definition(),condition})).error,'UNSUPPORTED_ALERT_TYPE');
 assert.equal((await f.runner.create({...definition(),symbol:'BTC-USDC',marketId:'coinbase:spot:BTC-USDC',quoteAsset:'USDC'})).error,'UNSUPPORTED_MARKET');assert.equal(f.runner.list().length,0);assert.equal(f.storage.loadAlerts().length,0);
});
test('same server alert lines support drag, rollback, pause/resume/delete and exact Hub navigation',async t=>{
 const f=await fixture(t),{alert}=await f.runner.create(definition());assert.equal(hub.openContext(alert).marketId,'coinbase:spot:BTC-USD');assert.match(hub.marketText(alert),/COINBASE/);assert.equal(quick.matchingAlerts(f.runner.list(),'coinbase:spot:BTC-USD').length,1);assert.equal(quick.matchingAlerts(f.runner.list(),'binance:spot:BTCUSDT').length,0);
 const update=new quick.UpdateCoordinator(),applied=[];update.register(alert.id,100);await update.commit(alert.id,110,{update:(id,v)=>f.runner.updatePrice(id,v),apply:v=>applied.push(v)});assert.equal(f.runner.list()[0].id,alert.id);await assert.rejects(update.commit(alert.id,120,{update:async()=>{throw Error('offline')},apply:v=>applied.push(v)}));assert.equal(applied.at(-1),110);await f.runner.pause(alert.id);assert.equal(f.runner.list()[0].status,'paused');await f.runner.resume(alert.id);assert.equal(f.runner.list()[0].status,'active');await f.runner.remove(alert.id);assert.equal(f.runner.list().length,0);
});
test('single runner, Core allowlist-only change and Radar remains four exchanges',async()=>{
 const app=await fs.readFile(path.join(__dirname,'../server/app.js'),'utf8');assert.equal((app.match(/new ServerAlertRunner/g)||[]).length,1);assert.match(app,/coinbase: new CoinbaseMarketTransport/);assert.deepEqual(require('../server/radar/event-schema').EXCHANGES,['binance','bybit','okx','bingx']);assert.ok(core.SUPPORTED_EXCHANGES.includes('coinbase'));
});
test('Coinbase raw market contradictions cannot be silently normalized to another context',async t=>{
 const f=await fixture(t);for(const change of [{marketType:'perpetual'},{marketId:'binance:spot:BTCUSDT'},{exchange:'COINBASE'}])assert.ok((await f.runner.create({...definition(),...change})).error);assert.equal(f.runner.list().length,0);
});
test('restarting persisted Coinbase alerts establishes a new baseline without startup trigger',async t=>{
 const f=await fixture(t),created=await f.runner.create(definition());await f.runner.stop();
 const storage=new JsonStorageAdapter({directory:f.directory,core,logger:silent});await storage.init();const transport=new CoinbaseMarketTransport({products,WebSocketImpl:Socket,now:()=>now}),runner=new ServerAlertRunner({core,storage,transport,notifier:{notify:async()=>{}},logger:silent,now:()=>now});
 try{await runner.start();assert.equal(runner.list()[0].id,created.alert.id);const s=Socket.all.at(-1);s.emit('open');await frame(transport,s,priceFrame(0,[trade(1,101)]));await runner.queue;assert.equal(runner.events().length,0);assert.equal(transport.diagnostics().requestedSubscriptions.length,2);}finally{await runner.stop();}
});
test('Coinbase events share one toast/sound dedup pipeline and exact navigation',()=>{
 const old=global.document,node=()=>({listeners:{},setAttribute(){},append(){},addEventListener(k,f){this.listeners[k]=f;},remove(){}});global.document={createElement:node};
 try{const {NotificationCenter}=require('../js/notifications/notification-center'),toasts=[];let plays=0,opened;
 const center=new NotificationCenter({region:{append:n=>toasts.push(n)},sound:{play:()=>plays++},describe:()=> 'crossing',formatTime:()=> '12:00',onOpen:e=>opened=hub.openContext(e),setTimer:()=>0}),event={...definition(),id:'coinbase-trigger',asset:'BTC',triggeredAt:now};const toast=center.notify(event);assert.equal(center.notify({...event}),null);toast.listeners.click();assert.equal(toasts.length,1);assert.equal(plays,1);assert.equal(opened.marketId,'coinbase:spot:BTC-USD');}finally{global.document=old;}
});
test('missing Coinbase transport fails honestly without cross-exchange routing',async()=>{
 const router=new MultiExchangeMarketTransport({transports:{binance:{}},logger:silent});assert.equal((await router.validateAlert(core.createAlert(definition(),{id:'missing'}))).error,'TRANSPORT_UNAVAILABLE');
});
test('wrong-product and malformed confirmations never acknowledge exact subscriptions',async t=>{
 const {transport,socket}=await setup(t);await frame(transport,socket,{channel:'subscriptions',sequence_num:0,events:[{subscriptions:{market_trades:['BTC-USDC'],heartbeats:'heartbeats'}}]});assert.equal(transport.diagnostics().confirmedSubscriptions.length,0);
 await frame(transport,socket,{channel:'subscriptions',sequence_num:1,events:[{subscriptions:{market_trades:'BTC-USD',heartbeats:['heartbeats']}}]});assert.deepEqual(transport.diagnostics().confirmedSubscriptions,['heartbeats']);
});
test('multiple native products stay distinct and all require usable data for healthy coverage',async t=>{
 const transport=new CoinbaseMarketTransport({WebSocketImpl:Socket,now:()=>now,products:async()=>({products:[product,{...product,product_id:'BTC-USDT',quote_currency_id:'USDT'}]})}),events=[];t.after(()=>transport.stop());
 const other={...definition(),marketId:'coinbase:spot:BTC-USDT',symbol:'BTC-USDT',quoteAsset:'USDT'};
 await transport.start([core.createAlert(definition(),{id:'usd'}),core.createAlert(other,{id:'usdt'})],{onEvent:e=>events.push(e)});const s=Socket.all.at(-1);s.emit('open');assert.deepEqual(s.sent[0].product_ids,['BTC-USD','BTC-USDT']);
 await frame(transport,s,priceFrame(0,[trade(1)]));assert.equal(transport.diagnostics().status,'subscribing');await frame(transport,s,priceFrame(1,[trade(1,101,{product_id:'BTC-USDT'})]));assert.equal(transport.diagnostics().status,'live');assert.equal(events.length,2);assert.notEqual(events[0].marketId,events[1].marketId);
});
