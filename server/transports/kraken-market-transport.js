'use strict';
const {BingxMarketTransport}=require('./bingx-market-transport');
const {KrakenBrowserAdapter}=require('../../js/exchanges/kraken-browser');
const {numeric}=require('../../js/exchanges/kraken-public');
const {normalize}=require('../../js/exchanges/kraken-chart');
const intervalMap=Object.freeze({'5m':5,'15m':15,'30m':30,'1h':60,'4h':240,'24h':1440});
const stamp=value=>typeof value==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(value)?Date.parse(value):NaN;
const tradeId=value=>Number.isSafeInteger(value)&&value>=0?String(value):typeof value==='string'&&/^\d+$/.test(value)?value:null;

// One socket per OHLC interval, plus one trade socket. All share the established
// generation/release/backoff lifecycle, mapping registry and single AlertRunner.
class KrakenChannelTransport extends BingxMarketTransport {
  constructor({owner,channel,interval=null,markets,...options}){
    super({...options,wsBase:'wss://ws.kraken.com/v2'});
    Object.assign(this,{owner,channel,interval,markets});this.lastHeartbeatAt=null;this.lastCandleAt=null;
  }
  async start(_alerts,handlers){const token=this.generation+1;await this.stop();if(token!==this.generation)return;this.handlers=handlers;this.topics=[...this.markets.keys()].sort();this.setStatus('connecting');this.open(token);}
  identity(symbol){const row=this.markets.get(symbol);return {marketId:`kraken:spot:${row.nativeSymbol}`,exchange:'kraken',marketType:'spot',symbol:row.nativeSymbol,baseAsset:row.baseAsset,quoteAsset:row.quoteAsset};}
  refresh(){
    const ctx=this.context;if(!ctx||ctx.closed)return;
    const stale=this.topics.some(symbol=>ctx.lastData.has(symbol)&&this.now()-ctx.lastData.get(symbol)>this.staleAfterMs);
    for(const symbol of this.topics)if(ctx.lastData.has(symbol)&&this.now()-ctx.lastData.get(symbol)>this.staleAfterMs)ctx.baseline.delete(symbol);
    this.setStatus(stale?'stale':this.topics.every(symbol=>ctx.acked.has(symbol)&&ctx.lastData.has(symbol))?'live':'subscribing');
  }
  open(token){
    if(token!==this.generation||!this.topics.length)return;
    let socket;try{socket=new this.WebSocketImpl(this.wsBase);}catch(error){this.lastError={code:'SOCKET_CREATE_FAILED',reason:error.message,at:this.now()};this.schedule(token);return;}
    this.socket=socket;const ctx={socket,token,closed:false,pending:new Map(),acked:new Set(),ackTimes:new Map(),lastData:new Map(),baseline:new Set(),candles:new Map(),ackTimer:null,heartbeatTimer:null};this.context=ctx;
    const current=()=>token===this.generation&&this.context===ctx&&!ctx.closed;
    const fail=(code,error)=>{if(!current())return;this.lastError={code,reason:String(error?.message||error),at:this.now()};this.lastDisconnect=this.lastError;this.setStatus('failed');this.release(ctx);try{socket.close(1000,'transport recovery');}catch{}this.schedule(token);};
    const transportAlive=()=>{clearTimeout(ctx.heartbeatTimer);ctx.heartbeatTimer=setTimeout(()=>fail('HEARTBEAT_TIMEOUT','Kraken transport silent'),this.heartbeatTimeoutMs);};
    ctx.ackTimer=setTimeout(()=>fail('CONNECT_TIMEOUT','Kraken connection timeout'),this.ackTimeoutMs);
    socket.addEventListener('open',()=>{
      if(!current())return;this.connectedAt=this.now();this.lastMessageAt=null;this.lastPriceAt=null;this.lastHeartbeatAt=null;this.lastCandleAt=null;this.setStatus('subscribing');clearTimeout(ctx.ackTimer);
      try{this.topics.forEach((symbol,index)=>{const id=index+1;ctx.pending.set(id,symbol);socket.send(JSON.stringify({method:'subscribe',params:{channel:this.channel,symbol:[symbol],snapshot:true,...(this.interval?{interval:this.interval}:{})},req_id:id}));});}
      catch(error){fail('SUBSCRIBE_SEND_FAILED',error);return;}
      ctx.ackTimer=setTimeout(()=>fail('ACK_TIMEOUT','Kraken subscription ACK timeout'),this.ackTimeoutMs);transportAlive();
    });
    socket.addEventListener('message',message=>{
      if(!current())return;
      try{
        const text=typeof message.data==='string'?message.data:Buffer.from(message.data).toString('utf8');if(Buffer.byteLength(text)>1048576)throw Error('Kraken frame too large');
        const p=JSON.parse(text);this.lastMessageAt=this.now();this.messageCount++;transportAlive();this.refresh();
        if(p.channel==='heartbeat'){this.lastHeartbeatAt=this.now();this.heartbeatCount++;return;}
        if(p.channel==='status'){if(p.data?.[0]?.system!=='online')fail('SYSTEM_UNAVAILABLE','Kraken system not online');return;}
        if(p.method==='subscribe'){
          const symbol=ctx.pending.get(p.req_id);
          if(!symbol||p.success!==true||p.result?.channel!==this.channel||p.result.symbol!==symbol||p.result.snapshot!==true||this.interval&&p.result.interval!==this.interval){fail('SUBSCRIBE_REJECTED',p.error||'Kraken ACK identity mismatch');return;}
          ctx.pending.delete(p.req_id);ctx.acked.add(symbol);ctx.ackTimes.set(symbol,this.now());if(!ctx.pending.size)clearTimeout(ctx.ackTimer);return;
        }
        if(p.channel!==this.channel)return;
        if(!['snapshot','update'].includes(p.type)||!Array.isArray(p.data)||p.data.length>10000)throw Error('Invalid Kraken data frame');
        if(p.type==='snapshot')this.owner.snapshots++;
        const rows=p.data.filter(row=>this.markets.has(row.symbol)&&ctx.acked.has(row.symbol));
        if(this.channel==='trade'){
          const trades=rows.map(row=>{const id=tradeId(row.trade_id),price=numeric(row.price),qty=numeric(row.qty),timestamp=stamp(row.timestamp);if(id===null||!(price>0)||!(qty>0)||!Number.isFinite(timestamp))throw Error('Malformed Kraken trade');return {...row,id,price,qty,time:timestamp};});
          // Kraken trade_id is a per-book sequence; timestamps are not dedup keys.
          trades.sort((a,b)=>a.symbol.localeCompare(b.symbol)||(BigInt(a.id)<BigInt(b.id)?-1:BigInt(a.id)>BigInt(b.id)?1:0));
          for(const row of trades){
            if(!current())return;const identity=this.identity(row.symbol),key=`${identity.marketId}:${row.id}`;
            if(this.owner.seen.has(key)){this.owner.duplicates++;continue;}this.owner.seen.set(key,true);if(this.owner.seen.size>50000)this.owner.seen.delete(this.owner.seen.keys().next().value);
            if(p.type==='snapshot')continue;
            const previous=this.owner.watermarks.get(identity.marketId);
            if(previous!==undefined&&BigInt(row.id)<=previous){this.owner.outOfOrder++;continue;}
            this.owner.watermarks.set(identity.marketId,BigInt(row.id));
            if(this.now()-row.time>this.staleAfterMs||row.time>this.now()+5000){ctx.baseline.delete(row.symbol);this.setStatus('stale');continue;}
            const gap=previous!==undefined&&BigInt(row.id)>previous+1n;
            if(!ctx.baseline.has(row.symbol)||gap||this.now()-(ctx.lastData.get(row.symbol)??this.now())>this.staleAfterMs){this.handlers.onBaselineReset?.(identity);ctx.baseline.add(row.symbol);this.owner.baselineResets++;}
            ctx.lastData.set(row.symbol,this.now());this.lastPriceAt=this.now();this.lastPrice=row.price;this.priceMessageCount++;this.attempt=0;this.refresh();
            this.handlers.onEvent?.({...identity,eventType:'ticker',price:row.price,size:row.qty,tradeId:row.id,sourceTimestamp:row.timestamp,timestamp:row.time});
          }
        }else{
          for(const row of rows){
            if(!current())return;if(row.interval!==this.interval)throw Error('Kraken OHLC interval mismatch');
            const begin=stamp(row.interval_begin),candle=normalize([begin/1000,row.open,row.high,row.low,row.close,row.vwap,row.volume,row.trades]);
            if(!Number.isSafeInteger(row.trades)||row.trades<0)throw Error('Invalid Kraken trade count');
            if(p.type==='snapshot'||begin>this.now()||begin+this.interval*60000<=this.now())continue;
            const previous=ctx.candles.get(row.symbol);
            if(previous&&(begin<previous.begin||begin===previous.begin&&(row.trades<previous.trades||row.trades===previous.trades&&candle.close===previous.close&&candle.volume===previous.volume)))continue;
            ctx.candles.set(row.symbol,{begin,trades:row.trades,close:candle.close,volume:candle.volume});ctx.lastData.set(row.symbol,this.now());this.lastCandleAt=this.now();this.attempt=0;this.refresh();
            // Movement uses open/close only. Retain real base-volume metadata for
            // Core's candle shape, but NEVER supply a quote-volume average.
            this.handlers.onEvent?.({...this.identity(row.symbol),eventType:'candle',interval:Object.keys(intervalMap).find(key=>intervalMap[key]===this.interval).replace('24h','1d'),price:candle.close,open:candle.open,high:candle.high,low:candle.low,volume:candle.volume,baseVolume:candle.volume,volumeUnit:'base',quoteVolume:null,averageVolume:null,openTime:begin,provisional:true,timestamp:this.now()});
          }
        }
      }catch(error){fail('MALFORMED_FRAME',error);}
    });
    socket.addEventListener('error',error=>fail('SOCKET_ERROR',error?.message||'Kraken WebSocket error'));
    socket.addEventListener('close',event=>{if(!current())return;this.lastDisconnect={code:event?.code??null,reason:String(event?.reason||'connection closed'),at:this.now()};this.release(ctx);this.schedule(token);});
  }
  diagnostics(){const base=super.diagnostics();return {...base,channel:this.channel,interval:this.interval,lastHeartbeatAt:this.lastHeartbeatAt,lastTradeAt:this.lastPriceAt,lastCandleAt:this.lastCandleAt,requestedSubscriptions:this.topics.map(symbol=>({channel:this.channel,symbol,nativeSymbol:this.markets.get(symbol).nativeSymbol,interval:this.interval})),confirmedSubscriptions:[...(this.context?.acked||[])].map(symbol=>({channel:this.channel,symbol,interval:this.interval}))};}
}

class KrakenMarketTransport {
  constructor(options={}){
    this.options={...options,reconnectBaseMs:options.reconnectBaseMs??5000,reconnectMaxMs:options.reconnectMaxMs??60000};this.now=options.now||Date.now;
    this.registry=options.registry||new KrakenBrowserAdapter({fetchImpl:options.fetchImpl||globalThis.fetch,now:this.now});this.channels=[];this.generation=0;this.status='idle';this.seen=new Map();this.watermarks=new Map();this.duplicates=0;this.outOfOrder=0;this.snapshots=0;this.baselineResets=0;this.lastError=null;
  }
  async validateAlert(alert,definition=alert){
    if(alert.exchange!=='kraken'||alert.marketType!=='spot'||!['price','movement'].includes(alert.type)||alert.type!==alert.condition?.type)return {error:'UNSUPPORTED_ALERT_TYPE',message:'Kraken supports Spot price and candle-relative movement alerts. Quote-volume alerts are unavailable.'};
    if(alert.type==='movement'&&!Object.hasOwn(intervalMap,alert.condition.window))return {error:'UNSUPPORTED_INTERVAL',message:'Unsupported Kraken movement window.'};
    if(definition.marketType&&definition.marketType!=='spot'||definition.marketId&&definition.marketId!==alert.marketId||alert.marketId!==`kraken:spot:${alert.symbol}`)return {error:'INVALID_MARKET',message:'Exact Kraken native Spot identity is required.'};
    try{const mapping=await this.registry.catalog(),row=mapping.byNative.get(alert.symbol);if(!row||row.baseAsset!==alert.baseAsset||row.quoteAsset!==alert.quoteAsset)return {error:'UNSUPPORTED_MARKET',message:'Kraken market is unavailable or not in the admitted mapping registry.'};}
    catch{return {error:'MARKET_UNAVAILABLE',message:'Kraken public market validation unavailable. Retry later.'};}return null;
  }
  async start(alerts,handlers={}){
    const token=this.generation+1;await this.stop();if(token!==this.generation)return;this.handlers=handlers;if(!alerts.length)return;this.status='connecting';handlers.onStatus?.(this.status);
    for(const alert of alerts){const error=await this.validateAlert(alert);if(token!==this.generation)return;if(error){this.lastError=error;this.status='failed';handlers.onStatus?.(this.status);return;}}
    const mapping=await this.registry.catalog();if(token!==this.generation)return;const groups=new Map();
    for(const alert of alerts){const channel=alert.type==='price'?'trade':'ohlc',interval=channel==='ohlc'?intervalMap[alert.condition.window]:null,key=`${channel}:${interval??''}`;if(!groups.has(key))groups.set(key,{channel,interval,markets:new Map()});const row=mapping.byNative.get(alert.symbol);groups.get(key).markets.set(row.wsSymbol,row);}
    this.channels=[...groups.values()].map(group=>new KrakenChannelTransport({...this.options,...group,owner:this}));
    await Promise.all(this.channels.map(channel=>channel.start([],{onEvent:event=>{if(token===this.generation)handlers.onEvent?.(event);},onBaselineReset:event=>{if(token===this.generation)handlers.onBaselineReset?.(event);},onStatus:()=>{if(token===this.generation){this.status=this.diagnostics().status;handlers.onStatus?.(this.status);}}})));
  }
  async stop(){this.generation++;await Promise.all(this.channels.map(channel=>channel.stop()));this.channels=[];this.status='idle';}
  diagnostics(){
    const channels=this.channels.map(c=>c.diagnostics()),status=channels.length?channels.every(c=>c.status==='live')?'live':channels.some(c=>c.status==='stale')?'stale':channels.some(c=>c.status==='failed')?'failed':channels.some(c=>c.status==='reconnecting')?'reconnecting':channels.some(c=>c.status==='connecting')?'connecting':'subscribing':this.status;
    const latest=key=>Math.max(0,...channels.map(c=>c[key]||0))||null;
    return {status,connections:channels.reduce((n,c)=>n+c.connections,0),subscriptions:channels.reduce((n,c)=>n+c.subscriptions,0),requestedSubscriptions:channels.flatMap(c=>c.requestedSubscriptions),confirmedSubscriptions:channels.flatMap(c=>c.confirmedSubscriptions),acknowledgedSubscriptions:channels.reduce((n,c)=>n+c.acknowledgedSubscriptions,0),requestedOHLCSubscriptions:channels.filter(c=>c.channel==='ohlc').flatMap(c=>c.requestedSubscriptions),acknowledgedIntervals:channels.filter(c=>c.channel==='ohlc').flatMap(c=>c.confirmedSubscriptions),lastMessageAt:latest('lastMessageAt'),lastHeartbeatAt:latest('lastHeartbeatAt'),lastTradeAt:latest('lastTradeAt'),lastPriceAt:latest('lastTradeAt'),lastCandleAt:latest('lastCandleAt'),reconnectCount:channels.reduce((n,c)=>n+c.reconnectCount,0),lastDisconnect:channels.map(c=>c.lastDisconnect).filter(Boolean).sort((a,b)=>b.at-a.at)[0]||null,lastError:channels.map(c=>c.lastError).find(Boolean)||this.lastError,duplicates:this.duplicates,outOfOrder:this.outOfOrder,snapshots:this.snapshots,baselineResets:this.baselineResets,channels};
  }
}
module.exports={KrakenMarketTransport,KrakenChannelTransport,intervalMap};
