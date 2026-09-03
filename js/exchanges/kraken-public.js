(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.ZychKrakenPublic=api;})(typeof window!=='undefined'?window:globalThis,function(){
  'use strict';
  const capabilities=Object.freeze({catalog:true,markets:true,search:true,chart:true,alerts:true,alertTypes:Object.freeze(['price','movement']),watchlist:true,radar:false,radarExclusionReason:'EXACT_QUOTE_VOLUME_UNAVAILABLE',exactQuoteVolume24h:false,allSpotQuotes:true,quoteAware:true});
  const ticker=value=>typeof value==='string'&&/^[A-Z0-9]{1,20}$/.test(value);
  const symbol=value=>typeof value==='string'&&/^[A-Z0-9-]{1,30}$/.test(value);
  const numeric=value=>{if(typeof value!=='number'&&typeof value!=='string'||typeof value==='string'&&!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim()))return null;const n=Number(value);return Number.isFinite(n)?n:null;};
  const nonnegative=value=>{const n=numeric(value);return n!==null&&n>=0?n:null;};
  function unwrap(value){if(!value||!Array.isArray(value.error)||value.error.length||!value.result||typeof value.result!=='object'||Array.isArray(value.result)||Object.keys(value.result).length>10000)throw new Error('Invalid Kraken public envelope');return value.result;}
  const uniqueIndex=(rows,key)=>{const result=new Map();for(const row of rows){const id=key(row);if(typeof id!=='string'||!id)continue;result.set(id,result.has(id)?null:row);}return result;};
  function registry(legacy,modern,assets,modernAssets){
    const modernByAlt=uniqueIndex(Object.entries(modern).map(([key,row])=>({key,row})),x=>x.row?.altname);
    const legacyByAlt=uniqueIndex(Object.entries(legacy).map(([key,row])=>({key,row})),x=>x.row?.altname);
    const assetsByAlt=uniqueIndex(Object.entries(modernAssets).map(([key,row])=>({key,row})),x=>x.row?.altname);
    const rawAssetsByAlt=uniqueIndex(Object.entries(assets).map(([key,row])=>({key,row})),x=>x.row?.altname);
    const asset=raw=>{const row=assets[raw],mapped=assetsByAlt.get(row?.altname);return row?.aclass==='currency'&&row.status==='enabled'&&mapped?.row.aclass==='currency'&&mapped.row.status==='enabled'&&rawAssetsByAlt.get(row.altname)?.key===raw&&ticker(mapped.key)?mapped.key:null;};
    const candidates=[],excluded=[];
    for(const [native,row]of Object.entries(legacy)){
      const match=modernByAlt.get(row?.altname),m=match?.row,base=asset(row?.base),quote=asset(row?.quote);
      let reason=null;
      if(!symbol(native)||!symbol(row?.altname))reason='NONSTANDARD_SYMBOL';
      else if(row.aclass_base!=='currency'||row.aclass_quote!=='currency')reason='NOT_CURRENCY_SPOT';
      else if(row.execution_venue!=='international')reason='UNSUPPORTED_VENUE';
      else if(row.status!=='online')reason='NOT_ONLINE';
      else if(!match||legacyByAlt.get(row.altname)?.key!==native)reason='AMBIGUOUS_OR_MISSING_MAPPING';
      else if(!base||!quote||base===quote||m.base!==base||m.quote!==quote||match.key!==`${base}/${quote}`||m.wsname!==row.wsname||typeof row.wsname!=='string'||row.wsname.split('/').length!==2)reason='INVALID_ASSET_MAPPING';
      else if(m.status!=='online'||m.aclass_base!=='currency'||m.aclass_quote!=='currency'||m.execution_venue!=='international')reason='INCONSISTENT_CATALOG';
      else if(!['pair_decimals','lot_decimals','cost_decimals'].every(k=>Number.isInteger(row[k])&&row[k]>=0&&row[k]<=18)||!(numeric(row.ordermin)>0)||!(numeric(row.costmin)>0)||!(numeric(row.tick_size)>0))reason='INVALID_PRECISION_OR_MINIMUM';
      if(reason){excluded.push({nativeSymbol:native,reason});continue;}
      const aliases=[native,row.altname,row.wsname,match.key,...row.wsname.split('/')];
      candidates.push({nativeSymbol:native,wsSymbol:match.key,altname:row.altname,wsname:row.wsname,rawBase:row.base,rawQuote:row.quote,baseAsset:base,quoteAsset:quote,searchAliases:[...new Set(aliases)],metadata:{priceDecimals:row.pair_decimals,quantityDecimals:row.lot_decimals,costDecimals:row.cost_decimals,orderMin:row.ordermin,costMin:row.costmin,tickSize:row.tick_size}});
    }
    const byWs=uniqueIndex(candidates,x=>x.wsSymbol),byNative=new Map();
    for(const row of candidates){if(!byWs.get(row.wsSymbol)){excluded.push({nativeSymbol:row.nativeSymbol,reason:'AMBIGUOUS_WS_SYMBOL'});continue;}byNative.set(row.nativeSymbol,row);}
    return {byNative,byWs:new Map([...byNative.values()].map(row=>[row.wsSymbol,row])),excluded};
  }
  function instrument(row){const id=`kraken:spot:${row.nativeSymbol}`;return{id,marketId:id,exchange:'kraken',marketType:'spot',symbol:row.nativeSymbol,nativeSymbol:row.nativeSymbol,baseAsset:row.baseAsset,asset:row.baseAsset,quoteAsset:row.quoteAsset,displaySymbol:row.wsSymbol,searchAliases:row.searchAliases,enabled:true,status:'online'};}
  function restTicker(row,receivedAt){return {price:nonnegative(row?.c?.[0]),high24h:nonnegative(row?.h?.[1]),low24h:nonnegative(row?.l?.[1]),baseVolume24h:nonnegative(row?.v?.[1]),vwap24h:nonnegative(row?.p?.[1]),receivedAt,sourceTimestamp:null};}
  function wsTicker(row,receivedAt){
    const sourceTimestamp=typeof row?.timestamp==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(row.timestamp)?Date.parse(row.timestamp):NaN;
    if(!Number.isFinite(sourceTimestamp)||sourceTimestamp<=0||sourceTimestamp>receivedAt+5000)return null;
    return {price:nonnegative(row.last),change24h:numeric(row.change_pct),change:numeric(row.change),high24h:nonnegative(row.high),low24h:nonnegative(row.low),baseVolume24h:nonnegative(row.volume),vwap24h:nonnegative(row.vwap),sourceTimestamp,sourceTime:row.timestamp,receivedAt};
  }
  function snapshot(row,rest,ws,now=Date.now(),maxAgeMs=180000){
    const fresh=value=>value&&now-value.receivedAt<=maxAgeMs&&value.receivedAt<=now+5000;
    const r=fresh(rest)?rest:null,w=fresh(ws)&&now-ws.sourceTimestamp<=maxAgeMs?ws:null,fields={},provenance={quoteVolumeReason:'EXACT_QUOTE_VOLUME_UNAVAILABLE',fields:{}};
    for(const key of ['price','high24h','low24h','baseVolume24h','vwap24h','change24h','change']){
      const rolling=key==='change24h'||key==='change',sources=(rolling?[w]:[r,w]).filter(value=>value&&value[key]!==null&&value[key]!==undefined).sort((a,b)=>(b.sourceTimestamp??b.receivedAt)-(a.sourceTimestamp??a.receivedAt));
      const source=sources[0];fields[key]=source?.[key]??null;provenance.fields[key]=source?{source:source===w?'kraken-ws-v2-ticker':'kraken-rest-ticker',sourceTimestamp:source.sourceTimestamp,receivedAt:source.receivedAt}:null;
    }
    const received=[r?.receivedAt,w?.receivedAt].filter(Number.isFinite),availability=Object.fromEntries(Object.entries(fields).map(([k,v])=>[k,v!==null]));
    return{marketId:`kraken:spot:${row.nativeSymbol}`,symbol:row.nativeSymbol,...fields,lastPrice:fields.price,changePercent:fields.change24h,high:fields.high24h,low:fields.low24h,quoteVolume24h:null,volume:null,sourceTimestamp:provenance.fields.price?.sourceTimestamp??null,snapshotTimestamp:null,receivedAt:received.length?Math.max(...received):null,receiptTimestamp:received.length?Math.max(...received):null,lastSnapshotAt:received.length?Math.max(...received):null,processingTimestamp:now,cacheStoredAt:null,cacheHit:false,availability:{...availability,quoteVolume24h:false},provenance};
  }
  return{capabilities,numeric,unwrap,registry,instrument,restTicker,wsTicker,snapshot};
});
