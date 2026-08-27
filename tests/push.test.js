'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const core = require('../js/alerts/alert-core.js');
const { JsonStorageAdapter, validSubscription } = require('../server/storage/json-storage.js');
const { WebPushNotifier, notificationText } = require('../server/notifiers/web-push-notifier.js');
const silent = { debug() {}, info() {}, warn() {}, error() {} };
const subscription = endpoint => ({ endpoint, keys: { p256dh: 'p'.repeat(65), auth: 'a'.repeat(16) } });
const trigger = { id: 'trigger-1', alertId: 'alert-1', asset: 'BTC', symbol: 'BTCUSDT', exchange: 'binance', alertType: 'price', triggerPrice: 78500, triggeredAt: 1000, condition: { type: 'price', operator: 'above', value: 78499 } };

test('subscription validation, deduplication and restart persistence', async () => {
  assert.equal(validSubscription({}), false); assert.equal(validSubscription(subscription('https://push.example/a')), true);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zych-push-')), storage = new JsonStorageAdapter({ directory, core, logger: silent }); await storage.init();
  await storage.savePushSubscription(subscription('https://push.example/a')); await storage.savePushSubscription(subscription('https://push.example/a')); assert.equal(storage.loadPushSubscriptions().length, 1);
  const reopened = new JsonStorageAdapter({ directory, core, logger: silent }); await reopened.init(); assert.equal(reopened.loadPushSubscriptions().length, 1); await fs.rm(directory, { recursive: true, force: true });
});

test('notification payload is compact, sanitized and trigger-specific', () => {
  const payload = notificationText(trigger); assert.equal(payload.type, 'alert-triggered'); assert.equal(payload.title, 'ZYCH Markets — BTC Alert'); assert.match(payload.body, /78,500/); assert.equal(payload.url, '/?trigger=trigger-1');
  const malformed = notificationText({ id: '<bad>\n', asset: 'ETH\u0000', alertType: 'movement', percentMove: 3.2, window: '15m' }); assert.equal(malformed.title.includes('\u0000'), false);
});

test('notifier receives TriggerEvent and isolates transient failure', async () => {
  const storage = { loadPushSubscriptions: () => [subscription('https://push.example/transient')], removePushSubscription: async () => { throw new Error('must not remove'); } }; let calls = 0;
  const notifier = new WebPushNotifier({ storage, logger: silent, publicKey: '', privateKey: '', subject: '', sendNotification: async () => { calls += 1; throw Object.assign(new Error('temporary'), { statusCode: 503 }); } }); notifier.enabled = true; await assert.doesNotReject(() => notifier.notify(trigger)); assert.equal(calls, 1);
});

test('one device subscription receives distinct BTC ETH SOL triggers', async () => {
  const sent = [], storage = { loadPushSubscriptions: () => [subscription('https://push.example/one-device')], removePushSubscription: async () => {} };
  const notifier = new WebPushNotifier({ storage, logger: silent, publicKey: '', privateKey: '', subject: '', sendNotification: async (_subscription, payload) => sent.push(JSON.parse(payload)) }); notifier.enabled = true;
  for (const asset of ['BTC', 'ETH', 'SOL']) await notifier.notify({ ...trigger, id: `trigger-${asset}`, alertId: `alert-${asset}`, asset, symbol: `${asset}USDT` });
  assert.equal(sent.length, 3); assert.deepEqual(sent.map(item => item.triggerId), ['trigger-BTC', 'trigger-ETH', 'trigger-SOL']);
});

test('expired subscription is removed without failing trigger pipeline', async () => {
  const removed = [], storage = { loadPushSubscriptions: () => [subscription('https://push.example/expired')], removePushSubscription: async endpoint => removed.push(endpoint) };
  const notifier = new WebPushNotifier({ storage, logger: silent, publicKey: '', privateKey: '', subject: '', sendNotification: async () => { throw Object.assign(new Error('gone'), { statusCode: 410 }); } }); notifier.enabled = true; await assert.doesNotReject(() => notifier.notify(trigger)); assert.deepEqual(removed, ['https://push.example/expired']);
});

test('service worker handles malformed push and constrains notification click URL', async () => {
  const listeners = {}, shown = [], opened = [];
  const context = { URL, encodeURIComponent, Date, self: { location: { origin: 'http://127.0.0.1:4178' }, registration: { showNotification: async (title, options) => shown.push({ title, options }) }, addEventListener: (name, handler) => { listeners[name] = handler; } }, clients: { matchAll: async () => [], openWindow: async url => opened.push(url) } };
  vm.runInNewContext(await fs.readFile(path.resolve(__dirname, '../sw.js'), 'utf8'), context);
  let pushWork; listeners.push({ data: { json: () => { throw new Error('bad'); } }, waitUntil: promise => { pushWork = promise; } }); await pushWork; assert.equal(shown[0].title, 'ZYCH Markets Alert');
  let clickWork; listeners.notificationclick({ notification: { data: { url: 'https://evil.example/' }, close() {} }, waitUntil: promise => { clickWork = promise; } }); await clickWork; assert.equal(opened[0], 'http://127.0.0.1:4178/');
});
