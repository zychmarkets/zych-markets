'use strict';

// Fixed, read-only public endpoints. No user-supplied URLs or provider credentials.
const SOURCES = Object.freeze({
  fearGreed: 'https://api.alternative.me/fng/?limit=1',
  global: 'https://api.alternative.me/v2/global/',
  bitcoin: 'https://api.alternative.me/v2/ticker/bitcoin/'
});
const MAX_AGE = { fearGreed: 48 * 3600000, global: 30 * 60000, bitcoin: 30 * 60000 };
const number = value => typeof value === 'number' && Number.isFinite(value);
function timestamp(value, now) {
  const seconds = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!number(seconds) || seconds <= 0 || seconds * 1000 > now + 300000) throw new Error('Invalid source timestamp');
  return seconds * 1000;
}
function normalize(key, payload, now) {
  if (!payload || payload.metadata?.error != null) throw new Error('Provider error');
  if (key === 'fearGreed') {
    const row = payload.data?.[0], raw = row?.value;
    const value = typeof raw === 'string' && /^\d{1,3}$/.test(raw) ? Number(raw) : raw;
    if (!Number.isInteger(value) || value < 0 || value > 100) throw new Error('Invalid sentiment');
    const labels = ['Extreme Fear', 'Fear', 'Neutral', 'Greed', 'Extreme Greed'];
    return { value, classification: labels.includes(row.value_classification) ? row.value_classification : null,
      asOf: timestamp(row.timestamp, now) };
  }
  if (key === 'global') {
    const data = payload.data, value = data?.quotes?.USD?.total_market_cap, coverage = data?.active_cryptocurrencies;
    if (!number(value) || value <= 0 || !Number.isSafeInteger(coverage) || coverage < 1) throw new Error('Invalid global data');
    return { value, coverage, asOf: timestamp(data.last_updated, now) };
  }
  const data = payload.data?.['1'], value = data?.quotes?.USD?.market_cap;
  if (data?.symbol !== 'BTC' || data?.id !== 1 || !number(value) || value <= 0) throw new Error('Invalid Bitcoin data');
  return { value, asOf: timestamp(data.last_updated, now) };
}
async function readJson(response) {
  if (!response.ok) throw new Error('Upstream unavailable');
  let size = 0; const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 65536) throw new Error('Oversized upstream response');
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function createFreeMarketContext({ fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 7000 } = {}) {
  const cache = new Map(), pending = new Map();
  async function get(key) {
    const previous = cache.get(key);
    if (previous && now() < previous.retryAt) return previous;
    if (pending.has(key)) return pending.get(key);
    const request = (async () => {
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const payload = await readJson(await fetchImpl(SOURCES[key], { signal: controller.signal, redirect: 'error' }));
        const receivedAt = now(), data = normalize(key, payload, receivedAt);
        // A delayed response must not replace a newer known snapshot.
        if (previous?.data && data.asOf < previous.data.asOf) throw new Error('Regressed source timestamp');
        const result = { data, receivedAt, failed: false, retryAt: receivedAt + 300000 };
        cache.set(key, result); return result;
      } catch {
        const result = { data: previous?.data || null, receivedAt: previous?.receivedAt || null,
          failed: true, retryAt: now() + 30000 };
        cache.set(key, result); return result;
      } finally { clearTimeout(timer); }
    })();
    pending.set(key, request);
    try { return await request; } finally { pending.delete(key); }
  }
  function metric(record, key, unit, scope) {
    const data = record.data;
    return { value: data?.value ?? null, asOf: data?.asOf ?? null, receivedAt: record.receivedAt,
      status: !data ? 'unavailable' : record.failed || now() - data.asOf > MAX_AGE[key] ? 'stale' : 'current',
      unit, scope, source: 'Alternative.me', sourceUrl: key === 'fearGreed'
        ? 'https://alternative.me/crypto/fear-and-greed-index/' : 'https://alternative.me/crypto/api/',
      maxAgeMs: MAX_AGE[key], ...(data?.coverage ? { coverage: data.coverage } : {}),
      ...(key === 'fearGreed' ? { classification: data?.classification ?? null } : {}) };
  }
  return async function snapshot() {
    const [fear, global, bitcoin] = await Promise.all(['fearGreed', 'global', 'bitcoin'].map(get));
    const totalCap = metric(global, 'global', 'USD', 'provider-universe');
    const btcDominance = { ...totalCap, value: null, status: 'unavailable', unit: '%',
      method: 'Bitcoin capitalization / provider total capitalization × 100' };
    // Derive the percentage explicitly: the provider's percentage field has
    // returned both fractions and percentages, so it is deliberately not used.
    if (global.data && bitcoin.data && bitcoin.data.value <= global.data.value &&
        Math.abs(global.data.asOf - bitcoin.data.asOf) <= 600000) {
      btcDominance.value = bitcoin.data.value / global.data.value * 100;
      btcDominance.asOf = Math.min(global.data.asOf, bitcoin.data.asOf);
      btcDominance.receivedAt = Math.min(global.receivedAt, bitcoin.receivedAt);
      btcDominance.status = totalCap.status === 'current' && metric(bitcoin, 'bitcoin').status === 'current' ? 'current' : 'stale';
    }
    return { generatedAt: now(), metrics: { fearGreed: metric(fear, 'fearGreed', 'index', 'Bitcoin sentiment · daily'), totalCap, btcDominance } };
  };
}
module.exports = { createFreeMarketContext, normalize, SOURCES };
