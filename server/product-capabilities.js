'use strict';
// Product scope is not runtime health or Radar coverage. Never use this matrix
// as the expected-exchange denominator in Radar ingestion/readiness.
const {exchanges}=require('../js/services/exchange-workspace');
const {EXCHANGES:radarExchanges}=require('./radar/event-schema');
const kraken=require('../js/exchanges/kraken-public');
const coinbase=require('../js/exchanges/coinbase-public');
const krakenChart=require('../js/exchanges/kraken-chart');
const coinbaseChart=require('../js/exchanges/coinbase-chart');
const {binanceInterval,bybitInterval,okxInterval,bingxInterval}=require('../js/exchanges/browser-exchange-adapters');
const {capability}=require('../js/services/reliability-contract');
function productCapabilities(){
  return {
    productExchanges:[...exchanges],
    radarSupportedExchanges:[...radarExchanges],
    exchanges:Object.fromEntries(exchanges.map(exchange=>{
      const contract=exchange==='kraken'?kraken.capabilities:exchange==='coinbase'?coinbase.capabilities:null;
      const exactQuoteVolume24h=contract?.exactQuoteVolume24h!==false;
      return [exchange,{
        catalog:'SUPPORTED',markets:exactQuoteVolume24h?'SUPPORTED':'LIMITED',search:'SUPPORTED',watchlist:'SUPPORTED',chart:exchange==='kraken'?'LIMITED':'SUPPORTED',
        alertTypes:[...(contract?.alertTypes||['price','movement','volume'])],
        exactQuoteVolume24h,
        radar:radarExchanges.includes(exchange)?'SUPPORTED':'RADAR-INELIGIBLE',
        radarExclusionReason:radarExchanges.includes(exchange)?null:'EXACT_QUOTE_VOLUME_UNAVAILABLE',
        diagnostics:'SUPPORTED',
        ...(exchange==='kraken'?{chartIntervals:Object.keys(krakenChart.intervals),unsupportedChartIntervals:['1M'],historyLimit:krakenChart.historyLimit,movementSemantics:'CURRENT_CANDLE_OPEN_TO_CURRENT_PRICE'}:{})
      }];
    }))
  };
}
// Additive canonical projection. The legacy matrix above remains byte-for-byte
// compatible; no transport or UI derives runtime state from these facts.
function normalizedProductCapabilities(){
  const legacy=productCapabilities(),frames=['1m','5m','15m','30m','1h','4h','1d','1w','1M'];
  const intervals={binance:binanceInterval,bybit:bybitInterval,okx:okxInterval,bingx:bingxInterval,coinbase:coinbaseChart.intervals,kraken:krakenChart.intervals};
  const fact=(state,reasonCode=null)=>capability({state,reasonCode});
  return {
    productExchanges:[...legacy.productExchanges],radarSupportedExchanges:[...legacy.radarSupportedExchanges],
    exchanges:Object.fromEntries(Object.entries(legacy.exchanges).map(([exchange,row])=>[exchange,{
      catalog:fact(row.catalog),search:fact(row.search),watchlist:fact(row.watchlist),
      snapshot:fact(row.markets,row.exactQuoteVolume24h?null:'EXACT_QUOTE_VOLUME_UNAVAILABLE'),
      chart:fact(row.chart,row.historyLimit?'HISTORY_WINDOW_LIMITED':null),
      history:fact(row.historyLimit?'LIMITED':'SUPPORTED',row.historyLimit?'HISTORY_WINDOW_LIMITED':null),
      chartIntervals:Object.fromEntries(frames.map(frame=>[frame,fact(Object.hasOwn(intervals[exchange],frame)?'SUPPORTED':'UNSUPPORTED',Object.hasOwn(intervals[exchange],frame)?null:'INTERVAL_UNSUPPORTED')])),
      alerts:Object.fromEntries(['price','movement','volume'].map(type=>[type,fact(row.alertTypes.includes(type)?'SUPPORTED':'UNSUPPORTED',row.alertTypes.includes(type)?null:type==='volume'?'EXACT_QUOTE_VOLUME_UNAVAILABLE':'ALERT_TYPE_UNSUPPORTED')])),
      exactQuoteVolume24h:fact(row.exactQuoteVolume24h?'SUPPORTED':'UNSUPPORTED',row.exactQuoteVolume24h?null:'EXACT_QUOTE_VOLUME_UNAVAILABLE'),
      radar:fact(row.radar==='SUPPORTED'?'SUPPORTED':'UNSUPPORTED',row.radar==='SUPPORTED'?null:'EXACT_LIQUIDITY_UNAVAILABLE')
    }]))
  };
}
module.exports={productCapabilities,normalizedProductCapabilities};
