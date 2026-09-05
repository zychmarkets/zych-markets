(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.ZychCatalogLoader=api;})(typeof window!=='undefined'?window:globalThis,function(){
  'use strict';
  class CatalogLoader {
    constructor(adapters,{onCatalog=()=>{},onQuotes=()=>{},onState=()=>{},onProgress=()=>{}}={}){
      this.adapters=adapters;Object.assign(this,{onCatalog,onQuotes,onState,onProgress});this.states=Object.fromEntries(Object.keys(adapters).map(id=>[id,{catalog:'loading',quotes:'idle'}]));this.jobs={};this.quoteJobs={};this.generation=0;
    }
    setActiveExchange(exchange){
      if(this.activeExchange===exchange&&this.unsubscribeProgress)return;
      this.unsubscribeProgress?.();this.unsubscribeProgress=null;this.activeExchange=exchange;
      const version=this.progressVersion=(this.progressVersion||0)+1,generation=this.generation;
      this.unsubscribeProgress=this.adapters[exchange]?.subscribeSnapshots?.(()=>{
        if(version===this.progressVersion&&generation===this.generation&&!this.controller?.signal.aborted)this.onProgress(exchange);
      });
    }
    start(){
      this.controller?.abort();const controller=this.controller=new AbortController(),generation=++this.generation;
      this.quoteJobs={};
      this.jobs=Object.fromEntries(Object.entries(this.adapters).map(([exchange,adapter])=>{
        this.states[exchange]={catalog:'loading',quotes:'idle'};
        const job=Promise.resolve().then(()=>adapter.discover(controller.signal)).then(markets=>{
          if(generation!==this.generation||controller.signal.aborted)return;
          this.states[exchange]={catalog:'ready',quotes:'loading'};this.onCatalog(exchange,markets);this.onState(exchange);
          void this.refresh(exchange);
        }).catch(error=>{
          if(generation!==this.generation||controller.signal.aborted)return;
          this.states[exchange]={catalog:'error',quotes:'idle'};this.onState(exchange);
        });return[exchange,job];
      }));
      this.unsubscribeProgress?.();this.unsubscribeProgress=null;this.setActiveExchange(this.activeExchange);
      this.onState();return Promise.all(Object.values(this.jobs));
    }
    wait(exchange){return this.jobs[exchange]||Promise.resolve();}
    refresh(exchange,markets){
      if(this.states[exchange]?.catalog!=='ready')return Promise.resolve();
      if(this.quoteJobs[exchange])return this.quoteJobs[exchange];
      const generation=this.generation,signal=this.controller.signal,adapter=this.adapters[exchange];
      this.states[exchange].quotes='loading';this.onState(exchange);
      const job=Promise.resolve().then(()=>markets?adapter.snapshots(markets,signal):adapter.allSnapshots(signal)).then(result=>{
        if(generation!==this.generation||signal.aborted)return;
        const health=adapter.diagnostics?.();this.states[exchange].quotes=health?.lastError||health?.lastRestError?'error':'ready';this.onQuotes(exchange,Array.isArray(result)?result:Object.entries(result).map(([marketId,row])=>({...row,marketId})),markets);this.onState(exchange);
      }).catch(error=>{
        if(generation!==this.generation||signal.aborted)return;
        this.states[exchange].quotes='error';this.onState(exchange);
      }).finally(()=>{if(this.quoteJobs[exchange]===job)delete this.quoteJobs[exchange];});
      this.quoteJobs[exchange]=job;return job;
    }
    dispose(){this.unsubscribeProgress?.();this.unsubscribeProgress=null;this.progressVersion++;this.controller?.abort();this.generation++;}
  }
  return {CatalogLoader};
});
