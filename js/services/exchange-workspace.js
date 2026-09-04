(function(global,factory){
  const api=factory(typeof module==='object'&&module.exports?require('../exchanges/exchange-adapter-v2.js'):global.ZychExchangeAdapterV2);
  if(typeof module==='object'&&module.exports)module.exports=api;else global.ZychWorkspace=api;
})(typeof window!=='undefined'?window:globalThis,function(adapters){
  'use strict';
  if(!adapters)throw new Error('Adapter v2 registry is required');
  const exchanges=adapters.manualExchangeIds;
  const resolveExchange=value=>adapters.resolveExchange(value)?.id||null;
  const validExchange=value=>resolveExchange(value)||'binance';
  const marketForAsset=(markets,asset,exchange,quoteAsset='USDT')=>{const same=(markets||[]).filter(market=>market.enabled&&market.asset===asset&&market.exchange===exchange);return same.find(market=>market.quoteAsset===quoteAsset)||(exchange==='kraken'?null:same.find(market=>market.quoteAsset==='USDT')||same[0])||null};
  const unavailableMarket=(asset,exchange,quoteAsset='USDT',requestedMarketId='')=>({id:`${exchange}:unavailable:${asset}:${quoteAsset}`,marketId:`${exchange}:unavailable:${asset}:${quoteAsset}`,requestedMarketId,asset,baseAsset:asset,quoteAsset,exchange,symbol:'',enabled:false,unavailable:true,status:'unavailable'});
  const equivalentMarket=(markets,current,exchange)=>current.exchange==='kraken'?(markets||[]).find(market=>market.enabled&&market.exchange===exchange&&market.asset===current.asset&&market.quoteAsset===current.quoteAsset)||null:marketForAsset(markets,current.asset,exchange,current.quoteAsset);
  const preference=state=>({exchange:validExchange(state.activeExchange),marketId:state.selectedMarket?.unavailable?state.selectedMarket.requestedMarketId||'':state.selectedMarket?.id||'',asset:state.selectedMarket?.asset||'BTC',quoteAsset:state.selectedMarket?.quoteAsset||'USDT',timeframe:state.selectedTimeframe||'1h'});
  // Only the explicit global selector may create a new market context. These
  // preferences rank admitted markets; they never construct exchange symbols.
  const manualQuotes=Object.freeze({kraken:['USD','USDT','USDC','EUR'],coinbase:['USD','USDT','USDC'],binance:['USDT','USDC'],bybit:['USDT','USDC'],okx:['USDT','USDC'],bingx:['USDT','USDC']});
  function manualSwitchMarket(markets,current,exchange){
    const adapter=adapters.resolveExchange(exchange),identity=adapter?.marketTypes?.spot?.identity;if(!identity)return null;
    const admitted=(markets||[]).filter(m=>m.exchange===adapter.id&&m.enabled===true&&m.marketType==='spot'&&!m.unavailable&&!m.unsupportedReason&&m.supported!==false&&!m.alias&&!m.radarOnly&&/^[A-Z0-9]{1,20}$/.test(m.baseAsset)&&/^[A-Z0-9]{1,20}$/.test(m.quoteAsset)&&identity.canonicalId(m.symbol,m.marketType)===m.id&&identity.parse(m.id)?.nativeSymbol===m.symbol&&(!m.marketId||m.marketId===m.id)&&(!m.nativeSymbol||m.nativeSymbol===m.symbol));
    const ordered=(rows,requested)=>{const quotes=[...new Set([requested,...manualQuotes[exchange]].filter(Boolean))],rank=m=>{const i=quotes.indexOf(m.quoteAsset);return i<0?quotes.length:i;};return [...rows].sort((a,b)=>rank(a)-rank(b)||(a.id<b.id?-1:a.id>b.id?1:0));};
    const same=admitted.filter(m=>m.baseAsset===(current?.baseAsset||current?.asset));
    return ordered(same,current?.quoteAsset)[0]||ordered(admitted.filter(m=>m.baseAsset==='BTC'))[0]||[...admitted].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0)[0]||null;
  }
  function restoreMarket(markets,saved){
    if(!exchanges.includes(saved.exchange))return null;
    // A saved canonical ID is authoritative, even when temporarily unavailable.
    if(saved.marketId)return (markets||[]).find(m=>m.enabled&&m.id===saved.marketId&&m.exchange===saved.exchange&&m.id===`${m.exchange}:${m.marketType||'spot'}:${m.symbol}`)||null;
    return (markets||[]).find(m=>m.enabled&&m.exchange===saved.exchange&&(m.baseAsset||m.asset)===saved.asset&&m.quoteAsset===saved.quoteAsset)||null;
  }
  return{exchanges,resolveExchange,validExchange,marketForAsset,unavailableMarket,equivalentMarket,preference,manualSwitchMarket,restoreMarket};
});
