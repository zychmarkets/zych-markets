const test=require('node:test');
const assert=require('node:assert/strict');
const {ServerAlertClient,resolveAlertApiBase}=require('../js/alerts/server-alert-client.js');
const {applyCors}=require('../server/http-server.js');

test('alert API uses same origin normally and the canonical backend for alternate local origins',()=>{
  assert.equal(resolveAlertApiBase({protocol:'http:',hostname:'127.0.0.1',port:'4178'}),'/api');
  assert.equal(resolveAlertApiBase({protocol:'http:',hostname:'localhost',port:'5173'}),'http://127.0.0.1:4178/api');
  assert.equal(resolveAlertApiBase({protocol:'file:',hostname:'',port:''}),'http://127.0.0.1:4178/api');
  assert.equal(resolveAlertApiBase({protocol:'https:',hostname:'localhost',port:'5173'}),'/api');
});

test('network failures become a stable service-unavailable result instead of raw fetch errors',async()=>{
  const original=global.fetch;global.fetch=async()=>{throw new TypeError('Failed to fetch')};
  try{const result=await new ServerAlertClient({baseUrl:'http://127.0.0.1:1/api'}).create({});assert.deepEqual(result,{error:'Alert service unavailable',errorCode:'NETWORK_UNAVAILABLE'})}
  finally{global.fetch=original}
});

test('alert backend permits alternate loopback origins only in local development',()=>{
  const response=()=>({headers:{},setHeader(name,value){this.headers[name]=value}}),request={headers:{origin:'http://localhost:5173',host:'127.0.0.1:4178'}};
  const local=response();assert.equal(applyCors(request,local,{production:false,allowedOrigins:[]}),true);assert.equal(local.headers['access-control-allow-origin'],'http://localhost:5173');
  assert.equal(applyCors(request,response(),{production:true,allowedOrigins:[]}),false);
});

test('post-create sync wins over an older polling response and updates one shared alert state',async()=>{
  const oldAlerts={};oldAlerts.promise=new Promise(resolve=>{oldAlerts.resolve=resolve});
  const oldTriggers={};oldTriggers.promise=new Promise(resolve=>{oldTriggers.resolve=resolve});
  const created={id:'bybit-alert-1',marketId:'bybit:spot:BTCUSDT',exchange:'bybit',marketType:'spot',symbol:'BTCUSDT',status:'active',condition:{type:'price',operator:'above',value:80000}};
  let alertsGets=0,triggersGets=0,changes=0;const original=global.fetch;
  global.fetch=async(url,options={})=>{const path=new URL(url).pathname;if(options.method==='POST')return{ok:true,status:201,json:async()=>({alert:created})};if(path.endsWith('/alerts')){alertsGets+=1;if(alertsGets===1)return oldAlerts.promise;return{ok:true,status:200,json:async()=>({alerts:[created]})}}if(path.endsWith('/triggers')){triggersGets+=1;if(triggersGets===1)return oldTriggers.promise;return{ok:true,status:200,json:async()=>({triggers:[]})}}if(path.endsWith('/health'))return{ok:true,status:200,json:async()=>({alerts:{monitoringStatus:'LIVE'}})};throw new Error('unexpected request')};
  try{const client=new ServerAlertClient({baseUrl:'http://127.0.0.1:4178/api',onChange:()=>{changes+=1}}),poll=client.sync({notify:false}),creation=client.create({});await creation;oldAlerts.resolve({ok:true,status:200,json:async()=>({alerts:[]})});oldTriggers.resolve({ok:true,status:200,json:async()=>({triggers:[]})});await poll;assert.deepEqual(client.list(),[created]);assert.equal(client.activeCount(),1);assert.equal(changes,1)}finally{global.fetch=original}
});

test('client reports backend monitoring diagnostics instead of inferring LIVE from alert count',async()=>{
  const original=global.fetch,statuses=[];global.fetch=async url=>({ok:true,status:200,json:async()=>String(url).endsWith('/alerts')?{alerts:[{status:'active'}]}:String(url).endsWith('/triggers')?{triggers:[]}:{alerts:{monitoringStatus:'RECONNECTING'}}});
  try{await new ServerAlertClient({baseUrl:'http://127.0.0.1:4178/api',onStatus:value=>statuses.push(value)}).sync();assert.deepEqual(statuses,['RECONNECTING'])}finally{global.fetch=original}
});

test('repeated polling and history disappearance cannot replay an already seen trigger',async()=>{const original=global.fetch,notified=[],trigger={id:'stable-trigger',alertId:'a',marketId:'binance:spot:BTCUSDT'},triggerResponses=[[],[trigger],[trigger],[],[trigger]];global.fetch=async url=>{const path=new URL(url).pathname;if(path.endsWith('/alerts'))return{ok:true,status:200,json:async()=>({alerts:[]})};if(path.endsWith('/triggers'))return{ok:true,status:200,json:async()=>({triggers:triggerResponses.shift()||[]})};return{ok:true,status:200,json:async()=>({alerts:{monitoringStatus:'IDLE'}})}};try{const client=new ServerAlertClient({baseUrl:'http://127.0.0.1:4178/api',notifier:{notify:event=>notified.push(event.id)}});for(let index=0;index<5;index++)await client.sync();assert.deepEqual(notified,['stable-trigger']);assert.deepEqual(client.events(),[trigger])}finally{global.fetch=original}});
