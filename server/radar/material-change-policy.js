'use strict';
class MaterialChangePolicy{
  constructor({momentumZDelta=1,volumeRelativeDelta=1,volumeZDelta=1}={}){Object.assign(this,{momentumZDelta,volumeRelativeDelta,volumeZDelta})}
  evaluate(previous,next){if(!previous)return{material:true,reason:'FIRST_EMISSION'};if(previous.direction!==next.direction)return{material:true,reason:'DIRECTION_CHANGE'};const before=new Set(previous.confirmationFactors),newConfirmation=next.confirmationFactors.some(item=>!before.has(item));if(newConfirmation)return{material:true,reason:'NEW_CONFIRMATION'};if(Math.abs(Number(next.metrics.momentumDeviationZScore||0))-Math.abs(Number(previous.metrics.momentumDeviationZScore||0))>=this.momentumZDelta)return{material:true,reason:'STRONGER_MOMENTUM'};if(Number(next.metrics.relativeVolume||0)-Number(previous.metrics.relativeVolume||0)>=this.volumeRelativeDelta||Number(next.metrics.volumeDeviationZScore||0)-Number(previous.metrics.volumeDeviationZScore||0)>=this.volumeZDelta)return{material:true,reason:'STRONGER_VOLUME'};return{material:false,reason:'NO_MATERIAL_CHANGE'}}
}
module.exports={MaterialChangePolicy};
