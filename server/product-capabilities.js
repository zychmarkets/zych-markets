'use strict';
// Product scope is not runtime health or Radar coverage. Never use this matrix
// as the expected-exchange denominator in Radar ingestion/readiness.
const {exchanges}=require('../js/services/exchange-workspace');
const {EXCHANGES:radarExchanges}=require('./radar/event-schema');
const kraken=require('../js/exchanges/kraken-public');
const coinbase=require('../js/exchanges/coinbase-public');
const krakenChart=require('../js/exchanges/kraken-chart');
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
module.exports={productCapabilities};
