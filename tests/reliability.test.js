'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const contract=require('../js/services/reliability-contract');
const {domainPolicy,freshness,reduceFeed,diagnostics,withReliability}=require('../js/services/reliability-reducer');
const {productCapabilities,normalizedProductCapabilities}=require('../server/product-capabilities');
const {healthReliability}=require('../server/reliability-diagnostics');
const {createHttpServer}=require('../server/http-server');
const now=10000,current={connectionId:'socket-1',generation:2};
const policy=domainPolicy('chart',{maxReceiptAgeMs:1000,maxSourceAgeMs:2000,ackTimeoutMs:500});
function fixture(patch={}){
  const base={identity:{domain:'chart',exchange:'binance',marketId:'binance:spot:BTCUSDT',nativeSymbol:'BTCUSDT',channel:'kline',timeframe:'1m',...current},capability:{state:'SUPPORTED'},connection:{state:'OPEN',openedAt:9000},subscription:{requestedAt:9100,acknowledgement:'acknowledged',lastAckAt:9200},data:{firstDataAt:9300,lastReceiptAt:9900,lastMarketDataAt:9900,sourceTimestamp:9800,processingTimestamp:9950}};
  return Object.fromEntries([...new Set([...Object.keys(base),...Object.keys(patch)])].map(key=>[key,{...base[key],...patch[key]}]));
}
const reduce=(e,options={})=>reduceFeed(e,{policy,now,current,...options});
const deepFreeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(deepFreeze);Object.freeze(value);}return value;};

test('12A missing fields normalize to null/UNKNOWN without timestamp synthesis',()=>{
  const e=contract.evidence({identity:{domain:'chart'},data:{sourceTimestamp:'123',lastReceiptAt:NaN,processingTimestamp:Infinity,candleOpenTime:100}});
  assert.equal(e.capability.state,'UNKNOWN');assert.equal(e.connection.state,'UNKNOWN');assert.equal(e.subscription.acknowledgement,'unknown');
  for(const value of Object.values(e.data))assert.equal(value,null);
  assert.equal(contract.timestamp(0),0);assert.equal(contract.timestamp(null),null);assert.deepEqual(JSON.parse(JSON.stringify(e)),e);
});
test('12A normalization strips foreign objects and does not mutate caller evidence',()=>{
  const input=fixture();input.socket=input;input.data.controller={abort(){}};const result=contract.evidence(input);
  assert.doesNotThrow(()=>JSON.stringify(result));assert.equal(result.socket,undefined);assert.equal(result.data.controller,undefined);assert.equal(input.data.controller.abort instanceof Function,true);
});
test('12A pure deterministic reducer accepts frozen input and explicit clock',()=>{
  const input=deepFreeze(fixture()),p=deepFreeze({...policy}),epoch=deepFreeze({...current});
  const a=reduceFeed(input,{policy:p,now,current:epoch}),b=reduceFeed(input,{policy:p,now,current:epoch});assert.deepEqual(a,b);assert.equal(a.state,'LIVE');
  assert.throws(()=>reduceFeed(input,{policy:p,current:epoch}),/clock/);
});
for(const state of ['SUPPORTED','LIMITED','UNSUPPORTED'])test('12A canonical capability '+state,()=>assert.equal(contract.capability({state}).state,state));
test('12A unknown capability never implies support',()=>{assert.equal(contract.capability('RADAR-INELIGIBLE').state,'UNKNOWN');assert.equal(reduce(fixture({capability:{state:null}})).state,'UNKNOWN');});
for(const domain of contract.DOMAINS)test('12A '+domain+' default has no universal freshness timeout',()=>{
  const p=domainPolicy(domain);assert.equal(p.maxReceiptAgeMs,null);assert.equal(p.maxSourceAgeMs,null);
  const e=fixture({identity:{domain}});assert.notEqual(reduceFeed(e,{policy:p,now,current}).state,'LIVE');
});
test('12A policy resolver receives domain exchange channel timeframe and preserves cadence hooks',()=>{
  let identity;const p=domainPolicy('chart',{...policy,cadence:'activity-driven'});
  const dto=diagnostics({domain:'chart',now,records:[{evidence:fixture(),current}],policy:i=>{identity=i;return p;}});
  assert.equal(dto.summary,'LIVE');assert.equal(identity.exchange,'binance');assert.equal(identity.channel,'kline');assert.equal(identity.timeframe,'1m');assert.equal(p.cadence,'activity-driven');
});
test('12A domain mismatch cannot establish health',()=>assert.equal(reduce(fixture({identity:{domain:'alerts'}})).state,'UNKNOWN'));
for(const field of ['sourceTimestamp','processingTimestamp','cacheStoredAt','lastHeartbeatAt','candleOpenTime'])test('12A '+field+' cannot serve as receipt freshness',()=>assert.throws(()=>freshness(fixture(),{...policy,dataField:field},now),/receipt/));

for(const [name,patch,expected] of [
  ['socket only',{subscription:{requestedAt:null,acknowledgement:'unknown',lastAckAt:null},data:{firstDataAt:null,lastReceiptAt:null,lastMarketDataAt:null,sourceTimestamp:null,processingTimestamp:null}},'UNKNOWN'],
  ['socket and heartbeat',{subscription:{requestedAt:9900,acknowledgement:'pending',lastAckAt:null},data:{lastMarketDataAt:null},heartbeat:{lastHeartbeatAt:now}},'SUBSCRIBING'],
  ['socket and ACK',{data:{lastMarketDataAt:null}},'WAITING_FOR_DATA'],
  ['old receipt',{data:{lastMarketDataAt:8000}},'STALE'],
  ['old source delivered now',{data:{lastMarketDataAt:now,sourceTimestamp:7000}},'STALE'],
  ['fresh usable data',{},'LIVE'],
  ['data before ACK',{subscription:{requestedAt:9900,acknowledgement:'pending',lastAckAt:null}},'SUBSCRIBING'],
  ['data before unknown ACK',{subscription:{requestedAt:null,acknowledgement:'unknown',lastAckAt:null}},'UNKNOWN'],
  ['negative ACK despite fresh data',{subscription:{acknowledgement:'rejected',errorCode:'DENIED'}},'FAILED'],
  ['direct stream without ACK',{subscription:{acknowledgement:'not-applicable',lastAckAt:null}},'LIVE'],
  ['ACK timeout',{subscription:{acknowledgement:'pending',lastAckAt:null}},'FAILED'],
  ['future ACK',{subscription:{lastAckAt:now+1}},'UNKNOWN'],
  ['unknown connection',{connection:{state:'UNKNOWN'}},'UNKNOWN'],
  ['connecting',{connection:{state:'CONNECTING'}},'CONNECTING'],
  ['closed',{connection:{state:'CLOSED'}},'OFFLINE'],
  ['failed connection',{connection:{state:'FAILED'}},'FAILED'],
  ['reconnecting with old data',{connection:{reconnecting:true}},'RECONNECTING'],
  ['future receipt',{data:{lastMarketDataAt:now+1}},'UNKNOWN'],
  ['future source',{data:{sourceTimestamp:now+1}},'UNKNOWN']
])test('12A false-LIVE prevention: '+name,()=>{
  const result=reduce(fixture(patch));assert.equal(result.state,expected);
  if(name==='data before ACK'){assert.equal(result.evidence.data.lastMarketDataAt,9900);assert.equal(result.evidence.subscription.acknowledgement,'pending');assert.equal(result.subscription.acknowledged,false);}
  if(name==='direct stream without ACK'){assert.equal(result.subscription.acknowledged,false);assert.equal(result.evidence.subscription.lastAckAt,null);}
  if(name==='closed'||name==='reconnecting with old data')assert.equal(result.subscription.active,false);
});
test('12A heartbeat cannot advance receipt age',()=>{
  const result=reduce(fixture({data:{lastMarketDataAt:8000},heartbeat:{lastHeartbeatAt:now}}));
  assert.equal(result.state,'STALE');assert.equal(result.freshness.ageMs,2000);
});
test('12A freshness boundary and optional absent source time are explicit',()=>{
  assert.equal(reduce(fixture({data:{lastMarketDataAt:9000,sourceTimestamp:null}})).state,'LIVE');
  assert.equal(reduce(fixture({data:{lastMarketDataAt:8999}})).state,'STALE');
  assert.equal(reduce(fixture({data:{sourceTimestamp:null}}),{policy:{...policy,requireSourceTimestamp:true}}).state,'UNKNOWN');
});
test('12A quiet market is fresh transport evidence but not fabricated fresh data',()=>{
  const result=reduce(fixture({heartbeat:{lastHeartbeatAt:now},data:{lastMarketDataAt:8000}}));assert.equal(result.evidence.connection.state,'OPEN');assert.equal(result.state,'STALE');assert.notEqual(result.state,'OFFLINE');
});
for(const selection of [undefined,{connectionId:'socket-1',generation:3},{connectionId:'replacement',generation:2},{connectionId:'socket-1',generation:null}])test('12A invalid epoch removes ACK heartbeat data errors: '+JSON.stringify(selection),()=>{
  const input=fixture({heartbeat:{lastHeartbeatAt:now},error:{lastErrorAt:now,code:'OLD_ERROR',message:'old'}});
  const r=reduce(input,{current:selection});assert.equal(r.state,'UNKNOWN');assert.equal(r.subscription.acknowledged,false);assert.equal(r.evidence.heartbeat.lastHeartbeatAt,null);assert.equal(r.evidence.data.lastMarketDataAt,null);assert.equal(r.evidence.error.code,null);assert.equal(input.error.code,'OLD_ERROR');
});
test('12A current-generation evidence is selected without mutation',()=>{
  const selected=contract.selectGeneration(fixture(),current);assert.equal(selected.current,true);assert.equal(selected.evidence.subscription.lastAckAt,9200);
});

function records(count=10){return Array.from({length:count},(_,i)=>({current,evidence:fixture({identity:{marketId:'binance:spot:S'+i,nativeSymbol:'S'+i}})}));}
test('12A partial topics: ten requested nine ACK one rejected',()=>{
  const rows=records();Object.assign(rows[9].evidence.subscription,{acknowledgement:'rejected',lastAckAt:null,errorCode:'TOPIC_REJECTED'});
  const dto=diagnostics({domain:'chart',records:rows,policy,now});assert.equal(dto.summary,'PARTIAL');assert.equal(dto.counts.requested,10);assert.equal(dto.counts.acknowledged,9);assert.equal(dto.counts.failed,1);assert.equal(dto.counts.active,9);
});
test('12A partial topics: one fresh nine unknown never exchange-wide LIVE',()=>{
  const rows=records();for(const row of rows.slice(1))row.evidence.data={};
  const dto=diagnostics({domain:'chart',records:rows,policy,now});assert.equal(dto.summary,'PARTIAL');assert.equal(dto.counts.active,1);assert.equal(dto.counts.live,1);
});
test('12A one topic ACK cannot establish other topic ACKs',()=>{
  const rows=records();for(const row of rows.slice(1))row.evidence.subscription={requestedAt:9900,acknowledgement:'pending'};
  const dto=diagnostics({domain:'chart',records:rows,policy,now});assert.equal(dto.summary,'PARTIAL');assert.equal(dto.counts.acknowledged,1);assert.equal(dto.counts.active,1);
});
test('12A aggregation excludes capability restrictions from runtime denominator',()=>{
  const rows=records(2);rows[1].evidence.capability={state:'UNSUPPORTED',reasonCode:'EXACT_LIQUIDITY_UNAVAILABLE'};
  const dto=diagnostics({domain:'chart',records:rows,policy,now});assert.equal(dto.summary,'LIVE');assert.equal(dto.counts.unsupported,1);assert.equal(dto.counts.live,1);
});
test('12A duplicate topic records are rejected',()=>assert.throws(()=>diagnostics({domain:'chart',records:[...records(1),...records(1)],policy,now}),/Duplicate/));
test('12A independent socket epochs permit many sockets',()=>{
  const rows=records(2);rows[1].current={connectionId:'socket-2',generation:5};Object.assign(rows[1].evidence.identity,rows[1].current);
  assert.equal(diagnostics({domain:'chart',records:rows,policy,now}).summary,'LIVE');
});
test('12A stale topic count does not become full LIVE',()=>{
  const rows=records(2);rows[1].evidence.data.lastMarketDataAt=1;const dto=diagnostics({domain:'chart',records:rows,policy,now});assert.equal(dto.summary,'PARTIAL');assert.equal(dto.counts.stale,1);
});
for(const gate of ['processing','persistence'])test('12A alert '+gate+' must be independently proven',()=>{
  const e=fixture({identity:{domain:'alerts'},processing:{state:'READY'},persistence:{state:'READY'}}),p=domainPolicy('alerts',{maxReceiptAgeMs:1000});
  assert.equal(reduce(e,{policy:p}).state,'LIVE');e[gate].state='UNKNOWN';assert.equal(reduce(e,{policy:p}).state,'UNKNOWN');e[gate].state='FAILED';assert.equal(reduce(e,{policy:p}).state,'DEGRADED');
});
test('12A Radar requires continuity and processing independently',()=>{
  const e=fixture({identity:{domain:'radar'},processing:{state:'READY'},continuity:{state:'VERIFIED'}}),p=domainPolicy('radar',{maxReceiptAgeMs:1000});
  assert.equal(reduce(e,{policy:p}).state,'LIVE');e.continuity.state='GAP';assert.equal(reduce(e,{policy:p}).state,'DEGRADED');
});
test('12A snapshot uses acquisition time, never cache access',()=>{
  const e=fixture({identity:{domain:'snapshot'},data:{lastSnapshotAt:8000,cacheStoredAt:now,lastReceiptAt:now}}),p=domainPolicy('snapshot',{maxReceiptAgeMs:1000});
  const r=reduce(e,{policy:p});assert.equal(r.state,'STALE');assert.equal(r.freshness.ageMs,2000);
});
test('12A irrelevant subscription failure cannot imply REST snapshot failure',()=>{
  const e=fixture({identity:{domain:'snapshot'},subscription:{acknowledgement:'rejected'},data:{lastSnapshotAt:9900}});
  const result=reduce(e,{policy:domainPolicy('snapshot',{maxReceiptAgeMs:1000})});assert.equal(result.state,'LIVE');assert.equal(result.evidence.subscription.acknowledgement,'rejected');
});
test('12A ACK timeout is derived and never rewrites observed pending acknowledgement',()=>{
  const e=deepFreeze(fixture({subscription:{acknowledgement:'pending',lastAckAt:null}})),result=reduce(e);
  assert.equal(result.subscription.failed,true);assert.equal(result.subscription.reasonCode,'ACK_TIMEOUT');assert.equal(result.evidence.subscription.acknowledgement,'pending');assert.equal(e.subscription.acknowledgement,'pending');
});
test('12A same symbol different intervals have independent subscription evidence',()=>{
  const rows=[{current,evidence:fixture()},{current,evidence:fixture({identity:{timeframe:'5m'},subscription:{acknowledgement:'rejected',lastAckAt:null}})}];
  const dto=diagnostics({domain:'chart',records:rows,policy,now});assert.equal(dto.summary,'PARTIAL');assert.equal(dto.counts.acknowledged,1);assert.equal(dto.counts.failed,1);
});
test('12A delivery failure is separate from alert execution',()=>{
  const e=fixture({identity:{domain:'alerts'},processing:{state:'READY'},persistence:{state:'READY'},delivery:{state:'FAILED'}});
  assert.equal(reduce(e,{policy:domainPolicy('alerts',{maxReceiptAgeMs:1000})}).state,'LIVE');
  e.identity.domain='notification';assert.equal(reduce(e,{policy:domainPolicy('notification',{maxReceiptAgeMs:1000})}).state,'DEGRADED');
});

const exchanges=['binance','bybit','okx','bingx','coinbase','kraken'];
for(const exchange of exchanges)test('12A six-exchange capability regression: '+exchange,()=>{
  const raw=productCapabilities(),canonical=normalizedProductCapabilities(),row=canonical.exchanges[exchange],legacy=raw.exchanges[exchange];
  assert.deepEqual(canonical.productExchanges,exchanges);assert.deepEqual(canonical.radarSupportedExchanges,exchanges.slice(0,4));
  assert.equal(row.catalog.state,'SUPPORTED');assert.equal(row.search.state,'SUPPORTED');assert.equal(row.watchlist.state,'SUPPORTED');
  for(const type of ['price','movement','volume'])assert.equal(row.alerts[type].state,legacy.alertTypes.includes(type)?'SUPPORTED':'UNSUPPORTED');
  assert.equal(row.radar.state,exchanges.indexOf(exchange)<4?'SUPPORTED':'UNSUPPORTED');assert.equal(legacy.radar,exchanges.indexOf(exchange)<4?'SUPPORTED':'RADAR-INELIGIBLE');
  assert.equal(row.exactQuoteVolume24h.state,legacy.exactQuoteVolume24h?'SUPPORTED':'UNSUPPORTED');assert.equal(legacy.status,undefined);
});
for(const [exchange,feature,expected,reason] of [
  ['kraken','radar','UNSUPPORTED','EXACT_LIQUIDITY_UNAVAILABLE'],['coinbase','radar','UNSUPPORTED','EXACT_LIQUIDITY_UNAVAILABLE'],
  ['kraken','1M','UNSUPPORTED','INTERVAL_UNSUPPORTED'],['kraken','history','LIMITED','HISTORY_WINDOW_LIMITED'],['kraken','volume','UNSUPPORTED','EXACT_QUOTE_VOLUME_UNAVAILABLE']
])test('12A capability is not outage: '+exchange+' '+feature,()=>{
  const row=normalizedProductCapabilities().exchanges[exchange],cap=row[feature]||row.chartIntervals[feature]||row.alerts[feature];
  assert.deepEqual(cap,{state:expected,reasonCode:reason});const result=reduce(fixture({capability:cap}));assert.equal(result.state,expected==='LIMITED'?'LIVE':'UNSUPPORTED');
  const disconnected=reduce(fixture({capability:cap,connection:{state:'CLOSED'}}));if(expected==='UNSUPPORTED')assert.equal(disconnected.state,'UNSUPPORTED');
});
test('12A canonical intervals reflect existing maps without altering legacy capability fields',()=>{
  const c=normalizedProductCapabilities();for(const e of ['kraken','coinbase'])assert.equal(c.exchanges[e].chartIntervals['30m'].state,'UNSUPPORTED');
  assert.deepEqual(productCapabilities().exchanges.kraken.unsupportedChartIntervals,['1M']);assert.equal(c.exchanges.coinbase.chartIntervals['1M'].state,'SUPPORTED');
});
test('12A DTO is bounded, serializable and excludes raw errors and foreign objects',()=>{
  const rows=records(205);rows[0].evidence.error={code:'UPSTREAM_FAILED',message:'https://push.example/secret',lastErrorAt:1};rows[0].evidence.subscription.errorMessage='owner secret';rows[0].evidence.connection.lastDisconnectReason='endpoint secret';rows[0].evidence.pushSubscription={endpoint:'secret'};
  const dto=diagnostics({domain:'chart',records:rows,policy,now,detailLimit:999,instanceId:'server-1'});
  assert.equal(dto.details.length,200);assert.equal(dto.omittedDetails,5);assert.equal(dto.counts.total,205);assert.doesNotMatch(JSON.stringify(dto),/secret|pushSubscription/);assert.deepEqual(JSON.parse(JSON.stringify(dto)),dto);
  assert.equal(rows[0].evidence.error.message,'https://push.example/secret');
});
test('12A zero-detail DTO retains complete summary',()=>{const dto=diagnostics({domain:'chart',records:records(),policy,now,detailLimit:0});assert.equal(dto.details.length,0);assert.equal(dto.counts.live,10);});
test('12A empty diagnostics are UNKNOWN',()=>{const dto=diagnostics({domain:'backend',now});assert.equal(dto.summary,'UNKNOWN');assert.deepEqual(dto.reasons,['EVIDENCE_MISSING']);});
test('12A server prep never promotes legacy transport claims',()=>{
  const result=healthReliability({now,instanceId:'server-1'});assert.equal(result.summary,'UNKNOWN');for(const dto of Object.values(result.domains))assert.equal(dto.summary,'UNKNOWN');
  assert.equal(result.domains.radar.counts.unsupported,2);assert.equal(result.domains.radar.counts.supported,4);assert.equal(result.domains.alerts.counts.active,0);
});
test('12A additive projection preserves all legacy fields even when canonical result differs',()=>{
  const legacy=deepFreeze({status:'ok',uptimeSeconds:20,capabilities:productCapabilities(),storage:{healthy:true},alerts:{status:'running',monitoringStatus:'LIVE'},push:{pushEnabled:false}});
  const projected=withReliability(legacy,healthReliability({now,instanceId:'server-1'})),{reliability,...rest}=projected;
  assert.deepEqual(rest,legacy);assert.equal(reliability.domains.alerts.summary,'UNKNOWN');assert.equal(legacy.reliability,undefined);
});
test('12A browser and Node pure modules produce identical output without DOM',()=>{
  const sandbox={};vm.createContext(sandbox);
  for(const file of ['reliability-contract','reliability-reducer'])vm.runInContext(fs.readFileSync(require.resolve('../js/services/'+file),'utf8'),sandbox);
  const output=sandbox.ZychReliability.reduceFeed(fixture(),{policy,now,current});assert.deepEqual(JSON.parse(JSON.stringify(output)),reduce(fixture()));
});
test('12A HTTP health adds diagnostics without changing legacy fields or Radar endpoints',async()=>{
  const runner={diagnostics:()=>({monitoringStatus:'LIVE',status:'running',connections:1})},storage={status:()=>({healthy:true,type:'memory'})},notifier={status:()=>({pushEnabled:false,pushSubscriptionsCount:0})};
  const health={live:()=>({status:'alive'}),ready:()=>({status:'ready',lifecycle:'READY'}),lifecycle:{snapshot:()=>({state:'READY',reasonCodes:[]})}};
  const universe={health:()=>({generatedAt:1,coverage:{status:'HEALTHY',expectedExchanges:['binance'],healthyExchanges:['binance']}})};
  const http=createHttpServer({runner,storage,notifier,health,universe,eventStore:{size:0,listRecent:()=>[]},config:{production:false,allowedOrigins:[]},logger:{warn(){},error(){}}});
  await new Promise(resolve=>http.server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+http.server.address().port;
  try{
    const get=async path=>{const response=await fetch(base+path);assert.equal(response.status,200);return response.json();};
    const first=await get('/api/health'),second=await get('/api/health');
    assert.equal(first.status,'ok');assert.equal(typeof first.uptimeSeconds,'number');assert.deepEqual(first.alerts,runner.diagnostics());assert.deepEqual(first.capabilities,productCapabilities());assert.deepEqual(first.storage,storage.status());assert.deepEqual(first.push,notifier.status());
    assert.equal(first.reliability.domains.alerts.summary,'UNKNOWN');assert.equal(first.reliability.instanceId,second.reliability.instanceId);
    assert.deepEqual(await get('/health/ready'),health.ready());
    for(const path of ['/api/radar/events','/api/radar/universe/health','/api/radar/health'])assert.equal((await get(path)).reliability,undefined);
  }finally{await new Promise(resolve=>http.server.close(resolve));}
});
