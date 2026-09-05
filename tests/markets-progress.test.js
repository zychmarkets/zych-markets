'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {coverage,confirmedChange,status,RenderThrottle}=require('../js/services/markets-progress'),{CatalogLoader}=require('../js/services/catalog-loader'),contract=require('../js/exchanges/kraken-public'),data=require('../js/services/markets-data');
const at=Date.parse('2026-09-05T12:00:00Z'),identity={nativeSymbol:'XXBTZUSD',wsSymbol:'BTC/USD',baseAsset:'BTC',quoteAsset:'USD'};
const rest=()=>contract.restTicker({c:['100'],h:[0,'110'],l:[0,'90'],v:[0,'10'],p:[0,'101']},at);
const ws=()=>contract.wsTicker({last:101,change_pct:2,change:2,high:110,low:90,volume:10,vwap:101,timestamp:new Date(at).toISOString()},at);
const item=(r,w,now=at)=>data.item(contract.instrument(identity),contract.snapshot(identity,r,w,now));
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('default browser timers are called without a throttle receiver',()=>{
  const vm=require('node:vm'),fs=require('node:fs');let scheduled=0,cancelled=0;
  const context=vm.createContext({setTimeout:function(){'use strict';assert.equal(this,undefined);scheduled++;return 1;},clearTimeout:function(){'use strict';assert.equal(this,undefined);cancelled++;}});
  vm.runInContext(fs.readFileSync(require.resolve('../js/services/markets-progress'),'utf8'),context);
  const throttle=new context.ZychMarketsProgress.RenderThrottle(()=>{}, {now:()=>0});
  throttle.request('kraken');throttle.request('kraken');throttle.dispose();assert.equal(scheduled,1);assert.equal(cancelled,1);
});
function clock(){let now=0,id=0;const timers=new Map();return{timers,now:()=>now,schedule(fn,delay){timers.set(++id,{at:now+delay,fn});return id;},cancel(id){timers.delete(id)},advance(ms){const target=now+ms;while(true){const next=[...timers].sort((a,b)=>a[1].at-b[1].at)[0];if(!next||next[1].at>target)break;now=next[1].at;timers.delete(next[0]);next[1].fn();}now=target;}};}
test('partial coverage separates REST prices from verified WS changes and retains nulls',()=>{
  const rows=[item(rest(),null),{...item(null,ws()),marketId:'kraken:spot:XETHZUSD'},item(null,null)];
  assert.deepEqual(coverage(rows),{total:3,prices:2,changes:1,complete:false});assert.equal(rows[0].change24h,null);assert.equal(rows[2].price,null);
  assert.equal(data.breadth(rows.filter(confirmedChange)).total,1);assert.equal(data.breadth(rows.filter(confirmedChange)).risingPct,100);
  assert.equal(confirmedChange({...rows[0],change24h:0}),false);assert.equal(confirmedChange({...rows[1],change24h:0}),true);
  assert.equal(rows[1].quoteVolume24h,null);assert.equal(coverage([item(rest(),ws(),at+180001)]).prices,0);assert.equal(coverage([item(rest(),ws(),at+180001)]).changes,0);
});
test('finished requests never imply full coverage and errors retain partial status',()=>{
  const partial={total:10,prices:10,changes:3,complete:false};
  assert.equal(status({catalog:'ready',quotes:'loading'},partial).key,'markets.loadingPartial');
  assert.equal(status({catalog:'ready',quotes:'ready'},partial).code,'partial');
  assert.equal(status({catalog:'ready',quotes:'error'},partial).key,'markets.partialError');
  assert.equal(status({catalog:'ready',quotes:'error'},{total:10,prices:0,changes:0}).code,'unavailable');
  assert.equal(status({catalog:'ready',quotes:'ready'},coverage([item(rest(),ws())])).code,'current');
});
test('render updates are at least 500ms apart and the final value has a trailing render',()=>{
  const c=clock(),renders=[];let latest=0;const t=new RenderThrottle(()=>renders.push({at:c.now(),value:latest}),c);
  t.request('kraken');for(let n=1;n<=10;n++){c.advance(40);latest=n;t.request('kraken');}
  assert.equal(renders.length,1);assert.equal(c.timers.size,1);c.advance(100);assert.deepEqual(renders,[{at:0,value:0},{at:500,value:10}]);
  latest=11;c.advance(10);t.request('kraken');c.advance(490);assert.deepEqual(renders.at(-1),{at:1000,value:11});assert.equal(c.timers.size,0);t.dispose();
});
test('switching cancels trailing renders and disposal frees timers',()=>{
  const c=clock(),renders=[];let exchange='kraken';const t=new RenderThrottle(()=>renders.push(exchange),c);
  t.request(exchange);c.advance(10);t.request(exchange);const obsolete=[...c.timers.values()][0].fn;
  exchange='bingx';t.request(exchange);obsolete();c.advance(600);assert.deepEqual(renders,['kraken','bingx']);
  t.request(exchange);c.advance(10);t.request(exchange);t.dispose();c.advance(500);assert.equal(c.timers.size,0);assert.deepEqual(renders,['kraken','bingx','bingx']);
});
test('progress subscriptions drop old exchange and old generation events, then dispose',async()=>{
  const handlers={},active=new Set(),events=[];
  const adapter=id=>({discover:async()=>[],allSnapshots:async()=>[],subscribeSnapshots(fn){handlers[id]=fn;active.add(id);return()=>active.delete(id)}});
  const loader=new CatalogLoader({kraken:adapter('kraken'),bingx:adapter('bingx')},{onProgress:id=>events.push(id)});
  loader.setActiveExchange('kraken');await loader.start();const old=handlers.kraken;old();loader.setActiveExchange('bingx');old();handlers.bingx();assert.deepEqual(events,['kraken','bingx']);assert.deepEqual([...active],['bingx']);
  const previous=handlers.bingx;await loader.start();previous();assert.equal(events.length,2);loader.dispose();handlers.bingx();assert.equal(events.length,2);assert.equal(active.size,0);
});
test('adapter-reported collection error publishes cached partial data and ends loading',async()=>{
  const rows=[item(rest(),null)],events=[];const loader=new CatalogLoader({kraken:{discover:async()=>[contract.instrument(identity)],allSnapshots:async()=>rows,diagnostics:()=>({lastError:'Kraken subscribe timeout'})}},{onQuotes:(id,values)=>events.push(values)});
  await loader.start();await tick();assert.equal(loader.states.kraken.quotes,'error');assert.equal(events[0][0].price,100);assert.equal(events[0][0].change24h,null);assert.equal(status(loader.states.kraken,coverage(events[0])).code,'partial');loader.dispose();
});
