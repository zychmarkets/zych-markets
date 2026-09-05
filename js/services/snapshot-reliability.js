(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.ZychSnapshotReliability=api})(typeof window!=='undefined'?window:globalThis,function(){
  'use strict';
  const POLICIES=Object.freeze({binance:75000,bybit:75000,okx:75000,bingx:80000,coinbase:80000,kraken:190000});
  const stamp=value=>Number.isSafeInteger(value)&&value>=0?value:null;
  function evaluate(value={},exchange,{now=Date.now(),failed=false}={}){
    const lastSnapshotAt=stamp(value.lastSnapshotAt??value.receivedAt),sourceTimestamp=stamp(value.sourceTimestamp),cacheStoredAt=stamp(value.cacheStoredAt),budget=POLICIES[exchange]||null;
    const ageMs=lastSnapshotAt!==null&&lastSnapshotAt<=now?now-lastSnapshotAt:null,sourceAgeMs=sourceTimestamp!==null&&sourceTimestamp<=now?now-sourceTimestamp:null,cacheHit=value.cacheHit===true;
    let state='UNAVAILABLE',reasonCode='SNAPSHOT_UNAVAILABLE';
    if(lastSnapshotAt!==null&&ageMs!==null&&budget!==null){
      if(failed||cacheHit||ageMs>budget){state=cacheHit?'CACHED':'STALE';reasonCode=failed?'REFRESH_FAILED':cacheHit?'CACHE_HIT':ageMs>budget?'ACQUISITION_STALE':null}
      else if(value.partial===true){state='PARTIAL';reasonCode='PARTIAL_REFRESH'}
      else {state='FRESH';reasonCode=null}
    }
    return{state,reasonCode,ageMs,sourceAgeMs,maxAgeMs:budget,sourceTimestamp,lastSnapshotAt,receiptTimestamp:stamp(value.receiptTimestamp??value.receivedAt),cacheStoredAt,cacheHit};
  }
  function summarize(rows=[],now=Date.now()){
    const results=rows.map(row=>evaluate(row,row.exchange,{now,failed:row.refreshFailed})),counts={total:results.length,FRESH:0,CACHED:0,STALE:0,PARTIAL:0,UNAVAILABLE:0};for(const row of results)counts[row.state]++;
    const state=!results.length?'UNAVAILABLE':counts.FRESH===results.length?'FRESH':counts.FRESH?'PARTIAL':counts.CACHED?'CACHED':counts.STALE?'STALE':counts.PARTIAL?'PARTIAL':'UNAVAILABLE';return{state,counts,oldestAgeMs:results.map(x=>x.ageMs).filter(Number.isFinite).sort((a,b)=>b-a)[0]??null,results};
  }
  return{POLICIES,evaluate,summarize};
});
