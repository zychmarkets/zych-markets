'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {ServerAlertClient}=require('../js/alerts/server-alert-client');
const {ServerAlertRunner}=require('../server/alert-runner');
const {JsonStorageAdapter}=require('../server/storage/json-storage');
const core=require('../js/alerts/alert-core'),watch=require('../js/services/watchlist-markets'),data=require('../js/services/markets-data');
const {notificationText}=require('../server/notifiers/web-push-notifier');
const logger={info(){},warn(){},error(){},debug(){}};
const definition={marketId:'binance:spot:BTCUSDT',exchange:'binance',symbol:'BTCUSDT',baseAsset:'BTC',asset:'BTC',quoteAsset:'USDT',condition:{type:'price',operator:'above',value:100},mode:'once'};
async function fixture(t){const directory=await fs.mkdtemp(path.join(os.tmpdir(),'zych-audit-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));const storage=new JsonStorageAdapter({directory,core,logger});await storage.init();const runner=new ServerAlertRunner({core,storage,logger,transport:{start:async()=>{},stop:async()=>{}},notifier:{notify(){}}});return{storage,runner};}
test('quiet mutation sync retains new triggers until one normal notification, without replaying history',async()=>{
 const notified=[],client=new ServerAlertClient({notifier:{notify:e=>notified.push(e.id)}});let triggers=[{id:'old'}];client.request=async p=>p==='/alerts'?{alerts:[]}:p==='/triggers'?{triggers}:{};
 await client.sync();triggers=[{id:'new'},{id:'new'},{id:'old'}];await client.sync({notify:false});assert.deepEqual(notified,[]);triggers=[];await client.sync();await client.sync();assert.deepEqual(notified,['new']);
});
test('successful creation is not reported as rejected when subsequent refresh fails',async()=>{
 const client=new ServerAlertClient();client.request=async(_p,o)=>{if(o?.method==='POST')return{alert:{id:'saved'}};throw Error('refresh offline')};const result=await client.create(definition);assert.equal(result.alert.id,'saved');assert.equal(result.syncPending,true);assert.equal(result.error,undefined);
});
test('failed create has no ghost in runner or storage; retry and concurrent duplicate serialize',async t=>{
 const {storage,runner}=await fixture(t),file=storage.file;storage.file=path.join(storage.directory,'missing','state.json');await assert.rejects(runner.create(definition));assert.deepEqual(runner.list(),[]);assert.deepEqual(storage.loadAlerts(),[]);storage.file=file;
 const results=await Promise.all([runner.create(definition),runner.create(definition)]);assert.equal(results.filter(x=>x.alert).length,1);assert.equal(results.filter(x=>x.error==='DUPLICATE_ALERT').length,1);assert.equal(storage.loadAlerts().length,1);
});
test('failed pause, edit, and removal keep the last committed alert',async t=>{
 const {storage,runner}=await fixture(t),created=(await runner.create(definition)).alert,original=runner.list();storage.file=path.join(storage.directory,'missing','state.json');
 for(const operation of [()=>runner.pause(created.id),()=>runner.updatePrice(created.id,150),()=>runner.remove(created.id)]){await assert.rejects(operation());assert.deepEqual(runner.list(),original);assert.deepEqual(storage.loadAlerts(),original)}
});
test('concurrent storage changes do not overwrite subscriptions or alert data',async t=>{
 const {storage}=await fixture(t),alert=core.createAlert(definition,{id:'atomic',now:1000});const sub={endpoint:'https://push.example/a',keys:{p256dh:require('node:crypto').createECDH('prime256v1').generateKeys().toString('base64url'),auth:Buffer.alloc(16,1).toString('base64url')}};
 await Promise.all([storage.save([alert],[]),storage.savePushSubscription(sub)]);assert.equal(storage.loadAlerts().length,1);assert.equal(storage.loadPushSubscriptions().length,1);assert.deepEqual(JSON.parse(await fs.readFile(storage.file,'utf8')),storage.snapshot());
});
const market=i=>({id:`binance:spot:T${i}USDT`,marketId:`binance:spot:T${i}USDT`,exchange:'binance',marketType:'spot',symbol:`T${i}USDT`,asset:`T${i}`,baseAsset:`T${i}`,quoteAsset:'USDT',enabled:true});
test('51st Watchlist addition preserves all saved instruments; migration never silently truncates',()=>{
 const items=Array.from({length:50},(_,i)=>watch.entry(market(i))),next=watch.toggle(items,market(50));assert.deepEqual(next,items);assert.equal(watch.toggle(items,market(0)).length,49);assert.equal(watch.migrate([...items,watch.entry(market(50))]).length,51);
});
test('Watchlist distinguishes fresh, stale, cached and unverified prices',()=>{
 const m=market(0),items=[watch.entry(m)],states={binance:{catalog:'ready',quotes:'ready'}};
 for(const [snapshot,status] of [[{lastPrice:1,receivedAt:1000},'ready'],[{lastPrice:1,receivedAt:0},'quotesStale'],[{lastPrice:1,receivedAt:1000,cacheHit:true},'quotesCached'],[{lastPrice:1},'quotesUnverified']]){assert.equal(watch.view(items,[m],states,{[m.id]:snapshot},76000)[0].status,status)}
});
test('volume totals and ranking scope never add BTC volume to USDT volume',()=>{
 const rows=[{marketId:'a',quoteAsset:'BTC',quoteVolume24h:100},{marketId:'b',quoteAsset:'USDT',quoteVolume24h:1000}],scope=data.volumeScope(rows);assert.equal(scope.total,1000);assert.deepEqual(scope.verified,[rows[1]]);assert.equal(data.volumeScope([...rows,{quoteAsset:'USDT',quoteVolume24h:null}]).total,null);
});
test('prices and push preserve actual quote currency, including BTC and EUR',()=>{
 assert.equal(data.money(.05,'BTC'),'0.05 BTC');assert.equal(data.money(null,'USD'),'—');for(const quoteAsset of ['BTC','EUR','USDT']){const payload=notificationText({id:'e',alertId:'a',alertType:'price',triggerPrice:10,quoteAsset});assert.match(payload.body,new RegExp(quoteAsset+'$'));assert.doesNotMatch(payload.body,/\$/)}
});
test('push validation blocks private endpoints and invalid encryption keys',()=>{
 const {validEndpoint,validKeys,publicAddress}=require('../server/notifiers/push-endpoint');
 for(const endpoint of ['https://127.0.0.1/a','https://[::1]/a','https://[::ffff:127.0.0.1]/a','https://10.0.0.2/a','https://user:pass@push.example/a','https://push.example:9443/a','https://device.local/a','http://push.example/a'])assert.equal(validEndpoint(endpoint),false,endpoint);
 for(const ip of ['192.168.1.1','169.254.169.254','100.64.0.1','fc00::1','fe80::1','2001:db8::1'])assert.equal(publicAddress(ip),false,ip);
 assert.equal(publicAddress('8.8.8.8'),true);assert.equal(publicAddress('2606:4700:4700::1111'),true);assert.equal(validEndpoint('https://push.example/a'),true);assert.equal(validKeys({p256dh:'p'.repeat(65),auth:'a'.repeat(16)}),false);
});
test('socket DNS guard rejects a hostname with any private resolution before connecting',async()=>{
 const dns=require('node:dns'),original=dns.lookup,{guardedLookup}=require('../server/notifiers/push-endpoint');dns.lookup=(_host,_options,callback)=>callback(null,[{address:'8.8.8.8',family:4},{address:'127.0.0.1',family:4}]);
 try{await assert.rejects(new Promise((resolve,reject)=>guardedLookup('push.example',{},(error,address)=>error?reject(error):resolve(address))),{code:'PUSH_ADDRESS_BLOCKED'})}finally{dns.lookup=original}
});
test('saved push survives restart and retries only devices without acceptance',async t=>{
 const {storage}=await fixture(t),crypto=require('node:crypto'),keys={p256dh:crypto.createECDH('prime256v1').generateKeys().toString('base64url'),auth:Buffer.alloc(16,1).toString('base64url')};
 await storage.savePushSubscription({endpoint:'https://push.example/a',keys});await storage.savePushSubscription({endpoint:'https://push.example/b',keys});
 const event={id:'durable',alertId:'alert',marketId:'binance:spot:BTCUSDT',triggeredAt:Date.now(),alertType:'price',triggerPrice:100,quoteAsset:'USDT'};await storage.save([],[event]);
 const reopened=new JsonStorageAdapter({directory:storage.directory,core,logger});await reopened.init();assert.equal(reopened.loadPendingPush().length,1);
 const {WebPushNotifier}=require('../server/notifiers/web-push-notifier'),sent=[];let fail=true;const notifier=new WebPushNotifier({storage:reopened,logger,publicKey:'',privateKey:'',sendNotification:async sub=>{sent.push(sub.endpoint);if(fail&&sub.endpoint.endsWith('/b'))throw Error('offline')}});notifier.enabled=true;
 await notifier.drain();assert.deepEqual(reopened.loadPendingPush()[0].endpoints,['https://push.example/b']);
 await reopened.savePushSubscription({endpoint:'https://push.example/new-device',keys});fail=false;await notifier.drain();assert.deepEqual(sent,['https://push.example/a','https://push.example/b','https://push.example/b']);assert.deepEqual(reopened.loadPendingPush(),[]);await notifier.drain();assert.equal(sent.length,3);
});
test('expired historical triggers are never queued to newly registered devices',async t=>{
 const {storage}=await fixture(t),crypto=require('node:crypto');await storage.savePushSubscription({endpoint:'https://push.example/a',keys:{p256dh:crypto.createECDH('prime256v1').generateKeys().toString('base64url'),auth:Buffer.alloc(16,1).toString('base64url')}});
 await storage.save([],[{id:'old',alertId:'a',marketId:'binance:spot:BTCUSDT',triggeredAt:Date.now()-301000}]);assert.deepEqual(storage.loadPendingPush(),[]);
});
test('deep link opens after its own catalog without waiting for another exchange',async()=>{
 const source=await fs.readFile(path.join(__dirname,'../app.js'),'utf8'),vm=require('node:vm');let release;const other=new Promise(resolve=>release=resolve),opened=[],waited=[];
 const context={navigationIntent:0,location:{search:'?trigger=e'},ZychMarketContext:{resolveLocation:async()=>({context:{exchange:'binance',marketId:'binance:spot:BTCUSDT'}})},catalogLoader:{start:()=>other,wait:async exchange=>waited.push(exchange),controller:{signal:{aborted:false}}},openMarketContext:value=>opened.push(value)};
 vm.createContext(context);vm.runInContext(source.slice(source.indexOf('  async function loadUniverseData(){'),source.indexOf("  document.getElementById('retry-button')")),context);
 const loading=context.loadUniverseData();await new Promise(resolve=>setImmediate(resolve));assert.equal(opened.length,1);assert.deepEqual(waited,['binance']);release();await loading;
 context.navigationIntent=1;context.ZychMarketContext.resolveLocation=async()=>{context.navigationIntent=2;return{context:{exchange:'kraken'}}};await context.loadUniverseData();assert.equal(opened.length,1);
});
test('chart bundle is served locally through the explicit static allowlist',async()=>{
 const {staticFile}=require('../server/http-server'),root=path.resolve(__dirname,'..'),relative='third-party/lightweight-charts-5.0.9/lightweight-charts.standalone.production.js';
 const html=await fs.readFile(path.join(root,'index.html'),'utf8');assert.ok(html.includes(`src="${relative}"`));assert.equal(staticFile(root,'/'+relative),path.join(root,relative));assert.equal(staticFile(root,'/third-party/private.txt'),null);assert.match((await fs.readFile(path.join(root,relative),'utf8')).slice(0,200),/v5\.0\.9/);
});
test('a timestamp from the future cannot mark a price fresh',()=>{const reliability=require('../js/services/snapshot-reliability');assert.equal(reliability.evaluate({receivedAt:1001},'binance',{now:1000}).state,'UNAVAILABLE')});
test('installation limits reject new resources without evicting existing ones',async t=>{
 const {storage,runner}=await fixture(t),crypto=require('node:crypto'),keys={p256dh:crypto.createECDH('prime256v1').generateKeys().toString('base64url'),auth:Buffer.alloc(16,1).toString('base64url')};
 runner.alerts=Array.from({length:1000},(_,i)=>({id:String(i)}));assert.equal((await runner.create(definition)).error,'ALERT_LIMIT');assert.equal(runner.list().length,1000);
 storage.state.pushSubscriptions=Array.from({length:100},(_,i)=>({endpoint:`https://push.example/${i}`,keys}));const result=await storage.savePushSubscription({endpoint:'https://push.example/extra',keys});assert.equal(result.error,'PUSH_SUBSCRIPTION_LIMIT');assert.equal(storage.loadPushSubscriptions().length,100);assert.ok((await storage.savePushSubscription({endpoint:'https://push.example/0',keys})).endpoint);
});
