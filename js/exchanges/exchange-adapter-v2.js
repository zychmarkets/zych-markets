(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.ZychExchangeAdapterV2=api;})(typeof window!=='undefined'?window:globalThis,function(){
  'use strict';
  const STATES=Object.freeze(['SUPPORTED','LIMITED','UNSUPPORTED']);
  const ACCESS_MODES=Object.freeze(['DIRECT','SAME_ORIGIN_PROXY','SERVER_ONLY']);
  const INTERVALS=Object.freeze(['1m','5m','15m','30m','1h','4h','1d','1w','1M']);
  const REASONS=Object.freeze({
    EXACT_QUOTE_VOLUME_UNAVAILABLE:'EXACT_QUOTE_VOLUME_UNAVAILABLE',INTERVAL_UNSUPPORTED:'INTERVAL_UNSUPPORTED',HISTORY_WINDOW_LIMITED:'HISTORY_WINDOW_LIMITED',BACKWARD_PAGINATION_UNAVAILABLE:'BACKWARD_PAGINATION_UNAVAILABLE',ALERT_TYPE_UNSUPPORTED:'ALERT_TYPE_UNSUPPORTED',RADAR_LIQUIDITY_REQUIREMENT_UNMET:'RADAR_LIQUIDITY_REQUIREMENT_UNMET',BROWSER_DIRECT_REST_UNAVAILABLE:'BROWSER_DIRECT_REST_UNAVAILABLE',SAME_ORIGIN_PROXY_REQUIRED:'SAME_ORIGIN_PROXY_REQUIRED',SERVER_TRANSPORT_UNAVAILABLE:'SERVER_TRANSPORT_UNAVAILABLE',MARKET_TYPE_UNSUPPORTED:'MARKET_TYPE_UNSUPPORTED'
  });
  const deepFreeze=value=>{if(value&&typeof value==='object'&&!Object.isFrozen(value)){Object.freeze(value);for(const child of Object.values(value))deepFreeze(child);}return value;};
  const reasonPattern=/^[A-Z][A-Z0-9_]{0,79}$/;
  const fact=(state,reasonCode=null,details)=>{if(!STATES.includes(state))throw new Error(`Invalid capability state: ${state}`);if(state!=='SUPPORTED'&&!reasonPattern.test(reasonCode||''))throw new Error(`Capability reason is required: ${state}`);if(state==='SUPPORTED'&&reasonCode!==null)throw new Error('Supported capability cannot have a reason');return deepFreeze({state,reasonCode,...(details===undefined?{}:{details:deepFreeze({...details})})});};
  const supported=details=>fact('SUPPORTED',null,details);
  const limited=(reasonCode,details)=>fact('LIMITED',reasonCode,details);
  const unsupported=(reasonCode,details)=>fact('UNSUPPORTED',reasonCode,details);
  const nativePatterns=Object.freeze({binance:/^[A-Z0-9]{1,30}$/,bybit:/^[A-Z0-9]{1,30}$/,okx:/^[A-Z0-9]{1,20}-[A-Z0-9]{1,20}$/,bingx:/^[A-Z0-9]{1,20}-[A-Z0-9]{1,20}$/,coinbase:/^[A-Z0-9]{1,20}-[A-Z0-9]{1,20}$/,kraken:/^[A-Z0-9-]{1,30}$/});
  const identity=exchange=>deepFreeze({
    nativeSymbolAuthoritative:true,
    canonicalId(nativeSymbol,marketType='spot'){if(marketType!=='spot'||!nativePatterns[exchange].test(nativeSymbol))return null;return `${exchange}:${marketType}:${nativeSymbol}`;},
    parse(marketId){const prefix=`${exchange}:spot:`;if(typeof marketId!=='string'||!marketId.startsWith(prefix))return null;const nativeSymbol=marketId.slice(prefix.length);return nativePatterns[exchange].test(nativeSymbol)?{exchange,marketType:'spot',nativeSymbol,marketId}:null;},
    resolve(value,catalog=[]){const nativeSymbol=String(value||'').toUpperCase(),direct=catalog.find(row=>row.nativeSymbol===nativeSymbol||row.symbol===nativeSymbol),alias=direct||catalog.find(row=>(row.searchAliases||[]).some(item=>String(item).toUpperCase()===nativeSymbol));const resolved=alias?.nativeSymbol||alias?.symbol||nativeSymbol;return this.canonicalId(resolved);}
  });
  const intervalFacts=(mappings,unsupportedFrames=[])=>deepFreeze(Object.fromEntries(INTERVALS.map(frame=>[frame,unsupportedFrames.includes(frame)?{capability:unsupported(REASONS.INTERVAL_UNSUPPORTED),protocols:{}}:{capability:supported(),protocols:deepFreeze({...mappings[frame]})}])));
  const commonMappings={binance:{'1m':'1m','5m':'5m','15m':'15m','30m':'30m','1h':'1h','4h':'4h','1d':'1d','1w':'1w','1M':'1M'},bybit:{'1m':'1','5m':'5','15m':'15','30m':'30','1h':'60','4h':'240','1d':'D','1w':'W','1M':'M'},okx:{'1m':'1m','5m':'5m','15m':'15m','30m':'30m','1h':'1H','4h':'4H','1d':'1D','1w':'1W','1M':'1M'}};
  const mapped=values=>Object.fromEntries(Object.entries(values).map(([key,value])=>[key,{rest:value,live:value}]));
  const bingxRest=commonMappings.binance,bingxWs={'1m':'1min','5m':'5min','15m':'15min','30m':'30min','1h':'60min','4h':'4hour','1d':'1day','1w':'1week','1M':'1mon'};
  const coinbase={'1m':'ONE_MINUTE','5m':'FIVE_MINUTE','15m':'FIFTEEN_MINUTE','1h':'ONE_HOUR','4h':'FOUR_HOUR','1d':'ONE_DAY','1w':'ONE_WEEK','1M':'ONE_MONTH'};
  const kraken={'1m':1,'5m':5,'15m':15,'1h':60,'4h':240,'1d':1440,'1w':10080};
  const allAlerts=deepFreeze({price:supported(),movement:supported(),volume:supported()});
  function capabilities({intervals,markets=supported(),history=supported(),historyDepth=supported(),alerts=allAlerts,radar=supported(),exact=supported(),accessMode}){return deepFreeze({markets,search:supported(),watchlist:supported(),chart:{history,live:supported(),intervals,historyDepth},alerts,radar,metrics:{exactQuoteVolume24h:exact},access:{browserRest:{mode:accessMode,reasonCode:accessMode==='SAME_ORIGIN_PROXY'?REASONS.SAME_ORIGIN_PROXY_REQUIRED:null},serverTransport:supported()}});}
  const ports=(browser,server,radar)=>deepFreeze({browser:{adapter:browser},server:{alertTransport:server,radar}});
  const definitions=[
    ['binance','exchange.binance','DIRECT',intervalFacts(mapped(commonMappings.binance))],
    ['bybit','exchange.bybit','DIRECT',intervalFacts(mapped(commonMappings.bybit))],
    ['okx','exchange.okx','DIRECT',intervalFacts(mapped(commonMappings.okx))],
    ['bingx','exchange.bingx','SAME_ORIGIN_PROXY',intervalFacts(Object.fromEntries(INTERVALS.map(frame=>[frame,{rest:bingxRest[frame],live:bingxWs[frame],spotWs:bingxWs[frame]}])))],
    ['coinbase','exchange.coinbase','SAME_ORIGIN_PROXY',intervalFacts(mapped(coinbase),['30m'])],
    ['kraken','exchange.kraken','DIRECT',intervalFacts(mapped(kraken),['30m','1M'])]
  ];
  const portNames={binance:['BinanceBrowserAdapter','server/transports/binance-market-transport','server/radar'],bybit:['BybitBrowserAdapter','server/transports/bybit-market-transport','server/radar'],okx:['OkxBrowserAdapter','server/transports/okx-market-transport','server/radar'],bingx:['BingxBrowserAdapter','server/transports/bingx-market-transport','server/radar'],coinbase:['CoinbaseBrowserAdapter','server/transports/coinbase-market-transport',null],kraken:['KrakenBrowserAdapter','server/transports/kraken-market-transport',null]};
  const registry=definitions.map(([id,labelKey,mode,intervals])=>{
    const coinbaseRow=id==='coinbase',krakenRow=id==='kraken',alerts=coinbaseRow?{price:supported(),movement:unsupported(REASONS.ALERT_TYPE_UNSUPPORTED),volume:unsupported(REASONS.ALERT_TYPE_UNSUPPORTED)}:krakenRow?{price:supported(),movement:supported(),volume:unsupported(REASONS.ALERT_TYPE_UNSUPPORTED)}:allAlerts;
    const spot=deepFreeze({identity:identity(id),capabilities:capabilities({intervals,markets:coinbaseRow||krakenRow?limited(REASONS.EXACT_QUOTE_VOLUME_UNAVAILABLE):supported(),history:krakenRow?limited(REASONS.HISTORY_WINDOW_LIMITED,{backwardPagination:false}):supported(),historyDepth:krakenRow?limited(REASONS.HISTORY_WINDOW_LIMITED,{backwardPagination:false}):supported(),alerts:deepFreeze(alerts),radar:coinbaseRow||krakenRow?unsupported(REASONS.RADAR_LIQUIDITY_REQUIREMENT_UNMET):supported(),exact:coinbaseRow||krakenRow?unsupported(REASONS.EXACT_QUOTE_VOLUME_UNAVAILABLE):supported(),accessMode:mode}),ports:ports(...portNames[id])});
    return deepFreeze({id,labelKey,marketTypes:deepFreeze({spot})});
  });
  const RUNTIME_KEYS=new Set(['offline','stale','reconnecting','heartbeatAge','lastDataAge','acknowledgement','generation','currentError']);
  function validateRegistry(rows){
    if(!Array.isArray(rows))throw new Error('Adapter v2 registry must be an array');const ids=new Set(),keys=new Set();
    for(const adapter of rows){if(!adapter||typeof adapter.id!=='string'||ids.has(adapter.id))throw new Error('Duplicate or invalid exchange ID');ids.add(adapter.id);const spot=adapter.marketTypes?.spot;if(!spot)throw new Error(`Missing Spot definition: ${adapter.id}`);if(typeof spot.identity?.canonicalId!=='function'||spot.identity.nativeSymbolAuthoritative!==true)throw new Error(`Missing identity contract: ${adapter.id}`);const key=`${adapter.id}:spot`;if(keys.has(key))throw new Error(`Duplicate canonical registry key: ${key}`);keys.add(key);
      if(!ACCESS_MODES.includes(spot.capabilities?.access?.browserRest?.mode))throw new Error(`Invalid access mode: ${adapter.id}`);
      const inspect=value=>{if(!value||typeof value!=='object')return;if(Object.hasOwn(value,'state')){if(!STATES.includes(value.state))throw new Error(`Invalid capability state: ${value.state}`);if(value.state!=='SUPPORTED'&&!reasonPattern.test(value.reasonCode||''))throw new Error(`Capability reason is required: ${value.state}`);}for(const [name,child] of Object.entries(value)){if(RUNTIME_KEYS.has(name))throw new Error(`Runtime health is forbidden: ${name}`);inspect(child);}};inspect(spot.capabilities);
      for(const frame of INTERVALS){const row=spot.capabilities.chart.intervals[frame];if(!row||!STATES.includes(row.capability?.state))throw new Error(`Invalid interval capability: ${adapter.id} ${frame}`);const hasMapping=Object.keys(row.protocols||{}).length>0;if(row.capability.state==='SUPPORTED'&&!hasMapping)throw new Error(`Supported interval missing mapping: ${adapter.id} ${frame}`);if(row.capability.state==='UNSUPPORTED'&&hasMapping)throw new Error(`Unsupported interval has mapping: ${adapter.id} ${frame}`);if(row.capability.state!=='SUPPORTED'&&!row.capability.reasonCode)throw new Error(`Interval reason missing: ${adapter.id} ${frame}`);}
    }
    return true;
  }
  validateRegistry(registry);const byId=deepFreeze(Object.fromEntries(registry.map(row=>[row.id,row]))),exchangeIds=deepFreeze(registry.map(row=>row.id));deepFreeze(registry);
  const get=(exchange,marketType='spot')=>byId[exchange]?.marketTypes?.[marketType]||null;
  const canonicalId=(exchange,marketType,nativeSymbol)=>get(exchange,marketType)?.identity.canonicalId(nativeSymbol,marketType)||null;
  const parseCanonicalId=marketId=>{if(typeof marketId!=='string')return null;const exchange=marketId.split(':',1)[0];return get(exchange,'spot')?.identity.parse(marketId)||null;};
  return deepFreeze({STATES,ACCESS_MODES,INTERVALS,REASONS,supported,limited,unsupported,validateRegistry,registry,byId,exchangeIds,get,canonicalId,parseCanonicalId});
});
