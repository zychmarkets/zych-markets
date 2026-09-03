'use strict';
const {diagnostics,domainPolicy}=require('../js/services/reliability-reducer');
const {normalizedProductCapabilities}=require('./product-capabilities');

// Foundation only: deliberately do not translate legacy `live`, counts or
// heartbeat timestamps into evidence that those transports do not yet supply.
function healthReliability({now,instanceId}){
  const capabilities=normalizedProductCapabilities();
  const domains=Object.fromEntries(['alerts','radar','snapshot','notification'].map(domain=>{
    const records=['alerts','radar','snapshot'].includes(domain)?capabilities.productExchanges.map(exchange=>({evidence:{identity:{domain,exchange},capability:domain==='alerts'?{state:'SUPPORTED'}:capabilities.exchanges[exchange][domain]}})):[];
    return [domain,diagnostics({domain,records,policy:domainPolicy(domain),now,instanceId})];
  }));
  return {...diagnostics({domain:'backend',now,instanceId}),capabilities,domains};
}
module.exports={healthReliability};
