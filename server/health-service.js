'use strict';
class HealthService {
  constructor({ lifecycle, universe, radar, eventPipeline, now = Date.now, minimumCompleteRatio = .1, maximumHealthyAgeMs = 180000 } = {}) { Object.assign(this,{lifecycle,universe,radar,eventPipeline,now,minimumCompleteRatio,maximumHealthyAgeMs});this.unsubscribe=null; }
  start(){if(!this.unsubscribe)this.unsubscribe=this.radar?.subscribeState?.(()=>this.assess())||null;return this.assess()}
  stop(){this.unsubscribe?.();this.unsubscribe=null}
  assess() {
    const current=this.lifecycle.snapshot();
    if (['STARTING','STOPPING','STOPPED'].includes(current.state)) return { ready:false, lifecycle:current.state, reasonCodes:current.reasonCodes.length?current.reasonCodes:[`APPLICATION_${current.state}`] };
    if (!this.universe || !this.radar?.running || this.eventPipeline?.stopped) return this.update(false,['RADAR_UNAVAILABLE']);
    const coverage=this.universe.health?.().coverage, selected=coverage?.selectedMarketCount||this.radar.selected?.size||0, healthyExchanges=coverage?.healthyExchanges?.length||0, state=this.radar.store?.diagnostics?.()||{}, complete=state.COMPLETE||0, total=state.totalStateEntries||0, ratio=total?complete/total:0;
    if (!selected || !healthyExchanges) return this.update(false,['ESSENTIAL_PROCESSING_UNAVAILABLE']);
    const lastHealthy=this.radar.stats?.lastHealthyProcessingTimestamp;
    if (!complete || ratio<this.minimumCompleteRatio || !lastHealthy) return this.update(false,['RADAR_WARMING_UP']);
    if(this.now()-lastHealthy>this.maximumHealthyAgeMs)return this.update(false,['HEALTHY_PROCESSING_STALE']);
    const degraded=healthyExchanges<(coverage?.expectedExchanges?.length||healthyExchanges)||complete<total;
    return this.update(true,degraded?['PARTIAL_PROCESSING_AVAILABLE']:[]);
  }
  update(ready,reasonCodes){const state=ready?(reasonCodes.length?'DEGRADED':'READY'):'WARMING_UP',current=this.lifecycle.snapshot(),unchanged=current.state===state&&current.reasonCodes.length===reasonCodes.length&&current.reasonCodes.every((value,index)=>value===reasonCodes[index]);if(!unchanged)this.lifecycle.transition(state,reasonCodes);return{ready,lifecycle:this.lifecycle.state,reasonCodes:[...reasonCodes]}}
  live(){return{status:'alive',timestamp:this.now()}}
  ready(){const assessment=this.assess();return{status:assessment.ready?'ready':'not_ready',lifecycle:assessment.lifecycle,reasonCodes:assessment.reasonCodes,timestamp:this.now()}}
}
module.exports={HealthService};
