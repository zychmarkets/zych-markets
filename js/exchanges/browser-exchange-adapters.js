(function (global) {
  'use strict';
  const data=global.ZychMarketsData||(typeof require==='function'?require('../services/markets-data.js'):null);
  const timeoutFetch = async (url, signal, timeout = 10000, fetchImpl=global.fetch) => {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(new DOMException('Request timed out', 'TimeoutError')), timeout), abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    if(signal?.aborted)abort();
    try { const response = await fetchImpl(url, { signal: controller.signal }); if (!response.ok) throw new Error(`Market HTTP ${response.status}`); return await response.json(); }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  };
  const market = (exchange, symbol, baseAsset, quoteAsset, status = 'TRADING') => {const normalized=global.ZychInstruments?.normalize?.({exchange,marketType:'spot',symbol,baseAsset,quoteAsset,enabled:true,status});return normalized||{id:`${exchange}:spot:${symbol}`,marketId:`${exchange}:spot:${symbol}`,exchange,marketType:'spot',symbol,nativeSymbol:symbol,displaySymbol:`${baseAsset}/${quoteAsset}`,baseAsset,quoteAsset,asset:baseAsset,enabled:true,status}};
  const snapshot = (price, change24h, change, high, low, quoteVolume24h, snapshotTimestamp, receivedAt) => data.snapshot({price,change24h,change,high,low,quoteVolume24h,snapshotTimestamp,receivedAt});
  const candle = row => ({ time: Math.floor(Number(row[0]) / 1000), open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]), volume: Number(row[5]) });
  const binanceInterval = Object.freeze({ '1m':'1m','5m':'5m','15m':'15m','30m':'30m','1h':'1h','4h':'4h','1d':'1d','1w':'1w','1M':'1M' });
  const bybitInterval = Object.freeze({ '1m': '1', '5m': '5', '15m': '15', '30m': '30', '1h': '60', '4h': '240', '1d': 'D', '1w': 'W', '1M':'M' });
  const okxInterval = Object.freeze({ '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1H', '4h': '4H', '1d': '1D', '1w': '1W', '1M':'1M' });
  const bingxPair = row => {
    const symbol=typeof row?.symbol==='string'?row.symbol:'',parts=symbol.match(/^([A-Z0-9]+)-([A-Z0-9]+)$/),baseAsset=typeof row?.baseAsset==='string'?row.baseAsset:parts?.[1],quoteAsset=typeof row?.quoteAsset==='string'?row.quoteAsset:parts?.[2];
    return parts&&baseAsset&&quoteAsset?{symbol,baseAsset,quoteAsset}:null;
  };
  const bingxPercent = value => {
    if(typeof value==='string'&&value.trim().endsWith('%'))return data.number(value.trim().slice(0,-1));
    return data.number(value);
  };
  const bingxInterval = Object.freeze({...binanceInterval});
  const bingxWsInterval = Object.freeze({...bingxInterval,'1m':'1min','5m':'5min','15m':'15min','30m':'30min'});
  const bingxCandle = row => {
    if(!Array.isArray(row))return null;
    const values=row.slice(0,6).map(data.number);
    if(values.length!==6||values.some(value=>value===null))return null;
    const [openTime,open,high,low,close,volume]=values,closeTime=data.number(row[6]),quoteVolume=data.number(row[7]);
    if(!Number.isSafeInteger(openTime)||openTime<=0||Math.min(open,high,low,close)<=0||volume<0||low>Math.min(open,close)||high<Math.max(open,close)||closeTime!==null&&closeTime<openTime||quoteVolume!==null&&quoteVolume<0)return null;
    return {time:Math.floor(openTime/1000),open,high,low,close,volume,closeTime,quoteVolume};
  };
  async function decodeBingxFrame(value) {
    if(typeof value==='string'){if(value.length>1048576)throw new Error('BingX frame too large');return value;}
    if(typeof global.DecompressionStream!=='function')throw new Error('BingX GZIP is unavailable in this browser');
    const blob=value instanceof Blob?value:new Blob([value]);
    if(blob.size>1048576)throw new Error('BingX frame too large');
    const reader=blob.stream().pipeThrough(new global.DecompressionStream('gzip')).getReader(),decoder=new TextDecoder();let result='',size=0;
    try{while(true){const {done,value:chunk}=await reader.read();if(done)break;size+=chunk.byteLength;if(size>1048576){await reader.cancel();throw new Error('BingX decoded frame too large');}result+=decoder.decode(chunk,{stream:true});}return result+decoder.decode();}finally{reader.releaseLock();}
  }

  class BinanceBrowserAdapter {
    constructor({ restBase = 'https://api.binance.com/api/v3', wsBase = 'wss://stream.binance.com:9443/ws', fetchImpl=global.fetch, now=Date.now } = {}) { this.id = 'binance'; this.restBase = restBase; this.wsBase = wsBase;this.fetchImpl=fetchImpl;this.now=now; }
    async discover(signal) { const value = await timeoutFetch(`${this.restBase}/exchangeInfo`, signal,10000,this.fetchImpl); return value.symbols.filter(row => row.status === 'TRADING' && row.isSpotTradingAllowed !== false).map(row => market(this.id, row.symbol, row.baseAsset, row.quoteAsset, row.status)); }
    normalizeTicker(row,receivedAt=this.now()){return snapshot(row.lastPrice,row.priceChangePercent,row.priceChange,row.highPrice,row.lowPrice,row.quoteVolume,row.closeTime,receivedAt)}
    async allSnapshots(signal) { const receivedAt=this.now(),rows = await timeoutFetch(`${this.restBase}/ticker/24hr`, signal,10000,this.fetchImpl); return rows.map(row => ({ marketId: `${this.id}:spot:${row.symbol}`, symbol: row.symbol, ...this.normalizeTicker(row,receivedAt) })); }
    async snapshots(markets, signal) { const receivedAt=this.now(),symbols = markets.map(item => item.symbol), rows = await timeoutFetch(`${this.restBase}/ticker/24hr?symbols=${encodeURIComponent(JSON.stringify(symbols))}`, signal,10000,this.fetchImpl); return Object.fromEntries(rows.map(row => [`${this.id}:spot:${row.symbol}`, this.normalizeTicker(row,receivedAt)])); }
    async candles(marketValue, timeframe, endTime, limit, signal) { const interval=binanceInterval[timeframe];if(!interval)throw new Error('Unsupported Binance interval');const end = Number.isFinite(endTime) ? `&endTime=${Math.floor(endTime)}` : ''; const rows = await timeoutFetch(`${this.restBase}/klines?symbol=${encodeURIComponent(marketValue.symbol)}&interval=${encodeURIComponent(interval)}&limit=${limit}${end}`, signal); return rows.map(candle); }
    socket(marketValue, timeframe, handlers) { const interval=binanceInterval[timeframe],socket = new WebSocket(`${this.wsBase}/${marketValue.symbol.toLowerCase()}@kline_${interval}`); socket.addEventListener('open', handlers.open); socket.addEventListener('close', handlers.close); socket.addEventListener('error', handlers.error); socket.addEventListener('message', event => { try { const row = JSON.parse(event.data).k; if (row) handlers.candle({ time: Math.floor(row.t / 1000), open: +row.o, high: +row.h, low: +row.l, close: +row.c, volume: +row.v }); } catch (error) { handlers.error(error); } }); return socket; }
  }

  class BybitBrowserAdapter {
    constructor({ restBase = 'https://api.bybit.com/v5/market', wsBase = 'wss://stream.bybit.com/v5/public/spot', fetchImpl=global.fetch, now=Date.now } = {}) { this.id = 'bybit'; this.restBase = restBase; this.wsBase = wsBase;this.fetchImpl=fetchImpl;this.now=now; }
    unwrap(value) { if (Number(value?.retCode) !== 0 || !value?.result) throw new Error(`Bybit API ${value?.retCode ?? 'invalid'}`); return value.result; }
    async discover(signal) { const result = this.unwrap(await timeoutFetch(`${this.restBase}/instruments-info?category=spot&limit=1000`, signal)); return (result.list || []).filter(row => row.status === 'Trading').map(row => market(this.id, row.symbol, row.baseCoin, row.quoteCoin, row.status)); }
    normalizeTicker(row,receivedAt=this.now()) { const last=data.number(row.lastPrice),previous=data.number(row.prevPrice24h),provided=data.number(row.price24hPcnt),change=last!==null&&previous!==null?last-previous:null,change24h=provided===null?data.percent(last,previous):provided*100; return snapshot(last,change24h,change,row.highPrice24h,row.lowPrice24h,row.turnover24h,null,receivedAt); }
    async allSnapshots(signal) { const value=await timeoutFetch(`${this.restBase}/tickers?category=spot`, signal,10000,this.fetchImpl),receivedAt=data.timestamp(value.time,this.now()),result = this.unwrap(value); return (result.list || []).map(row => ({ marketId: `${this.id}:spot:${row.symbol}`, symbol: row.symbol, ...this.normalizeTicker(row,receivedAt) })); }
    async snapshots(markets, signal) { const value=await timeoutFetch(`${this.restBase}/tickers?category=spot`, signal,10000,this.fetchImpl),receivedAt=data.timestamp(value.time,this.now()),result = this.unwrap(value), wanted = new Map(markets.map(item => [item.symbol, item.id])); return Object.fromEntries((result.list || []).filter(row => wanted.has(row.symbol)).map(row => [wanted.get(row.symbol), this.normalizeTicker(row,receivedAt)])); }
    async candles(marketValue, timeframe, endTime, limit, signal) { const interval = bybitInterval[timeframe]; if (!interval) throw new Error('Unsupported Bybit interval'); const end = Number.isFinite(endTime) ? `&end=${Math.floor(endTime)}` : ''; const result = this.unwrap(await timeoutFetch(`${this.restBase}/kline?category=spot&symbol=${encodeURIComponent(marketValue.symbol)}&interval=${interval}&limit=${Math.min(1000, limit)}${end}`, signal)); return (result.list || []).map(candle).sort((a, b) => a.time - b.time); }
    socket(marketValue, timeframe, handlers) { const interval = bybitInterval[timeframe]; const socket = new WebSocket(this.wsBase); socket.addEventListener('open', () => { socket.send(JSON.stringify({ op: 'subscribe', args: [`kline.${interval}.${marketValue.symbol}`] })); handlers.open(); }); socket.addEventListener('close', handlers.close); socket.addEventListener('error', handlers.error); socket.addEventListener('message', event => { try { const payload = JSON.parse(event.data); if (!String(payload.topic || '').startsWith('kline.')) return; const row = payload.data?.[0]; if (row) handlers.candle({ time: Math.floor(Number(row.start) / 1000), open: +row.open, high: +row.high, low: +row.low, close: +row.close, volume: +row.volume }); } catch (error) { handlers.error(error); } }); return socket; }
  }

  class OkxBrowserAdapter {
    constructor({ restBase = 'https://www.okx.com/api/v5', wsBase = 'wss://ws.okx.com:8443/ws/v5/business', fetchImpl=global.fetch, now=Date.now } = {}) { this.id = 'okx'; this.restBase = restBase; this.wsBase = wsBase;this.fetchImpl=fetchImpl;this.now=now; }
    unwrap(value) { if (String(value?.code) !== '0' || !Array.isArray(value?.data)) throw new Error(`OKX API ${value?.code ?? 'invalid'}`); return value.data; }
    async discover(signal) { const rows = this.unwrap(await timeoutFetch(`${this.restBase}/public/instruments?instType=SPOT`, signal)); return rows.filter(row => row.state === 'live').map(row => market(this.id, row.instId, row.baseCcy, row.quoteCcy, row.state)); }
    normalizeTicker(row,receivedAt=this.now()) { const last=data.number(row.last),open=data.number(row.open24h),change=last!==null&&open!==null?last-open:null; return snapshot(last,data.percent(last,open),change,row.high24h,row.low24h,row.volCcy24h,row.ts,receivedAt); }
    async allSnapshots(signal) { const rows = this.unwrap(await timeoutFetch(`${this.restBase}/market/tickers?instType=SPOT`, signal,10000,this.fetchImpl)); return rows.map(row => ({ marketId: `${this.id}:spot:${row.instId}`, symbol: row.instId, ...this.normalizeTicker(row) })); }
    async snapshots(markets, signal) { const rows = this.unwrap(await timeoutFetch(`${this.restBase}/market/tickers?instType=SPOT`, signal,10000,this.fetchImpl)), wanted = new Map(markets.map(item => [item.symbol, item.id])); return Object.fromEntries(rows.filter(row => wanted.has(row.instId)).map(row => [wanted.get(row.instId), this.normalizeTicker(row)])); }
    async candles(marketValue, timeframe, endTime, limit, signal) { const bar = okxInterval[timeframe]; if (!bar) throw new Error('Unsupported OKX interval'); const result = new Map(); let cursor = Number.isFinite(endTime) ? Math.floor(endTime) : null; while (result.size < limit) { const pageSize = Math.min(300, limit - result.size), after = Number.isFinite(cursor) ? `&after=${cursor}` : '', rows = this.unwrap(await timeoutFetch(`${this.restBase}/market/candles?instId=${encodeURIComponent(marketValue.symbol)}&bar=${bar}&limit=${pageSize}${after}`, signal)); rows.map(candle).forEach(item => result.set(item.time, item)); if (rows.length < pageSize) break; const oldest = Math.min(...rows.map(row => Number(row[0]))); if (!Number.isFinite(oldest) || oldest === cursor) break; cursor = oldest; } return [...result.values()].sort((a, b) => a.time - b.time); }
    socket(marketValue, timeframe, handlers) { const bar = okxInterval[timeframe], socket = new WebSocket(this.wsBase); socket.addEventListener('open', () => { socket.send(JSON.stringify({ op: 'subscribe', args: [{ channel: `candle${bar}`, instId: marketValue.symbol }] })); handlers.open(); }); socket.addEventListener('close', handlers.close); socket.addEventListener('error', handlers.error); socket.addEventListener('message', event => { try { const payload = JSON.parse(event.data); if (payload.arg?.channel !== `candle${bar}` || payload.arg?.instId !== marketValue.symbol) return; const row = payload.data?.[0]; if (row) handlers.candle(candle(row)); } catch (error) { handlers.error(error); } }); return socket; }
  }
  class BingxBrowserAdapter {
    constructor({ restBase = 'https://open-api.bingx.com', historyBase='https://open-api.bingx.com', wsBase='wss://open-api-ws.bingx.com/market', catalogPath='/openApi/spot/v1/common/symbols', tickerPath='/openApi/spot/v1/ticker/24hr', fetchImpl=global.fetch, socketFactory=url=>new global.WebSocket(url), decodeFrame=decodeBingxFrame, ackTimeoutMs=15000, heartbeatTimeoutMs=45000, now=Date.now } = {}) { this.id='bingx';this.requiresSubscriptionAck=true;Object.assign(this,{restBase,historyBase,wsBase,catalogPath,tickerPath,fetchImpl,socketFactory,decodeFrame,ackTimeoutMs,heartbeatTimeoutMs,now}); }
    unwrap(value,key) { if(Number(value?.code)!==0)throw new Error(`BingX API ${value?.code??'invalid'}`);const rows=key?value?.data?.[key]:value?.data;if(!Array.isArray(rows))throw new Error('BingX API malformed response');return rows; }
    async request(path,signal) { const url=`${this.restBase}${path}`;try{return await timeoutFetch(url,signal,10000,this.fetchImpl)}catch(error){global.console?.warn?.('bingx_browser_request_failed',JSON.stringify({url,method:'GET',name:error?.name||'Error',message:error?.message||String(error)}));throw error} }
    async discover(signal) { const rows=this.unwrap(await this.request(this.catalogPath,signal),'symbols'),markets=rows.filter(row=>Number(row.status)===1&&row.apiStateBuy===true&&row.apiStateSell===true).map(row=>{const pair=bingxPair(row);return pair?market(this.id,pair.symbol,pair.baseAsset,pair.quoteAsset,row.status):null}).filter(Boolean);return [...new Map(markets.map(item=>[item.id,item])).values()]; }
    normalizeTicker(row,receivedAt=this.now()) { return snapshot(row?.lastPrice,bingxPercent(row?.priceChangePercent),row?.priceChange,row?.highPrice,row?.lowPrice,row?.quoteVolume,row?.closeTime,receivedAt); }
    async allSnapshots(signal) { const receivedAt=this.now(),rows=this.unwrap(await this.request(this.tickerPath,signal)),snapshots=rows.filter(row=>bingxPair(row)).map(row=>({marketId:`${this.id}:spot:${row.symbol}`,symbol:row.symbol,...this.normalizeTicker(row,receivedAt)}));return [...new Map(snapshots.map(item=>[item.marketId,item])).values()]; }
    async snapshots(markets,signal) { const rows=await this.allSnapshots(signal),wanted=new Map(markets.map(item=>[item.symbol,item.id]));return Object.fromEntries(rows.filter(row=>wanted.has(row.symbol)).map(row=>[wanted.get(row.symbol),(({marketId,symbol,...value})=>value)(row)])); }
    validateChart(marketValue,timeframe) {if(marketValue?.exchange!=='bingx'||marketValue?.marketType!=='spot'||!bingxPair(marketValue))throw new Error('Invalid BingX Spot market');if(!bingxInterval[timeframe])throw new Error(`Unsupported BingX interval: ${timeframe}`);}
    async candles(marketValue,timeframe,endTime,limit=1000,signal,startTime) {
      this.validateChart(marketValue,timeframe);
      if(!Number.isInteger(limit)||limit<1)throw new Error('Invalid BingX candle limit');
      const params=new URLSearchParams({symbol:marketValue.symbol,interval:bingxInterval[timeframe],limit:String(Math.min(1440,limit))});
      if(Number.isFinite(endTime))params.set('endTime',String(Math.floor(endTime)));
      if(Number.isFinite(startTime))params.set('startTime',String(Math.floor(startTime)));
      const path=this.historyBase.startsWith('/')?'/candles':'/openApi/spot/v2/market/kline';
      const rows=this.unwrap(await timeoutFetch(`${this.historyBase}${path}?${params}`,signal,10000,this.fetchImpl));
      const normalized=rows.map(bingxCandle);
      if(normalized.some(row=>!row))throw new Error('BingX malformed candle');
      return [...new Map(normalized.map(row=>[row.time,row])).values()].sort((a,b)=>a.time-b.time);
    }
    socket(marketValue,timeframe,handlers) {
      this.validateChart(marketValue,timeframe);
      if(this.decodeFrame===decodeBingxFrame&&typeof global.DecompressionStream!=='function')throw new Error('BingX GZIP is unavailable in this browser');
      const socket=this.socketFactory(this.wsBase),id=global.crypto.randomUUID(),topic=`${marketValue.symbol}@kline_${bingxWsInterval[timeframe]}`;
      socket.binaryType='arraybuffer';
      let closed=false,verified=false,ackTimer=null,heartbeatTimer=null,queue=Promise.resolve(),pending=0,lastTime=-Infinity;
      const active=()=>!closed&&socket.readyState===1;
      const cleanup=()=>{closed=true;clearTimeout(ackTimer);clearTimeout(heartbeatTimer);};
      const close=socket.close.bind(socket);socket.close=(...args)=>{cleanup();return close(...args);};
      const fail=error=>{if(closed)return;cleanup();handlers.error(error);close();};
      const heartbeat=()=>{clearTimeout(heartbeatTimer);heartbeatTimer=setTimeout(()=>fail(new Error('BingX heartbeat timeout')),this.heartbeatTimeoutMs);};
      const verify=()=>{if(!verified){verified=true;clearTimeout(ackTimer);handlers.status?.('LIVE');}};
      socket.addEventListener('open',()=>{if(!active())return;handlers.open?.();handlers.status?.('SUBSCRIBING');socket.send(JSON.stringify({id,reqType:'sub',dataType:topic}));ackTimer=setTimeout(()=>fail(new Error('BingX subscription timeout')),this.ackTimeoutMs);heartbeat();});
      socket.addEventListener('close',event=>{cleanup();handlers.close?.(event);});
      socket.addEventListener('error',()=>fail(new Error('BingX WebSocket error')));
      socket.addEventListener('message',event=>{
        if(!active())return;
        if(++pending>64){fail(new Error('BingX message queue overflow'));return;}
        queue=queue.then(async()=>{
          if(!active())return;
          const text=await this.decodeFrame(event.data);if(!active())return;
          if(text==='Ping'||text==='ping'){heartbeat();socket.send('Pong');return;}
          const payload=JSON.parse(text);
          if(!payload||typeof payload!=='object')throw new Error('BingX malformed message');
          if(!payload.dataType&&Object.hasOwn(payload,'ping')){heartbeat();socket.send('Pong');return;}
          if(Object.hasOwn(payload,'id')){
            if(payload.id!==id)return;
            if(payload.code!==0)throw new Error(`BingX subscription rejected: ${payload.code}`);
            heartbeat();verify();return;
          }
          if(payload.dataType!==topic)return;
          if(Object.hasOwn(payload,'code')&&payload.code!==0)throw new Error(`BingX data rejected: ${payload.code}`);
          if(payload.data?.s&&payload.data.s!==marketValue.symbol)return;
          const row=payload.data?.K,value=bingxCandle(row&&[row.t,row.o,row.h,row.l,row.c,row.v,row.T,row.q]);
          if(!value)throw new Error('BingX malformed live candle');
          if(value.time<lastTime)return;
          lastTime=value.time;heartbeat();verify();handlers.candle(value);
        }).catch(fail).finally(()=>{pending-=1;});
      });
      return socket;
    }
  }
  const api={ BinanceBrowserAdapter, BybitBrowserAdapter, OkxBrowserAdapter, BingxBrowserAdapter, binanceInterval, bybitInterval, okxInterval, bingxInterval, bingxWsInterval, bingxCandle, decodeBingxFrame, bingxPair, bingxPercent, market };
  if(typeof module==='object'&&module.exports)module.exports=api;else global.ZychExchanges={...api,adapters:{ binance: new BinanceBrowserAdapter(), bybit: new BybitBrowserAdapter(), okx: new OkxBrowserAdapter(), bingx: new BingxBrowserAdapter({restBase:'/api/markets/bingx',historyBase:'/api/markets/bingx',catalogPath:'/catalog',tickerPath:'/tickers'}) }};
})(typeof window!=='undefined'?window:globalThis);
