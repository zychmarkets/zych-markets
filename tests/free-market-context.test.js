'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFreeMarketContext, normalize, SOURCES } = require('../server/free-market-context');
const { presentation, render, Client } = require('../js/services/free-market-context');
const { createHttpServer } = require('../server/http-server');
const NOW = 1788638400000;
test('default browser functions retain the global receiver during refresh and disposal', async () => {
  const vm = require('node:vm'), fs = require('node:fs');
  const context = vm.createContext({ AbortController, Response });
  vm.runInContext(`
    'use strict';
    globalThis.calls = [];
    globalThis.setTimeout = function (callback, delay) {
      if (this !== globalThis) throw new TypeError('Illegal invocation');
      calls.push(['setTimeout', delay]); return calls.length;
    };
    globalThis.clearTimeout = function (id) {
      if (this !== globalThis) throw new TypeError('Illegal invocation');
      calls.push(['clearTimeout', id]);
    };
    globalThis.fetch = async function (url) {
      if (this !== globalThis) throw new TypeError('Illegal invocation');
      calls.push(['fetch', url]);
      return new Response(JSON.stringify({ generatedAt: 1788638400000, metrics: {
        fearGreed: { value: 73, status: 'current' },
        totalCap: { value: 2500000000000, status: 'current' },
        btcDominance: { value: 64, status: 'current' }
      }}));
    };
  `, context);
  vm.runInContext(fs.readFileSync(require.resolve('../js/services/free-market-context'), 'utf8'), context);
  await vm.runInContext(`(async () => {
    const client = new ZychFreeMarketContext.Client();
    await client.refresh();
    globalThis.result = client.payload;
    client.dispose();
  })()`, context);
  assert.equal(context.result.metrics.fearGreed.value, 73);
  assert.equal(context.result.metrics.fearGreed.status, 'current');
  assert.equal(context.calls.filter(call => call[0] === 'fetch').length, 1);
  assert.ok(context.calls.some(call => call[0] === 'setTimeout' && call[1] === 60000));
  assert.equal(context.calls.filter(call => call[0] === 'clearTimeout').length, 3);
});
function fixtures() {
  return {
    fearGreed: { data: [{ value: '0', timestamp: String(NOW / 1000 - 3600), value_classification: 'Extreme Fear' }], metadata: { error: null } },
    global: { data: { active_cryptocurrencies: 178, bitcoin_percentage_of_market_cap: 0.64, quotes: { USD: { total_market_cap: 2500000000000 } }, last_updated: NOW / 1000 }, metadata: { error: null } },
    bitcoin: { data: { '1': { id: 1, symbol: 'BTC', quotes: { USD: { market_cap: 1600000000000 } }, last_updated: NOW / 1000 - 120 } }, metadata: { error: null } }
  };
}
function fixture() {
  let time = NOW; const data = fixtures(), calls = [], fail = new Set();
  const get = createFreeMarketContext({ now: () => time, fetchImpl: async (url, options) => {
    const key = Object.keys(SOURCES).find(key => SOURCES[key] === url);
    assert.ok(key); assert.equal(options.redirect, 'error'); calls.push(key);
    if (fail.has(key)) throw new Error('offline');
    return new Response(JSON.stringify(data[key]));
  } });
  return { get, data, calls, fail, advance: ms => { time += ms; } };
}
test('free context preserves zero sentiment and derives dominance independently of ambiguous percentage units', async () => {
  const f = fixture(); const { metrics } = await f.get();
  assert.equal(metrics.fearGreed.value, 0); assert.equal(metrics.fearGreed.status, 'current');
  assert.equal(metrics.btcDominance.value, 64); assert.equal(metrics.btcDominance.unit, '%');
  assert.equal(metrics.btcDominance.asOf, NOW - 120000); assert.equal(metrics.btcDominance.coverage, 178);
  assert.equal(metrics.totalCap.unit, 'USD'); assert.match(metrics.fearGreed.scope, /Bitcoin/);
  f.data.global.data.bitcoin_percentage_of_market_cap = 64; f.advance(300001);
  assert.equal((await f.get()).metrics.btcDominance.value, 64);
});
test('concurrent clients coalesce requests and warm reads do not contact providers', async () => {
  const f = fixture(); await Promise.all(Array.from({ length: 20 }, () => f.get()));
  assert.equal(f.calls.length, 3); await f.get(); assert.equal(f.calls.length, 3);
  f.advance(300001); await f.get(); assert.equal(f.calls.length, 6);
});
test('a failed provider preserves stale values without marking them fresh; other metrics survive', async () => {
  const f = fixture(); const before = await f.get(); f.advance(300001); f.fail.add('global');
  const after = await f.get(); assert.equal(after.metrics.totalCap.status, 'stale');
  assert.equal(after.metrics.totalCap.asOf, before.metrics.totalCap.asOf);
  assert.equal(after.metrics.totalCap.receivedAt, before.metrics.totalCap.receivedAt);
  assert.equal(after.metrics.btcDominance.status, 'stale'); assert.equal(after.metrics.fearGreed.status, 'current');
  f.fail.delete('global'); f.advance(30001); assert.equal((await f.get()).metrics.totalCap.status, 'current');
});
test('empty cold responses remain unavailable and use a failure retry cooldown', async () => {
  const f = fixture(); f.fail.add('global'); f.fail.add('bitcoin');
  const { metrics } = await f.get(); assert.equal(metrics.totalCap.value, null); assert.equal(metrics.btcDominance.value, null);
  assert.equal(metrics.fearGreed.value, 0); await f.get(); assert.equal(f.calls.length, 3);
  f.advance(30001); await f.get(); assert.equal(f.calls.length, 5);
});
test('dominance rejects mismatched timestamps and impossible capitalization ratios', async () => {
  for (const change of [data => { data.bitcoin.data['1'].last_updated -= 3600; }, data => { data.bitcoin.data['1'].quotes.USD.market_cap *= 10; }]) {
    const f = fixture(); change(f.data); const { metrics } = await f.get();
    assert.equal(metrics.btcDominance.status, 'unavailable'); assert.equal(metrics.btcDominance.value, null);
    assert.equal(metrics.totalCap.status, 'current');
  }
});
test('provider timestamps, nulls, numeric strings, wrong currency and error envelopes are validated', () => {
  const cases = [
    ['fearGreed', p => { p.data[0].value = null; }], ['fearGreed', p => { p.data[0].value = '101'; }],
    ['fearGreed', p => { p.data[0].timestamp = NOW / 1000 + 301; }],
    ['global', p => { p.data.quotes.USD.total_market_cap = '250'; }],
    ['global', p => { p.data.active_cryptocurrencies = null; }],
    ['bitcoin', p => { p.data['1'].symbol = 'ETH'; }], ['bitcoin', p => { p.metadata.error = 'failure'; }]
  ];
  for (const [key, change] of cases) { const p = fixtures()[key]; change(p); assert.throws(() => normalize(key, p, NOW)); }
});
test('old provider timestamps are stale even when just fetched; regressed timestamps do not overwrite', async () => {
  const f = fixture(); f.data.global.data.last_updated -= 3600;
  const first = (await f.get()).metrics.totalCap; assert.equal(first.status, 'stale');
  f.advance(300001); f.data.global.data.last_updated -= 3600;
  assert.equal((await f.get()).metrics.totalCap.asOf, first.asOf);
});
test('slow or oversized upstream responses fail safely', async () => {
  const oversized = createFreeMarketContext({ fetchImpl: async () => new Response('x'.repeat(65537)) });
  assert.equal((await oversized()).metrics.fearGreed.status, 'unavailable');
  const slow = createFreeMarketContext({ timeoutMs: 5, fetchImpl: async (_, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('abort')), { once: true })) });
  assert.equal((await slow()).metrics.totalCap.status, 'unavailable');
});
test('UI formatting keeps zero and re-evaluates freshness without a new network response', () => {
  const metric = { value: 0, status: 'current', asOf: NOW, classification: 'Extreme Fear' };
  assert.equal(presentation('fearGreed', metric, { now: NOW }).value, '0/100');
  assert.equal(presentation('fearGreed', metric, { now: NOW + 172800001 }).status, 'stale');
  assert.equal(presentation('fearGreed', { ...metric, value: null }, { now: NOW }).value, '—');
  assert.equal(presentation('btcDominance', { ...metric, value: 101 }, { now: NOW }).value, '—');
  assert.match(presentation('totalCap', { ...metric, value: 2500000000000, coverage: 178 }, { now: NOW }).value, /USD$/);
});
test('all render targets get attribution beside the data, safe classification and numeric visual properties', () => {
  const value = {}, detail = {}, needle = { style: {} }, ring = { style: {} };
  const node = { dataset: { freeContext: 'fearGreed' }, classList: { toggle() {} }, querySelector: selector => ({ '[data-context-value]': value, '[data-context-detail]': detail, '.context-needle': needle, '.context-dominance-ring': ring }[selector]) };
  render({ querySelectorAll: () => [node] }, { metrics: { fearGreed: { value: 0, asOf: NOW, status: 'current', classification: '<img onerror=evil>' } } }, { now: NOW });
  assert.equal(value.textContent, '0/100'); assert.match(detail.innerHTML, /https:\/\/alternative.me\/crypto\/fear-and-greed-index\//);
  assert.doesNotMatch(detail.innerHTML, /onerror|<img/); assert.equal(needle.style.transform, 'rotate(-90deg)');
});
test('client uses current origin, coalesces refresh, marks failed refresh stale and discards disposed requests', async () => {
  const payload = await fixture().get(); let calls = 0, fail = false, release, changes = 0;
  const client = new Client({ setTimer: () => 1, clearTimer() {}, onChange: () => changes++, fetchImpl: async (url) => {
    assert.equal(url, '/api/market-context/free'); calls++;
    if (fail) throw new Error('offline'); return new Response(JSON.stringify(payload));
  } });
  await Promise.all([client.refresh(), client.refresh()]); assert.equal(calls, 1);
  fail = true; await client.refresh(); assert.equal(client.payload.metrics.fearGreed.status, 'stale');
  assert.equal(client.payload.metrics.fearGreed.value, 0);
  client.fetchImpl = () => new Promise(resolve => { release = resolve; });
  const pending = client.refresh(); client.dispose(); release(new Response(JSON.stringify(payload))); await pending;
  assert.equal(changes, 2);
});
test('HTTP context route rejects proxy parameters and mutation methods, keeps CSP unchanged', async () => {
  let calls = 0; const { server } = createHttpServer({ config: { root: process.cwd() }, logger: { warn() {} },
    freeContext: async () => { calls++; return { metrics: {} }; } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/market-context/free`;
    const response = await fetch(url); assert.equal(response.status, 200);
    assert.match(response.headers.get('content-security-policy'), /style-src 'self';/);
    assert.equal((await fetch(url + '?url=https://example.com')).status, 400);
    assert.equal((await fetch(url, { method: 'POST' })).status, 405); assert.equal(calls, 1);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
