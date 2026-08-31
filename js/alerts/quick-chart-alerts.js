(function(global){
  'use strict';
  const coordinateToPrice=(series,y)=>{const price=Number(series?.coordinateToPrice?.(Number(y)));return Number.isFinite(price)&&price>0?price:null};
  const operatorFor=(level,current)=>Number(level)>=Number(current)?'above':'below';
  const definitionFor=(market,level,current)=>({marketId:market.id,asset:market.asset,baseAsset:market.baseAsset,quoteAsset:market.quoteAsset,exchange:market.exchange,symbol:market.symbol,condition:{type:'price',operator:operatorFor(level,current),value:Number(level)},mode:'once'});
  const canonical=value=>{const parts=String(value||'').split(':');return parts.length===2?`${parts[0]}:spot:${parts[1]}`:String(value||'')};
  const matchingAlerts=(alerts,marketId)=>(alerts||[]).filter(alert=>(alert.status==='active'||alert.status==='paused')&&canonical(alert.marketId)===canonical(marketId)&&alert.condition?.type==='price'&&Number.isFinite(Number(alert.condition.value)));
  const closestLine=(records,y,priceToCoordinate,hitRadius=9)=>{let best=null,distance=Infinity;for(const record of records||[]){const coordinate=Number(priceToCoordinate(Number(record.price))),delta=Math.abs(coordinate-Number(y));if(Number.isFinite(coordinate)&&delta<=hitRadius&&delta<distance){best=record;distance=delta}}return best};
  const exceedsDragThreshold=(start,x,y,threshold=4)=>Math.hypot(Number(x)-Number(start.x),Number(y)-Number(start.y))>=Number(threshold);
  class MenuController{
    constructor(element){this.element=element;this.payload=null}
    open({x,y,price,label}){this.payload={price:Number(price)};this.element.style.left=`${Math.max(0,Number(x))}px`;this.element.style.top=`${Math.max(0,Number(y))}px`;this.element.querySelector('[data-quick-alert-action]').textContent=`Add alert at ${label}`;this.element.hidden=false}
    close(){this.payload=null;this.element.hidden=true}
  }
  class UpdateCoordinator{
    constructor(){this.states=new Map()}
    register(id,price){const current=this.states.get(id);if(!current||!current.pending)this.states.set(id,{version:current?.version||0,confirmedPrice:Number(price),queue:current?.queue||Promise.resolve(),pending:false})}
    removeMissing(ids){const keep=new Set(ids);this.states.forEach((_state,id)=>{if(!keep.has(id))this.states.delete(id)})}
    commit(id,price,{update,apply,success=()=>{},failure=()=>{}}){const state=this.states.get(id);if(!state)throw new Error('Unknown alert');const version=++state.version;state.pending=true;const run=async()=>{try{const result=await update(id,Number(price));state.confirmedPrice=Number(result.alert?.condition?.value??price);if(version===state.version){apply(state.confirmedPrice);success(result)}return result}catch(error){if(version===state.version){apply(state.confirmedPrice);failure(error)}throw error}finally{if(version===state.version)state.pending=false}};state.queue=state.queue.catch(()=>{}).then(run);return state.queue}
    confirmed(id){return this.states.get(id)?.confirmedPrice}
  }
  class ActionCoordinator{
    constructor(){this.states=new Map()}
    register(id,status){const current=this.states.get(id);if(!current||!current.pending)this.states.set(id,{version:current?.version||0,confirmedStatus:status,queue:current?.queue||Promise.resolve(),pending:false})}
    removeMissing(ids){const keep=new Set(ids);this.states.forEach((_state,id)=>{if(!keep.has(id))this.states.delete(id)})}
    commit(id,status,{update,apply,success=()=>{},failure=()=>{},optimistic=true}){const state=this.states.get(id);if(!state)throw new Error('Unknown alert');const version=++state.version;state.pending=true;if(optimistic)apply(status);const run=async()=>{try{const result=await update(id,status);state.confirmedStatus=result.alert?.status??status;if(version===state.version){apply(state.confirmedStatus);success(result)}return result}catch(error){if(version===state.version){apply(state.confirmedStatus);failure(error)}throw error}finally{if(version===state.version)state.pending=false}};state.queue=state.queue.catch(()=>{}).then(run);return state.queue}
    confirmed(id){return this.states.get(id)?.confirmedStatus}
  }
  const api={coordinateToPrice,operatorFor,definitionFor,matchingAlerts,closestLine,exceedsDragThreshold,MenuController,UpdateCoordinator,ActionCoordinator};
  if(typeof module==='object'&&module.exports)module.exports=api;else global.ZychQuickAlerts=api;
})(typeof window!=='undefined'?window:globalThis);
