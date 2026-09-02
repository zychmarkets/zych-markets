'use strict';
const {validateProducts}=require('../js/exchanges/coinbase-public.js');
const UPSTREAM='https://api.coinbase.com/api/v3/brokerage/market/products';
const PAGE_SIZE=1000,MAX_PAGES=20,MAX_BYTES=8*1024*1024;

// One complete public Spot response, one cache entry, one in-flight request.
// No caller-controlled upstream, headers, credentials, route or pagination.
function createCoinbasePublicProxy({fetchImpl=globalThis.fetch,now=Date.now,timeoutMs=10000,cacheTtlMs=5000}={}){
  let cache=null,pending=null;
  return async()=>{
    if(cache&&now()-cache.receivedAt<cacheTtlMs)return cache;
    if(pending)return pending;
    pending=(async()=>{
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs),products=[],seen=new Set();
      try{
        let offset=0;
        for(let page=0;page<MAX_PAGES;page++){
          const response=await fetchImpl(`${UPSTREAM}?product_type=SPOT&limit=${PAGE_SIZE}&offset=${offset}`,{signal:controller.signal,redirect:'error',credentials:'omit'});
          if(!response.ok)throw new Error(`Coinbase upstream HTTP ${response.status}`);
          if(!response.headers.get('content-type')?.includes('application/json'))throw new Error('Invalid Coinbase content type');
          if(Number(response.headers.get('content-length'))>MAX_BYTES)throw new Error('Coinbase response too large');
          const reader=response.body.getReader();let bytes=0;const chunks=[];
          try{while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>MAX_BYTES){await reader.cancel();throw new Error('Coinbase response too large');}chunks.push(Buffer.from(value));}}finally{reader.releaseLock();}
          const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));
          validateProducts(value.products);
          if(value.products.length>PAGE_SIZE||typeof value.pagination?.has_next!=='boolean')throw new Error('Invalid Coinbase pagination');
          let added=0;
          for(const row of value.products){if(seen.has(row.product_id))continue;seen.add(row.product_id);products.push(row);added++;}
          if(!value.pagination.has_next){cache={products,receivedAt:now()};return cache;}
          if(!added)throw new Error('Coinbase pagination made incomplete progress');
          offset+=value.products.length;
        }
        throw new Error('Coinbase catalog exceeds pagination bound');
      }finally{clearTimeout(timer);}
    })();
    try{return await pending;}finally{pending=null;}
  };
}
const chart=require('../js/exchanges/coinbase-chart.js');
function candleQuery(params){
  if(params.size!==5||[...params.keys()].some(key=>!['product_id','granularity','start','end','limit'].includes(key)))throw new Error('Invalid Coinbase candle query');
  const product=params.get('product_id'),frame=Object.keys(chart.intervals).find(key=>chart.intervals[key]===params.get('granularity'));
  const start=Number(params.get('start')),end=Number(params.get('end'));
  if(!/^[A-Z0-9]{1,20}-[A-Z0-9]{1,20}$/.test(product)||!frame||!/^\d+$/.test(params.get('start'))||!/^\d+$/.test(params.get('end'))||!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<1420070400||end<start||end>chart.shift(chart.bucket(start,frame),frame,350)||params.get('limit')!=='350')throw new Error('Invalid Coinbase candle bounds');
  return {product,frame,start,end};
}
function createCoinbaseCandleProxy({products,fetchImpl=globalThis.fetch}={}){
  return async params=>{
    const {product}=candleQuery(params),catalog=await products();
    const {unsupportedReason}=require('../js/exchanges/coinbase-public.js');
    if(!catalog.products.some(row=>row.product_id===product&&!unsupportedReason(row)))throw new Error('Coinbase product is not admitted');
    const query=new URLSearchParams(params);query.delete('product_id');
    const response=await fetchImpl(`${UPSTREAM}/${product}/candles?${query}`,{signal:AbortSignal.timeout(10000),credentials:'omit',redirect:'error'});
    if(!response.ok)throw new Error(`Coinbase candles HTTP ${response.status}`);
    if(!response.headers.get('content-type')?.includes('application/json'))throw new Error('Invalid Coinbase candle content type');
    const reader=response.body.getReader(),chunks=[];let size=0;
    try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>262144){await reader.cancel();throw new Error('Coinbase candle response too large');}chunks.push(Buffer.from(value));}}finally{reader.releaseLock();}
    const result=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if(!Array.isArray(result.candles)||result.candles.length>350)throw new Error('Invalid Coinbase candle response');result.candles.forEach(chart.normalize);return {candles:result.candles};
  };
}
module.exports={createCoinbasePublicProxy,createCoinbaseCandleProxy,candleQuery};
