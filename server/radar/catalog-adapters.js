'use strict';
const {marketId,legacyMarketId}=require('./market-identity.js');

const spreadPct=(bidValue,askValue)=>{const bid=Number(bidValue),ask=Number(askValue),mid=(bid+ask)/2;return bid>0&&ask>=bid&&mid>0?(ask-bid)/mid*100:null};
const json=async(fetchImpl,url,signal)=>{const response=await fetchImpl(url,{signal});if(!response.ok)throw new Error(`Catalog HTTP ${response.status}`);return response.json()};
const normalized=(exchange,row,ticker,now)=>{const market={exchange,marketType:'spot',symbol:row.symbol,baseAsset:row.baseAsset,quoteAsset:row.quoteAsset,status:row.status,quoteVolume24h:ticker?Number(ticker.quoteVolume24h):null,marketAge:null,spread:ticker?spreadPct(ticker.bid,ticker.ask):null,snapshotTimestamp:ticker?now:null};return{...market,marketId:marketId(market),legacyMarketId:legacyMarketId(market)}};

class BinanceCatalogAdapter{
  constructor({restBase,fetchImpl=globalThis.fetch,now=Date.now}={}){this.id='binance';this.restBase=restBase||'https://api.binance.com/api/v3';this.fetchImpl=fetchImpl;this.now=now}
  // Binance quoteVolume is the 24h turnover denominated in the quote asset.
  async load(signal){const [info,tickers]=await Promise.all([json(this.fetchImpl,`${this.restBase}/exchangeInfo`,signal),json(this.fetchImpl,`${this.restBase}/ticker/24hr`,signal)]),bySymbol=new Map((tickers||[]).map(row=>[row.symbol,{quoteVolume24h:row.quoteVolume,bid:row.bidPrice,ask:row.askPrice}])),now=this.now();return(info.symbols||[]).filter(row=>row.isSpotTradingAllowed!==false).map(row=>normalized(this.id,{symbol:row.symbol,baseAsset:row.baseAsset,quoteAsset:row.quoteAsset,status:row.status},bySymbol.get(row.symbol),now))}
}
class BybitCatalogAdapter{
  constructor({restBase,fetchImpl=globalThis.fetch,now=Date.now}={}){this.id='bybit';this.restBase=restBase||'https://api.bybit.com/v5/market';this.fetchImpl=fetchImpl;this.now=now}
  unwrap(value){if(Number(value?.retCode)!==0||!value?.result)throw new Error(`Bybit API ${value?.retCode??'invalid'}`);return value.result}
  async instruments(signal){const rows=[],seen=new Set();let cursor='';do{const suffix=cursor?`&cursor=${encodeURIComponent(cursor)}`:'',page=this.unwrap(await json(this.fetchImpl,`${this.restBase}/instruments-info?category=spot&limit=1000${suffix}`,signal));rows.push(...(page.list||[]));const next=String(page.nextPageCursor||'');if(!next)break;if(seen.has(next))throw new Error('Bybit pagination cursor loop');seen.add(next);cursor=next}while(true);return rows}
  // Bybit turnover24h is quote-currency turnover (unlike volume24h, which is base units).
  async load(signal){const [instruments,tickers]=await Promise.all([this.instruments(signal),json(this.fetchImpl,`${this.restBase}/tickers?category=spot`,signal)]),bySymbol=new Map((this.unwrap(tickers).list||[]).map(row=>[row.symbol,{quoteVolume24h:row.turnover24h,bid:row.bid1Price,ask:row.ask1Price}])),now=this.now();return instruments.map(row=>normalized(this.id,{symbol:row.symbol,baseAsset:row.baseCoin,quoteAsset:row.quoteCoin,status:row.status},bySymbol.get(row.symbol),now))}
}
class OkxCatalogAdapter{
  constructor({restBase,fetchImpl=globalThis.fetch,now=Date.now}={}){this.id='okx';this.restBase=restBase||'https://www.okx.com/api/v5';this.fetchImpl=fetchImpl;this.now=now}
  unwrap(value){if(String(value?.code)!=='0'||!Array.isArray(value?.data))throw new Error(`OKX API ${value?.code??'invalid'}`);return value.data}
  // For Spot, OKX volCcy24h is volume in quote currency; vol24h is base units.
  async load(signal){const [info,tickers]=await Promise.all([json(this.fetchImpl,`${this.restBase}/public/instruments?instType=SPOT`,signal),json(this.fetchImpl,`${this.restBase}/market/tickers?instType=SPOT`,signal)]),instruments=this.unwrap(info),bySymbol=new Map(this.unwrap(tickers).map(row=>[row.instId,{quoteVolume24h:row.volCcy24h,bid:row.bidPx,ask:row.askPx}])),now=this.now();return instruments.map(row=>normalized(this.id,{symbol:row.instId,baseAsset:row.baseCcy,quoteAsset:row.quoteCcy,status:row.state},bySymbol.get(row.instId),now))}
}
class BingxCatalogAdapter{
  constructor({restBase='https://open-api.bingx.com',fetchImpl=globalThis.fetch,now=Date.now}={}){this.id='bingx';Object.assign(this,{restBase,fetchImpl,now})}
  unwrap(value,key){const rows=key?value?.data?.[key]:value?.data;if(value?.code!==0||!Array.isArray(rows))throw new Error(`BingX catalog API ${value?.code??'invalid'}`);return rows}
  async load(signal){
    const [info,tickers]=await Promise.all([json(this.fetchImpl,`${this.restBase}/openApi/spot/v1/common/symbols`,signal),json(this.fetchImpl,`${this.restBase}/openApi/spot/v1/ticker/24hr`,signal)]);
    const bySymbol=new Map(this.unwrap(tickers).map(row=>[row.symbol,row])),now=this.now();
    return this.unwrap(info,'symbols').map(row=>{const parts=/^([A-Z0-9]+)-([A-Z0-9]+)$/.exec(row.symbol);return {...row,baseAsset:row.baseAsset||parts?.[1],quoteAsset:row.quoteAsset||parts?.[2]}}).filter(row=>Number(row.status)===1&&row.apiStateBuy===true&&row.apiStateSell===true&&row.baseAsset&&row.quoteAsset&&row.symbol===`${row.baseAsset}-${row.quoteAsset}`).map(row=>{
      const ticker=bySymbol.get(row.symbol),value=ticker?.quoteVolume,valid=value!=null&&value!==''&&Number.isFinite(Number(value))&&Number(value)>=0;
      const result=normalized(this.id,{...row,status:'TRADING'},valid?{quoteVolume24h:value}:null,now);
      return {...result,sourceStatus:row.status};
    });
  }
}
module.exports={BinanceCatalogAdapter,BybitCatalogAdapter,OkxCatalogAdapter,BingxCatalogAdapter,spreadPct,normalized};
