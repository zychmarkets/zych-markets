(function(root,factory){
  'use strict';
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.ZychReliabilityContract=api;
})(typeof window!=='undefined'?window:globalThis,function(){
  'use strict';
  const SCHEMA_VERSION=1;
  const DOMAINS=Object.freeze(['chart','alerts','radar','snapshot','notification','backend']);
  const CAPABILITIES=Object.freeze(['SUPPORTED','LIMITED','UNSUPPORTED']);
  const ACKNOWLEDGEMENTS=Object.freeze(['pending','acknowledged','rejected','not-applicable','unknown']);
  const STATES=Object.freeze(['UNSUPPORTED','UNKNOWN','CONNECTING','SUBSCRIBING','WAITING_FOR_DATA','LIVE','RECONNECTING','STALE','PARTIAL','DEGRADED','OFFLINE','FAILED']);
  const text=(value,limit=200)=>typeof value==='string'?value.replace(/[\u0000-\u001f\u007f]/g,'').slice(0,limit):null;
  const identifier=value=>typeof value==='string'&&/^[A-Za-z0-9_:/.-]{1,160}$/.test(value)&&!value.includes('://')?value:null;
  const code=value=>typeof value==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(value)?value:null;
  // Never coerce strings, null, candle boundaries or a clock into a timestamp.
  const timestamp=value=>Number.isSafeInteger(value)&&value>=0?value:null;
  const count=value=>Number.isSafeInteger(value)&&value>=0?value:null;
  const member=(value,values,fallback='UNKNOWN')=>values.includes(value)?value:fallback;
  function capability(value={}){
    const state=typeof value==='string'?value:value?.state;
    return {state:member(state,CAPABILITIES),reasonCode:code(value?.reasonCode)};
  }
  // Whitelist every field: no sockets, controllers, timers or owner records.
  function evidence(value={}){
    const v=value||{},i=v.identity||{},c=v.connection||{},s=v.subscription||{},d=v.data||{},h=v.heartbeat||{},q=v.continuity||{},e=v.error||{};
    const stage=name=>({state:member(v[name]?.state,['READY','PENDING','FAILED','DISABLED','NOT_CONFIGURED']),lastSuccessAt:timestamp(v[name]?.lastSuccessAt),reasonCode:code(v[name]?.reasonCode)});
    return {
      identity:{domain:member(i.domain,DOMAINS),exchange:identifier(i.exchange),marketId:identifier(i.marketId),nativeSymbol:identifier(i.nativeSymbol),channel:identifier(i.channel),timeframe:identifier(i.timeframe),connectionId:identifier(i.connectionId),generation:count(i.generation)},
      capability:capability(v.capability),
      connection:{state:member(c.state,['OPEN','CONNECTING','CLOSED','FAILED']),openedAt:timestamp(c.openedAt),closedAt:timestamp(c.closedAt),reconnecting:typeof c.reconnecting==='boolean'?c.reconnecting:null,reconnectCount:count(c.reconnectCount),lastReconnectAt:timestamp(c.lastReconnectAt),lastDisconnectReason:text(c.lastDisconnectReason)},
      subscription:{requestedAt:timestamp(s.requestedAt),acknowledgement:member(s.acknowledgement,ACKNOWLEDGEMENTS,'unknown'),lastAckAt:timestamp(s.lastAckAt),errorCode:code(s.errorCode),errorMessage:text(s.errorMessage)},
      data:{firstDataAt:timestamp(d.firstDataAt),lastReceiptAt:timestamp(d.lastReceiptAt),sourceTimestamp:timestamp(d.sourceTimestamp),processingTimestamp:timestamp(d.processingTimestamp),lastMarketDataAt:timestamp(d.lastMarketDataAt),lastPriceAt:timestamp(d.lastPriceAt),lastCandleAt:timestamp(d.lastCandleAt),lastSnapshotAt:timestamp(d.lastSnapshotAt),cacheStoredAt:timestamp(d.cacheStoredAt),upstreamReceiptAt:timestamp(d.upstreamReceiptAt)},
      heartbeat:{lastHeartbeatAt:timestamp(h.lastHeartbeatAt)},
      continuity:{state:member(q.state,['VERIFIED','GAP','RECOVERING']),lastVerifiedAt:timestamp(q.lastVerifiedAt),reasonCode:code(q.reasonCode)},
      processing:stage('processing'),persistence:stage('persistence'),delivery:stage('delivery'),
      error:{lastErrorAt:timestamp(e.lastErrorAt),code:code(e.code),message:text(e.message)}
    };
  }
  // The caller supplies the authoritative current epoch for THIS connection.
  // Missing epoch selection cannot validate connection-scoped observations.
  function selectGeneration(value,current){
    const result=evidence(value),id=result.identity;
    const valid=Boolean(current&&identifier(current.connectionId)!==null&&count(current.generation)!==null&&id.connectionId===current.connectionId&&id.generation===current.generation);
    if(valid)return {evidence:result,current:true};
    return {evidence:evidence({identity:{...id,connectionId:identifier(current?.connectionId),generation:count(current?.generation)},capability:result.capability}),current:false};
  }
  return {SCHEMA_VERSION,DOMAINS,CAPABILITIES,ACKNOWLEDGEMENTS,STATES,timestamp,identifier,code,capability,evidence,selectGeneration};
});
