'use strict';
const {isDetector}=require('./detector-contract.js');
class DetectorRegistry{
  constructor({detectors=[],pipeline,logger={warn(){}}}={}){this.detectors=[];this.pipeline=pipeline;this.logger=logger;detectors.forEach(item=>this.register(item));this.running=true}
  register(detector){if(!isDetector(detector))throw new Error('Invalid detector');this.detectors.push(detector)}
  evaluate(input){if(!this.running||!input.event.isClosed||input.state.lastEvaluatedOpenTime===input.event.openTime)return 0;if(input.state.dataQuality!=='COMPLETE'){for(const detector of this.detectors)if(detector.stats){if(input.state.dataQuality==='WARMING_UP')detector.stats.skippedWarmingUp++;else detector.stats.skippedUnhealthy++}return 0}input.state.lastEvaluatedOpenTime=input.event.openTime;let count=0;for(const detector of this.detectors)try{for(const candidate of detector.evaluate(input)||[]){if(this.pipeline.publishCandidate(candidate))count++}}catch(error){this.logger.warn('radar_detector_failed',{detectorId:detector.id,message:error.message})}return count}
  async evaluateDetailed(input){
    const state=input.state;
    if(!this.running||!input.event.isClosed||state.lastEvaluatedOpenTime===input.event.openTime||state.dataQuality!=='COMPLETE')return {processed:false,success:false};
    state.lastEvaluatedOpenTime=input.event.openTime;
    const publications=[];let success=true;
    for(const detector of this.detectors)try{
      for(const candidate of detector.evaluate(input)||[])publications.push(this.pipeline.publishCandidateAsync?this.pipeline.publishCandidateAsync(candidate):Promise.resolve(this.pipeline.publishCandidate(candidate)));
    }catch(error){success=false;this.logger.warn('radar_detector_failed',{detectorId:detector.id,message:error.message})}
    const outcomes=await Promise.allSettled(publications);
    return {processed:true,success:success&&outcomes.every(r=>r.status==='fulfilled'&&r.value===true)};
  }
  diagnostics(){return this.detectors.map(item=>item.diagnostics?.()||{detectorId:item.id,detectorVersion:item.version})}
  stop(){this.running=false}
}
module.exports={DetectorRegistry};
