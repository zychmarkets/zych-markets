(function(global){
  'use strict';
  const statuses=new Set(['active','paused']);
  const visibleAlerts=(alerts,filter='all')=>(alerts||[]).filter(alert=>statuses.has(alert.status)&&(filter==='all'||alert.status===filter)).map((alert,index)=>({alert,index})).sort((a,b)=>{const status=(a.alert.status==='active'?0:1)-(b.alert.status==='active'?0:1);if(status)return status;const created=Number(b.alert.createdAt||0)-Number(a.alert.createdAt||0);return created||a.index-b.index}).map(item=>item.alert);
  const marketText=alert=>`${String(alert.exchange||'').toUpperCase()} · ${alert.baseAsset||alert.asset||''}/${alert.quoteAsset||''}`;
  const openContext=alert=>({id:alert.id,exchange:alert.exchange,marketType:alert.marketType||'spot',marketId:`${alert.exchange}:${alert.marketType||'spot'}:${alert.symbol}`,symbol:alert.symbol,timeframe:alert.timeframe||'',eventTimestamp:alert.triggeredAt||null});
  const api={visibleAlerts,marketText,openContext};
  if(typeof module==='object'&&module.exports)module.exports=api;else global.ZychAlertHub=api;
})(typeof window!=='undefined'?window:globalThis);
