'use strict';
// Isolated non-production E2E: live BTC feeds on four exchanges, plus explicitly
// deterministic BingX detector evidence. No owner storage or production event injection.
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {createServerApp}=require('../server/app'),{loadConfig}=require('../server/config');
const {BinanceCatalogAdapter,BybitCatalogAdapter,OkxCatalogAdapter,BingxCatalogAdapter}=require('../server/radar/catalog-adapters');
const {MarketCatalogService}=require('../server/radar/market-catalog-service'),{MarketUniverseService}=require('../server/radar/market-universe-service');
const {PriceMomentumDetector}=require('../server/radar/detectors/price-momentum'),{normalizeBingxCandle}=require('../server/radar/candle-adapters');
const {MarketStateStore}=require('../server/radar/market-state-store');
(async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'zych-bingx-radar-')),config={...loadConfig({}),port:4182,dataDir:directory,radarRefreshIntervalMs:60000};
 const adapters=[new BinanceCatalogAdapter(),new BybitCatalogAdapter(),new OkxCatalogAdapter(),new BingxCatalogAdapter()].map(adapter=>({id:adapter.id,load:async signal=>(await adapter.load(signal)).filter(m=>m.baseAsset==='BTC'&&m.quoteAsset==='USDT')}));
 const universe=new MarketUniverseService({catalog:new MarketCatalogService({adapters,requestTimeoutMs:15000}),policy:config.universePolicy,refreshIntervalMs:60000});await universe.initialize();
 const app=await createServerApp({config,universe});await app.runner.persist();
 const original=app.server.listeners('request')[0];app.server.removeAllListeners('request');
 const fixture=await fs.readFile(path.join(__dirname,'bingx-fixture-storage.js'),'utf8');
 let stopped=false;async function stop(){if(stopped)return;stopped=true;await app.stop();assert.equal(path.dirname(directory),os.tmpdir());assert.ok(path.basename(directory).startsWith('zych-bingx-radar-'));await fs.rm(directory,{recursive:true,force:true});console.log('TEMP_DATA_REMOVED; OWNER_NOT_TOUCHED')}
 app.server.on('request',async(req,res)=>{try{
   if(req.url==='/verification-stop'&&req.method==='POST'){res.end('stopping');setImmediate(()=>stop().then(()=>process.exit(0)));return}
   if(req.url==='/verification-state'&&req.method==='GET'){res.setHeader('content-type','application/json');res.end(JSON.stringify({directory,catalog:universe.health(),radar:app.radar.diagnostics(),coverage:app.radar.coverage(universe.health().coverage),recovery:app.radar.recovery.diagnostics(),alerts:app.runner.diagnostics(),events:app.eventStore.listRecent()}));return}
   if(req.url==='/verification-event'&&req.method==='POST'){
     const market=universe.getSnapshot().markets.find(m=>m.marketId==='bingx:spot:BTC-USDT');if(!market)throw Error('BingX BTC is not in the verified universe');
     const now=Date.now(),end=Math.floor(now/60000)*60000,store=new MarketStateStore({minimumLookback:65}),candles=Array.from({length:70},(_,i)=>{const close=i===69?120:100+(i%2)*.1;return normalizeBingxCandle(market,'1m',[end-(70-i)*60000,100,121,99,close,10,end-(69-i)*60000-1,1000],{now,closed:true})});
     const state=store.load(market,'1m',candles),detector=new PriceMomentumDetector(),candidates=detector.evaluate({market,event:candles.at(-1),state});for(const candidate of candidates)app.eventPipeline.publishCandidate(candidate);await app.eventPipeline.idle();store.stop();res.setHeader('content-type','application/json');res.end(JSON.stringify({testOnly:true,candidates:candidates.length,events:app.eventStore.listRecent().filter(e=>e.market.exchange==='bingx')}));return;
   }
   if(req.method==='GET'&&new URL(req.url,'http://localhost').pathname==='/'){
     let html=await fs.readFile(path.join(__dirname,'../index.html'),'utf8');html=html.replace('<head>','<head><script>'+fixture+'</script>').replace('<script src="app.js"></script>','<script>ZychAlerts.ServerAlertClient=class extends ZychAlerts.ServerAlertClient{constructor(options){super({...options,baseUrl:"/api"})}};</script><script src="app.js"></script>');
     html=html.replace('</body>','<aside style="position:fixed;bottom:0;left:0;z-index:9999;background:#162333;color:white">ISOLATED TEST · BTC-only live universe · deterministic BingX event</aside></body>');res.setHeader('content-type','text/html');res.end(html);return;
   }
   original(req,res);
 }catch(error){res.writeHead(500).end(error.message)}});
 await app.listen();console.log('ISOLATED_RADAR http://127.0.0.1:4182/ '+directory);
})().catch(error=>{console.error(error);process.exitCode=1});
