'use strict';
// Read-only API + in-memory browser storage. No owner files or execution runner.
// / uses real public market adapters; /?fixture=1 uses explicitly synthetic UI adapters.
// /layout runs CSS viewport-equivalent zoom checks, not native browser zoom.
const fs=require('node:fs'),path=require('node:path');
const {createHttpServer}=require('../server/http-server'),core=require('../js/alerts/alert-core');
const {markets}=require('./six-exchange-fixture');
const root=path.resolve(__dirname,'..'),read=name=>fs.readFileSync(path.join(__dirname,name),'utf8');
const alerts=markets.slice(0,6).map((market,i)=>({...core.createAlert({...market,condition:{type:'price',operator:'above',value:79000},mode:'once'},{id:'isolated-'+i}),status:'paused'}));
const instance=createHttpServer({config:{production:false,root,staticRoot:root},logger:console,runner:{list:()=>alerts,events:()=>[],diagnostics:()=>({status:'idle',monitoringStatus:'IDLE',activeAlerts:0}),create:()=>({error:'READ_ONLY_FIXTURE',message:'This fixture does not execute alerts.'})},storage:{status:()=>({healthy:true,type:'memory-fixture'})},notifier:{status:()=>({pushEnabled:false})}});
const original=instance.server.listeners('request')[0];instance.server.removeAllListeners('request');
instance.server.on('request',(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(req.method==='POST'&&url.pathname==='/verification-stop'){res.end('Stopping isolated fixture');setImmediate(()=>instance.server.close(()=>process.exit(0)));return;}
  if(req.method==='GET'&&url.pathname==='/layout'){res.setHeader('content-type','text/html');res.end(`<!doctype html><title>Isolated responsive verification</title><h1>Six-exchange layout verification</h1><p>CSS viewport-equivalent zoom; not native browser zoom. Synthetic market fixture, no owner data.</p><button id="run">Run 100 layout checks</button><pre id="results">Not run</pre><iframe id="product" title="Isolated product viewport" style="border:0;display:block"></iframe><script>${read('six-exchange-layout-verification.js')}</script>`);return;}
  if(req.method==='GET'&&url.pathname==='/'){
    const bootstrap=`<script>${read('bingx-fixture-storage.js')}</script>`;
    const fixture=url.searchParams.get('fixture')==='1',injection=`<script>ZychAlerts.ServerAlertClient=class extends ZychAlerts.ServerAlertClient{constructor(options){super({...options,baseUrl:'/api'})}};</script>`+(fixture?`<script>${read('six-exchange-fixture.js')}</script><script>${read('six-exchange-browser-fixture.js')}</script>`:'');
    res.setHeader('content-type','text/html');res.setHeader('cache-control','no-store');res.end(fs.readFileSync(path.join(root,'index.html'),'utf8').replace('<head>','<head>'+bootstrap).replace('<script src="app.js"></script>',injection+'<script src="app.js"></script>'));return;
  }
  original(req,res);
});
instance.server.listen(4200,'127.0.0.1',()=>console.log('ISOLATED_SIX_EXCHANGE http://127.0.0.1:4200/?fixture=1 ; /layout ; POST /verification-stop. NO OWNER STORAGE.'));
