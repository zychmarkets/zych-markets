(function(global){
  'use strict';
  const MARKET_TYPES=new Set(['spot','perpetual']);
  const clean=value=>String(value||'').trim();
  const instrumentId=value=>`${clean(value.exchange).toLowerCase()}:${clean(value.marketType||'spot').toLowerCase()}:${clean(value.nativeSymbol||value.symbol).toUpperCase()}`;
  function normalize(value){
    const exchange=clean(value?.exchange).toLowerCase(),marketType=clean(value?.marketType||'spot').toLowerCase(),baseAsset=clean(value?.baseAsset||value?.base).toUpperCase(),quoteAsset=clean(value?.quoteAsset||value?.quote).toUpperCase(),nativeSymbol=clean(value?.nativeSymbol||value?.symbol).toUpperCase();
    if(!exchange||!MARKET_TYPES.has(marketType)||!baseAsset||!quoteAsset||!nativeSymbol)return null;
    const id=instrumentId({exchange,marketType,nativeSymbol});
    return{id,marketId:id,exchange,marketType,baseAsset,quoteAsset,asset:baseAsset,symbol:nativeSymbol,nativeSymbol,displaySymbol:`${baseAsset}/${quoteAsset}`,enabled:value.enabled!==false,status:value.status||null};
  }
  function search(instruments,query,{limit=100}={}){
    const term=clean(query).toUpperCase(),compactTerm=term.replace(/[\/-]/g,'');if(!term)return[];
    const normalized=(instruments||[]).map(normalize).filter(Boolean),hasBaseMatch=normalized.some(instrument=>instrument.baseAsset.includes(term)),includeQuoteMatches=['USDT','USDC','FDUSD'].includes(term),quotePriority={USDT:0,USDC:1,FDUSD:2};
    return normalized.map(instrument=>{const compact=instrument.displaySymbol.replace(/[\/-]/g,''),base=instrument.baseAsset,quote=instrument.quoteAsset,symbol=instrument.nativeSymbol,compactSymbol=symbol.replace(/[\/-]/g,'');let rank=9;if(base===term)rank=0;else if(compact===compactTerm||compactSymbol===compactTerm)rank=1;else if(quote===term)rank=2;else if(base.startsWith(term))rank=3;else if(compact.startsWith(compactTerm)||compactSymbol.startsWith(compactTerm))rank=4;else if(base.includes(term)||quote.includes(term)||compact.includes(compactTerm)||compactSymbol.includes(compactTerm))rank=5;return{instrument,rank}}).filter(item=>item.rank<9&&(!hasBaseMatch||includeQuoteMatches||item.instrument.baseAsset.includes(term))).sort((a,b)=>a.rank-b.rank||(quotePriority[a.instrument.quoteAsset]??9)-(quotePriority[b.instrument.quoteAsset]??9)||a.instrument.baseAsset.localeCompare(b.instrument.baseAsset)||a.instrument.exchange.localeCompare(b.instrument.exchange)||a.instrument.id.localeCompare(b.instrument.id)).slice(0,limit).map(item=>item.instrument);
  }
  const api={MARKET_TYPES,instrumentId,normalize,search};if(typeof module==='object'&&module.exports)module.exports=api;else global.ZychInstruments=api;
})(typeof window!=='undefined'?window:globalThis);
