(function(root,factory){
  const api=factory(typeof module==='object'&&module.exports?require('./reliability-contract'):root.ZychReliabilityContract,typeof module==='object'&&module.exports?require('./reliability-reducer'):root.ZychReliability);
  if(typeof module==='object'&&module.exports)module.exports=api;else root.ZychChartReliability=api;
})(typeof window!=='undefined'?window:globalThis,function(contract,reducer){
  'use strict';
  let epoch=0;
  const durations={'1m':60000,'5m':300000,'15m':900000,'30m':1800000,'1h':3600000,'4h':14400000,'1d':86400000,'1w':604800000,'1M':2678400000};
  function policy(exchange,timeframe){
    const activityDriven=['coinbase','kraken'].includes(exchange),interval=durations[timeframe]||60000;
    // Receipt budgets are Chart policy, not transport watchdogs. Bybit documents
    // 1–60s pushes; Binance/OKX update much faster. Quiet activity-driven feeds
    // get a bounded timeframe allowance; expiry means STALE, never socket failure.
    const maxReceiptAgeMs=activityDriven?Math.min(900000,Math.max(120000,interval*2)):({binance:15000,bybit:90000,okx:30000,bingx:90000}[exchange]||90000);
    return reducer.domainPolicy('chart',{requireContinuity:activityDriven,maxReceiptAgeMs,maxSourceAgeMs:['binance','bybit','bingx','coinbase'].includes(exchange)?maxReceiptAgeMs:null,ackTimeoutMs:15000});
  }
  function capability(market,timeframe,adapter={}){
    if(market.unavailable||market.enabled===false)return {state:'UNSUPPORTED',reasonCode:'MARKET_UNAVAILABLE'};
    if(adapter.capabilities?.chart===false||adapter.capabilities?.intervals&&!adapter.capabilities.intervals.includes(timeframe)||market.exchange==='kraken'&&!['1m','5m','15m','1h','4h','1d','1w'].includes(timeframe))return {state:'UNSUPPORTED',reasonCode:'UNSUPPORTED_INTERVAL'};
    return market.exchange==='kraken'?{state:'LIMITED',reasonCode:'HISTORY_LIMITED'}:{state:'SUPPORTED'};
  }
  function bind(market,timeframe,output={},now=Date.now){
    const generation=++epoch,current={generation,connectionId:`chart:${generation}`};
    const p=policy(market.exchange,timeframe);
    let value=contract.evidence({identity:{domain:'chart',exchange:market.exchange,marketId:market.id,nativeSymbol:market.symbol,timeframe,channel:({coinbase:'market_trades',kraken:'ohlc',okx:'candle'})[market.exchange]||'kline',...current},capability:capability(market,timeframe),connection:{state:'CONNECTING',reconnecting:false,reconnectCount:output.reconnectCount||0,lastReconnectAt:output.lastReconnectAt},subscription:{acknowledgement:market.exchange==='binance'?'not-applicable':'unknown'},continuity:{state:p.requireContinuity?'RECOVERING':'UNKNOWN'}});
    let stopped=false,timer=null,lastState=null,lastCandleTime=null;
    const active=()=>!stopped&&(!output.isCurrent||output.isCurrent());
    const result=()=>reducer.reduceFeed(value,{policy:p,now:now(),current});
    const publish=()=>{if(!active())return;const r=result();output.reliability?.(r);if(r.state!==lastState){lastState=r.state;output.status?.(r.state);}return r;};
    const change=patch=>{if(!active())return;for(const [key,fields]of Object.entries(patch))value[key]={...value[key],...fields};value=contract.evidence(value);publish();};
    const handlers={...output,
      open:()=>{change({connection:{state:'OPEN',openedAt:now(),reconnecting:false}});output.open?.();},
      requested:()=>change({subscription:{requestedAt:now(),acknowledgement:market.exchange==='binance'?'not-applicable':'pending'}}),
      acknowledged:()=>change({subscription:{acknowledgement:'acknowledged',lastAckAt:now()}}),
      rejected:error=>change({subscription:{acknowledgement:'rejected',errorCode:'SUBSCRIPTION_REJECTED',errorMessage:error?.message},error:{lastErrorAt:now(),code:'SUBSCRIPTION_REJECTED',message:error?.message}}),
      heartbeat:()=>change({heartbeat:{lastHeartbeatAt:now()}}),
      marketData:({sourceTimestamp=null,receiptTimestamp=now(),price=false,candleTime=null}={})=>{
        if(!active())return;
        if(candleTime!==null){
          if(!Number.isFinite(candleTime)||candleTime>receiptTimestamp/1000||lastCandleTime!==null&&candleTime<lastCandleTime)return;
          const end=timeframe==='1M'?Date.UTC(new Date(candleTime*1000).getUTCFullYear(),new Date(candleTime*1000).getUTCMonth()+1,1):candleTime*1000+durations[timeframe];
          if(end<receiptTimestamp)return;
          lastCandleTime=candleTime;
        }
        change({data:{firstDataAt:value.data.firstDataAt??receiptTimestamp,lastReceiptAt:receiptTimestamp,lastMarketDataAt:receiptTimestamp,lastCandleAt:receiptTimestamp,...(price?{lastPriceAt:receiptTimestamp}:{}),sourceTimestamp:contract.timestamp(sourceTimestamp),processingTimestamp:now()}});
      },
      continuity:state=>change({continuity:{state,...(state==='VERIFIED'?{lastVerifiedAt:now(),reasonCode:null}:{reasonCode:'CONTINUITY_UNPROVEN'})}}),
      // Adapter lifecycle hints cannot establish health. Only the reducer does.
      status:()=>publish(),
      candle:candle=>{if(active())output.candle?.(candle);},
      reconcile:rows=>{if(active())output.reconcile?.(rows);},
      diagnostics:details=>{if(active())output.diagnostics?.(details);},
      error:error=>{change({error:{lastErrorAt:now(),code:'CHART_STREAM_ERROR',message:error?.message},connection:{state:'FAILED'}});if(active())output.error?.(error);},
      close:event=>{change({connection:{state:'CLOSED',closedAt:now(),reconnecting:true,lastReconnectAt:now(),reconnectCount:(value.connection.reconnectCount||0)+1,lastDisconnectReason:event?.reason||null}});clearInterval(timer);stopped=true;output.close?.(event);}
    };
    return {handlers,attach(socket){
      const close=socket.close.bind(socket);
      socket.close=(...args)=>{change({connection:{state:'CLOSED',closedAt:now(),reconnecting:true,lastReconnectAt:now(),reconnectCount:(value.connection.reconnectCount||0)+1}});clearInterval(timer);stopped=true;return close(...args);};
      socket.chartReliability={snapshot:result,tick:publish};
      timer=setInterval(publish,1000);timer.unref?.();return socket;
    }};
  }
  return {bind,policy,capability};
});
