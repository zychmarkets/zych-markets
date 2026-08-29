'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {CandleStreamAdapter,BYBIT_MAX_ARGS_PER_SUBSCRIBE,chunk}=require('../server/radar/candle-stream-adapters.js');

const market=(exchange,index)=>({marketId:`${exchange}:spot:M${index}USDT`,exchange,marketType:'spot',symbol:`M${index}USDT`,baseAsset:`M${index}`,quoteAsset:'USDT'});
const markets=(exchange,count)=>Array.from({length:count},(_,index)=>market(exchange,index));

class FakeSocket{
  static instances=[];
  constructor(url){this.url=url;this.readyState=0;this.listeners={};this.sent=[];this.closed=false;FakeSocket.instances.push(this)}
  addEventListener(type,handler){this.listeners[type]=handler}
  send(value){this.sent.push(JSON.parse(value))}
  open(){this.readyState=1;this.listeners.open?.()}
  close(code,reason){this.readyState=3;this.closed=true;this.closeCode=code;this.closeReason=reason}
  disconnect(){this.readyState=3;this.listeners.close?.()}
}

const adapter=(exchange,options={})=>{FakeSocket.instances=[];return new CandleStreamAdapter({exchange,wsBase:`wss://${exchange}.test`,WebSocketImpl:FakeSocket,logger:{warn(){}},...options})};

async function bybitMessages(count){const stream=adapter('bybit');await stream.start(markets('bybit',count),['1m']);assert.equal(FakeSocket.instances.length,1);FakeSocket.instances[0].open();const messages=FakeSocket.instances[0].sent;await stream.stop();return messages}

for(const [count,expectedSizes]of [[1,[1]],[10,[10]],[11,[10,1]],[30,[10,10,10]],[100,Array(10).fill(10)]])test(`Bybit ${count} topics use subscribe batches ${expectedSizes.join('+')}`,async()=>{const messages=await bybitMessages(count);assert.deepEqual(messages.map(item=>item.args.length),expectedSizes);assert.equal(messages.every(item=>item.op==='subscribe'&&item.args.length<=BYBIT_MAX_ARGS_PER_SUBSCRIBE),true);assert.equal(new Set(messages.flatMap(item=>item.args)).size,count)});

test('Binance URL subscription behavior remains unchanged',async()=>{const stream=adapter('binance');await stream.start(markets('binance',2),['1m']);assert.equal(FakeSocket.instances.length,1);assert.equal(FakeSocket.instances[0].url,'wss://binance.test/stream?streams=m0usdt@kline_1m/m1usdt@kline_1m');FakeSocket.instances[0].open();assert.deepEqual(FakeSocket.instances[0].sent,[]);await stream.stop()});

test('OKX sends its existing single subscribe message unchanged',async()=>{const stream=adapter('okx');await stream.start(markets('okx',11),['1m']);assert.equal(FakeSocket.instances.length,1);FakeSocket.instances[0].open();assert.equal(FakeSocket.instances[0].sent.length,1);assert.equal(FakeSocket.instances[0].sent[0].args.length,11);assert.deepEqual(FakeSocket.instances[0].sent[0].args[0],{channel:'candle1m',instId:'M0USDT'});await stream.stop()});

test('Bybit reconnect resubscribes once without multiplying or duplicating topics',async()=>{const stream=adapter('bybit');await stream.start(markets('bybit',11),['1m']);const first=FakeSocket.instances[0];first.open();assert.deepEqual(first.sent.map(item=>item.args.length),[10,1]);first.disconnect();await new Promise(resolve=>setTimeout(resolve,1100));assert.equal(FakeSocket.instances.length,2);const second=FakeSocket.instances[1];second.open();assert.deepEqual(second.sent.map(item=>item.args.length),[10,1]);assert.deepEqual(second.sent,first.sent);assert.equal(new Set(second.sent.flatMap(item=>item.args)).size,11);await stream.stop();await new Promise(resolve=>setTimeout(resolve,10));assert.equal(FakeSocket.instances.length,2)});

test('Bybit batching composes with existing socket sharding',async()=>{const stream=adapter('bybit',{maxTopicsPerSocket:12});await stream.start(markets('bybit',25),['1m']);assert.equal(FakeSocket.instances.length,3);FakeSocket.instances.forEach(socket=>socket.open());assert.deepEqual(FakeSocket.instances.map(socket=>socket.sent.map(item=>item.args.length)),[[10,2],[10,2],[1]]);assert.equal(new Set(FakeSocket.instances.flatMap(socket=>socket.sent.flatMap(item=>item.args))).size,25);await stream.stop()});

test('batch helper is explicit, stable and non-mutating',()=>{const values=Array.from({length:11},(_,index)=>index),before=[...values];assert.deepEqual(chunk(values,10),[values.slice(0,10),[10]]);assert.deepEqual(values,before)});
