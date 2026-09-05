(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.ZychMarketsProgress=api;})(typeof window!=='undefined'?window:globalThis,function(){
  'use strict';
  const confirmedChange=item=>Number.isFinite(item.change24h)&&(item.exchange!=='kraken'||item.provenance?.fields?.change24h?.source==='kraken-ws-v2-ticker');
  const coverage=items=>{const total=items.length,prices=items.filter(item=>Number.isFinite(item.price)).length,changes=items.filter(confirmedChange).length;return{total,prices,changes,complete:total>0&&prices===total&&changes===total};};
  const status=(load,counts)=>{
    if(!load||load.catalog==='loading')return{code:'loading',key:'watchlist.catalogLoading'};
    if(load.catalog==='error')return{code:'unavailable',key:'watchlist.catalogError'};
    if(load.quotes==='error')return{code:counts.prices||counts.changes?'partial':'unavailable',key:'markets.partialError'};
    if(load.quotes==='loading'||load.quotes==='idle')return{code:'loading',key:counts.prices||counts.changes?'markets.loadingPartial':'watchlist.quotesLoading'};
    return{code:counts.complete?'current':'partial',key:counts.complete?'markets.dataReceived':'markets.partialData'};
  };
  // A trailing render is always retained, including the final collection result.
  class RenderThrottle{
    constructor(render,{interval=500,now=Date.now,schedule=(fn,delay)=>setTimeout(fn,delay),cancel=id=>clearTimeout(id)}={}){Object.assign(this,{render,interval,now,schedule,cancel});this.last=-Infinity;this.version=0;this.timer=null;this.disposed=false;}
    request(context){
      if(this.disposed)return;
      if(context!==this.context){this.reset();this.context=context;}
      if(this.timer!==null)return;
      const delay=Math.max(0,this.interval-(this.now()-this.last)),version=this.version;
      const run=()=>{if(this.disposed||version!==this.version)return;this.timer=null;this.last=this.now();this.render();};
      if(!delay)run();else this.timer=this.schedule(run,delay);
    }
    reset(){if(this.timer!==null)this.cancel(this.timer);this.timer=null;this.last=-Infinity;this.version++;}
    dispose(){this.reset();this.disposed=true;}
  }
  return{confirmedChange,coverage,status,RenderThrottle};
});
