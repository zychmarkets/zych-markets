'use strict';
class MultiExchangeMarketTransport {
  constructor({ transports, logger }){this.transports=transports;this.logger=logger;this.status='idle'}
  async start(alerts,handlers={}){const groups=Object.groupBy(alerts,item=>item.exchange),results=await Promise.allSettled(Object.entries(this.transports).map(async([exchange,transport])=>transport.start(groups[exchange]||[],{onEvent:event=>{if(event.exchange===exchange)handlers.onEvent?.(event)},onStatus:status=>handlers.onStatus?.(`${exchange}:${status}`)})));results.forEach((result,index)=>{if(result.status==='rejected')this.logger.error('exchange_transport_start_failed',{exchange:Object.keys(this.transports)[index],message:result.reason?.message})});this.status=alerts.length?'running':'idle'}
  async stop(){await Promise.allSettled(Object.values(this.transports).map(transport=>transport.stop()));this.status='idle'}
  diagnostics(){const exchanges=Object.fromEntries(Object.entries(this.transports).map(([id,transport])=>[id,transport.diagnostics()])),values=Object.values(exchanges);return{status:this.status,connections:values.reduce((sum,item)=>sum+item.connections,0),subscriptions:values.reduce((sum,item)=>sum+item.subscriptions,0),exchanges}}
}
module.exports={MultiExchangeMarketTransport};
