'use strict';
const {candle,INTERVAL_MS}=require('./candle.js');
const identity=(market,timeframe,now)=>({marketId:market.marketId,exchange:market.exchange,marketType:market.marketType,symbol:market.symbol,timeframe,receivedAt:now});
// Candle semantics: Binance volume/base asset, quoteVolume/quote-asset turnover.
const binance=(market,timeframe,row,{now=Date.now(),closed=true}={})=>candle({...identity(market,timeframe,now),openTime:row[0],closeTime:row[6],open:row[1],high:row[2],low:row[3],close:row[4],volume:row[5],quoteVolume:row[7],isClosed:closed,sourceTimestamp:row[6]});
// Bybit Spot kline volume is base-coin volume; turnover is quote-coin turnover.
const bybit=(market,timeframe,row,{now=Date.now(),closed=true}={})=>candle({...identity(market,timeframe,now),openTime:row[0],closeTime:Number(row[0])+INTERVAL_MS[timeframe]-1,open:row[1],high:row[2],low:row[3],close:row[4],volume:row[5],quoteVolume:row[6],isClosed:closed,sourceTimestamp:Number(row[0])+INTERVAL_MS[timeframe]-1});
// OKX Spot candle vol is base-currency volume; volCcyQuote is quote-currency volume.
const okx=(market,timeframe,row,{now=Date.now()}={})=>candle({...identity(market,timeframe,now),openTime:row[0],closeTime:Number(row[0])+INTERVAL_MS[timeframe]-1,open:row[1],high:row[2],low:row[3],close:row[4],volume:row[5],quoteVolume:row[7],isClosed:String(row[8])==='1',sourceTimestamp:Number(row[0])+INTERVAL_MS[timeframe]-1});
function normalizeStream(exchange,market,timeframe,payload,now=Date.now()){if(exchange==='bingx'){const k=payload.data?.K,time=Number(payload.data?.E??payload.timestamp);if(!k||payload.data?.s!==market.symbol||k.s&&k.s!==market.symbol||k.i&&k.i!==({'1m':'1min','5m':'5min','15m':'15min'})[timeframe]||!Number.isSafeInteger(time)||time<=0)return null;return bingx(market,timeframe,[k.t,k.o,k.h,k.l,k.c,k.v,k.T,k.q],{now,closed:time>Number(k.T),sourceTimestamp:time})}if(exchange==='binance'){const k=payload.k||payload.data?.k;return k&&binance(market,timeframe,[k.t,k.o,k.h,k.l,k.c,k.v,k.T,k.q],{now,closed:k.x})}if(exchange==='bybit'){const row=payload.data?.[0];return row&&bybit(market,timeframe,[row.start,row.open,row.high,row.low,row.close,row.volume,row.turnover],{now,closed:Boolean(row.confirm)})}if(exchange==='okx'){const row=payload.data?.[0];return row&&okx(market,timeframe,row,{now})}return null}
const bingx=(market,timeframe,row,{now=Date.now(),closed=false,sourceTimestamp=row?.[6]}={})=>{
  if(market.exchange!=='bingx'||market.marketType!=='spot'||market.marketId!==`bingx:spot:${market.symbol}`||!Array.isArray(row)||row.length<8)throw new Error('Invalid BingX candle identity');
  const values=row.slice(0,8).map(value=>value==null||value===''?NaN:Number(value));
  if(!values.every(Number.isFinite)||values[0]<=0||values[6]<values[0]||Math.min(...values.slice(1,5))<=0||values[5]<0||values[7]<0||values[2]<Math.max(values[1],values[4],values[3])||values[3]>Math.min(values[1],values[4]))throw new Error('Invalid BingX candle values');
  return candle({...identity(market,timeframe,now),openTime:row[0],closeTime:row[6],open:row[1],high:row[2],low:row[3],close:row[4],volume:row[5],quoteVolume:row[7],isClosed:closed,sourceTimestamp});
};
module.exports={normalizeBinanceCandle:binance,normalizeBybitCandle:bybit,normalizeOkxCandle:okx,normalizeBingxCandle:bingx,normalizeStream};
