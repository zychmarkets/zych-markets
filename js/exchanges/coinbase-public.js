(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.ZychCoinbasePublic=api})(typeof window!=='undefined'?window:globalThis,function(){
  'use strict';
  const flags=Object.freeze(['is_disabled','trading_disabled','cancel_only','post_only','auction_mode','limit_only']);
  const capabilities=Object.freeze({chart:true,alerts:true,alertTypes:Object.freeze(['price']),radar:false,exactQuoteVolume24h:false});
  const numeric=value=>{
    if(typeof value!=='number'&&typeof value!=='string')return null;
    if(typeof value==='string'&&!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim()))return null;
    const result=Number(value);return Number.isFinite(result)?result:null;
  };
  const percent=value=>numeric(typeof value==='string'?value.trim().replace(/%$/,'').trim():value);
  const nonnegative=value=>{const result=numeric(value);return result!==null&&result>=0?result:null};
  function validateProducts(products){
    if(!Array.isArray(products)||products.length>20000)throw new Error('Invalid Coinbase products');
    for(const row of products){
      if(!row||typeof row!=='object'||typeof row.product_id!=='string'||!/^[A-Z0-9-]{1,30}$/.test(row.product_id)||!['base_currency_id','quote_currency_id'].every(key=>typeof row[key]==='string'&&/^[A-Z0-9]{1,20}$/.test(row[key]))||typeof row.product_type!=='string'||typeof row.status!=='string'||typeof row.alias!=='string'||!flags.every(key=>typeof row[key]==='boolean'))throw new Error('Invalid Coinbase product schema');
      if(['view_only','hidden_from_discovery'].some(key=>row[key]!==undefined&&typeof row[key]!=='boolean'))throw new Error('Invalid Coinbase optional trading flag');
    }
    return products;
  }
  function unsupportedReason(row){
    if(row.product_type!=='SPOT')return 'NOT_SPOT';
    if(row.status!=='online')return 'NOT_ONLINE';
    const flag=flags.find(key=>row[key]!==false);if(flag)return flag.toUpperCase();
    if(row.alias)return 'UNIFIED_BOOK_ALIAS';
    if(row.view_only===true||row.hidden_from_discovery===true)return 'NOT_DISCOVERABLE';
    if(row.product_id!==`${row.base_currency_id}-${row.quote_currency_id}`)return 'INVALID_NATIVE_IDENTITY';
    return null;
  }
  function instrument(row){
    const symbol=row.product_id,id=`coinbase:spot:${symbol}`;
    return{id,marketId:id,exchange:'coinbase',marketType:'spot',symbol,nativeSymbol:symbol,baseAsset:row.base_currency_id,asset:row.base_currency_id,quoteAsset:row.quote_currency_id,displaySymbol:`${row.base_currency_id}/${row.quote_currency_id}`,enabled:true,status:row.status};
  }
  function snapshot(row,receivedAt){
    const price=nonnegative(row.price),change24h=percent(row.price_percentage_change_24h),high24h=nonnegative(row.high_24h),low24h=nonnegative(row.low_24h),baseVolume24h=nonnegative(row.volume_24h);
    return{marketId:`coinbase:spot:${row.product_id}`,symbol:row.product_id,price,lastPrice:price,change24h,changePercent:change24h,change:null,high24h,high:high24h,low24h,low:low24h,baseVolume24h,quoteVolume24h:null,volume:null,sourceTimestamp:null,snapshotTimestamp:null,receivedAt,receiptTimestamp:receivedAt,lastSnapshotAt:receivedAt,processingTimestamp:Date.now(),cacheStoredAt:null,cacheHit:false,
      availability:{price:price!==null,change24h:change24h!==null,high24h:high24h!==null,low24h:low24h!==null,baseVolume24h:baseVolume24h!==null,quoteVolume24h:false},
      provenance:{source:'coinbase-advanced-trade-public',timestampKind:'receipt',quoteVolumeReason:'EXACT_QUOTE_VOLUME_UNAVAILABLE'}};
  }
  return{flags,capabilities,numeric,percent,validateProducts,unsupportedReason,instrument,snapshot};
});
