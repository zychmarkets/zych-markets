'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const core = require('../js/alerts/alert-core.js');
const { JsonStorageAdapter } = require('../server/storage/json-storage.js');
const { ServerAlertRunner } = require('../server/alert-runner.js');
const { createServerApp } = require('../server/app.js');
const { BinanceMarketTransport } = require('../server/transports/binance-market-transport.js');
const { BybitMarketTransport } = require('../server/transports/bybit-market-transport.js');
const { createUnifiedEvent } = require('../server/radar/event-schema.js');

const silent = { debug() {}, info() {}, warn() {}, error() {} };
class FakeTransport {
  constructor() { this.starts = 0; this.stops = 0; this.alerts = []; this.handlers = {}; this.connections = 0; }
  async start(alerts, handlers) { this.starts += 1; this.alerts = alerts; this.handlers = handlers; this.connections = alerts.length ? 1 : 0; }
  async stop() { this.stops += 1; this.connections = 0; }
  emit(event) { return this.handlers.onEvent?.(event); }
  diagnostics() { return { status: this.connections ? 'live' : 'idle', connections: this.connections, subscriptions: new Set(this.alerts.map(a => `${a.symbol}:${a.type}`)).size }; }
}
const definition = (condition = { type: 'price', operator: 'above', value: 100 }, mode = 'once', asset = 'BTC') => ({ marketId: `binance:${asset}USDT`, exchange: 'binance', symbol: `${asset}USDT`, baseAsset: asset, asset, quoteAsset: 'USDT', condition, mode });
const ticker = (price, asset = 'BTC') => ({ exchange: 'binance', symbol: `${asset}USDT`, baseAsset: asset, quoteAsset: 'USDT', eventType: 'ticker', price, timestamp: Date.now() });
const candle = values => ({ exchange: 'binance', symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', eventType: 'candle', interval: '1h', price: values.price, open: values.open ?? 100, high: 110, low: 90, volume: values.volume ?? 100, averageVolume: values.averageVolume ?? 50, timestamp: Date.now() });

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zych-server-'));
  const storage = new JsonStorageAdapter({ directory, core, logger: silent, historyLimit: 500 }); await storage.init();
  const transport = new FakeTransport(), notifications = [];
  const runner = new ServerAlertRunner({ core, storage, transport, notifier: { notify: event => notifications.push(event) }, logger: silent }); await runner.start();
  return { directory, storage, transport, notifications, runner, async close() { await runner.stop(); await fs.rm(directory, { recursive: true, force: true }); } };
}

test('durable storage survives restart, deduplicates records and recovers corruption', async () => {
  const f = await fixture(); const created = await f.runner.create(definition()); await f.runner.pause(created.alert.id); await f.runner.stop();
  const reopened = new JsonStorageAdapter({ directory: f.directory, core, logger: silent }); await reopened.init(); assert.equal(reopened.loadAlerts()[0].status, 'paused');
  const raw = JSON.parse(await fs.readFile(reopened.file, 'utf8')); raw.alerts.push(raw.alerts[0]); await fs.writeFile(reopened.file, JSON.stringify(raw)); const duplicate = new JsonStorageAdapter({ directory: f.directory, core, logger: silent }); await duplicate.init(); assert.equal(duplicate.loadAlerts().length, 1);
  await fs.writeFile(duplicate.file, '{broken'); const recovered = new JsonStorageAdapter({ directory: f.directory, core, logger: silent }); await recovered.init(); assert.deepEqual(recovered.loadAlerts(), []); await fs.rm(f.directory, { recursive: true, force: true });
});

test('runner supports lifecycle, once, recurring, re-arm and all conditions', async () => {
  const f = await fixture();
  const once = await f.runner.create(definition()); await f.runner.handle(ticker(99)); assert.equal(f.notifications.length,0); await f.runner.handle(ticker(101)); assert.equal(f.runner.list().find(a => a.id === once.alert.id).status, 'triggered');
  const recurring = await f.runner.create(definition({ type: 'price', operator: 'below', value: 100 }, 'recurring', 'ETH')); await f.runner.handle(ticker(101, 'ETH')); await f.runner.handle(ticker(99, 'ETH')); await f.runner.handle(ticker(98, 'ETH')); assert.equal(f.runner.list().find(a => a.id === recurring.alert.id).triggerCount, 1); await f.runner.handle(ticker(101, 'ETH')); f.runner.alerts.find(a => a.id === recurring.alert.id).lastTriggeredAt = 0; await f.runner.handle(ticker(99, 'ETH')); assert.equal(f.runner.list().find(a => a.id === recurring.alert.id).triggerCount, 2);
  await f.runner.create(definition({ type: 'movement', direction: 'up', percent: 5, window: '1h' })); await f.runner.handle(candle({ price: 106 }));
  await f.runner.create(definition({ type: 'movement', direction: 'down', percent: 5, window: '1h' })); await f.runner.handle(candle({ price: 94 }));
  await f.runner.create(definition({ type: 'volume', multiplier: 2, timeframe: '1h' })); await f.runner.handle(candle({ price: 100, volume: 201, averageVolume: 100 }));
  assert.equal(f.notifications.length, 6); await f.close();
});

test('runner keeps a baseline per normalized market and dispatches a crossing exactly once', async () => {
  const f=await fixture(),bybit={marketId:'bybit:spot:BTCUSDT',exchange:'bybit',marketType:'spot',symbol:'BTCUSDT',baseAsset:'BTC',quoteAsset:'USDT',condition:{type:'price',operator:'above',value:100},mode:'once'};
  const created=(await f.runner.create(bybit)).alert;
  await f.runner.handle({exchange:'binance',marketType:'spot',symbol:'BTCUSDT',eventType:'ticker',price:99,timestamp:1});
  await f.runner.handle({exchange:'binance',marketType:'spot',symbol:'BTCUSDT',eventType:'ticker',price:101,timestamp:2});
  assert.equal(f.notifications.length,0); assert.equal(f.runner.list().find(a=>a.id===created.id).status,'active');
  await f.runner.handle({marketId:'bybit:spot:BTCUSDT',exchange:'bybit',marketType:'spot',symbol:'BTCUSDT',eventType:'ticker',price:99,timestamp:3});
  await f.runner.handle({marketId:'bybit:spot:BTCUSDT',exchange:'bybit',marketType:'spot',symbol:'BTCUSDT',eventType:'ticker',price:101,timestamp:4});
  await f.runner.handle({marketId:'bybit:spot:BTCUSDT',exchange:'bybit',marketType:'spot',symbol:'BTCUSDT',eventType:'ticker',price:102,timestamp:5});
  assert.equal(f.notifications.length,1); assert.equal(f.runner.events().length,1); assert.equal(f.runner.list().find(a=>a.id===created.id).status,'triggered'); await f.close();
});

test('normalized Bybit websocket ticks reach the authoritative runner after subscribe and reconnect',async()=>{
  const f=await fixture(),created=(await f.runner.create({marketId:'bybit:spot:BTCUSDT',exchange:'bybit',marketType:'spot',symbol:'BTCUSDT',baseAsset:'BTC',quoteAsset:'USDT',condition:{type:'price',operator:'above',value:100},mode:'once'})).alert,sockets=[];
  class FakeSocket{constructor(){this.readyState=0;this.listeners={};this.sent=[];sockets.push(this)}addEventListener(type,handler){this.listeners[type]=handler}send(value){this.sent.push(JSON.parse(value))}close(){this.readyState=3}}
  const transport=new BybitMarketTransport({restBase:'',wsBase:'ws://bybit',logger:silent,WebSocketImpl:FakeSocket,reconnectBaseMs:1,reconnectMaxMs:1});
  await transport.start([created],{onEvent:event=>f.runner.enqueue(event)});sockets[0].readyState=1;sockets[0].listeners.open();sockets[0].listeners.message({data:JSON.stringify({success:true,op:'subscribe'})});sockets[0].listeners.message({data:JSON.stringify({topic:'tickers.BTCUSDT',ts:1,data:{symbol:'BTCUSDT',lastPrice:'99'}})});await f.runner.queue;sockets[0].readyState=3;sockets[0].listeners.close({code:1006,reason:'test'});await new Promise(resolve=>setTimeout(resolve,5));sockets[1].readyState=1;sockets[1].listeners.open();sockets[1].listeners.message({data:JSON.stringify({success:true,op:'subscribe'})});sockets[1].listeners.message({data:JSON.stringify({topic:'tickers.BTCUSDT',ts:2,data:{symbol:'BTCUSDT',lastPrice:'101'}})});await f.runner.queue;assert.deepEqual(sockets[1].sent[0].args,['tickers.BTCUSDT']);assert.equal(f.notifications.length,1);assert.equal(f.runner.list().find(alert=>alert.id===created.id).status,'triggered');await transport.stop();await f.close();
});

test('100 alerts across BTC ETH SOL use one transport and unique subscriptions', async () => {
  const f = await fixture();
  for (let index = 0; index < 100; index += 1) { const asset = ['BTC', 'ETH', 'SOL'][index % 3]; await f.runner.create(definition({ type: 'price', operator: 'above', value: 100 + index }, 'once', asset)); }
  const diagnostics = f.runner.diagnostics(); assert.equal(diagnostics.activeAlerts, 100); assert.equal(diagnostics.activeMarkets, 3); assert.equal(diagnostics.connections, 1); assert.equal(diagnostics.subscriptions, 3); await f.close();
});

test('price update preserves alert identity and changes only condition value', async () => {
  const f=await fixture(),created=await f.runner.create(definition()),before=created.alert,result=await f.runner.updatePrice(before.id,123.45),after=result.alert;
  assert.equal(after.id,before.id);assert.equal(after.exchange,before.exchange);assert.equal(after.marketId,before.marketId);assert.equal(after.symbol,before.symbol);assert.equal(after.type,'price');assert.equal(after.condition.operator,before.condition.operator);assert.equal(after.condition.value,123.45);assert.equal(f.runner.list().length,1);assert.equal((await f.runner.updatePrice(before.id,-1)).error,'INVALID_PRICE');await f.close();
});

test('pause preserves identity and price, suppresses triggers, and resume restores evaluation', async () => {
  const f=await fixture(),created=(await f.runner.create(definition())).alert,before=structuredClone(created),paused=await f.runner.pause(created.id);
  assert.equal(paused.id,before.id);assert.equal(paused.marketId,before.marketId);assert.equal(paused.exchange,before.exchange);assert.equal(paused.symbol,before.symbol);assert.deepEqual(paused.condition,before.condition);assert.equal(paused.status,'paused');await f.runner.handle(ticker(101));assert.equal(f.notifications.length,0);assert.equal(f.runner.list().find(alert=>alert.id===created.id).status,'paused');const resumed=await f.runner.resume(created.id);assert.equal(resumed.id,before.id);assert.deepEqual(resumed.condition,before.condition);await f.runner.handle(ticker(99));await f.runner.handle(ticker(101));assert.equal(f.notifications.length,1);await f.close();
});

test('HTTP API health, CRUD, validation and malformed payload', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zych-api-')), transport = new FakeTransport();
  const config = { host: '127.0.0.1', port: 0, dataDir: directory, historyLimit: 500, logLevel: 'error', root: path.resolve(__dirname, '..'), binanceRestBase: '', binanceWsBase: '' };
  const universe={stopped:false,async initialize(){},getSnapshot:({includeExcluded,excludedLimit=100,excludedOffset=0}={})=>({generatedAt:1,policyVersion:'test',markets:[{marketId:'binance:spot:BTCUSDT',exchange:'binance',marketType:'spot',symbol:'BTCUSDT',eligibility:{eligible:true,liquidityTier:'A',reasons:['ACTIVE_MARKET']}}],...(includeExcluded?{excludedMarkets:[],excludedPagination:{offset:excludedOffset,limit:excludedLimit,total:0}}:{}),coverage:{status:'HEALTHY'}}),health:()=>({generatedAt:1,policyVersion:'test',coverage:{status:'HEALTHY'}}),async stop(){this.stopped=true}};
  const app = await createServerApp({ config, logger: silent, transport, universe }); const address = await app.listen(), base = `http://127.0.0.1:${address.port}/api`;
  let response = await fetch(`${base}/health`); assert.equal(response.status, 200); assert.equal((await response.json()).status, 'ok');
  response=await fetch(`${base}/radar/universe?includeExcluded=true`);assert.equal(response.status,400);response=await fetch(`${base}/radar/universe?diagnostics=true&includeExcluded=true&excludedLimit=20`);assert.equal(response.status,200);const radar=await response.json();assert.equal(radar.markets[0].marketType,'spot');assert.deepEqual(radar.excludedMarkets,[]);assert.equal(radar.excludedPagination.limit,20);
  response=await fetch(`${base}/radar/universe/health`);assert.equal((await response.json()).coverage.status,'HEALTHY');
  const radarEvent=createUnifiedEvent({detectorId:'test',detectorVersion:'1',eventType:'TEST',market:{marketId:'binance:spot:BTCUSDT',exchange:'binance',marketType:'spot',symbol:'BTCUSDT',baseAsset:'BTC',quoteAsset:'USDT'},timeframe:'1h',eventTimestamp:Date.now(),observedAt:Date.now(),deepLink:{marketId:'binance:spot:BTCUSDT',exchange:'binance',marketType:'spot',symbol:'BTCUSDT',timeframe:'1h',eventTimestamp:Date.now()}},{id:'api-event'});app.eventStore.add(radarEvent);response=await fetch(`${base}/radar/events?exchange=binance&limit=1`);assert.equal((await response.json()).events[0].eventId,'api-event');assert.equal((await fetch(`${base}/radar/events?limit=9999`)).status,400);assert.equal((await fetch(`${base}/radar/events/api-event`)).status,200);assert.equal((await fetch(`${base}/radar/events/missing`)).status,404);
  response = await fetch(`${base}/alerts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(definition()) }); assert.equal(response.status, 201); const id = (await response.json()).alert.id;
  response = await fetch(`${base}/alerts`); assert.equal((await response.json()).alerts.length, 1);
  response = await fetch(`${base}/alerts/${id}/price`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: 123.45 }) }); assert.equal(response.status, 200); assert.equal((await response.json()).alert.condition.value, 123.45);
  assert.equal((await fetch(`${base}/alerts/${id}/price`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: 0 }) })).status, 422);
  assert.equal((await fetch(`${base}/alerts/${id}/pause`, { method: 'POST' })).status, 200); assert.equal((await fetch(`${base}/alerts/${id}/resume`, { method: 'POST' })).status, 200);
  assert.equal((await fetch(`${base}/alerts`, { method: 'POST', body: '{}' })).status, 422); assert.equal((await fetch(`${base}/alerts`, { method: 'POST', body: '{' })).status, 400);
  assert.equal((await fetch(`${base}/push/public-key`)).status, 503);
  const pushRecord = { endpoint: 'https://push.example/device', keys: { p256dh: 'p'.repeat(65), auth: 'a'.repeat(16) } };
  assert.equal((await fetch(`${base}/push/subscribe`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(pushRecord) })).status, 201);
  assert.equal((await fetch(`${base}/push/subscribe`, { method: 'POST', body: '{}' })).status, 422);
  assert.equal((await fetch(`${base}/push/unsubscribe`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: pushRecord.endpoint }) })).status, 200);
  assert.equal((await fetch(`${base}/alerts/${id}`, { method: 'DELETE' })).status, 204); await app.stop();assert.equal(universe.stopped,true); await fs.rm(directory, { recursive: true, force: true });
});

test('Binance transport reconnects and resubscribes without duplicate streams', async () => {
  const sockets = [];
  class FakeSocket {
    constructor() { this.readyState = 0; this.listeners = {}; this.sent = []; sockets.push(this); }
    addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }
    emit(name, value = {}) { this.listeners[name]?.forEach(fn => fn(value)); }
    send(value) { this.sent.push(JSON.parse(value)); }
    close() { this.readyState = 3; }
  }
  const transport = new BinanceMarketTransport({ restBase: '', wsBase: 'ws://test', logger: silent, WebSocketImpl: FakeSocket, fetchImpl: async () => ({ ok: true, json: async () => [] }), reconnectBaseMs: 1, reconnectMaxMs: 1 });
  const alerts = [core.createAlert(definition(), { id: 'a', now: 1 }), core.createAlert(definition({ type: 'price', operator: 'above', value: 200 }), { id: 'b', now: 1 })];
  await transport.start(alerts, {}); sockets[0].emit('open'); assert.deepEqual(sockets[0].sent[0].params, ['btcusdt@ticker']); sockets[0].emit('close'); await new Promise(resolve => setTimeout(resolve, 5)); sockets[1].emit('open'); assert.deepEqual(sockets[1].sent[0].params, ['btcusdt@ticker']); await transport.stop(); assert.equal(transport.diagnostics().connections, 0);
});
