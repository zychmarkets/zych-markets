(function(root,factory){
  'use strict';
  const api=factory(typeof module==='object'&&module.exports?require('./reliability-contract'):root.ZychReliabilityContract);
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.ZychReliability=api;
})(typeof window!=='undefined'?window:globalThis,function(contract){
  'use strict';
  const {evidence,selectGeneration,timestamp}=contract;
  const positive=value=>Number.isFinite(value)&&value>0;
  const elapsed=(now,at)=>timestamp(now)!==null&&timestamp(at)!==null&&at<=now?now-at:null;
  const RECEIPT_FIELDS=Object.freeze(['lastReceiptAt','lastMarketDataAt','lastPriceAt','lastCandleAt','lastSnapshotAt']);
  // No production timeouts. Callers choose policy by domain/exchange/channel/
  // timeframe/cadence. The default deliberately cannot establish freshness.
  function domainPolicy(domain,overrides={}){
    if(!contract.DOMAINS.includes(domain))throw new TypeError('Unknown reliability domain');
    const stream=['chart','alerts','radar'].includes(domain);
    return {...overrides,domain,requireGeneration:overrides.requireGeneration??stream,requireConnection:overrides.requireConnection??stream,requireSubscription:overrides.requireSubscription??stream,requireContinuity:overrides.requireContinuity??(domain==='radar'),requireProcessing:overrides.requireProcessing??(domain==='alerts'||domain==='radar'),requirePersistence:overrides.requirePersistence??(domain==='alerts'),requireDelivery:overrides.requireDelivery??(domain==='notification'),dataField:overrides.dataField??(domain==='snapshot'?'lastSnapshotAt':stream?'lastMarketDataAt':'lastReceiptAt'),maxReceiptAgeMs:overrides.maxReceiptAgeMs??null,maxSourceAgeMs:overrides.maxSourceAgeMs??null,requireSourceTimestamp:overrides.requireSourceTimestamp??false,ackTimeoutMs:overrides.ackTimeoutMs??null};
  }
  function freshness(value,policy,now){
    if(!RECEIPT_FIELDS.includes(policy.dataField))throw new TypeError('Freshness requires a validated receipt field');
    const e=evidence(value),at=e.data[policy.dataField],ageMs=elapsed(now,at),sourceAgeMs=elapsed(now,e.data.sourceTimestamp);
    let state='UNKNOWN',reasonCode='FRESHNESS_UNPROVEN';
    if(ageMs!==null&&positive(policy.maxReceiptAgeMs)){
      if(ageMs>policy.maxReceiptAgeMs){state='STALE';reasonCode='DATA_RECEIPT_STALE';}
      else if(e.data.sourceTimestamp!==null&&sourceAgeMs===null)reasonCode='SOURCE_CLOCK_UNVERIFIED';
      else if(sourceAgeMs!==null&&positive(policy.maxSourceAgeMs)&&sourceAgeMs>policy.maxSourceAgeMs){state='STALE';reasonCode='SOURCE_DATA_STALE';}
      else if(policy.requireSourceTimestamp&&(sourceAgeMs===null||!positive(policy.maxSourceAgeMs)))reasonCode='SOURCE_FRESHNESS_UNPROVEN';
      else {state='FRESH';reasonCode=null;}
    }
    return {state,ageMs,sourceAgeMs,reasonCode};
  }
  function subscription(value,policy,now,fresh){
    const s=value.subscription,requested=s.requestedAt!==null,acknowledged=s.acknowledgement==='acknowledged'&&elapsed(now,s.lastAckAt)!==null;
    const timedOut=requested&&['pending','unknown'].includes(s.acknowledgement)&&positive(policy.ackTimeoutMs)&&elapsed(now,s.requestedAt)!==null&&elapsed(now,s.requestedAt)>policy.ackTimeoutMs;
    const failed=s.acknowledgement==='rejected'||Boolean(timedOut);
    const satisfied=!policy.requireSubscription||!failed&&(acknowledged||s.acknowledgement==='not-applicable');
    return {requested,acknowledged,failed,active:satisfied&&fresh.state==='FRESH',stale:requested&&fresh.state==='STALE',satisfied,reasonCode:timedOut?'ACK_TIMEOUT':failed?s.errorCode||'SUBSCRIPTION_REJECTED':null};
  }
  function reduceFeed(value,{policy=domainPolicy(value?.identity?.domain||'chart'),now,current}={}){
    if(timestamp(now)===null)throw new TypeError('An explicit clock value is required');
    const selected=policy.requireGeneration?selectGeneration(value,current):{evidence:evidence(value),current:true},e=selected.evidence;
    const fresh=freshness(e,policy,now),sub=subscription(e,policy,now,fresh);
    let state='UNKNOWN',reason='EVIDENCE_MISSING';
    if(e.capability.state==='UNSUPPORTED'){state='UNSUPPORTED';reason=e.capability.reasonCode||'CAPABILITY_UNSUPPORTED';}
    else if(!selected.current){reason='GENERATION_UNVERIFIED';}
    else if(e.capability.state==='UNKNOWN'){reason='CAPABILITY_UNKNOWN';}
    else if(e.identity.domain!==policy.domain){reason='POLICY_DOMAIN_MISMATCH';}
    else if(policy.requireConnection&&e.connection.reconnecting===true){state='RECONNECTING';reason='CONNECTION_RECOVERING';}
    else if(policy.requireConnection&&e.connection.state==='FAILED'){state='FAILED';reason='CONNECTION_FAILED';}
    else if(policy.requireConnection&&e.connection.state==='CLOSED'){state='OFFLINE';reason='CONNECTION_CLOSED';}
    else if(policy.requireConnection&&e.connection.state==='CONNECTING'){state='CONNECTING';reason='CONNECTION_PENDING';}
    else if(policy.requireConnection&&e.connection.state!=='OPEN'){reason='CONNECTION_UNKNOWN';}
    else if(policy.requireSubscription&&sub.failed){state='FAILED';reason=sub.reasonCode;}
    else if(!sub.satisfied){state=e.subscription.acknowledgement==='pending'?'SUBSCRIBING':'UNKNOWN';reason='SUBSCRIPTION_UNPROVEN';}
    else if(fresh.state==='STALE'){state='STALE';reason=fresh.reasonCode;}
    else if(e.data[policy.dataField]===null){state=e.connection.state==='OPEN'||e.subscription.requestedAt!==null?'WAITING_FOR_DATA':'UNKNOWN';reason='NO_USABLE_DATA';}
    else if(fresh.state!=='FRESH'){reason=fresh.reasonCode;}
    else {
      const gates=[...(policy.requireContinuity?[{state:e.continuity.state,ready:'VERIFIED',reason:'CONTINUITY_UNPROVEN'}]:[]),...['processing','persistence','delivery'].filter(name=>policy['require'+name[0].toUpperCase()+name.slice(1)]).map(name=>({state:e[name].state,ready:'READY',reason:name.toUpperCase()+'_UNPROVEN'}))];
      const blocked=gates.find(gate=>gate.state!==gate.ready);
      if(blocked){state=blocked.state==='UNKNOWN'?'UNKNOWN':'DEGRADED';reason=blocked.reason;}
      else {state='LIVE';reason=null;}
    }
    sub.active=sub.active&&selected.current&&['SUPPORTED','LIMITED'].includes(e.capability.state)&&e.identity.domain===policy.domain&&(!policy.requireConnection||e.connection.state==='OPEN'&&e.connection.reconnecting!==true);
    return {state,capability:e.capability,freshness:fresh,subscription:sub,reasons:reason?[reason]:[],evidence:e};
  }
  // One record per expected topic. Missing records must remain in this manifest.
  // Duplicate topic identities are rejected rather than silently overstating coverage.
  function summarize(results=[]){
    const counts={total:results.length,supported:0,unsupported:0,requested:0,acknowledged:0,failed:0,active:0,stale:0,live:0,unknown:0};
    const seen=new Set();
    for(let index=0;index<results.length;index++){
      const r=results[index];
      const i=r.evidence.identity,key=JSON.stringify([i.domain,i.exchange,i.marketId,i.nativeSymbol,i.channel,i.timeframe,i.connectionId]);
      if(seen.has(key))throw new TypeError('Duplicate reliability topic');seen.add(key);
      if(r.state==='UNSUPPORTED'){counts.unsupported++;continue;}
      counts.supported+=r.capability.state==='SUPPORTED'||r.capability.state==='LIMITED'?1:0;
      for(const key of ['requested','acknowledged','failed','active','stale'])counts[key]+=r.subscription[key]?1:0;
      counts.live+=r.state==='LIVE'?1:0;counts.unknown+=r.state==='UNKNOWN'?1:0;
    }
    const applicable=results.filter(r=>r.state!=='UNSUPPORTED'),states=new Set(applicable.map(r=>r.state));
    const state=applicable.length===0?(results.length?'UNSUPPORTED':'UNKNOWN'):states.size===1?applicable[0].state:'PARTIAL';
    return {state,counts,reasons:[...new Set(results.flatMap(r=>r.reasons))]};
  }
  function diagnostics({domain,records=[],policy=domainPolicy(domain),now,instanceId=null,detailLimit=50}={}){
    if(timestamp(now)===null)throw new TypeError('An explicit clock value is required');
    if(!contract.DOMAINS.includes(domain))throw new TypeError('Unknown reliability domain');
    const results=records.map(record=>reduceFeed(record.evidence,{now,current:record.current,policy:typeof policy==='function'?policy(evidence(record.evidence).identity):policy}));
    if(results.some(r=>r.evidence.identity.domain!==domain))throw new TypeError('Diagnostics domain mismatch');
    const summary=summarize(results),limit=Number.isInteger(detailLimit)?Math.max(0,Math.min(200,detailLimit)):50;
    const details=results.slice(0,limit).map(result=>{
      // Free-form transport errors can contain URLs, credentials or owner data.
      // Public DTOs expose only machine codes, never free-form error strings.
      const clean=evidence(result.evidence);clean.error.message=null;clean.subscription.errorMessage=null;clean.connection.lastDisconnectReason=null;
      return {...result,evidence:clean};
    });
    return {schemaVersion:contract.SCHEMA_VERSION,generatedAt:now,instanceId:contract.identifier(instanceId),domain,summary:summary.state,counts:summary.counts,reasons:summary.reasons.length?summary.reasons:records.length?[]:['EVIDENCE_MISSING'],details,omittedDetails:results.length-details.length};
  }
  // Additive projection, NOT a translation of LIVE into a legacy status. Older
  // consumers keep exactly their existing fields until their domain migrates.
  const withReliability=(legacy,dto)=>({...legacy,reliability:dto});
  return {domainPolicy,freshness,subscription,reduceFeed,summarize,diagnostics,withReliability};
});
