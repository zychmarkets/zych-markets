(function(global){
  'use strict';
  const instruments=typeof module==='object'&&module.exports?require('./instrument-search.js'):global.ZychInstruments;
  function create(value){const instrument=instruments.normalize(value?.instrument);if(!instrument||value?.instrumentId!==instrument.id||typeof value.id!=='string'||!value.id||!Number.isFinite(Number(value.timestamp))||typeof value.eventType!=='string'||!value.eventType)return null;return Object.freeze({id:value.id,instrumentId:instrument.id,instrument,timestamp:Number(value.timestamp),eventType:value.eventType,metrics:value.metrics&&typeof value.metrics==='object'?{...value.metrics}:{},reasons:Array.isArray(value.reasons)?[...value.reasons]:[],rank:Number.isFinite(Number(value.rank))?Number(value.rank):null})}
  const api={create};if(typeof module==='object'&&module.exports)module.exports=api;else global.ZychRadarEvent=api;
})(typeof window!=='undefined'?window:globalThis);
