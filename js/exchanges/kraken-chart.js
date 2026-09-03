(function(root,factory){const api=factory(typeof module==='object'&&module.exports?require('./kraken-public.js'):root.ZychKrakenPublic);if(typeof module==='object'&&module.exports)module.exports=api;else root.ZychKrakenChart=api;})(typeof window!=='undefined'?window:globalThis,function(contract){
  'use strict';
  const reliabilityContract=typeof module==='object'&&module.exports?require('../services/chart-reliability'):window.ZychChartReliability;
  const intervals=Object.freeze({'1m':1,'5m':5,'15m':15,'1h':60,'4h':240,'1d':1440,'1w':10080});
  const historyLimit='HISTORY LIMITED · Kraken public OHLC provides only the recent retained window.';
  function validate(adapter,market,frame){
    if(!Object.hasOwn(intervals,frame))throw new Error(`Unsupported Kraken interval: ${frame}`);
    const row=adapter.mapping?.byNative.get(market?.symbol);
    if(!row||market.exchange!=='kraken'||market.marketType!=='spot'||market.id!==`kraken:spot:${row.nativeSymbol}`||market.baseAsset!==row.baseAsset||market.quoteAsset!==row.quoteAsset)throw new Error('Kraken market is not in the admitted catalog');
    return row;
  }
  function normalize(row){
    if(!Array.isArray(row)||row.length!==8)throw new Error('Malformed Kraken candle');
    const [time,open,high,low,close,,volume]=row.map(contract.numeric);
    if(!Number.isSafeInteger(time)||time<=0||[open,high,low,close,volume].some(v=>v===null)||Math.min(open,high,low,close)<=0||volume<0||low>Math.min(open,close)||high<Math.max(open,close))throw new Error('Malformed Kraken OHLCV');
    return {time,open,high,low,close,volume,source:'kraken-rest',provisional:false};
  }
  async function candles(adapter,market,frame,endTime,limit=1000,signal){
    validate(adapter,market,frame);signal?.throwIfAborted();
    // There is no backward pagination on Kraken. Never send a synthetic since cursor.
    if(Number.isFinite(endTime))return Object.assign([],{exhausted:true,historyLimit});
    const result=await adapter.request(`OHLC?${new URLSearchParams({pair:market.symbol,interval:String(intervals[frame])})}`);signal?.throwIfAborted();
    const raw=result[market.symbol];
    if(!Array.isArray(raw)||raw.length>721||Object.keys(result).some(k=>k!=='last'&&k!==market.symbol))throw new Error('Malformed Kraken OHLC response');
    const rows=[...new Map(raw.map(normalize).map(row=>[row.time,row])).values()].sort((a,b)=>a.time-b.time);
    if(rows.length)rows.at(-1).provisional=true;
    return Object.assign(rows,{exhausted:true,historyLimit});
  }
  function socket(adapter,market,frame,handlers){
    const instrument=validate(adapter,market,frame),interval=intervals[frame];
    const reliability=reliabilityContract.bind(market,frame,handlers,adapter.now);handlers=reliability.handlers;
    // A dedicated replacement socket avoids competing intervals on one symbol.
    const ws=adapter.socketFactory('wss://ws.kraken.com/v2'),controller=new AbortController();
    const state={nativeSymbol:market.symbol,symbol:instrument.wsSymbol,interval,acknowledged:false,lastMessage:null,lastHeartbeat:null,lastCandle:null,snapshots:0,updates:0,reconciliations:0};
    ws.krakenState=state;
    let closed=false,ackTimer,connectTimer,watchdog,ready=false,repairing=false,current=null,queue=[],lastRepair=0;
    const close=ws.close.bind(ws),active=()=>!closed&&ws.readyState===1,report=()=>handlers.diagnostics?.({...state});
    const cleanup=()=>{closed=true;controller.abort();clearTimeout(connectTimer);clearTimeout(ackTimer);clearInterval(watchdog);queue=[];};
    ws.close=(...args)=>{cleanup();return close(...args);};
    const fail=error=>{if(closed)return;handlers.error?.(error);cleanup();close();};
    const status=()=>handlers.status?.();
    async function repair(){
      if(repairing||closed)return;repairing=true;handlers.continuity('RECOVERING');
      try{
        const rows=await candles(adapter,market,frame,null,1000,controller.signal);if(!active())return;
        // REST commits prior intervals; the final row remains provisional. Pending
        // WS cumulative rows replace REST rows, never add their volumes.
        const previous=current,latest=rows.at(-1);
        if(previous&&latest&&previous.time>=latest.time&&(previous.time>latest.time||previous.volume>=latest.volume)){const index=rows.findIndex(row=>row.time===previous.time);if(index>=0)rows[index]=previous;else rows.push(previous);}
        handlers.reconcile?.(rows);current=rows.at(-1)||null;ready=true;lastRepair=adapter.now();state.reconciliations++;
        const pending=queue;queue=[];for(const item of pending)apply(item.row,item.receiptTimestamp,item.qualifying);handlers.continuity(rows.length?'VERIFIED':'RECOVERING');status();report();
      }catch(error){if(!closed)fail(error);}finally{repairing=false;}
    }
    function apply(row,receiptTimestamp,qualifying){
      if(current&&(row.time<current.time||row.time===current.time&&row.volume<current.volume))return;
      const progressed=current&&row.time>current.time;if(progressed)handlers.continuity('RECOVERING');current=row;handlers.candle?.(row);
      if(qualifying){state.lastCandle=receiptTimestamp;handlers.marketData({receiptTimestamp});}
      if(progressed)void repair();
    }
    connectTimer=setTimeout(()=>fail(new Error('Kraken connection timeout')),15000);
    ws.addEventListener('open',()=>{if(!active())return;clearTimeout(connectTimer);handlers.open?.();handlers.status?.('SUBSCRIBING');state.lastMessage=adapter.now();
      ws.send(JSON.stringify({method:'subscribe',params:{channel:'ohlc',symbol:[instrument.wsSymbol],interval,snapshot:true},req_id:1}));
      handlers.requested();
      ackTimer=setTimeout(()=>fail(new Error('Kraken OHLC ACK timeout')),15000);
      watchdog=setInterval(()=>{if(adapter.now()-state.lastMessage>15000)fail(new Error('Kraken transport timeout'));else if(state.acknowledged){status();if(ready&&adapter.now()-lastRepair>=60000)void repair();}},5000);
    });
    ws.addEventListener('close',event=>{cleanup();handlers.close?.(event);});
    ws.addEventListener('error',()=>fail(new Error('Kraken WebSocket error')));
    ws.addEventListener('message',event=>{if(!active())return;const receiptTimestamp=adapter.now();try{
      if(typeof event.data!=='string'||event.data.length>1048576)throw new Error('Invalid Kraken frame');
      const p=JSON.parse(event.data);state.lastMessage=adapter.now();
      if(p.channel==='heartbeat'){state.lastHeartbeat=adapter.now();handlers.heartbeat();report();return;}
      if(p.channel==='status'){if(p.data?.[0]?.system!=='online')throw new Error('Kraken system unavailable');return;}
      if(p.method==='subscribe'){
        if(p.req_id!==1||p.success!==true||p.result?.channel!=='ohlc'||p.result.symbol!==instrument.wsSymbol||p.result.interval!==interval||p.result.snapshot!==true){handlers.rejected(new Error(p.error||'Kraken OHLC ACK mismatch'));throw new Error(p.error||'Kraken OHLC ACK mismatch');}
        state.acknowledged=true;clearTimeout(ackTimer);handlers.acknowledged();report();void repair();return;
      }
      if(p.channel!=='ohlc')return;
      if(!state.acknowledged||!['snapshot','update'].includes(p.type)||!Array.isArray(p.data)||p.data.length>721)throw new Error('Invalid Kraken OHLC event');
      const rows=p.data.map(row=>{
        if(row.symbol!==instrument.wsSymbol||row.interval!==interval||typeof row.interval_begin!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(row.interval_begin))throw new Error('Kraken OHLC identity mismatch');
        const candle=normalize([Date.parse(row.interval_begin)/1000,row.open,row.high,row.low,row.close,row.vwap,row.volume,row.trades]);
        if(candle.time>adapter.now()/1000+5)throw new Error('Future Kraken candle');
        return {...candle,source:'kraken-ws-v2',provisional:true};
      }).sort((a,b)=>a.time-b.time);
      state[p.type==='snapshot'?'snapshots':'updates']++;
      // An old snapshot is not evidence of fresh candles, nor is a heartbeat.
      for(const row of rows){const qualifying=p.type==='update'&&row.time>=(current?.time??0)&&row.time+interval*60>receiptTimestamp/1000;if(!ready||repairing){if(queue.length>=20000)throw new Error('Kraken reconciliation queue overflow');queue.push({row,receiptTimestamp,qualifying});}else apply(row,receiptTimestamp,qualifying);}
      status();report();
    }catch(error){fail(error);}});
    return reliability.attach(ws);
  }
  return {intervals,historyLimit,validate,normalize,candles,socket};
});
