'use strict';
const {validateCandidateEvent,validateUnifiedEvent,SCHEMA_VERSION}=require('./event-schema.js');
class RadarEventPipeline{
  constructor({store,queueLimit=1000,promote=null,now=Date.now,logger={warn(){}}}){this.store=store;this.queueLimit=queueLimit;this.promote=promote;this.now=now;this.logger=logger;this.queue=[];this.processing=false;this.stopped=false;this.waiters=[];this.stats={candidateCount:0,publishedUnifiedCount:0,droppedEventsCount:0,validationFailures:0,consumerFailures:0,lastEventTimestamp:null,totalProcessingLagMs:0}}
  publishCandidate(candidate,complete=()=>{}){if(this.stopped)return false;const validation=validateCandidateEvent(candidate);if(!validation.valid){this.stats.validationFailures++;return false}this.stats.candidateCount++;if(this.queue.length>=this.queueLimit){this.queue.shift().complete(false);this.stats.droppedEventsCount++}this.queue.push({candidate,complete});this.drain();return true}
  publishCandidateAsync(candidate){return new Promise(resolve=>{if(!this.publishCandidate(candidate,resolve))resolve(false)})}
  publishUnified(event){const validation=validateUnifiedEvent(event);if(!validation.valid){this.stats.validationFailures++;return false}try{this.store.add(event);this.stats.publishedUnifiedCount++;this.stats.lastEventTimestamp=event.eventTimestamp;return true}catch(error){this.stats.consumerFailures++;this.logger.warn('radar_event_store_failed',{message:error.message});return false}}
  drain(){if(this.processing)return;this.processing=true;queueMicrotask(async()=>{while(this.queue.length&&!this.stopped){const {candidate,complete}=this.queue.shift();try{const output=await this.promote?.(candidate);const success=!output||this.publishUnified(output);complete(success);this.stats.totalProcessingLagMs+=Math.max(0,this.now()-candidate.createdAt)}catch(error){complete(false);this.stats.consumerFailures++;this.logger.warn('radar_candidate_consumer_failed',{message:error.message})}}this.processing=false;this.waiters.splice(0).forEach(resolve=>resolve())})}
  idle(){return this.processing?new Promise(resolve=>this.waiters.push(resolve)):Promise.resolve()}
  diagnostics(){return{status:this.stopped?'STOPPED':'READY',schemaVersion:SCHEMA_VERSION,queueDepth:this.queue.length,eventStoreCount:this.store.size,...this.stats,averageProcessingLagMs:this.stats.candidateCount?this.stats.totalProcessingLagMs/this.stats.candidateCount:0}}
  async stop(){this.stopped=true;await this.idle();this.queue.splice(0).forEach(item=>item.complete(false))}
}
module.exports={RadarEventPipeline};
