'use strict';
// Isolated browser origin and read-only backend: never opens owner storage.
const {createHttpServer}=require('../server/http-server.js');
const instance=createHttpServer({config:{production:true,root:process.cwd(),staticRoot:process.cwd()},logger:console,
  runner:{list:()=>[],events:()=>[],diagnostics:()=>({status:'verification-disabled'}),create:()=>({error:'Verification is read-only'})},
  storage:{status:()=>({status:'verification-no-owner-data'})},notifier:{status:()=>({push:false})}});
// A visible test-only transport interruption exercises the application's actual
// reconnect closure. This is never part of the production static response.
const request=instance.server.listeners('request')[0];instance.server.removeListener('request',request);
instance.server.on('request',(req,res)=>{
  if(req.url==='/app.js'){
    const source=require('node:fs').readFileSync(require.resolve('../app.js'),'utf8');
    const injection=`const verifyButton=document.createElement('button');verifyButton.textContent='Verification: interrupt stream';verifyButton.style.cssText='position:fixed;bottom:4px;left:4px;z-index:10000';document.body.append(verifyButton);verifyButton.onclick=()=>{if(activeSocket)WebSocket.prototype.close.call(activeSocket,1000,'Verification transport interruption');};`;
    res.writeHead(200,{'content-type':'text/javascript','cache-control':'no-store'});res.end(source.replace('function stopMarket(){',injection+'\n  function stopMarket(){'));return;
  }
  request(req,res);
});
instance.server.listen(4186,'127.0.0.1',()=>console.log('Isolated live verification http://127.0.0.1:4186'));
