'use strict';
// Catalog eligibility is not socket health. Compose them only at the diagnostics boundary.
function radarCoverage(catalog={},ingestion={}){
  const expected=catalog.expectedExchanges||[],exchanges={};
  for(const exchange of expected){const source=catalog.exchanges?.[exchange]||{},stream=ingestion.exchanges?.[exchange];let status=source.status||(catalog.healthyExchanges?.includes(exchange)?'HEALTHY':'UNAVAILABLE');
    if(stream&&(stream.requestedTopics??stream.subscriptions)===0&&status==='HEALTHY')status='PARTIAL';
    if((stream?.requestedTopics??stream?.subscriptions)>0&&status==='HEALTHY'){
      if(!stream.activeSockets)status='OFFLINE';
      else if(stream.status==='stale')status='STALE';
      else if(stream.failedTopics||stream.acknowledgedTopics<stream.requestedTopics||stream.freshTopics<stream.requestedTopics)status='PARTIAL';
      else if(stream.status&&stream.status!=='live')status='DEGRADED';
    }
    if(status==='HEALTHY'&&stream?.stateQuality){const quality=stream.stateQuality;if(quality.STALE)status='STALE';else if(quality.COMPLETE<quality.total)status='PARTIAL'}
    exchanges[exchange]={...source,status,catalogStatus:source.status||status,...(stream?{ingestion:stream}:{})};
  }
  const healthy=expected.filter(exchange=>exchanges[exchange].status==='HEALTHY');
  const status=expected.length&&healthy.length===expected.length?'HEALTHY':healthy.length?'DEGRADED':expected.some(exchange=>exchanges[exchange].status==='STALE')?'STALE':'UNAVAILABLE';
  return{...catalog,status,expectedExchanges:[...expected],healthyExchanges:healthy,exchanges};
}
module.exports={radarCoverage};
