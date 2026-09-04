(function(global,factory){
  const api=factory(typeof module==='object'&&module.exports?require('../exchanges/exchange-adapter-v2.js'):global.ZychExchangeAdapterV2);
  if(typeof module==='object'&&module.exports)module.exports=api;else global.ZychMarketContext=api;
})(typeof window!=='undefined'?window:globalThis,function(adapters){
  'use strict';
  if(!adapters)throw new Error('Adapter v2 registry is required');
  const timeframe=/^(1|3|5|15|30)m$|^(1|2|4|6|8|12)h$|^1d$|^1w$|^1M$/;
  const create=value=>{if(!value||typeof value.symbol!=='string')return null;const parsed=adapters.parseCanonicalId(value.marketId);if(!parsed||parsed.exchange!==value.exchange||parsed.marketType!==value.marketType||parsed.nativeSymbol!==value.symbol)return null;if(value.timeframe&&!timeframe.test(value.timeframe))return null;const stamp=value.eventTimestamp==null?null:Number(value.eventTimestamp);if(stamp!==null&&!(stamp>0))return null;return{marketId:value.marketId,exchange:value.exchange,marketType:value.marketType,symbol:value.symbol,timeframe:value.timeframe||null,eventTimestamp:stamp}}
  const fromMarket=(market,extras={})=>{const marketType=market.marketType||'spot',marketId=adapters.canonicalId(market.exchange,marketType,market.symbol);return create({marketId,exchange:market.exchange,marketType,symbol:market.symbol,...extras});};
  const fromTrigger=trigger=>{const marketType=trigger.marketType||'spot',marketId=adapters.canonicalId(trigger.exchange,marketType,trigger.symbol);return create({marketId,exchange:trigger.exchange,marketType,symbol:trigger.symbol,timeframe:trigger.timeframe||null,eventTimestamp:trigger.triggeredAt||trigger.timestamp});};
  const fromUnifiedEvent=event=>create(event.deepLink||{...event.market,timeframe:event.timeframe,eventTimestamp:event.eventTimestamp});
  async function resolveLocation(search,fetchImpl=globalThis.fetch){const query=new URLSearchParams(search||'');if(query.has('event')){const response=await fetchImpl(`/api/radar/events/${encodeURIComponent(query.get('event'))}`);if(response.status===404)return{error:'EVENT_NOT_FOUND'};if(!response.ok)return{error:'EVENT_LOOKUP_FAILED'};return{context:fromUnifiedEvent((await response.json()).event)}}if(query.has('trigger')){const response=await fetchImpl('/api/triggers');if(!response.ok)return{error:'TRIGGER_LOOKUP_FAILED'};const event=(await response.json()).triggers?.find(item=>item.id===query.get('trigger'));return event?{context:fromTrigger(event)}:{error:'TRIGGER_NOT_FOUND'}}return{context:null}}
  return{create,fromMarket,fromTrigger,fromUnifiedEvent,resolveLocation};
});
