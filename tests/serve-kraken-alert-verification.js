'use strict';
// Real public feeds + production runner/client. Only the data directory and browser storage are isolated.
// No synthetic ticks or owner storage access. POST /verification-stop for graceful cleanup
// (some Windows terminal hosts terminate the process without delivering Ctrl+C).
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {createServerApp}=require('../server/app'),{loadConfig}=require('../server/config');
const root=path.resolve(__dirname,'..');
(async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'zych-kraken-live-'));
  const app=await createServerApp({config:{...loadConfig({}),port:4199,dataDir:directory,radarEnabled:false,radarIngestionEnabled:false}});
  await app.runner.persist();
  const ticks=[],transport=app.transport.transports.kraken;
  const start=transport.start.bind(transport);
  transport.start=(alerts,handlers)=>start(alerts,{...handlers,onEvent:event=>{ticks.push(event);if(ticks.length>5000)ticks.shift();handlers.onEvent?.(event)}});
  const original=app.server.listeners('request')[0];app.server.removeAllListeners('request');
  const bootstrap=`<script>${await fs.readFile(path.join(__dirname,'bingx-fixture-storage.js'),'utf8')}
  localStorage.setItem('zych.watchlist.v1',JSON.stringify([{key:'kraken:spot:XXBTZUSD',marketId:'kraken:spot:XXBTZUSD',exchange:'kraken',marketType:'spot',symbol:'XXBTZUSD',asset:'BTC',baseAsset:'BTC',quoteAsset:'USD'}]));
  localStorage.setItem('zych.exchange-workspace.v1',JSON.stringify({exchange:'kraken',marketId:'kraken:spot:XXBTZUSD',asset:'BTC',quoteAsset:'USD',timeframe:'1m'}));</script>`;
  const instrumentation=`<script>
  ZychAlerts.ServerAlertClient=class extends ZychAlerts.ServerAlertClient{constructor(options){super({...options,baseUrl:'/api'})}};
  const evidence=document.createElement('details');evidence.id='verification-evidence';evidence.style='position:fixed;bottom:4px;left:4px;z-index:10000;background:#101820;color:white;max-width:450px';evidence.innerHTML='<summary>Isolated live test evidence</summary><pre id="verification-observations"></pre>';document.body.append(evidence);
  const observations={toastCount:0,sound:null,toasts:[]},output=()=>document.getElementById('verification-observations').textContent=JSON.stringify(observations,null,2);
  ZychNotifications.AlertSoundManager=class extends ZychNotifications.AlertSoundManager{emitState(){super.emitState();observations.sound=this.state();output()}};
  new MutationObserver(records=>{for(const record of records)for(const node of record.addedNodes)if(node.classList?.contains('alert-toast')){observations.toastCount++;observations.toasts.push(node.textContent);output()}}).observe(document.getElementById('toast-region'),{childList:true});output();
  </script>`;
  app.server.on('request',async(req,res)=>{
    try{
      if(req.method==='POST'&&req.url==='/verification-stop'){res.end('Stopping isolated verification');setImmediate(()=>stop().then(()=>process.exit(0)));return}
      if(req.method==='GET'&&req.url==='/verification-state'){res.setHeader('content-type','application/json');res.end(JSON.stringify({directory,alerts:app.runner.list(),history:app.runner.events(),diagnostics:app.runner.diagnostics(),ticks,persisted:JSON.parse(await fs.readFile(path.join(directory,'alerts-state.json'),'utf8'))}));return}
      if(req.method==='GET'&&new URL(req.url,'http://localhost').pathname==='/'){const html=(await fs.readFile(path.join(root,'index.html'),'utf8')).replace('<head>','<head>'+bootstrap).replace('<script src="app.js"></script>',instrumentation+'<script src="app.js"></script>');res.setHeader('content-type','text/html');res.end(html);return}
      original(req,res);
    }catch(error){res.writeHead(500).end(error.message)}
  });
  await app.listen();console.log('ISOLATED_REAL_KRAKEN http://127.0.0.1:4199/ '+directory);
  let stopping=false;const stop=async()=>{if(stopping)return;stopping=true;await app.stop();assert.equal(path.dirname(directory),os.tmpdir());assert.ok(path.basename(directory).startsWith('zych-kraken-live-'));await fs.rm(directory,{recursive:true,force:true});console.log('TEMP_DATA_REMOVED; OWNER_DATA_NOT_TOUCHED');};
  process.on('SIGINT',()=>stop().then(()=>process.exit(0)));process.on('SIGTERM',()=>stop().then(()=>process.exit(0)));
})().catch(error=>{console.error(error);process.exitCode=1});
