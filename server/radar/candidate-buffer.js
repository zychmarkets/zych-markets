'use strict';
const keyOf=candidate=>`${candidate.market.marketId}|${candidate.timeframe}`;
class CandidateBuffer{
  constructor({maxSize=2000,maxPerKey=20,ttlMs=120000,now=Date.now}={}){Object.assign(this,{maxSize,maxPerKey,ttlMs,now});this.items=new Map();this.ids=new Set();this.stats={expiredCount:0,duplicateCandidateCount:0};this.stopped=false}
  prune(now=this.now()){for(const[key,rows]of this.items){const keep=rows.filter(item=>now-item.addedAt<=this.ttlMs);this.stats.expiredCount+=rows.length-keep.length;rows.filter(item=>!keep.includes(item)).forEach(item=>this.ids.delete(item.candidate.candidateId));if(keep.length)this.items.set(key,keep);else this.items.delete(key)}}
  add(candidate){if(this.stopped)return{added:false,reason:'STOPPED'};this.prune();if(this.ids.has(candidate.candidateId)){this.stats.duplicateCandidateCount++;return{added:false,reason:'DUPLICATE'}}const key=keyOf(candidate),rows=this.items.get(key)||[],entry={candidate,addedAt:this.now()};rows.push(entry);while(rows.length>this.maxPerKey){const removed=rows.shift();this.ids.delete(removed.candidate.candidateId)}this.items.set(key,rows);this.ids.add(candidate.candidateId);while(this.size>this.maxSize){const first=this.items.entries().next().value;if(!first)break;const[firstKey,firstRows]=first,removed=firstRows.shift();this.ids.delete(removed.candidate.candidateId);if(!firstRows.length)this.items.delete(firstKey)}return{added:true,key}}
  related(candidate,windowMs){this.prune();return(this.items.get(keyOf(candidate))||[]).map(item=>item.candidate).filter(item=>item.candidateId!==candidate.candidateId&&Math.abs(item.eventTimestamp-candidate.eventTimestamp)<=windowMs).sort((a,b)=>a.eventTimestamp-b.eventTimestamp)}
  get size(){let count=0;for(const rows of this.items.values())count+=rows.length;return count}
  diagnostics(){return{currentSize:this.size,keys:this.items.size,maxSize:this.maxSize,maxPerKey:this.maxPerKey,ttlMs:this.ttlMs,...this.stats}}
  clear(){this.items.clear();this.ids.clear()}
  stop(){this.stopped=true;this.clear()}
}
module.exports={CandidateBuffer,keyOf};
