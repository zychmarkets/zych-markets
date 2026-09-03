'use strict';
const {diagnostics,domainPolicy}=require('../js/services/reliability-reducer');
const {normalizedProductCapabilities}=require('./product-capabilities');

// Foundation only: deliberately do not translate legacy `live`, counts or
// heartbeat timestamps into evidence that those transports do not yet supply.
function healthReliability({now,instanceId,runner,notifier,radar}){
  const capabilities=normalizedProductCapabilities();
  const domains=Object.fromEntries(['alerts','radar','snapshot','notification'].map(domain=>{
    const records=['alerts','radar','snapshot'].includes(domain)?capabilities.productExchanges.map(exchange=>({evidence:{identity:{domain,exchange},capability:domain==='alerts'?{state:'SUPPORTED'}:capabilities.exchanges[exchange][domain]}})):[];
    return [domain,diagnostics({domain,records,policy:domainPolicy(domain),now,instanceId})];
  }));
  if(radar?.reliability)domains.radar=radar.reliability(now);
  if (runner?.diagnostics) {
    const alerts = runner.diagnostics().reliability;
    if (alerts) domains.alerts = { ...alerts.transportSummary, instanceId, readiness: alerts };
  }
  return {...diagnostics({domain:'backend',now,instanceId}),capabilities,domains,notificationDelivery:{push:notifier?.status?.() || {latestOutcome:'UNKNOWN'},inApp:'UNKNOWN',toast:'UNKNOWN',sound:'UNKNOWN'}};
}
module.exports={healthReliability};
