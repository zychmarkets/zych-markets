'use strict';
class MarketCatalogService{
  constructor({adapters,now=Date.now,logger={warn(){}},requestTimeoutMs=10000}){this.adapters=adapters;this.now=now;this.logger=logger;this.cache=new Map();this.requestTimeoutMs=requestTimeoutMs}
  load(adapter,signal){const timeout=AbortSignal.timeout(this.requestTimeoutMs),combined=signal?AbortSignal.any([signal,timeout]):timeout;return adapter.load(combined)}
  async refresh(signal){const generatedAt=this.now(),settled=await Promise.allSettled(this.adapters.map(adapter=>this.load(adapter,signal)));return{generatedAt,exchanges:Object.fromEntries(settled.map((result,index)=>{const adapter=this.adapters[index];if(result.status==='fulfilled'){const markets=result.value;this.cache.set(adapter.id,markets);return[adapter.id,{exchange:adapter.id,status:'HEALTHY',markets,error:null}]};const cached=this.cache.get(adapter.id)||[];this.logger.warn('radar_catalog_failed',{exchange:adapter.id,message:result.reason?.message});return[adapter.id,{exchange:adapter.id,status:cached.length?'STALE':'UNAVAILABLE',markets:cached,error:result.reason?.message||'Catalog unavailable'}]}))}}
}
module.exports={MarketCatalogService};
