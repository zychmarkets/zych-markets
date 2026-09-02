'use strict';
// Public read-only network probe; no owner persistence, no synthetic production events.
const {BingxCatalogAdapter}=require('../server/radar/catalog-adapters');
const {MarketCatalogService}=require('../server/radar/market-catalog-service');
const {MarketUniverseService}=require('../server/radar/market-universe-service');
const {CandleHistoryAdapter}=require('../server/radar/candle-history-adapters');
const {CandleStreamAdapter}=require('../server/radar/candle-stream-adapters');
const {MarketStateStore}=require('../server/radar/market-state-store');
const {RecoveryCoordinator}=require('../server/radar/recovery-coordinator');
const {IngestionSupervisor}=require('../server/radar/ingestion-supervisor');
const {loadConfig}=require('../server/config');
const logger={warn:(event,data)=>console.log(JSON.stringify({event,...data}))};
(async()=>{
 const config=loadConfig({}),catalog=new MarketCatalogService({adapters:[new BingxCatalogAdapter()],logger}),universe=new MarketUniverseService({catalog,policy:config.universePolicy,refreshIntervalMs:0,logger});await universe.initialize();
 const snapshot=universe.getSnapshot(),market=snapshot.markets.find(m=>m.marketId==='bingx:spot:BTC-USDT');if(!market)throw Error('BTC-USDT not eligible in actual Top-N');console.log(JSON.stringify({catalog:snapshot.coverage,selected:market}));
 const selected={getSnapshot:()=>({markets:[market]}),subscribe:()=>()=>{}},store=new MarketStateStore({minimumLookback:65}),stream=new CandleStreamAdapter({exchange:'bingx',logger}),counts={},evaluated={};
 const recovery=new RecoveryCoordinator({store,adapters:{bingx:new CandleHistoryAdapter({exchange:'bingx',restBase:config.bingxRestBase})},logger});
 const radar=new IngestionSupervisor({universe:selected,store,recovery,streams:{bingx:stream},registry:{evaluate:({event})=>{evaluated[event.timeframe]=(evaluated[event.timeframe]||0)+1},stop(){}},logger});
 const receive=radar.onCandle.bind(radar);radar.onCandle=event=>{counts[event.timeframe]=(counts[event.timeframe]||0)+1;return receive(event)};
 await radar.start();const timer=setInterval(()=>console.log(JSON.stringify({stream:stream.diagnostics(),state:store.diagnostics(),counts,evaluated})),20000);
 setTimeout(async()=>{clearInterval(timer);const diagnostics=stream.diagnostics(),state=store.diagnostics();console.log(JSON.stringify({final:true,diagnostics,state,counts,evaluated,coverage:radar.coverage(snapshot.coverage),recovery:recovery.diagnostics()}));await radar.stop();await universe.stop();if(diagnostics.status!=='live'||diagnostics.acknowledgedTopics!==3||!diagnostics.heartbeatCount||state.COMPLETE!==3||!['1m','5m','15m'].every(tf=>counts[tf]>0)||!evaluated['1m'])process.exitCode=1},80000);
})().catch(error=>{console.error(error);process.exitCode=1});
