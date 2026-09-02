'use strict';
const {randomUUID}=require('node:crypto');
const {gunzip}=require('node:zlib');
const {promisify}=require('node:util');
const unzip=promisify(gunzip),MAX_FRAME_BYTES=1024*1024,VOLUME_WINDOW=20;
const intervalMap=Object.freeze({'5m':'5min','15m':'15min','30m':'30min','1h':'1h','4h':'4h','24h':'1d','1d':'1d'});
const restInterval=value=>value==='24h'?'1d':value;
const number=value=>(typeof value==='number'||typeof value==='string'&&value.trim()!=='')&&Number.isFinite(Number(value))?Number(value):null;
const timestamp=value=>{const n=number(value);return Number.isSafeInteger(n)&&n>0?n:null;};
async function decodeFrame(frame){
  if(typeof frame==='string'){if(Buffer.byteLength(frame)>MAX_FRAME_BYTES)throw new Error('BingX frame too large');return frame;}
  const bytes=Buffer.from(frame instanceof Blob?await frame.arrayBuffer():frame);
  if(bytes.length>MAX_FRAME_BYTES)throw new Error('BingX frame too large');
  return (await unzip(bytes,{maxOutputLength:MAX_FRAME_BYTES})).toString('utf8');
}

class BingxMarketTransport {
  constructor({restBase='https://open-api.bingx.com',wsBase='wss://open-api-ws.bingx.com/market',logger={info(){},warn(){},error(){}},WebSocketImpl=globalThis.WebSocket,fetchImpl=globalThis.fetch,decode=decodeFrame,now=Date.now,reconnectBaseMs=1000,reconnectMaxMs=30000,ackTimeoutMs=15000,heartbeatTimeoutMs=45000,staleAfterMs=30000,requestTimeoutMs=10000}={}){
    Object.assign(this,{restBase,wsBase,logger,WebSocketImpl,fetchImpl,decode,now,reconnectBaseMs,reconnectMaxMs,ackTimeoutMs,heartbeatTimeoutMs,staleAfterMs,requestTimeoutMs});
    this.generation=0;this.socket=null;this.context=null;this.timer=null;this.controller=null;this.alerts=[];this.handlers={};this.topics=[];this.topicInfo=new Map();this.baselines=new Map();this.lastCandles=new Map();this.latest=new Map();this.status='idle';this.attempt=0;this.reconnectCount=0;this.messageCount=0;this.priceMessageCount=0;this.heartbeatCount=0;this.pongCount=0;this.lastMessageAt=null;this.lastPriceAt=null;this.lastUpdateAt=null;this.lastDisconnect=null;this.lastError=null;this.lastPrice=null;this.connectedAt=null;
  }
  topicsFor(alerts){
    const topics=new Map();
    for(const alert of alerts){
      if(alert.exchange!=='bingx'||(alert.marketType||'spot')!=='spot'||!/^([A-Z0-9]+)-([A-Z0-9]+)$/.test(alert.symbol))throw new Error('Invalid BingX Spot alert market');
      topics.set(`${alert.symbol}@lastPrice`,{symbol:alert.symbol,eventType:'ticker'});
      if(alert.type==='movement'||alert.type==='volume'){
        const interval=alert.type==='movement'?alert.condition.window:alert.condition.timeframe,wsInterval=intervalMap[interval];
        if(!wsInterval)throw new Error('Unsupported BingX alert interval');
        topics.set(`${alert.symbol}@kline_${wsInterval}`,{symbol:alert.symbol,eventType:'candle',interval:restInterval(interval),wsInterval});
      }
    }
    return new Map([...topics].sort(([a],[b])=>a.localeCompare(b)));
  }
  identity(symbol){const alert=this.alerts.find(item=>item.symbol===symbol);return{marketId:`bingx:spot:${symbol}`,exchange:'bingx',marketType:'spot',symbol,baseAsset:alert?.baseAsset||symbol.split('-')[0],quoteAsset:alert?.quoteAsset||symbol.split('-')[1]};}
  setStatus(status){if(this.status===status)return;this.status=status;this.handlers.onStatus?.(status);}
  async start(alerts,handlers={}){
    await this.stop();this.handlers=handlers;this.alerts=alerts.map(item=>({...item}));this.topicInfo=this.topicsFor(this.alerts);this.topics=[...this.topicInfo.keys()];
    if(!this.topics.length)return;
    const token=this.generation;this.setStatus('connecting');await this.prepareBaselines(token);if(token===this.generation)this.open(token);
  }
  async prepareBaselines(token){
    this.controller=new AbortController();const controller=this.controller;
    const unique=new Map(this.alerts.filter(a=>a.type==='volume').map(a=>[`${a.symbol}:${restInterval(a.condition.timeframe)}`,a]));
    for(const [key,alert] of unique){
      if(token!==this.generation)return;
      const request=new AbortController(),abort=()=>request.abort(),timer=setTimeout(abort,this.requestTimeoutMs);controller.signal.addEventListener('abort',abort,{once:true});if(controller.signal.aborted)abort();
      try{
        const params=new URLSearchParams({symbol:alert.symbol,interval:restInterval(alert.condition.timeframe),limit:String(VOLUME_WINDOW+1)});
        const response=await this.fetchImpl(`${this.restBase}/openApi/spot/v2/market/kline?${params}`,{signal:request.signal}),value=await response.json();
        if(token!==this.generation)return;
        if(!response.ok||value?.code!==0||!Array.isArray(value.data))throw new Error('Invalid BingX volume baseline response');
        const rows=value.data.filter(Array.isArray).map(r=>({time:timestamp(r[0]),closeTime:timestamp(r[6]),volume:number(r[7])})).filter(r=>r.time!==null&&r.closeTime!==null&&r.closeTime<this.now()&&r.volume!==null&&r.volume>=0).sort((a,b)=>a.time-b.time);
        this.baselines.set(key,new Map([...new Map(rows.map(r=>[r.time,r.volume]))].slice(-VOLUME_WINDOW)));
      }catch(error){if(token===this.generation){this.lastError={code:'BASELINE_UNAVAILABLE',reason:error.message,at:this.now()};this.logger.warn('bingx_baseline_failed',{marketId:alert.marketId,message:error.message});}}
      finally{clearTimeout(timer);controller.signal.removeEventListener('abort',abort);}
    }
  }
  normalize(payload){
    const topic=payload?.dataType,info=this.topicInfo.get(topic),row=payload?.data;if(!info||!row||row.s!==info.symbol)return null;
    if(Object.hasOwn(payload,'code')&&payload.code!==0)return null;
    if(info.eventType==='ticker'){
      const price=number(row.c),time=timestamp(row.T)||timestamp(payload.timestamp);if(price===null||price<=0||time===null)return null;
      return {...this.identity(info.symbol),eventType:'ticker',price,timestamp:time};
    }
    const k=row.K;if(!k||k.s&&k.s!==info.symbol||k.i&&k.i!==info.wsInterval)return null;
    const price=number(k.c),open=number(k.o),high=number(k.h),low=number(k.l),volume=number(k.q),openTime=timestamp(k.t),closeTime=timestamp(k.T),time=timestamp(row.E)||timestamp(payload.timestamp);
    if([price,open,high,low,volume,openTime,closeTime,time].some(n=>n===null)||Math.min(price,open,high,low)<=0||volume<0||high<low||closeTime<openTime)return null;
    const key=`${info.symbol}:${info.interval}`,previous=this.lastCandles.get(key),baseline=this.baselines.get(key)||new Map();
    if(previous&&openTime<previous.openTime)return null;
    if(previous&&openTime>previous.openTime)baseline.set(previous.openTime,previous.volume);
    const closedVolumes=[...baseline].filter(([t])=>t<openTime).sort(([a],[b])=>a-b).slice(-VOLUME_WINDOW);
    const averageVolume=closedVolumes.length===VOLUME_WINDOW?closedVolumes.reduce((sum,[,v])=>sum+v,0)/VOLUME_WINDOW:null;
    const event={...this.identity(info.symbol),eventType:'candle',interval:info.interval,price,open,high,low,volume,averageVolume,openTime,closeTime,closed:time>closeTime,timestamp:time};
    this.lastCandles.set(key,event);if(event.closed)baseline.set(openTime,volume);
    // Retain the current closed candle plus its 20 predecessors: a repeated final
    // update must neither count itself in its baseline nor evict a predecessor.
    this.baselines.set(key,new Map([...baseline].sort(([a],[b])=>a-b).slice(-(VOLUME_WINDOW+1))));
    return event;
  }
  open(token){
    if(token!==this.generation||!this.topics.length)return;
    let socket;try{socket=new this.WebSocketImpl(this.wsBase);}catch(error){this.lastError={code:'SOCKET_CREATE_FAILED',reason:error.message,at:this.now()};this.schedule(token);return;}
    this.socket=socket;socket.binaryType='arraybuffer';
    const ctx={socket,token,closed:false,pending:new Map(),acked:new Set(),lastData:new Map(),queue:Promise.resolve(),queued:0,ackTimer:null,heartbeatTimer:null};this.context=ctx;
    const current=()=>token===this.generation&&this.context===ctx&&!ctx.closed;
    const fail=(code,error)=>{if(!current())return;this.lastError={code,reason:String(error?.message||error),at:this.now()};this.lastDisconnect=this.lastError;this.setStatus('failed');this.release(ctx);try{socket.close(1000,'transport recovery');}catch{}this.schedule(token);};
    const heartbeat=()=>{clearTimeout(ctx.heartbeatTimer);ctx.heartbeatTimer=setTimeout(()=>fail('HEARTBEAT_TIMEOUT','BingX heartbeat/data timeout'),this.heartbeatTimeoutMs);};
    ctx.ackTimer=setTimeout(()=>fail('CONNECT_TIMEOUT','BingX connection timeout'),this.ackTimeoutMs);
    socket.addEventListener('open',()=>{
      if(!current())return;
      this.connectedAt=this.now();this.lastMessageAt=null;this.lastPriceAt=null;this.lastUpdateAt=null;this.setStatus('subscribing');clearTimeout(ctx.ackTimer);
      try{for(const topic of this.topics){const id=randomUUID();ctx.pending.set(id,topic);socket.send(JSON.stringify({id,reqType:'sub',dataType:topic}));}}catch(error){fail('SUBSCRIBE_SEND_FAILED',error);return;}
      ctx.ackTimer=setTimeout(()=>fail('ACK_TIMEOUT','BingX subscription acknowledgement timeout'),this.ackTimeoutMs);heartbeat();
    });
    socket.addEventListener('message',message=>{
      if(!current())return;if(++ctx.queued>128){fail('QUEUE_OVERFLOW','BingX message queue overflow');return;}
      ctx.queue=ctx.queue.then(async()=>{
        if(!current())return;const text=await this.decode(message.data);if(!current())return;
        this.messageCount++;this.lastMessageAt=this.now();
        const payload=text==='Ping'||text==='ping'?{ping:true}:JSON.parse(text);
        if(!payload||typeof payload!=='object')throw new Error('Invalid BingX message');
        if(!payload.dataType&&Object.hasOwn(payload,'ping')){this.heartbeatCount++;heartbeat();socket.send('Pong');this.pongCount++;return;}
        if(Object.hasOwn(payload,'id')){
          const topic=ctx.pending.get(payload.id);if(!topic)return;
          if(payload.code!==0){fail('SUBSCRIBE_REJECTED',`BingX subscription rejected: ${payload.code}`);return;}
          ctx.pending.delete(payload.id);ctx.acked.add(topic);heartbeat();
          if(!ctx.pending.size){clearTimeout(ctx.ackTimer);this.attempt=0;this.setStatus('live');}return;
        }
        if(!this.topicInfo.has(payload.dataType))return;
        if(Object.hasOwn(payload,'code')&&payload.code!==0){fail('DATA_REJECTED',`BingX data error: ${payload.code}`);return;}
        // Explicit per-topic ACK is required: data or heartbeat cannot mask a missing ACK.
        if(!ctx.acked.has(payload.dataType))return;
        const last=this.latest.get(payload.dataType),sourceTime=this.topicInfo.get(payload.dataType).eventType==='ticker'?(timestamp(payload.data?.T)||timestamp(payload.timestamp)):timestamp(payload.data?.E)||timestamp(payload.timestamp);
        if(sourceTime!==null&&last&&sourceTime<last.timestamp)return;
        const event=this.normalize(payload);if(!event)throw new Error('Invalid BingX subscribed market payload');
        if(last&&event.timestamp===last.timestamp&&event.price===last.price&&event.volume===last.volume)return;
        this.latest.set(payload.dataType,event);ctx.lastData.set(payload.dataType,this.now());this.lastUpdateAt=this.now();heartbeat();
        if(event.eventType==='ticker'){this.priceMessageCount++;this.lastPriceAt=this.now();this.lastPrice=event.price;}
        this.handlers.onEvent?.(event);
      }).catch(error=>fail('MALFORMED_FRAME',error)).finally(()=>{ctx.queued--;});
    });
    socket.addEventListener('error',error=>fail('SOCKET_ERROR',error?.message||'BingX WebSocket error'));
    socket.addEventListener('close',event=>{if(!current())return;this.lastDisconnect={code:event?.code??null,reason:String(event?.reason||'connection closed'),at:this.now()};this.release(ctx);this.schedule(token);});
  }
  release(ctx){ctx.closed=true;clearTimeout(ctx.ackTimer);clearTimeout(ctx.heartbeatTimer);ctx.pending.clear();ctx.acked.clear();if(this.socket===ctx.socket)this.socket=null;}
  schedule(token){if(token!==this.generation||!this.topics.length)return;clearTimeout(this.timer);this.setStatus('reconnecting');this.reconnectCount++;const delay=Math.min(this.reconnectMaxMs,this.reconnectBaseMs*2**Math.min(this.attempt++,16));this.timer=setTimeout(()=>{if(token===this.generation){this.setStatus('connecting');this.open(token);}},delay);}
  async stop(){this.generation++;clearTimeout(this.timer);this.timer=null;this.controller?.abort();this.controller=null;const socket=this.socket;if(this.context)this.release(this.context);this.context=null;if(socket&&socket.readyState<2)socket.close(1000,'shutdown');this.status='idle';this.topics=[];this.topicInfo.clear();this.alerts=[];this.baselines.clear();this.lastCandles.clear();this.latest.clear();this.attempt=0;}
  diagnostics(){
    const ctx=this.context,active=Boolean(this.socket&&this.socket.readyState===1),stale=this.status==='live'&&this.topics.some(topic=>{const time=ctx?.lastData.get(topic);return this.now()-(time??this.connectedAt??0)>this.staleAfterMs;});
    return{status:stale?'stale':this.status,connections:this.socket&&this.socket.readyState<=1?1:0,activeSockets:active?1:0,connected:active,subscriptions:this.topics.length,requestedSubscriptions:this.topics.length,acknowledgedSubscriptions:ctx?.acked.size||0,pendingAcknowledgements:ctx?.pending.size||0,acknowledged:Boolean(this.topics.length&&ctx?.acked.size===this.topics.length),topics:[...this.topics],endpoint:this.wsBase,connectedAt:this.connectedAt,lastMessageAt:this.lastMessageAt,lastPriceAt:this.lastPriceAt,lastUpdateAt:this.lastUpdateAt,lastPrice:this.lastPrice,messageCount:this.messageCount,priceMessageCount:this.priceMessageCount,heartbeatCount:this.heartbeatCount,pongCount:this.pongCount,reconnectCount:this.reconnectCount,lastDisconnect:this.lastDisconnect,lastError:this.lastError,stale};
  }
}
module.exports={BingxMarketTransport,intervalMap,decodeFrame,VOLUME_WINDOW};
