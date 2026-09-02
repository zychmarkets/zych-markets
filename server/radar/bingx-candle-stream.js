'use strict';
const {randomUUID}=require('node:crypto');
const {decodeFrame}=require('../transports/bingx-market-transport');
const {normalizeStream}=require('./candle-adapters');
const intervals=Object.freeze({'1m':'1min','5m':'5min','15m':'15min'});

// Protocol adapter only. Recovery, rolling state and detectors remain exchange-neutral.
class BingxCandleStream {
  constructor({wsBase='wss://open-api-ws.bingx.com/market',WebSocketImpl=globalThis.WebSocket,maxTopicsPerSocket=100,logger={warn(){}},now=Date.now,decode=decodeFrame,ackTimeoutMs=15000,heartbeatTimeoutMs=45000,staleAfterMs=45000,reconnectBaseMs=1000,reconnectMaxMs=30000}={}){
    Object.assign(this,{wsBase,WebSocketImpl,maxTopicsPerSocket,logger,now,decode,ackTimeoutMs,heartbeatTimeoutMs,staleAfterMs,reconnectBaseMs,reconnectMaxMs});
    this.generation=0;this.running=false;this.shards=[];this.handlers={};this.lastDisconnect=null;this.lastError=null;
    this.stats={reconnectCount:0,heartbeatCount:0,pongCount:0,heartbeatFailures:0,decompressionFailures:0,malformedFrames:0,lastMessageTimestamp:null,lastCandleTimestamp:null};
  }
  async start(markets,timeframes,handlers={}){
    await this.stop();this.handlers=handlers;this.running=true;const topics=new Map();
    for(const market of markets)for(const timeframe of timeframes){if(!intervals[timeframe]||market.exchange!=='bingx'||market.marketType!=='spot'||market.marketId!==`bingx:spot:${market.symbol}`||!/^[A-Z0-9]+-[A-Z0-9]+$/.test(market.symbol))throw new Error('Invalid BingX Radar topic');topics.set(`${market.symbol}@kline_${intervals[timeframe]}`,{market,timeframe})}
    const rows=[...topics],size=Math.max(1,this.maxTopicsPerSocket);
    for(let i=0;i<rows.length;i+=size){const shard={topics:new Map(rows.slice(i,i+size)),pending:new Map(),acked:new Set(),failed:new Set(),lastData:new Map(),previous:new Map(),socket:null,attempt:0,timer:null,ackTimer:null,heartbeatTimer:null,status:'connecting'};this.shards.push(shard);this.open(shard,this.generation)}
    this.notify();
  }
  notify(){this.handlers.onStatus?.(this.diagnostics().status)}
  open(shard,generation){
    if(!this.running||generation!==this.generation)return;
    shard.status='connecting';shard.pending.clear();shard.acked.clear();shard.failed.clear();shard.lastData.clear();shard.previous.clear();
    let socket;try{socket=new this.WebSocketImpl(this.wsBase)}catch(error){this.recover(shard,generation,'SOCKET_CREATE_FAILED',error.message);return}
    shard.socket=socket;socket.binaryType='arraybuffer';let queue=Promise.resolve(),queued=0;
    const current=()=>this.running&&generation===this.generation&&shard.socket===socket;
    const fail=(code,reason)=>{if(current())this.recover(shard,generation,code,String(reason||code))};
    const heartbeat=()=>{clearTimeout(shard.heartbeatTimer);shard.heartbeatTimer=setTimeout(()=>{this.stats.heartbeatFailures++;fail('HEARTBEAT_TIMEOUT','No BingX message or heartbeat')},this.heartbeatTimeoutMs)};
    shard.ackTimer=setTimeout(()=>fail('CONNECT_TIMEOUT','BingX socket did not open'),this.ackTimeoutMs);
    socket.addEventListener('open',()=>{
      if(!current())return;clearTimeout(shard.ackTimer);shard.status='subscribing';
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
          else shard.acked.add(topic);
          if(!shard.pending.size){clearTimeout(shard.ackTimer);if(shard.failed.size){this.notify();fail('SUBSCRIBE_REJECTED','BingX topic subscription rejected');return}shard.status='live';shard.attempt=0}
          heartbeat();this.notify();return;
        }
        const topic=payload.dataType,info=shard.topics.get(topic);if(!info||!shard.acked.has(topic))return;
        if(Object.hasOwn(payload,'code')&&payload.code!==0){shard.failed.add(topic);fail('DATA_REJECTED',`${topic}: ${payload.code}`);return}
        const value=normalizeStream('bingx',info.market,info.timeframe,payload,this.now());if(!value)throw Error('Invalid BingX candle');
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
  recover(shard,generation,code,reason){
    if(!this.running||generation!==this.generation)return;
    clearTimeout(shard.ackTimer);clearTimeout(shard.heartbeatTimer);clearTimeout(shard.timer);
    const socket=shard.socket;shard.socket=null;shard.status='reconnecting';shard.acked.clear();shard.pending.clear();shard.lastData.clear();shard.previous.clear();
    this.lastDisconnect={code,reason,at:this.now()};this.lastError=this.lastDisconnect;
    try{if(socket&&socket.readyState<2)socket.close(1000,'recovery')}catch{}
    this.stats.reconnectCount++;this.handlers.onReconnect?.();this.handlers.onError?.(new Error(reason));this.notify();
    shard.timer=setTimeout(()=>this.open(shard,generation),Math.min(this.reconnectMaxMs,this.reconnectBaseMs*2**Math.min(shard.attempt++,10)));
  }
  diagnostics(){
    const topics=this.shards.flatMap(shard=>[...shard.topics.keys()]),requested=topics.length,activeSockets=this.shards.filter(shard=>shard.socket?.readyState===1).length,acked=this.shards.reduce((sum,s)=>sum+s.acked.size,0),failed=this.shards.flatMap(shard=>[...shard.failed]);
    const fresh=this.shards.reduce((sum,s)=>sum+[...s.acked].filter(topic=>s.lastData.has(topic)&&this.now()-s.lastData.get(topic)<=this.staleAfterMs).length,0);
    let status='idle';if(requested){if(!activeSockets)status=this.shards.some(s=>s.status==='connecting')?'connecting':'offline';else if(failed.length||acked<requested)status=acked?'partial':'subscribing';else if(fresh<requested)status=this.shards.some(s=>[...s.lastData.values()].some(time=>this.now()-time>this.staleAfterMs))?'stale':'subscribing';else status='live'}
    return{status,requestedTopics:requested,acknowledgedTopics:acked,failedTopics:failed.length,failedTopicNames:failed,topics,subscriptions:requested,freshTopics:fresh,activeSockets,...this.stats,lastDisconnect:this.lastDisconnect,lastError:this.lastError};
  }
  async stop(){this.running=false;this.generation++;for(const shard of this.shards){clearTimeout(shard.timer);clearTimeout(shard.ackTimer);clearTimeout(shard.heartbeatTimer);const socket=shard.socket;shard.socket=null;if(socket&&socket.readyState<2)socket.close(1000,'shutdown')}this.shards=[]}
}
module.exports={BingxCandleStream,intervals};
