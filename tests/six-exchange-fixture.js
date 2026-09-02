(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.ZychSixExchangeFixture=api;})(typeof window==='undefined'?globalThis:window,()=>{
  'use strict';
  // Deliberately synthetic, exclusively for isolated product/UI regressions.
  const pairs=[['binance','BTCUSDT','USDT'],['bybit','BTCUSDT','USDT'],['okx','BTC-USDT','USDT'],['bingx','BTC-USDT','USDT'],['coinbase','BTC-USD','USD'],['kraken','XXBTZUSD','USD'],['kraken','XBTUSDT','USDT'],['coinbase','BTC-USDT','USDT'],['coinbase','BTC-USDC','USDC'],['kraken','XBTUSDC','USDC'],['kraken','XXBTZEUR','EUR']];
  const markets=pairs.map(([exchange,symbol,quoteAsset])=>({id:`${exchange}:spot:${symbol}`,marketId:`${exchange}:spot:${symbol}`,exchange,symbol,nativeSymbol:symbol,marketType:'spot',baseAsset:'BTC',asset:'BTC',quoteAsset,displaySymbol:`BTC/${quoteAsset}`,enabled:true,...(exchange==='kraken'?{searchAliases:['BTC','XBT',`XBT${quoteAsset}`,`BTC${quoteAsset}`]}:{})}));
  return {markets};
});
