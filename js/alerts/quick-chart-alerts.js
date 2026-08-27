(function(global){
  'use strict';
  const coordinateToPrice=(series,y)=>{const price=Number(series?.coordinateToPrice?.(Number(y)));return Number.isFinite(price)&&price>0?price:null};
  const operatorFor=(level,current)=>Number(level)>=Number(current)?'above':'below';
  const definitionFor=(market,level,current)=>({marketId:market.id,asset:market.asset,baseAsset:market.baseAsset,quoteAsset:market.quoteAsset,exchange:market.exchange,symbol:market.symbol,condition:{type:'price',operator:operatorFor(level,current),value:Number(level)},mode:'once'});
  const matchingAlerts=(alerts,marketId)=>(alerts||[]).filter(alert=>alert.status==='active'&&alert.marketId===marketId&&alert.condition?.type==='price'&&Number.isFinite(Number(alert.condition.value)));
  class MenuController{
    constructor(element){this.element=element;this.payload=null}
    open({x,y,price,label}){this.payload={price:Number(price)};this.element.style.left=`${Math.max(0,Number(x))}px`;this.element.style.top=`${Math.max(0,Number(y))}px`;this.element.querySelector('[data-quick-alert-action]').textContent=`Add alert at ${label}`;this.element.hidden=false}
    close(){this.payload=null;this.element.hidden=true}
  }
  const api={coordinateToPrice,operatorFor,definitionFor,matchingAlerts,MenuController};
  if(typeof module==='object'&&module.exports)module.exports=api;else global.ZychQuickAlerts=api;
})(typeof window!=='undefined'?window:globalThis);
