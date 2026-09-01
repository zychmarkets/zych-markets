(function(global){
  'use strict';
  const MARKET_TYPE='spot';
  const identity=market=>`${String(market?.exchange||'').toLowerCase()}:${String(market?.marketType||MARKET_TYPE).toLowerCase()}:${String(market?.symbol||'').toUpperCase()}`;
  const entry=market=>({key:identity(market),marketId:market.id||market.marketId,exchange:market.exchange,marketType:market.marketType||MARKET_TYPE,symbol:market.symbol,asset:market.asset||market.baseAsset,baseAsset:market.baseAsset||market.asset,quoteAsset:market.quoteAsset});
  const valid=item=>item&&typeof item==='object'&&typeof item.exchange==='string'&&typeof item.symbol==='string'&&typeof(item.asset||item.baseAsset)==='string';
  const migrate=(value,{markets=[],exchange='binance',defaults=[]}={})=>{
    const source=Array.isArray(value)?value:defaults;
    const resolved=source.map(item=>{
      if(valid(item)){const key=identity(item),market=markets.find(candidate=>identity(candidate)===key);return market?entry(market):{key,marketId:key,exchange:item.exchange,marketType:item.marketType||MARKET_TYPE,symbol:item.symbol,asset:item.asset||item.baseAsset,baseAsset:item.baseAsset||item.asset,quoteAsset:item.quoteAsset||'USDT'}}
      if(typeof item!=='string')return null;
      const asset=item.trim().toUpperCase();
      const market=markets.find(candidate=>candidate.enabled&&candidate.exchange===exchange&&candidate.asset===asset&&candidate.quoteAsset==='USDT')||markets.find(candidate=>candidate.enabled&&candidate.exchange===exchange&&candidate.asset===asset);
      return market?entry(market):null;
    }).filter(Boolean);
    return [...new Map(resolved.map(item=>[item.key,item])).values()].slice(0,50);
  };
  const contains=(items,market)=>items.some(item=>item.key===identity(market));
  const toggle=(items,market)=>contains(items,market)?items.filter(item=>item.key!==identity(market)):[...items,entry(market)].slice(-50);
  const resolve=(item,markets)=>{const key=typeof item?.key==='string'?item.key:identity(item);return markets.find(market=>identity(market)===key)||null};
  const api={MARKET_TYPE,identity,entry,migrate,contains,toggle,resolve};
  if(typeof module==='object'&&module.exports)module.exports=api;else global.ZychWatchlist=api;
})(typeof window!=='undefined'?window:globalThis);
