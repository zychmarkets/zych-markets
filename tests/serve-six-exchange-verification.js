'use strict';
// Read-only API + in-memory browser storage. No owner files or execution runner.
// / uses real public market adapters; /?fixture=1 uses explicitly synthetic UI adapters.
// /?switch=1 starts at real Binance LINK/USDT and retains only the test workspace
// across reloads in server memory. Stopping this server discards that context.
// /layout runs CSS viewport-equivalent zoom checks, not native browser zoom.
const fs=require('node:fs'),path=require('node:path');
const {createHttpServer}=require('../server/http-server'),core=require('../js/alerts/alert-core');
const {markets}=require('./six-exchange-fixture');
const root=path.resolve(__dirname,'..'),read=name=>fs.readFileSync(path.join(__dirname,name),'utf8');
const alerts=markets.slice(0,6).map((market,i)=>({...core.createAlert({...market,condition:{type:'price',operator:'above',value:79000},mode:'once'},{id:'isolated-'+i}),status:'paused'}));
const instance=createHttpServer({config:{production:false,root,staticRoot:root},logger:console,runner:{list:()=>alerts,events:()=>[],diagnostics:()=>({status:'idle',monitoringStatus:'IDLE',activeAlerts:0}),create:()=>({error:'READ_ONLY_FIXTURE',message:'This fixture does not execute alerts.'})},storage:{status:()=>({healthy:true,type:'memory-fixture'})},notifier:{status:()=>({pushEnabled:false})}});
const original=instance.server.listeners('request')[0];instance.server.removeAllListeners('request');
let switchWorkspace=null;
instance.server.on('request',(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  // Isolated manual-switch acceptance state, retained only until this server stops.
  if(url.pathname==='/verification-workspace'){
    if(req.method==='GET'){res.setHeader('content-type','application/json');res.end(JSON.stringify(switchWorkspace));return;}
    if(req.method==='POST'){let body='';req.on('data',chunk=>{body+=chunk;if(body.length>2048)req.destroy();});req.on('end',()=>{try{const value=JSON.parse(body);if(!['binance','bybit','okx','bingx','coinbase','kraken'].includes(value.exchange)||!['marketId','asset','quoteAsset','timeframe'].every(key=>typeof value[key]==='string'&&/^[A-Za-z0-9:/-]{0,100}$/.test(value[key])))throw Error('Invalid fixture context');switchWorkspace=value;res.end('OK');}catch{res.statusCode=400;res.end('Invalid fixture context');}});return;}
  }
  if(req.method==='POST'&&url.pathname==='/verification-stop'){res.end('Stopping isolated fixture');setImmediate(()=>instance.server.close(()=>process.exit(0)));return;}
  if(req.method==='GET'&&url.pathname==='/layout'){res.setHeader('content-type','text/html');res.end(`<!doctype html><title>Isolated responsive verification</title><h1>Six-exchange layout verification</h1><p>CSS viewport-equivalent zoom; not native browser zoom. Synthetic market fixture, no owner data.</p><button id="run">Run 100 layout checks</button><pre id="results">Not run</pre><iframe id="product" title="Isolated product viewport" style="border:0;display:block"></iframe><script>${read('six-exchange-layout-verification.js')}</script>`);return;}
  if(req.method==='GET'&&url.pathname==='/'){
    const switchTest=url.searchParams.get('switch')==='1';
    const bootstrap=`<script>${read('bingx-fixture-storage.js')}</script>`+(switchTest?`<script>localStorage.setItem('zych.exchange-workspace.v1',${JSON.stringify(JSON.stringify(switchWorkspace||{exchange:'binance',marketId:'binance:spot:LINKUSDT',asset:'LINK',quoteAsset:'USDT',timeframe:'1m'})).replace(/</g,'\\u003c')});const fixtureSetItem=localStorage.setItem;localStorage.setItem=(key,value)=>{fixtureSetItem(key,value);if(key==='zych.exchange-workspace.v1')fetch('/verification-workspace',{method:'POST',headers:{'content-type':'application/json'},body:value});};</script>`:'');
    const fixture=url.searchParams.get('fixture')==='1',injection=`<script>ZychAlerts.ServerAlertClient=class extends ZychAlerts.ServerAlertClient{constructor(options){super({...options,baseUrl:'/api'})}};</script>`+(fixture?`<script>${read('six-exchange-fixture.js')}</script><script>${read('six-exchange-browser-fixture.js')}</script>`:'');
    res.setHeader('content-type','text/html');res.setHeader('cache-control','no-store');res.end(fs.readFileSync(path.join(root,'index.html'),'utf8').replace('<head>','<head>'+bootstrap).replace('<script src="app.js"></script>',injection+'<script src="app.js"></script>'));return;
  }
  original(req,res);
});
instance.server.listen(4200,'127.0.0.1',()=>console.log('ISOLATED_SIX_EXCHANGE http://127.0.0.1:4200/?fixture=1 ; /layout ; POST /verification-stop. NO OWNER STORAGE.'));
