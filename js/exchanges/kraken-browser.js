(function(root,factory){const api=factory(root,typeof module==='object'&&module.exports?require('./kraken-public.js'):root.ZychKrakenPublic);if(typeof module==='object'&&module.exports)module.exports=api;else root.ZychKrakenBrowser=api;})(typeof window!=='undefined'?window:globalThis,function(root,contract){
  'use strict';
  const REST='https://api.kraken.com/0/public',WS='wss://ws.kraken.com/v2';
  const aborted=()=>Object.assign(new Error('Kraken request aborted'),{name:'AbortError'});
  function observe(promise,signal){if(!signal)return promise;if(signal.aborted)return Promise.reject(aborted());return new Promise((resolve,reject)=>{const cancel=()=>reject(aborted());signal.addEventListener('abort',cancel,{once:true});promise.then(resolve,reject).finally(()=>signal.removeEventListener('abort',cancel));});}
  class KrakenBrowserAdapter {
    constructor({fetchImpl=root.fetch,socketFactory=url=>new root.WebSocket(url),now=Date.now,batchSize=64,batchDelayMs=1000,ackTimeoutMs=10000,collectionTimeoutMs=90000,requestSpacingMs=1100,cacheTtlMs=30000,maxAgeMs=180000}={}){
      this.id='kraken';this.chartContract=typeof module==='object'&&module.exports?require('./kraken-chart.js'):root.ZychKrakenChart;this.requiresSubscriptionAck=true;this.reconnectDelay=attempt=>Math.min(60000,5000*2**Math.min(attempt,4));this.capabilities={...contract.capabilities,chart:true,watchlist:true,alerts:true,alertTypes:['price','movement'],intervals:Object.keys(this.chartContract.intervals),historyLimit:this.chartContract.historyLimit};Object.assign(this,{fetchImpl,socketFactory,now,batchSize:Math.max(1,Math.min(64,batchSize)),batchDelayMs,ackTimeoutMs,collectionTimeoutMs,requestSpacingMs,cacheTtlMs,maxAgeMs});
      this.snapshotListeners=new Set();this.mapping=null;this.catalogAt=null;this.catalogMetadata=[];this.rest=new Map();this.ws=new Map();this.queue=Promise.resolve();this.nextRequestAt=0;this.controllers=new Set();this.disposed=false;this.lastRefreshAt=null;this.retryAt=0;this.stats={state:'idle',connections:0,requested:0,acknowledged:0,verifiedSnapshots:0,lastHeartbeatAt:null,lastMessageAt:null,lastError:null,rejected:[]};
    }
    subscribeSnapshots(listener){this.snapshotListeners.add(listener);return()=>this.snapshotListeners.delete(listener);}
    notifySnapshots(){for(const listener of this.snapshotListeners){try{listener();}catch{}}}
    request(path){
      const run=this.queue.then(async()=>{
        if(this.disposed)throw aborted();const delay=Math.max(0,this.nextRequestAt-this.now());if(delay)await new Promise(resolve=>setTimeout(resolve,delay));if(this.disposed)throw aborted();this.nextRequestAt=this.now()+this.requestSpacingMs;
        const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),12000);this.controllers.add(controller);
        try{const response=await this.fetchImpl.call(root,`${REST}/${path}`,{signal:controller.signal,credentials:'omit',redirect:'error'});if(!response.ok)throw new Error(`Kraken HTTP ${response.status}`);const text=await response.text();if(text.length>8000000)throw new Error('Kraken response too large');return contract.unwrap(JSON.parse(text));}finally{clearTimeout(timer);this.controllers.delete(controller);}
      });this.queue=run.catch(()=>{});return run;
    }
    catalog(signal){
      if(this.mapping&&this.now()-this.catalogAt<300000)return observe(Promise.resolve(this.mapping),signal);
      if(!this.catalogPending)this.catalogPending=(async()=>{
        const legacy=await this.request('AssetPairs?aclass_base=currency&execution_venue=international');
        const modern=await this.request('AssetPairs?aclass_base=currency&execution_venue=international&assetVersion=1');
        const assets=await this.request('Assets'),modernAssets=await this.request('Assets?assetVersion=1');
        const mapping=contract.registry(legacy,modern,assets,modernAssets);
        if(!mapping.byNative.size||mapping.byNative.size>5000)throw new Error('Kraken catalog has no safe markets or exceeds limit');
        this.mapping=mapping;this.catalogAt=this.now();this.catalogMetadata=mapping.excluded;
        for(const cache of [this.rest,this.ws])for(const key of cache.keys())if(!mapping.byNative.has(key))cache.delete(key);
        return mapping;
      })().finally(()=>{this.catalogPending=null;});
      return observe(this.catalogPending,signal);
    }
    async discover(signal){return [...(await this.catalog(signal)).byNative.values()].map(contract.instrument);}
    collect(mapping){
      if(this.collecting)return this.collecting;
      if(this.disposed||this.now()<this.retryAt)return Promise.resolve();
      this.collecting=new Promise(resolve=>{
        let socket,done=false,batch=null,remaining=[],batchTimer,paceTimer,deadline,phase='instrument',requestId=1,instrumentAck=false,instrumentData=null;
        const finish=error=>{if(done)return;done=true;clearTimeout(batchTimer);clearTimeout(paceTimer);clearTimeout(deadline);this.cancelCollection=null;this.stats.connections=0;this.stats.state=error||this.stats.rejected.length?'partial':'idle';this.stats.lastError=error?.message||null;if(error)this.retryAt=this.now()+30000;try{socket?.close(1000,'ticker collection complete');}catch{}this.notifySnapshots();resolve();};
        this.cancelCollection=()=>finish(aborted());this.stats={...this.stats,state:'connecting',requested:0,acknowledged:0,verifiedSnapshots:0,rejected:[]};
        const guard=()=>{clearTimeout(batchTimer);batchTimer=setTimeout(()=>finish(new Error(`Kraken ${phase} timeout`)),this.ackTimeoutMs);};
        const send=(method,params,id)=>socket.send(JSON.stringify({method,params,req_id:id}));
        const next=()=>{
          if(done)return;if(!remaining.length){finish();return;}
          const rows=remaining.splice(0,this.batchSize);batch={rows,byWs:new Map(rows.map(row=>[row.wsSymbol,row])),acked:new Set(),rejected:new Set(),received:new Set(),unsubscribed:new Set(),subscribeId:++requestId,unsubscribeId:null};phase='subscribe';
          this.stats.requested+=rows.length;send('subscribe',{channel:'ticker',symbol:rows.map(row=>row.wsSymbol),snapshot:true,event_trigger:'trades'},batch.subscribeId);guard();
        };
        const progress=()=>{
          if(!batch||phase!=='subscribe')return;
          if(!batch.rows.every(row=>batch.rejected.has(row.wsSymbol)||batch.acked.has(row.wsSymbol)&&batch.received.has(row.wsSymbol)))return;
          clearTimeout(batchTimer);
          if(!batch.acked.size){phase='between-batches';paceTimer=setTimeout(next,this.batchDelayMs);return;}
          phase='unsubscribe';batch.unsubscribeId=++requestId;send('unsubscribe',{channel:'ticker',symbol:[...batch.acked],event_trigger:'trades'},batch.unsubscribeId);guard();
        };
        const verifyInstruments=()=>{
          if(!instrumentAck||!instrumentData||phase!=='instrument')return;
          const pairs=new Map();for(const row of instrumentData){if(typeof row?.symbol!=='string')continue;pairs.set(row.symbol,pairs.has(row.symbol)?null:row);}
          for(const row of mapping.byNative.values()){
            const p=pairs.get(row.wsSymbol);if(p&&p.status==='online'&&p.base===row.baseAsset&&p.quote===row.quoteAsset)remaining.push(row);
            else{this.ws.delete(row.nativeSymbol);this.stats.rejected.push({nativeSymbol:row.nativeSymbol,reason:'WS_INSTRUMENT_UNVERIFIED'});}
          }
          // Familiar markets first, then stable native ordering. Identity never changes.
          remaining.sort((a,b)=>(['XXBTZUSD','XBTUSDT','XETHZUSD','ETHUSDT'].includes(b.nativeSymbol)?1:0)-(['XXBTZUSD','XBTUSDT','XETHZUSD','ETHUSDT'].includes(a.nativeSymbol)?1:0)||a.nativeSymbol.localeCompare(b.nativeSymbol));
          clearTimeout(batchTimer);next();
        };
        try{socket=this.socketFactory(WS);this.stats.connections=1;deadline=setTimeout(()=>finish(new Error('Kraken collection deadline')),this.collectionTimeoutMs);guard();
          socket.addEventListener('open',()=>{if(done)return;this.stats.state='collecting';send('subscribe',{channel:'instrument',snapshot:true},1);guard();});
          socket.addEventListener('error',()=>finish(new Error('Kraken WebSocket unavailable')));
          socket.addEventListener('close',()=>finish(new Error('Kraken WebSocket closed before collection completed')));
          socket.addEventListener('message',event=>{if(done)return;try{
            if(typeof event.data!=='string'||event.data.length>8000000)throw new Error('Kraken invalid/oversized frame');const p=JSON.parse(event.data);this.stats.lastMessageAt=this.now();
            if(p.channel==='heartbeat'||p.method==='pong'){this.stats.lastHeartbeatAt=this.now();return;}
            if(p.channel==='status'){if(p.data?.[0]?.system!=='online')throw new Error('Kraken system not online');return;}
            if(p.method==='subscribe'&&p.req_id===1){if(p.success!==true||p.result?.channel!=='instrument')throw new Error('Kraken instrument rejected');instrumentAck=true;verifyInstruments();return;}
            if(p.channel==='instrument'&&p.type==='snapshot'){if(!Array.isArray(p.data?.pairs)||p.data.pairs.length>10000)throw new Error('Invalid Kraken instruments');instrumentData=p.data.pairs;verifyInstruments();return;}
            if(p.method==='subscribe'&&p.req_id===batch?.subscribeId){const name=p.result?.symbol||p.symbol;if(!batch.byWs.has(name))throw new Error('Uncorrelated Kraken ACK');if(p.success===true&&p.result?.channel==='ticker'&&p.result.snapshot===true&&p.result.event_trigger==='trades'){if(!batch.acked.has(name))this.stats.acknowledged++;batch.acked.add(name);}else{batch.rejected.add(name);this.ws.delete(batch.byWs.get(name).nativeSymbol);this.stats.rejected.push({nativeSymbol:batch.byWs.get(name).nativeSymbol,reason:p.error||'TICKER_REJECTED'});}progress();return;}
            if(p.method==='unsubscribe'&&phase==='unsubscribe'&&p.req_id===batch?.unsubscribeId){if(p.success!==true||p.result?.channel!=='ticker'||!batch.acked.has(p.result.symbol))throw new Error('Kraken unsubscribe rejected');batch.unsubscribed.add(p.result.symbol);if(batch.unsubscribed.size===batch.acked.size){clearTimeout(batchTimer);phase='between-batches';paceTimer=setTimeout(next,this.batchDelayMs);}return;}
            if(p.channel!=='ticker'||!['snapshot','update'].includes(p.type))return;
            if(!Array.isArray(p.data)||p.data.length>this.batchSize)throw new Error('Invalid Kraken ticker batch');
            for(const raw of p.data){const row=batch?.byWs.get(raw.symbol);if(!row||!batch.acked.has(raw.symbol)||batch.rejected.has(raw.symbol)||phase!=='subscribe')continue;
              const value=contract.wsTicker(raw,this.now());if(!value)throw new Error('Invalid Kraken ticker timestamp');const previous=this.ws.get(row.nativeSymbol);if(!previous||value.sourceTimestamp>=previous.sourceTimestamp)this.ws.set(row.nativeSymbol,value);
              if(!batch.received.has(raw.symbol)){batch.received.add(raw.symbol);this.stats.verifiedSnapshots++;}
            }this.notifySnapshots();progress();
          }catch(error){finish(error);}});
        }catch(error){finish(error);}
      }).finally(()=>{this.collecting=null;});
      return this.collecting;
    }
    async allSnapshots(signal){
      const mapping=await this.catalog(signal);
      if(!this.refreshPending&&(this.lastRefreshAt===null||this.now()-this.lastRefreshAt>=this.cacheTtlMs))this.refreshPending=(async()=>{
        await Promise.all([this.collect(mapping),this.request('Ticker').then(rows=>{this.stats.lastRestError=null;const at=this.now();for(const row of mapping.byNative.values())if(Object.hasOwn(rows,row.nativeSymbol))this.rest.set(row.nativeSymbol,contract.restTicker(rows[row.nativeSymbol],at));this.notifySnapshots();}).catch(error=>{this.stats.lastRestError=error.message;})]);this.lastRefreshAt=this.now();
      })().finally(()=>{this.refreshPending=null;});
      if(this.refreshPending)await observe(this.refreshPending,signal);
      return [...mapping.byNative.values()].map(row=>contract.snapshot(row,this.rest.get(row.nativeSymbol),this.ws.get(row.nativeSymbol),this.now(),this.maxAgeMs));
    }
    cachedSnapshot(native){const row=this.mapping?.byNative.get(native);return row?contract.snapshot(row,this.rest.get(native),this.ws.get(native),this.now(),this.maxAgeMs):null;}
    async snapshots(markets,signal){await this.catalog(signal);const wanted=new Set(markets.filter(row=>row.exchange==='kraken'&&row.marketType==='spot'&&row.id===`kraken:spot:${row.symbol}`&&this.mapping?.byNative.has(row.symbol)).map(row=>row.id));if(!wanted.size)return{};return Object.fromEntries((await this.allSnapshots(signal)).filter(row=>wanted.has(row.marketId)).map(row=>[row.marketId,row]));}
    async candles(...args){return this.chartContract.candles(this,...args);}
    socket(...args){return this.chartContract.socket(this,...args);}
    diagnostics(){return{...this.stats,catalogAt:this.catalogAt,admitted:this.mapping?.byNative.size||0,excluded:this.catalogMetadata.length,cacheSize:this.ws.size,capabilities:this.capabilities};}
    dispose(){this.snapshotListeners.clear();this.disposed=true;this.cancelCollection?.();for(const controller of this.controllers)controller.abort();}
  }
  return {KrakenBrowserAdapter};
});
