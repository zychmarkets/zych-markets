'use strict';
// Isolated read-only development server. Never starts the alert runner or opens owner data.
const http=require('node:http'),fs=require('node:fs/promises'),path=require('node:path');
const {createBingxPublicProxy}=require('../server/http-server');
const root=path.resolve(__dirname,'..'),proxy=createBingxPublicProxy();
http.createServer(async(req,res)=>{
  try{
    if(req.method!=='GET'){res.writeHead(405).end();return;}
    const url=new URL(req.url,'http://localhost'),route=url.pathname;
    if(['/api/markets/bingx/catalog','/api/markets/bingx/tickers','/api/markets/bingx/candles'].includes(route)){res.setHeader('content-type','application/json');res.end(JSON.stringify(await proxy(route.split('/').at(-1),url.searchParams)));return;}
    if(route.startsWith('/api/')){res.writeHead(503,{'content-type':'application/json'}).end(JSON.stringify({error:'Isolated verification: backend disabled'}));return;}
    const file=path.resolve(root,'.'+decodeURIComponent(route==='/'?'/index.html':route));
    if(!file.startsWith(root+path.sep)||!['.html','.js','.css'].includes(path.extname(file))||file.includes(path.sep+'server-data'+path.sep)){res.writeHead(404).end();return;}
    let value=await fs.readFile(file);
    if(route==='/'&&url.searchParams.get('bingxFixture')==='1')value=value.toString().replace('<head>','<head><script src="/tests/bingx-fixture-storage.js"></script>');
    res.setHeader('content-type',({'.html':'text/html','.js':'text/javascript','.css':'text/css'})[path.extname(file)]);res.setHeader('cache-control','no-store');res.end(value);
  }catch(error){res.writeHead(502).end(error.message);}
}).listen(4180,'127.0.0.1',()=>console.log('Read-only BingX verification: http://127.0.0.1:4180'));
