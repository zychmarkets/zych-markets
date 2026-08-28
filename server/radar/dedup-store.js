'use strict';
const exactKey=value=>`${value.market.marketId}|${value.timeframe}|${value.setupType}|${value.direction}`;
const contextKey=value=>`${value.market.marketId}|${value.timeframe}`;
class DedupStore{
  constructor({maxEntries=2000,ttlMs=86400000,cooldowns={'1m':300000,'5m':900000,'15m':1800000},materialChangePolicy,now=Date.now}={}){Object.assign(this,{maxEntries,ttlMs,cooldowns,materialChangePolicy,now});this.entries=new Map();this.stats={cooldownSuppressions:0,emittedAfterCooldown:0,emittedDueToNewConfirmation:0,emittedDueToStrongerMomentum:0,emittedDueToStrongerVolume:0,emittedDueToDirectionChange:0,materialChangeEvaluations:0,failures:0};this.stopped=false}
  prune(now=this.now()){for(const[key,value]of this.entries)if(now-value.emittedAt>this.ttlMs)this.entries.delete(key)}
  decide(opportunity){if(this.stopped)return{emit:false,reason:'STOPPED'};this.prune();const now=this.now(),key=exactKey(opportunity),exact=this.entries.get(key),context=[...this.entries.values()].filter(item=>item.contextKey===contextKey(opportunity)).sort((a,b)=>b.emittedAt-a.emittedAt)[0]||null,previous=exact||context;if(!previous)return{emit:true,reason:'FIRST_EMISSION',key};const cooldown=this.cooldowns[opportunity.timeframe]??this.cooldowns.default??300000;if(now-previous.emittedAt>=cooldown){this.stats.emittedAfterCooldown++;return{emit:true,reason:'COOLDOWN_EXPIRED',key}}this.stats.materialChangeEvaluations++;const change=this.materialChangePolicy.evaluate(previous,opportunity);if(change.material){const names={NEW_CONFIRMATION:'emittedDueToNewConfirmation',STRONGER_MOMENTUM:'emittedDueToStrongerMomentum',STRONGER_VOLUME:'emittedDueToStrongerVolume',DIRECTION_CHANGE:'emittedDueToDirectionChange'};if(names[change.reason])this.stats[names[change.reason]]++;return{emit:true,reason:change.reason,key}}this.stats.cooldownSuppressions++;return{emit:false,reason:'COOLDOWN_SUPPRESSED',key}}
  record(opportunity,eventId){const key=exactKey(opportunity),value={key,contextKey:contextKey(opportunity),eventId,emittedAt:this.now(),setupType:opportunity.setupType,direction:opportunity.direction,confirmationFactors:[...opportunity.confirmationFactors],metrics:{...opportunity.metrics}};this.entries.delete(key);this.entries.set(key,value);while(this.entries.size>this.maxEntries)this.entries.delete(this.entries.keys().next().value);return value}
  diagnostics(){return{storeSize:this.entries.size,maxEntries:this.maxEntries,ttlMs:this.ttlMs,...this.stats}}
  clear(){this.entries.clear()}
  stop(){this.stopped=true;this.clear()}
}
module.exports={DedupStore,exactKey};
