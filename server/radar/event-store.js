'use strict';
class UnifiedEventStore{
  constructor({limit=500}={}){this.limit=limit;this.events=[];this.byId=new Map();this.stopped=false}
  add(event){if(this.stopped)throw new Error('Event store stopped');if(this.byId.has(event.eventId)){const error=new Error('Duplicate eventId');error.code='DUPLICATE_EVENT';throw error}this.events.unshift(event);this.byId.set(event.eventId,event);while(this.events.length>this.limit){const removed=this.events.pop();this.byId.delete(removed.eventId)}return event}
  getById(id){return this.byId.get(id)||null}
  listRecent({limit=50,exchange,marketType,symbol,eventType,timeframe}={}){return this.events.filter(event=>(!exchange||event.market.exchange===exchange)&&(!marketType||event.market.marketType===marketType)&&(!symbol||event.market.symbol===symbol)&&(!eventType||event.eventType===eventType)&&(!timeframe||event.timeframe===timeframe)).slice(0,Math.min(limit,200))}
  clear(){this.events=[];this.byId.clear()}
  stop(){this.stopped=true;this.clear()}
  get size(){return this.events.length}
}
module.exports={UnifiedEventStore};
