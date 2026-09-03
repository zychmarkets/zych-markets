(function(global){
  'use strict';
  const reliabilityContract=global.ZychChartReliability||(typeof require==='function'?require('../services/chart-reliability'):null);
  const intervals=Object.freeze({'1m':'ONE_MINUTE','5m':'FIVE_MINUTE','15m':'FIFTEEN_MINUTE','1h':'ONE_HOUR','4h':'FOUR_HOUR','1d':'ONE_DAY','1w':'ONE_WEEK','1M':'ONE_MONTH'});
  const seconds={'1m':60,'5m':300,'15m':900,'1h':3600,'4h':14400,'1d':86400,'1w':604800};
  // Coinbase supplies fractional UTC seconds with variable precision. Pad the
  // fraction before ordering so equal instants use trade_id, not string length.
  const tradeTime=value=>value.replace(/(?:\.(\d+))?Z$/,(_match,fraction='')=>'.'+fraction.padEnd(9,'0')+'Z');
  const compareTrades=(a,b)=>tradeTime(a.time).localeCompare(tradeTime(b.time))||(BigInt(a.trade_id)<BigInt(b.trade_id)?-1:BigInt(a.trade_id)>BigInt(b.trade_id)?1:0);
  function bucket(time,frame){
    if(!intervals[frame])throw new Error('Unsupported Coinbase interval');
    if(frame==='1M'){const d=new Date(time*1000);return Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),1)/1000;}
    const offset=frame==='1w'?345600:0;return Math.floor((time-offset)/seconds[frame])*seconds[frame]+offset;
  }
  function shift(time,frame,count){if(frame!=='1M')return time+seconds[frame]*count;const d=new Date(time*1000);return Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+count,1)/1000;}
  function normalize(row){
    const keys=['start','open','high','low','close','volume'];
    if(!row||keys.some(k=>!['number','string'].includes(typeof row[k])||String(row[k]).trim()===''||!Number.isFinite(Number(row[k]))))throw new Error('Malformed Coinbase candle');
    const [time,open,high,low,close,volume]=keys.map(k=>Number(row[k]));
    if(!Number.isSafeInteger(time)||time<=0||Math.min(open,high,low,close)<=0||volume<0||low>Math.min(open,close)||high<Math.max(open,close))throw new Error('Malformed Coinbase OHLCV');
    return {time,open,high,low,close,volume,source:'coinbase-rest',provisional:false};
  }
  function validate(market,frame,metadata){
    if(!intervals[frame])throw new Error(`Unsupported Coinbase interval: ${frame}`);
    if(market?.exchange!=='coinbase'||market.marketType!=='spot'||market.id!==`coinbase:spot:${market.symbol}`||market.symbol!==`${market.baseAsset}-${market.quoteAsset}`||!metadata.some(row=>row.productId===market.symbol&&!row.unsupportedReason))throw new Error('Coinbase market is not in the admitted catalog');
  }
  async function candles(adapter,market,frame,endTime,limit=1000,signal){
    validate(market,frame,adapter.catalogMetadata);
    if(!Number.isInteger(limit)||limit<1||limit>1000)throw new Error('Invalid Coinbase logical page');
    let end=Math.floor((Number.isFinite(endTime)?endTime:adapter.now())/1000);const result=new Map();
    // Scan bounded windows, including sparse/empty windows. The continuation is
    // explicit so a sparse page cannot be mistaken for exhausted history.
    for(let page=0;page<20&&result.size<limit&&end>=1420070400;page++){
      signal?.throwIfAborted();const start=Math.max(1420070400,shift(bucket(end,frame),frame,-349));
      const params=new URLSearchParams({product_id:market.symbol,granularity:intervals[frame],start:String(start),end:String(end),limit:'350'});
      const response=await adapter.fetchImpl.call(global,`/api/markets/coinbase/candles?${params}`,{signal,credentials:'omit'});
      if(!response.ok)throw new Error(`Coinbase ${frame} history HTTP ${response.status}${['1w','1M'].includes(frame)?' (live-verified, undocumented granularity)':''}`);
      const value=await response.json();signal?.throwIfAborted();
      if(!Array.isArray(value.candles)||value.candles.length>350)throw new Error('Malformed Coinbase candle page');
      for(const row of value.candles.map(normalize)){if(row.time>=start&&row.time<=end)result.set(row.time,{...row,provisional:row.time===bucket(adapter.now()/1000,frame)});}
      end=start-1;
    }
    const rows=[...result.values()].sort((a,b)=>a.time-b.time).slice(-limit);rows.nextEndTime=rows.length===limit?(rows[0].time*1000-1):end*1000;rows.exhausted=end<1420070400&&result.size<=limit;return rows;
  }
  function socket(adapter,market,frame,handlers){
    validate(market,frame,adapter.catalogMetadata);
    const reliability=reliabilityContract.bind(market,frame,handlers,adapter.now);handlers=reliability.handlers;
    const ws=adapter.socketFactory('wss://advanced-trade-ws.coinbase.com'),controller=new AbortController();
    const state={requested:['market_trades','heartbeats'],confirmed:[],productId:market.symbol,sequence:null,lastHeartbeat:null,lastTrade:null,tradeId:null,duplicates:0,gaps:0,provisional:true};
    ws.coinbaseState=state;
    let closed=false,timer=null,ackTimer=null,current=null,overlap=null,repairing=false,ready=false,queue=[],seen=new Set(),firstTrade=null,lastTrade=null,lastRepair=0;
    const active=()=>!closed&&ws.readyState===1;
    const report=()=>handlers.diagnostics?.({...state});
    const close=ws.close.bind(ws);
    const cleanup=()=>{closed=true;controller.abort();clearTimeout(timer);clearTimeout(ackTimer);};
    ws.close=(...args)=>{cleanup();return close(...args);};
    const fail=error=>{if(closed)return;handlers.status?.('RECOVERING');handlers.error?.(error);cleanup();close();};
    const publish=()=>{report();if(current)handlers.candle({...current});};
    async function repair(initial=false){
      if(repairing)return;repairing=true;handlers.continuity('RECOVERING');
      try{
        const rows=await candles(adapter,market,frame,null,initial?1000:3,controller.signal);if(!active())return;
        const boundary=bucket(adapter.now()/1000,frame);
        handlers.reconcile?.(rows.filter(row=>row.time<boundary));
        lastRepair=adapter.now();
        if(initial){current=rows.find(row=>row.time===boundary)||null;overlap=boundary;if(current)current={...current,volume:null,provisional:true,source:'coinbase-trades'};ready=true;const pending=queue;queue=[];for(const item of pending)apply(item.trade,item.receiptTimestamp);}
        handlers.continuity(rows.length?'VERIFIED':'RECOVERING');
      }catch(error){if(!closed)fail(error);}finally{repairing=false;}
    }
    function apply(trade,receiptTimestamp){
      const time=bucket(Date.parse(trade.time)/1000,frame),price=Number(trade.price),size=Number(trade.size);
      if(current&&time<current.time){void repair();return;}
      if(!current||time>current.time){const previous=current;firstTrade=null;lastTrade=null;current={time,open:price,high:price,low:price,close:price,volume:time===overlap?null:0,source:'coinbase-trades',provisional:true};if(previous)void repair();}
      current.high=Math.max(current.high,price);current.low=Math.min(current.low,price);
      if(!firstTrade||compareTrades(trade,firstTrade)<0){firstTrade=trade;if(time!==overlap)current.open=price;}
      if(!lastTrade||compareTrades(trade,lastTrade)>0){lastTrade=trade;current.close=price;}
      if(current.volume!==null)current.volume+=size;
      publish();
      handlers.marketData({sourceTimestamp:Date.parse(trade.time),receiptTimestamp,price:true});
    }
    ws.addEventListener('open',()=>{if(!active())return;handlers.open?.();for(const channel of state.requested)ws.send(JSON.stringify({type:'subscribe',channel,product_ids:[market.symbol]}));handlers.requested();
      ackTimer=setTimeout(()=>fail(new Error('Coinbase subscription confirmation timeout')),15000);
      timer=setInterval(()=>{if(adapter.now()-(state.lastHeartbeat||opened)>15000)fail(new Error('Coinbase heartbeat timeout'));else if(ready&&adapter.now()-lastRepair>=30000)void repair();},5000);const opened=adapter.now();void repair(true);
    });
    ws.addEventListener('close',event=>{cleanup();handlers.close?.(event);});
    ws.addEventListener('error',()=>fail(new Error('Coinbase WebSocket error')));
    ws.addEventListener('message',event=>{
      if(!active())return;
      const receiptTimestamp=adapter.now();
      try{
        if(typeof event.data!=='string'||event.data.length>1048576)throw new Error('Invalid Coinbase frame');
        const payload=JSON.parse(event.data);if(payload.type==='error'){handlers.rejected(new Error(payload.message||'Coinbase subscription rejected'));throw new Error(payload.message||'Coinbase subscription rejected');}
        const seq=payload.sequence_num;if(!Number.isSafeInteger(seq)||seq<0)throw new Error('Invalid Coinbase sequence');
        if(state.sequence!==null&&seq<=state.sequence){state.duplicates++;report();return;}
        if(state.sequence!==null&&seq!==state.sequence+1){state.gaps++;handlers.continuity('GAP');report();throw new Error('Coinbase sequence gap');}state.sequence=seq;
        if(payload.channel==='subscriptions'){
          for(const event of payload.events||[]){const ack=event.subscriptions||{};state.confirmed=state.requested.filter(channel=>Array.isArray(ack[channel])&&ack[channel].includes(channel==='heartbeats'?'heartbeats':market.symbol));}
          if(state.confirmed.length===2){clearTimeout(ackTimer);handlers.acknowledged();}report();return;
        }
        if(payload.channel==='heartbeats'){state.lastHeartbeat=adapter.now();handlers.heartbeat();report();return;}
        if(payload.channel!=='market_trades')return;
        for(const event of payload.events||[]){
          if(!['snapshot','update'].includes(event.type)||!Array.isArray(event.trades))throw new Error('Malformed Coinbase trade event');
          const trades=event.trades.filter(t=>t.product_id===market.symbol);
          if(trades.some(t=>typeof t.trade_id!=='string'||!/^\d+$/.test(t.trade_id)||typeof t.time!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(t.time)||!Number.isFinite(Date.parse(t.time))||!Number.isFinite(Number(t.price))||Number(t.price)<=0||!Number.isFinite(Number(t.size))||Number(t.size)<=0))throw new Error('Malformed Coinbase trade');
          trades.sort(compareTrades);
          for(const trade of trades){
            if(seen.has(trade.trade_id)){state.duplicates++;continue;}seen.add(trade.trade_id);if(seen.size>50000)seen.delete(seen.values().next().value);
            if(event.type!=='update')continue;
            state.lastTrade=trade.time;state.tradeId=trade.trade_id;
            if(!ready){if(queue.length>=20000)throw new Error('Coinbase repair queue overflow');queue.push({trade,receiptTimestamp});}else apply(trade,receiptTimestamp);
          }
        }
        report();
      }catch(error){fail(error);}
    });
    return reliability.attach(ws);
  }
  const api={intervals,bucket,shift,normalize,validate,candles,socket,compareTrades};if(typeof module==='object'&&module.exports)module.exports=api;else global.ZychCoinbaseChart=api;
})(typeof window!=='undefined'?window:globalThis);
