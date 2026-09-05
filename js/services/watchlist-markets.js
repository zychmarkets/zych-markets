(function(global,factory){
  const api=factory(typeof module==='object'&&module.exports?require('../exchanges/exchange-adapter-v2.js'):global.ZychExchangeAdapterV2);
  if(typeof module==='object'&&module.exports)module.exports=api;else global.ZychWatchlist=api;
})(typeof window!=='undefined'?window:globalThis,function(adapters){
  'use strict';
  if(!adapters)throw new Error('Adapter v2 registry is required');
  const MARKET_TYPE='spot';
  const capabilityAdmitted=capability=>Boolean(capability)&&capability.state!=='UNSUPPORTED';
  const definition=value=>adapters.get(value?.exchange,value?.marketType||MARKET_TYPE);
  const identity=market=>definition(market)?.identity.canonicalId(market?.nativeSymbol||market?.symbol,market?.marketType||MARKET_TYPE)||null;
  const structurallyValid=item=>{if(!item||typeof item!=='object'||typeof item.exchange!=='string'||typeof item.symbol!=='string'||typeof(item.asset||item.baseAsset)!=='string')return false;const marketId=identity(item);if(!marketId)return false;return(!item.marketId||item.marketId===marketId)&&(!item.id||item.id===marketId)&&(!item.key||item.key===marketId)&&(!item.nativeSymbol||item.nativeSymbol===item.symbol)&&adapters.parseCanonicalId(marketId)?.nativeSymbol===item.symbol};
  const watchlistAdmitted=market=>structurallyValid(market)&&capabilityAdmitted(definition(market)?.capabilities.watchlist);
  const entry=market=>{if(!structurallyValid(market))return null;const marketId=identity(market);return{key:marketId,marketId,exchange:market.exchange,marketType:market.marketType||MARKET_TYPE,symbol:market.symbol,asset:market.asset||market.baseAsset,baseAsset:market.baseAsset||market.asset,quoteAsset:market.quoteAsset}};
  // Older persisted entries used exchange:symbol IDs with a canonical key.
  // Convert only exact matching IDs at the storage boundary; runtime admission stays strict.
  const restoreEntry=item=>{
    const marketId=identity(item);if(!marketId)return null;
    const legacyId=`${item.exchange}:${item.symbol}`,restored={...item};
    for(const field of ['marketId','id'])if(restored[field]===legacyId)restored[field]=marketId;
    return structurallyValid(restored)?restored:null;
  };
  const migrate=(value,{markets=[],exchange='binance',defaults=[]}={})=>{
    const source=Array.isArray(value)?value:defaults;
    const resolved=source.map(item=>{
      if(item&&typeof item==='object'){item=restoreEntry(item);if(!item)return null;const key=identity(item),market=markets.find(candidate=>identity(candidate)===key);return market?entry(market):{key,marketId:key,exchange:item.exchange,marketType:item.marketType||MARKET_TYPE,symbol:item.symbol,asset:item.asset||item.baseAsset,baseAsset:item.baseAsset||item.asset,quoteAsset:item.quoteAsset||'USDT'}}
      if(typeof item!=='string')return null;
      const asset=item.trim().toUpperCase();
      const market=markets.find(candidate=>candidate.enabled&&candidate.exchange===exchange&&candidate.asset===asset&&candidate.quoteAsset==='USDT')||markets.find(candidate=>candidate.enabled&&candidate.exchange===exchange&&candidate.asset===asset);
      return market?entry(market):null;
    }).filter(Boolean);
    return [...new Map(resolved.map(item=>[item.key,item])).values()].slice(0,50);
  };
  const contains=(items,market)=>{const key=identity(market);return Boolean(key)&&items.some(item=>structurallyValid(item)&&identity(item)===key)};
  const toggle=(items,market)=>{if(!watchlistAdmitted(market))return items;const key=identity(market);return contains(items,market)?items.filter(item=>identity(item)!==key):[...items,entry(market)].slice(-50)};
  const resolve=(item,markets)=>{if(!structurallyValid(item))return null;const key=identity(item);return markets.find(market=>structurallyValid(market)&&identity(market)===key)||null};
  const finite=value=>(typeof value==='number'||typeof value==='string'&&value.trim()!=='')&&Number.isFinite(Number(value));
  const view=(items,markets,states,snapshots={})=>items.filter(watchlistAdmitted).map(item=>{
    const load=states[item.exchange]||{catalog:'loading',quotes:'idle'},resolved=load.catalog==='ready'?resolve(item,markets):null;
    const market=resolved&&watchlistAdmitted(resolved)?resolved:null,snapshot=market?snapshots[market.id]:null;
    const status=load.catalog==='error'?'catalogError':load.catalog!=='ready'?'catalogLoading':!market?'notFound':load.quotes==='error'||snapshot?.refreshFailed?'quotesError':finite(snapshot?.lastPrice)?'ready':load.quotes==='loading'||load.quotes==='idle'?'quotesLoading':'quotesUnavailable';
    return {item,market:market||{...item,id:identity(item),nativeSymbol:item.symbol,displaySymbol:item.symbol},resolved:Boolean(market),status,snapshot};
  });
  return{MARKET_TYPE,capabilityAdmitted,identity,structurallyValid,watchlistAdmitted,entry,migrate,contains,toggle,resolve,finite,view};
});
