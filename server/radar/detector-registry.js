'use strict';
const {isDetector}=require('./detector-contract.js');
class DetectorRegistry{
  constructor({detectors=[],pipeline,logger={warn(){}}}={}){this.detectors=[];this.pipeline=pipeline;this.logger=logger;detectors.forEach(item=>this.register(item));this.running=true}
  register(detector){if(!isDetector(detector))throw new Error('Invalid detector');this.detectors.push(detector)}
  evaluate(input){if(!this.running||!input.event.isClosed||input.state.lastEvaluatedOpenTime===input.event.openTime)return 0;if(input.state.dataQuality!=='COMPLETE'){for(const detector of this.detectors)if(detector.stats){if(input.state.dataQuality==='WARMING_UP')detector.stats.skippedWarmingUp++;else detector.stats.skippedUnhealthy++}return 0}input.state.lastEvaluatedOpenTime=input.event.openTime;let count=0;for(const detector of this.detectors)try{for(const candidate of detector.evaluate(input)||[]){if(this.pipeline.publishCandidate(candidate))count++}}catch(error){this.logger.warn('radar_detector_failed',{detectorId:detector.id,message:error.message})}return count}
  diagnostics(){return this.detectors.map(item=>item.diagnostics?.()||{detectorId:item.id,detectorVersion:item.version})}
  stop(){this.running=false}
}
module.exports={DetectorRegistry};
