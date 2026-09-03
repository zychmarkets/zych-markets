'use strict';
const expectedIntervals=Object.freeze(['1m','5m','15m']);
function radarCoverage(catalog={},ingestion={}){
  const expected=catalog.expectedExchanges||[],exchanges={};
  for(const exchange of expected){
    const source=catalog.exchanges?.[exchange]||{},stream=ingestion.exchanges?.[exchange],intervals=stream?.intervals||[];
    let status=source.status||(catalog.healthyExchanges?.includes(exchange)?'HEALTHY':'UNAVAILABLE');
    if(status==='HEALTHY'){
      if(!stream){}
      else if(!stream.activeSockets&&((stream.requestedTopics||0)>0||(stream.subscriptions||0)>0))status=stream.connectingSockets?'DEGRADED':'OFFLINE';
      else if(!Number.isInteger(stream.requestedTopics)||stream.requestedTopics<=0)status='PARTIAL';
      else if(stream.failedTopics>0)status='PARTIAL';
      else if((stream.acknowledgedTopics||0)+(stream.notApplicableTopics||0)<stream.requestedTopics)status='PARTIAL';
      else if(intervals.length&&expectedIntervals.some(frame=>!intervals.some(row=>row.timeframe===frame&&row.fresh&&row.continuity==='VERIFIED')))status=intervals.some(row=>row.state==='STALE')?'STALE':'PARTIAL';
      else if(intervals.length&&intervals.some(row=>!row.fresh||row.state!=='COMPLETE'))status=intervals.some(row=>row.state==='STALE')?'STALE':'PARTIAL';
      else if(stream.status==='stale')status='STALE';
      else if(stream.stateQuality&&stream.stateQuality.COMPLETE<stream.stateQuality.total)status='PARTIAL';
      else if(!intervals.length&&stream.status&&stream.status!=='live')status='DEGRADED';
    }
    exchanges[exchange]={...source,status,catalogStatus:source.status||status,...(stream?{ingestion:stream}:{})};
  }
  const healthy=expected.filter(exchange=>exchanges[exchange].status==='HEALTHY');
  const status=expected.length&&healthy.length===expected.length?'HEALTHY':healthy.length?'DEGRADED':expected.some(exchange=>exchanges[exchange].status==='STALE')?'STALE':'UNAVAILABLE';
  return{...catalog,status,expectedExchanges:[...expected],healthyExchanges:healthy,exchanges};
}
module.exports={radarCoverage,expectedIntervals};
