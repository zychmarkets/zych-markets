(function(global){
  'use strict';
  const exchanges=Object.freeze(['binance','bybit','okx','bingx','coinbase','kraken']);
  const validExchange=value=>exchanges.includes(value)?value:'binance';
  const marketForAsset=(markets,asset,exchange,quoteAsset='USDT')=>{const same=(markets||[]).filter(market=>market.enabled&&market.asset===asset&&market.exchange===exchange);return same.find(market=>market.quoteAsset===quoteAsset)||(exchange==='kraken'?null:same.find(market=>market.quoteAsset==='USDT')||same[0])||null};
  const unavailableMarket=(asset,exchange,quoteAsset='USDT')=>({id:`${exchange}:unavailable:${asset}:${quoteAsset}`,marketId:`${exchange}:unavailable:${asset}:${quoteAsset}`,asset,baseAsset:asset,quoteAsset,exchange,symbol:'',enabled:false,unavailable:true,status:'unavailable'});
  const equivalentMarket=(markets,current,exchange)=>current.exchange==='kraken'?(markets||[]).find(market=>market.enabled&&market.exchange===exchange&&market.asset===current.asset&&market.quoteAsset===current.quoteAsset)||null:marketForAsset(markets,current.asset,exchange,current.quoteAsset);
  const preference=state=>({exchange:validExchange(state.activeExchange),marketId:state.selectedMarket?.unavailable?'':state.selectedMarket?.id||'',asset:state.selectedMarket?.asset||'BTC',quoteAsset:state.selectedMarket?.quoteAsset||'USDT',timeframe:state.selectedTimeframe||'1h'});
  const api={exchanges,validExchange,marketForAsset,unavailableMarket,equivalentMarket,preference};
  if(typeof module==='object'&&module.exports)module.exports=api;else global.ZychWorkspace=api;
})(typeof window!=='undefined'?window:globalThis);
