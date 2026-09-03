'use strict';
const {BingxMarketTransport}=require('./bingx-market-transport');
const {createCoinbasePublicProxy}=require('../coinbase-public-proxy');
const {unsupportedReason,numeric}=require('../../js/exchanges/coinbase-public');
const {compareTrades}=require('../../js/exchanges/coinbase-chart');

// Reuse the existing transport lifecycle (generation, release, exponential
// reconnect, stop). Coinbase supplies its own public wire protocol only.
class CoinbaseMarketTransport extends BingxMarketTransport {
  constructor({products=createCoinbasePublicProxy(),...options}={}){
    super({...options,wsBase:'wss://advanced-trade-ws.coinbase.com'});
    this.products=products;this.seen=new Map();this.sequenceGaps=0;this.duplicates=0;this.outOfOrder=0;this.lastHeartbeatAt=null;
  }
  async validateAlert(alert,definition=alert){
    if(alert.exchange!=='coinbase'||alert.marketType!=='spot'||alert.type!=='price')return {error:'UNSUPPORTED_ALERT_TYPE',message:'Coinbase supports Spot price crossing alerts only.'};
    if(definition.marketType&&definition.marketType!=='spot'||definition.marketId&&definition.marketId!==alert.marketId||alert.marketId!==`coinbase:spot:${alert.symbol}`||alert.symbol!==`${alert.baseAsset}-${alert.quoteAsset}`)return {error:'INVALID_MARKET',message:'Exact Coinbase native market identity is required.'};
    try{const value=await this.products();if(!value.products.some(row=>row.product_id===alert.symbol&&!unsupportedReason(row)))return {error:'UNSUPPORTED_MARKET',message:'Coinbase product is unavailable or an excluded unified-book alias.'};}
    catch{return {error:'MARKET_UNAVAILABLE',message:'Coinbase public product validation is unavailable. Retry later.'};}
    return null;
  }
  async start(alerts,handlers={}){
    await this.stop();this.handlers=handlers;this.alerts=alerts.map(a=>({...a}));if(!alerts.length)return;
    const token=this.generation;this.setStatus('connecting');
    for(const alert of alerts){const error=await this.validateAlert(alert);if(token!==this.generation)return;if(error){this.lastError={code:error.error,reason:error.message,at:this.now()};this.setStatus('failed');return;}}
    this.topics=[...new Set(alerts.map(a=>a.symbol))].sort();this.open(token);
  }
  identity(symbol){const a=this.alerts.find(a=>a.symbol===symbol);return{marketId:`coinbase:spot:${symbol}`,exchange:'coinbase',marketType:'spot',symbol,baseAsset:a.baseAsset,quoteAsset:a.quoteAsset};}
  open(token){
    if(token!==this.generation||!this.topics.length)return;
    let socket;try{socket=new this.WebSocketImpl(this.wsBase);}catch(error){this.lastError={code:'SOCKET_CREATE_FAILED',reason:error.message,at:this.now()};this.schedule(token);return;}
    this.socket=socket;
    const ctx={socket,token,closed:false,pending:new Map(),acked:new Set(),ackTimes:new Map(),lastData:new Map(),sequence:null,baseline:new Set(),queue:Promise.resolve(),queued:0,ackTimer:null,heartbeatTimer:null};this.context=ctx;
    const current=()=>token===this.generation&&this.context===ctx&&!ctx.closed;
    const fail=(code,error)=>{if(!current())return;this.lastError={code,reason:String(error?.message||error),at:this.now()};this.lastDisconnect=this.lastError;this.setStatus('failed');this.release(ctx);try{socket.close(1000,'transport recovery');}catch{}this.schedule(token);};
    const heartbeat=()=>{clearTimeout(ctx.heartbeatTimer);ctx.heartbeatTimer=setTimeout(()=>fail('HEARTBEAT_TIMEOUT','Coinbase heartbeat timeout'),this.heartbeatTimeoutMs);};
    ctx.ackTimer=setTimeout(()=>fail('CONNECT_TIMEOUT','Coinbase connection timeout'),this.ackTimeoutMs);
    socket.addEventListener('open',()=>{
      if(!current())return;this.connectedAt=this.now();this.lastMessageAt=null;this.lastPriceAt=null;this.lastHeartbeatAt=null;this.setStatus('subscribing');clearTimeout(ctx.ackTimer);
      try{for(const channel of ['market_trades','heartbeats']){ctx.pending.set(channel,[...this.topics]);socket.send(JSON.stringify({type:'subscribe',channel,product_ids:this.topics}));}}
      catch(error){fail('SUBSCRIBE_SEND_FAILED',error);return;}
      ctx.ackTimer=setTimeout(()=>fail('ACK_TIMEOUT','Coinbase subscription confirmation timeout'),this.ackTimeoutMs);heartbeat();
    });
    socket.addEventListener('message',message=>{
      if(!current())return;if(++ctx.queued>128){fail('QUEUE_OVERFLOW','Coinbase message queue overflow');return;}
      ctx.queue=ctx.queue.then(async()=>{
        if(!current())return;
        const text=typeof message.data==='string'?message.data:Buffer.from(message.data).toString('utf8');if(Buffer.byteLength(text)>1048576)throw new Error('Coinbase frame too large');
        const p=JSON.parse(text);this.messageCount++;this.lastMessageAt=this.now();
        if(p.type==='error'){fail('SUBSCRIBE_REJECTED',p.message);return;}
        if(!Number.isSafeInteger(p.sequence_num)||p.sequence_num<0)throw new Error('Invalid Coinbase sequence');
        if(ctx.sequence!==null&&p.sequence_num<=ctx.sequence){if(p.sequence_num===ctx.sequence)this.duplicates++;else this.outOfOrder++;return;}
        if(ctx.sequence!==null&&p.sequence_num!==ctx.sequence+1){this.sequenceGaps++;fail('SEQUENCE_GAP',`Expected ${ctx.sequence+1}, received ${p.sequence_num}`);return;}ctx.sequence=p.sequence_num;
        if(p.channel==='heartbeats'){this.heartbeatCount++;this.lastHeartbeatAt=this.now();heartbeat();return;}
        if(p.channel==='subscriptions'){
          for(const event of p.events||[]){const ack=event.subscriptions||{};ctx.acked.clear();ctx.ackTimes.clear();
            for(const symbol of this.topics)if(Array.isArray(ack.market_trades)&&ack.market_trades.includes(symbol))ctx.acked.add(`market_trades:${symbol}`);
            if(Array.isArray(ack.heartbeats)&&ack.heartbeats.includes('heartbeats'))ctx.acked.add('heartbeats');
          }
          for(const topic of ctx.acked)ctx.ackTimes.set(topic,this.now());
          if(ctx.acked.size===this.topics.length+1){ctx.pending.clear();clearTimeout(ctx.ackTimer);}return;
        }
        if(p.channel!=='market_trades')return;
        const updates=[];
        for(const event of p.events||[]){
          if(!['snapshot','update'].includes(event.type)||!Array.isArray(event.trades))throw new Error('Invalid Coinbase trades event');
          for(const trade of event.trades){
            if(!this.topics.includes(trade.product_id))continue;
            const price=numeric(trade.price),size=numeric(trade.size),time=Date.parse(trade.time);
            if(typeof trade.trade_id!=='string'||!/^\d+$/.test(trade.trade_id)||typeof trade.time!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(trade.time)||!Number.isFinite(time)||price===null||price<=0||size===null||size<=0)throw new Error('Invalid Coinbase trade');
            const key=`${trade.product_id}:${trade.trade_id}`;
            if(this.seen.has(key)){this.duplicates++;continue;}this.seen.set(key,true);if(this.seen.size>50000)this.seen.delete(this.seen.keys().next().value);
            // Snapshots are historical context, never executions or crossings.
            if(event.type==='update')updates.push(trade);
          }
        }
        updates.sort(compareTrades);
        for(const trade of updates){
          if(!current())return;
          const previous=this.latest.get(trade.product_id);if(previous&&compareTrades(trade,previous)<=0){this.outOfOrder++;continue;}
          this.latest.set(trade.product_id,trade);
          const timestamp=Date.parse(trade.time);
          if(this.now()-timestamp>this.staleAfterMs||timestamp>this.now()+5000){ctx.baseline.delete(trade.product_id);this.setStatus('stale');continue;}
          if(!ctx.baseline.has(trade.product_id)){ctx.baseline.add(trade.product_id);this.handlers.onBaselineReset?.(this.identity(trade.product_id));}
          this.lastPriceAt=this.now();this.lastUpdateAt=this.now();this.lastPrice=Number(trade.price);ctx.lastData.set(trade.product_id,this.now());this.priceMessageCount++;this.attempt=0;
          if(this.topics.every(s=>ctx.lastData.has(s)))this.setStatus('live');
          await this.handlers.onEvent?.({...this.identity(trade.product_id),eventType:'ticker',price:Number(trade.price),size:Number(trade.size),tradeId:trade.trade_id,productId:trade.product_id,sourceTimestamp:trade.time,timestamp,sequenceNum:p.sequence_num});
        }
      }).catch(error=>fail('MALFORMED_FRAME',error)).finally(()=>ctx.queued--);
    });
    socket.addEventListener('error',error=>fail('SOCKET_ERROR',error?.message||'Coinbase WebSocket error'));
    socket.addEventListener('close',event=>{if(!current())return;this.lastDisconnect={code:event?.code??null,reason:String(event?.reason||'connection closed'),at:this.now()};this.release(ctx);this.schedule(token);});
  }
  async stop(){await super.stop();this.seen.clear();}
  diagnostics(){
    const ctx=this.context,active=Boolean(this.socket&&this.socket.readyState===1),stale=this.status==='live'&&this.topics.some(s=>this.now()-(ctx?.lastData.get(s)||0)>this.staleAfterMs);
    return{status:stale?'stale':this.status,connections:this.socket&&this.socket.readyState<=1?1:0,activeSockets:active?1:0,connected:active,subscriptions:this.topics.length?this.topics.length+1:0,requestedSubscriptions:this.topics.length?[...this.topics.map(s=>`market_trades:${s}`),'heartbeats']:[],confirmedSubscriptions:[...(ctx?.acked||[])],acknowledgedSubscriptions:ctx?.acked.size||0,pendingAcknowledgements:this.topics.length?this.topics.length+1-(ctx?.acked.size||0):0,sequenceNum:ctx?.sequence??null,lastMessageAt:this.lastMessageAt,lastTradeAt:this.lastPriceAt,lastPriceAt:this.lastPriceAt,lastHeartbeatAt:this.lastHeartbeatAt,lastPrice:this.lastPrice,firstUsableProducts:[...(ctx?.baseline||[])],sequenceGaps:this.sequenceGaps,duplicates:this.duplicates,outOfOrder:this.outOfOrder,reconnectCount:this.reconnectCount,lastDisconnect:this.lastDisconnect,lastError:this.lastError,endpoint:this.wsBase,stale};
  }
}
module.exports={CoinbaseMarketTransport};
