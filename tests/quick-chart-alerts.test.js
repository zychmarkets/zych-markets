'use strict';
const assert=require('node:assert/strict');
const quick=require('../js/alerts/quick-chart-alerts.js');
assert.equal(quick.coordinateToPrice({coordinateToPrice:y=>100-y},25),75);
assert.equal(quick.coordinateToPrice({coordinateToPrice:()=>NaN},25),null);
assert.equal(quick.operatorFor(101,100),'above');assert.equal(quick.operatorFor(99,100),'below');
const market=(exchange,symbol)=>({id:`${exchange}:${symbol}`,marketId:`${exchange}:${symbol}`,exchange,symbol,asset:'BTC',baseAsset:'BTC',quoteAsset:'USDT'});
for(const [exchange,symbol] of [['binance','BTCUSDT'],['bybit','BTCUSDT'],['okx','BTC-USDT']]){const definition=quick.definitionFor(market(exchange,symbol),101,100);assert.equal(definition.exchange,exchange);assert.equal(definition.marketId,`${exchange}:${symbol}`);assert.equal(definition.symbol,symbol);assert.equal(definition.condition.operator,'above')}
const alerts=[...['binance:BTCUSDT','bybit:BTCUSDT','okx:BTC-USDT'].map((marketId,index)=>({id:String(index),marketId,status:'active',condition:{type:'price',value:100+index}})),{id:'paused',marketId:'binance:BTCUSDT',status:'paused',condition:{type:'price',value:90}},{id:'volume',marketId:'binance:BTCUSDT',status:'active',condition:{type:'volume',value:90}}];
assert.deepEqual(quick.matchingAlerts(alerts,'binance:BTCUSDT').map(item=>item.id),['0']);assert.deepEqual(quick.matchingAlerts(alerts,'bybit:BTCUSDT').map(item=>item.id),['1']);assert.deepEqual(quick.matchingAlerts(alerts,'okx:BTC-USDT').map(item=>item.id),['2']);
const action={textContent:''},element={hidden:true,style:{},querySelector:()=>action},menu=new quick.MenuController(element);menu.open({x:10,y:20,price:123,label:'123.00'});assert.equal(element.hidden,false);assert.equal(menu.payload.price,123);assert.match(action.textContent,/123\.00/);menu.close();assert.equal(element.hidden,true);assert.equal(menu.payload,null);
console.log('quick chart alerts tests: PASS');
