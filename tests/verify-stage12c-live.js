'use strict';
// Opt-in live acceptance. Never loads server-data, owner alerts or VAPID keys.
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const core=require('../js/alerts/alert-core');
const {ServerAlertRunner}=require('../server/alert-runner');
const {JsonStorageAdapter}=require('../server/storage/json-storage');
const {loadConfig}=require('../server/config');
const {BinanceMarketTransport}=require('../server/transports/binance-market-transport');
const {BybitMarketTransport}=require('../server/transports/bybit-market-transport');
const {OkxMarketTransport}=require('../server/transports/okx-market-transport');
const {BingxMarketTransport}=require('../server/transports/bingx-market-transport');
const {CoinbaseMarketTransport}=require('../server/transports/coinbase-market-transport');
const {KrakenMarketTransport}=require('../server/transports/kraken-market-transport');
const logger={info(){},debug(){},warn(){},error(){}};
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,timeout=45000){const start=Date.now();while(Date.now()-start<timeout){if(fn())return;await wait(100);}throw Error('ACCEPTANCE_TIMEOUT');}
async function main(){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'zych-12c-live-')),c=loadConfig({}), results=[];
  const transports={
    binance:new BinanceMarketTransport({logger,restBase:c.binanceRestBase,wsBase:c.binanceWsBase}),
    bybit:new BybitMarketTransport({logger,restBase:c.bybitRestBase,wsBase:c.bybitWsBase}),
    okx:new OkxMarketTransport({logger,restBase:c.okxRestBase,wsPublicBase:c.okxWsPublicBase,wsBusinessBase:c.okxWsBusinessBase}),
    bingx:new BingxMarketTransport({logger}),coinbase:new CoinbaseMarketTransport({logger}),kraken:new KrakenMarketTransport({logger})
  };
  try{await Promise.all(Object.entries(transports).map(async([exchange,transport])=>{
    const symbol=({binance:'BTCUSDT',bybit:'BTCUSDT',okx:'BTC-USDT',bingx:'BTC-USDT',coinbase:'BTC-USD',kraken:'XXBTZUSD'})[exchange];
    const storage=new JsonStorageAdapter({directory:path.join(directory,exchange),core,logger});await storage.init();
    const definition={exchange,marketType:'spot',marketId:`${exchange}:spot:${symbol}`,symbol,baseAsset:'BTC',quoteAsset:['coinbase','kraken'].includes(exchange)?'USD':'USDT',condition:{type:'price',operator:'above',value:1e12},mode:'recurring'};
    const alerts=[core.createAlert(definition,{id:`12c-${exchange}`})];
    if(exchange==='binance')alerts.push(core.createAlert({...definition,condition:{type:'price',operator:'below',value:0.01}},{id:'12c-binance-below'}));
    await storage.save(alerts,[]);
    let ordered=false;
    const runner=new ServerAlertRunner({core,storage,transport,logger,notifier:{async notify(event){const disk=JSON.parse(await fs.readFile(storage.file,'utf8'));ordered=disk.history.some(e=>e.id===event.id);throw Error('ISOLATED_FORCED_PUSH_FAILURE');}}});
    try{
      await runner.start();await until(()=>runner.diagnostics().reliability.counts.ready===alerts.length);
      const detail=runner.diagnostics().reliability.details[0];console.log(JSON.stringify({exchange,readiness:'READY',baseline:detail.baseline,subscription:detail.evidence.subscription.acknowledgement,age:detail.lastMarketDataAgeMs}));
      if(exchange==='binance'){
        const price=runner.previousPrices.get(definition.marketId);runner.alerts.forEach(a=>{a.condition.value=price;});await runner.persist();
        await until(()=>runner.diagnostics().notificationDelivery.latest.some(d=>d.push==='FAILED'));
        if(!ordered)throw Error('PERSISTENCE_ORDER_FAILED');console.log(JSON.stringify({controlledRealTrigger:'PASS',persistBeforePush:ordered,push:'FAILED',execution:'SUCCESS'}));
        // Disarm test thresholds while testing transport recovery.
        runner.alerts.forEach(a=>{a.condition.value=a.condition.operator==='above'?1e12:0.01;});
        transport.socket.close(1000,'isolated acceptance reconnect');await until(()=>runner.diagnostics().reliability.counts.ready===0,5000);await until(()=>runner.diagnostics().reliability.counts.ready===alerts.length);console.log(JSON.stringify({reconnect:'PASS',exchange}));
      }
      results.push({exchange,result:'PASS'});
    }catch(error){results.push({exchange,result:'FAIL',error:error.message,readiness:runner.diagnostics().reliability,transportError:transport.lastError||null});}
    finally{await runner.stop();}
  }));}finally{
    const resolved=path.resolve(directory);if(path.dirname(resolved)!==path.resolve(os.tmpdir())||!path.basename(resolved).startsWith('zych-12c-live-'))throw Error('UNSAFE_CLEANUP');
    await fs.rm(resolved,{recursive:true,force:true});
  }
  console.log(JSON.stringify({results,temporaryArtifacts:'REMOVED'},null,2));if(results.some(r=>r.result!=='PASS'))process.exitCode=1;
}
main().catch(error=>{console.error(error);process.exitCode=1;});
