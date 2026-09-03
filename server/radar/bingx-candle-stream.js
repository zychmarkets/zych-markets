'use strict';
const {randomUUID}=require('node:crypto');
const {decodeFrame}=require('../transports/bingx-market-transport');
const {normalizeStream}=require('./candle-adapters');
const intervals=Object.freeze({'1m':'1min','5m':'5min','15m':'15min'});

// Protocol adapter only. Recovery, rolling state and detectors remain exchange-neutral.
class BingxCandleStream {
  constructor({wsBase='wss://open-api-ws.bingx.com/market',WebSocketImpl=globalThis.WebSocket,maxTopicsPerSocket=100,logger={warn(){}},now=Date.now,decode=decodeFrame,ackTimeoutMs=15000,heartbeatTimeoutMs=45000,staleAfterMs=45000,startupValidationMs=45000,reconnectBaseMs=1000,reconnectMaxMs=30000}={}){
    Object.assign(this,{wsBase,WebSocketImpl,maxTopicsPerSocket,logger,now,decode,ackTimeoutMs,heartbeatTimeoutMs,staleAfterMs,startupValidationMs,reconnectBaseMs,reconnectMaxMs});
    this.generation=0;this.running=false;this.shards=[];this.handlers={};this.lastDisconnect=null;this.lastError=null;
    this.quarantined=new Map();this.marketFailures=new Map();this.validationTimer=null;this.catalogMarketCount=0;
    this.stats={reconnectCount:0,heartbeatCount:0,pongCount:0,heartbeatFailures:0,decompressionFailures:0,malformedFrames:0,lastMessageTimestamp:null,lastCandleTimestamp:null};
  }
  async start(markets,timeframes,handlers={}){
    await this.stop();this.handlers=handlers;this.running=true;this.quarantined.clear();this.marketFailures.clear();this.catalogMarketCount=new Set(markets.map(item=>item.marketId)).size;const topics=new Map();
    for(const market of markets)for(const timeframe of timeframes){if(!intervals[timeframe]||market.exchange!=='bingx'||market.marketType!=='spot'||market.marketId!==`bingx:spot:${market.symbol}`||!/^[A-Z0-9]+-[A-Z0-9]+$/.test(market.symbol))throw new Error('Invalid BingX Radar topic');topics.set(`${market.symbol}@kline_${intervals[timeframe]}`,{market,timeframe})}
    const rows=[...topics],size=Math.max(1,this.maxTopicsPerSocket);
    for(let i=0;i<rows.length;i+=size){const shard={topics:new Map(rows.slice(i,i+size)),pending:new Map(),acked:new Set(),failed:new Set(),lastData:new Map(),previous:new Map(),socket:null,attempt:0,timer:null,ackTimer:null,heartbeatTimer:null,status:'connecting'};this.shards.push(shard);this.open(shard,this.generation)}
    this.notify();
  }
  notify(){this.handlers.onStatus?.(this.diagnostics().status)}
  open(shard,generation){
    if(!this.running||generation!==this.generation)return;
    shard.epoch=(shard.epoch||0)+1;shard.openedAt=null;shard.ackAt=new Map();shard.status='connecting';shard.pending.clear();shard.acked.clear();shard.failed.clear();shard.lastData.clear();shard.previous.clear();
    let socket;try{socket=new this.WebSocketImpl(this.wsBase)}catch(error){this.recover(shard,generation,'SOCKET_CREATE_FAILED',error.message);return}
    shard.socket=socket;socket.binaryType='arraybuffer';let queue=Promise.resolve(),queued=0;
    const current=()=>this.running&&generation===this.generation&&shard.socket===socket;
    const fail=(code,reason)=>{if(current())this.recover(shard,generation,code,String(reason||code))};
    const heartbeat=()=>{clearTimeout(shard.heartbeatTimer);shard.heartbeatTimer=setTimeout(()=>{this.stats.heartbeatFailures++;fail('HEARTBEAT_TIMEOUT','No BingX message or heartbeat')},this.heartbeatTimeoutMs)};
    shard.ackTimer=setTimeout(()=>fail('CONNECT_TIMEOUT','BingX socket did not open'),this.ackTimeoutMs);
    socket.addEventListener('open',()=>{
      if(!current())return;clearTimeout(shard.ackTimer);shard.status='subscribing';shard.openedAt=this.now();
      try{for(const topic of shard.topics.keys()){const id=randomUUID();shard.pending.set(id,topic);socket.send(JSON.stringify({id,reqType:'sub',dataType:topic}))}}catch(error){fail('SUBSCRIBE_SEND_FAILED',error.message);return}
      shard.ackTimer=setTimeout(()=>{for(const topic of shard.pending.values())shard.failed.add(topic);fail('ACK_TIMEOUT','Missing BingX topic acknowledgements')},this.ackTimeoutMs);heartbeat();this.notify();
    });
    socket.addEventListener('message',message=>{
      if(!current())return;if(++queued>256){fail('QUEUE_OVERFLOW','BingX frame queue full');return}
      queue=queue.then(async()=>{
        if(!current())return;let text;try{text=await this.decode(message.data)}catch(error){if(current())this.stats.decompressionFailures++;throw error}if(!current())return;
        this.stats.lastMessageTimestamp=this.now();const payload=text==='Ping'||text==='ping'?{ping:true}:JSON.parse(text);
        if(!payload||typeof payload!=='object')throw Error('Invalid BingX frame');
        if(!payload.dataType&&Object.hasOwn(payload,'ping')){this.stats.heartbeatCount++;socket.send('Pong');this.stats.pongCount++;heartbeat();return}
        if(Object.hasOwn(payload,'id')){
          const topic=shard.pending.get(payload.id);if(!topic)return;shard.pending.delete(payload.id);
          if(payload.code!==0){shard.failed.add(topic);shard.status='partial';this.lastError={code:'SUBSCRIBE_REJECTED',reason:`${topic}: ${payload.code}`,at:this.now()}}
          else {shard.acked.add(topic);shard.ackAt.set(topic,this.now())}
          if(!shard.pending.size){clearTimeout(shard.ackTimer);if(shard.failed.size){this.notify();fail('SUBSCRIBE_REJECTED','BingX topic subscription rejected');return}shard.status='live';shard.attempt=0;this.scheduleValidation(generation)}
          heartbeat();this.notify();return;
        }
        const topic=payload.dataType,info=shard.topics.get(topic);if(!info||!shard.acked.has(topic))return;
        if(Object.hasOwn(payload,'code')&&payload.code!==0){shard.failed.add(topic);fail('DATA_REJECTED',`${topic}: ${payload.code}`);return}
        let value;try{value=normalizeStream('bingx',info.market,info.timeframe,payload,this.now())}catch(error){this.rejectCandle(shard,topic,info,error.message);heartbeat();return}if(!value){this.rejectCandle(shard,topic,info,'Invalid BingX candle');heartbeat();return}shard.failed.delete(topic);if(!shard.failed.size)shard.status='live';
        const previous=shard.previous.get(topic);if(previous&&(value.openTime<previous.openTime||value.sourceTimestamp<previous.sourceTimestamp))return;
        // BingX has no confirm flag. The next period confirms closure of the last
        // observed candle. On reconnect we discard it and let generic recovery fill gaps.
        if(previous&&value.openTime>previous.openTime&&!previous.isClosed)this.handlers.onCandle?.(Object.freeze({...previous,isClosed:true,receivedAt:this.now()}));
        shard.previous.set(topic,value);shard.lastData.set(topic,this.now());this.stats.lastCandleTimestamp=this.now();heartbeat();this.handlers.onCandle?.(value);this.notify();
      }).catch(error=>{if(current()){this.stats.malformedFrames++;fail('MALFORMED_FRAME',error.message)}}).finally(()=>queued--);
      return queue;
    });
    socket.addEventListener('error',error=>fail('SOCKET_ERROR',error?.message));
    socket.addEventListener('close',event=>fail(event?.code||'SOCKET_CLOSED',event?.reason||'BingX connection closed'));
  }
  rejectCandle(shard,topic,info,reason){
    const now=this.now(),prior=this.marketFailures.get(info.market.marketId)||{count:0,firstFailureAt:now,lastFailureAt:now,intervals:new Set()};prior.count++;prior.lastFailureAt=now;prior.intervals.add(info.timeframe);this.marketFailures.set(info.market.marketId,prior);
    this.stats.malformedFrames++;shard.failed.add(topic);shard.status='partial';this.lastError={code:'INVALID_CANDLE',reason,at:now};
    this.notify();
  }
  scheduleValidation(generation){clearTimeout(this.validationTimer);this.validationTimer=setTimeout(()=>{if(!this.running||generation!==this.generation)return;const markets=new Map();for(const shard of this.shards)for(const [topic,info]of shard.topics){const row=markets.get(info.market.marketId)||{market:info.market,topics:[],acked:true,usable:false};row.topics.push({shard,topic,timeframe:info.timeframe});row.acked&&=shard.acked.has(topic);row.usable||=shard.lastData.has(topic);markets.set(info.market.marketId,row)}for(const row of markets.values())if(row.acked&&!row.usable)this.quarantineMarket(row.market,'RADAR_STREAM_UNVIABLE',row.topics.map(item=>item.timeframe),row.topics.map(item=>item.shard.ackAt.get(item.topic)).filter(Number.isFinite).sort((a,b)=>a-b)[0]||this.now(),this.now())},this.startupValidationMs);this.validationTimer.unref?.()}
  quarantineMarket(market,reasonCode,failedIntervals,firstFailureAt,lastFailureAt){
    if(this.quarantined.has(market.marketId))return;const record=Object.freeze({exchange:'bingx',marketId:market.marketId,nativeSymbol:market.symbol,reasonCode,failedIntervals:[...new Set(failedIntervals)].sort(),firstFailureAt,lastFailureAt,retryGeneration:this.generation});this.quarantined.set(market.marketId,record);
    for(const shard of this.shards)for(const [topic,info]of [...shard.topics])if(info.market.marketId===market.marketId){shard.topics.delete(topic);shard.pending.forEach((value,key)=>{if(value===topic)shard.pending.delete(key)});shard.acked.delete(topic);shard.failed.delete(topic);shard.lastData.delete(topic);shard.previous.delete(topic)}
    this.lastError={code:reasonCode,reason:`${market.symbol}: no usable live candle`,at:lastFailureAt};this.handlers.onQuarantine?.(record);this.notify();
  }
  recover(shard,generation,code,reason){
    if(!this.running||generation!==this.generation)return;
    clearTimeout(shard.ackTimer);clearTimeout(shard.heartbeatTimer);clearTimeout(shard.timer);
    const socket=shard.socket;shard.socket=null;shard.status='reconnecting';shard.acked.clear();shard.pending.clear();shard.lastData.clear();shard.previous.clear();
    this.lastDisconnect={code,reason,at:this.now()};this.lastError=this.lastDisconnect;
    try{if(socket&&socket.readyState<2)socket.close(1000,'recovery')}catch{}
    this.stats.reconnectCount++;this.handlers.onReconnect?.();this.handlers.onError?.(new Error(reason));this.notify();
    shard.timer=setTimeout(()=>this.open(shard,generation),Math.min(this.reconnectMaxMs,this.reconnectBaseMs*2**Math.min(shard.attempt++,10)));
  }
  topicEvidence(){return this.shards.flatMap((shard,index)=>[...shard.topics].map(([topic,info])=>({
    marketId:info.market.marketId,nativeSymbol:info.market.symbol,timeframe:info.timeframe,connectionId:`bingx-${index}`,generation:shard.epoch,
    connection:{state:shard.socket?.readyState===1?'OPEN':shard.socket?.readyState===0?'CONNECTING':'CLOSED',openedAt:shard.openedAt},
    subscription:{requestedAt:shard.openedAt,acknowledgement:shard.failed.has(topic)?'rejected':shard.acked.has(topic)?'acknowledged':shard.openedAt?'pending':'unknown',lastAckAt:shard.ackAt?.get(topic)},
    data:{lastMarketDataAt:shard.lastData.get(topic)},error:{code:typeof this.lastError?.code==='string'?this.lastError.code:null,lastErrorAt:this.lastError?.at}
  })))}
  diagnostics(){
    const topics=this.shards.flatMap(shard=>[...shard.topics.keys()]),requested=topics.length,activeSockets=this.shards.filter(shard=>shard.socket?.readyState===1).length,acked=this.shards.reduce((sum,s)=>sum+s.acked.size,0),failed=this.shards.flatMap(shard=>[...shard.failed]);
    const fresh=this.shards.reduce((sum,s)=>sum+[...s.acked].filter(topic=>s.lastData.has(topic)&&this.now()-s.lastData.get(topic)<=this.staleAfterMs).length,0);
    let status='idle';if(requested){if(!activeSockets)status=this.shards.some(s=>s.status==='connecting')?'connecting':'offline';else if(failed.length||acked<requested)status=acked?'partial':'subscribing';else if(fresh<requested)status=this.shards.some(s=>[...s.lastData.values()].some(time=>this.now()-time>this.staleAfterMs))?'stale':'subscribing';else status='live'}
    const quarantinedMarkets=[...this.quarantined.values()];
    return{status,eligibleCatalogMarkets:this.catalogMarketCount,activeMonitoredMarkets:new Set(this.shards.flatMap(shard=>[...shard.topics.values()].map(item=>item.market.marketId))).size,quarantinedCount:quarantinedMarkets.length,quarantinedMarkets:quarantinedMarkets.slice(0,100),requestedTopics:requested,acknowledgedTopics:acked,failedTopics:failed.length,failedTopicNames:failed.slice(0,200),topics:topics.slice(0,200),omittedTopics:Math.max(0,topics.length-200),connectingSockets:this.shards.filter(s=>s.socket?.readyState===0).length,subscriptions:requested,freshTopics:fresh,activeSockets,...this.stats,lastDisconnect:this.lastDisconnect,lastError:this.lastError};
  }
  async stop(){this.running=false;this.generation++;clearTimeout(this.validationTimer);this.validationTimer=null;for(const shard of this.shards){clearTimeout(shard.timer);clearTimeout(shard.ackTimer);clearTimeout(shard.heartbeatTimer);const socket=shard.socket;shard.socket=null;if(socket&&socket.readyState<2)socket.close(1000,'shutdown')}this.shards=[]}
}
module.exports={BingxCandleStream,intervals};
