(function (global) {
  'use strict';

  const PAGE_LIMIT = 1000, MAX_CACHE_ENTRIES = 12;
  const INITIAL_CANDLES = Object.freeze({
    '1m': 4320,
    '5m': 4032,
    '15m': 2880,
    '30m': 2880,
    '1h': 4320,
    '4h': 2190,
    '1d': 1825,
    '1w': 1000
  });
  const keyFor = (market, timeframe) => `${market.id}:${timeframe}`;
  const normalize = row => ({ time: Math.floor(row[0] / 1000), open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]), volume: Number(row[5]) });

  class ChartHistoryService {
    constructor({ adapters = null, restBase = 'https://api.binance.com/api/v3', requestTimeout = 10000 } = {}) {
      this.adapters = adapters; this.restBase = restBase; this.requestTimeout = requestTimeout; this.cache = new Map();
    }
    entry(market, timeframe) {
      const key = keyFor(market, timeframe);
      if (!this.cache.has(key)) this.cache.set(key, { key, marketId: market.id, symbol: market.symbol, timeframe, candles: [], times: new Set(), endReached: false, loading: null, pages: 0, requestedEnds: new Set(), lastUsed: Date.now() });
      const entry = this.cache.get(key); entry.lastUsed = Date.now();
      if (this.cache.size > MAX_CACHE_ENTRIES) [...this.cache.values()].filter(item => item.key !== key && !item.loading).sort((a, b) => a.lastUsed - b.lastUsed).slice(0, this.cache.size - MAX_CACHE_ENTRIES).forEach(item => this.cache.delete(item.key));
      return entry;
    }
    async request(market, timeframe, endTime, signal, limit = PAGE_LIMIT) {
      if (this.adapters?.[market.exchange]) return this.adapters[market.exchange].candles(market, timeframe, endTime, limit, signal);
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(new DOMException('History request timed out', 'TimeoutError')), this.requestTimeout);
      const abort = () => controller.abort(signal?.reason); signal?.addEventListener('abort', abort, { once: true });
      const end = Number.isFinite(endTime) ? `&endTime=${Math.floor(endTime)}` : '';
      try {
        const response = await fetch(`${this.restBase}/klines?symbol=${encodeURIComponent(market.symbol)}&interval=${encodeURIComponent(timeframe)}&limit=${limit}${end}`, { signal: controller.signal });
        if (!response.ok) throw new Error(`Binance history HTTP ${response.status}`);
        return (await response.json()).map(normalize);
      } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
    }
    merge(entry, rows) {
      let added = 0;
      rows.forEach(candle => { if (!entry.times.has(candle.time)) { entry.times.add(candle.time); entry.candles.push(candle); added += 1; } });
      if (added) entry.candles.sort((a, b) => a.time - b.time);
      return added;
    }
    async initial(market, timeframe, signal) {
      const entry = this.entry(market, timeframe), target = INITIAL_CANDLES[timeframe] || PAGE_LIMIT;
      if (entry.loading) { try { await entry.loading; } catch (error) { if (signal?.aborted) throw error; } }
      if (entry.candles.length >= target || entry.endReached) return { key: entry.key, data: entry.candles, pages: entry.pages, endReached: entry.endReached, cached: true };
      entry.loading = (async () => {
        while (entry.candles.length < target && !entry.endReached) {
          const endTime = entry.candles.length ? entry.candles[0].time * 1000 - 1 : null;
          const limit = Math.min(PAGE_LIMIT, target - entry.candles.length);
          const requestKey = endTime === null ? 'latest' : String(endTime);
          if (entry.requestedEnds.has(requestKey)) { entry.endReached = true; break; }
          entry.requestedEnds.add(requestKey);
          try {
            const rows = await this.request(market, timeframe, endTime, signal, limit);
            if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');
            const added = this.merge(entry, rows); entry.pages += 1;
            if (!rows.length || rows.length < limit || added === 0) entry.endReached = true;
          } catch (error) { entry.requestedEnds.delete(requestKey); throw error; }
        }
      })();
      try { await entry.loading; } finally { entry.loading = null; }
      return { key: entry.key, data: entry.candles, pages: entry.pages, endReached: entry.endReached, cached: false };
    }
    async older(market, timeframe, signal) {
      const entry = this.entry(market, timeframe);
      if (entry.endReached) return { key: entry.key, data: entry.candles, added: 0, endReached: true, pages: entry.pages };
      if (entry.loading) return entry.loading;
      const endTime = entry.candles.length ? entry.candles[0].time * 1000 - 1 : null, requestKey = endTime === null ? 'latest' : String(endTime);
      if (entry.requestedEnds.has(requestKey)) return { key: entry.key, data: entry.candles, added: 0, endReached: entry.endReached, pages: entry.pages };
      entry.requestedEnds.add(requestKey);
      entry.loading = (async () => {
        try {
          const rows = await this.request(market, timeframe, endTime, signal);
          if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');
          const added = this.merge(entry, rows); entry.pages += 1;
          if (!rows.length || rows.length < PAGE_LIMIT || added === 0) entry.endReached = true;
          return { key: entry.key, data: entry.candles, added, endReached: entry.endReached, pages: entry.pages };
        } catch (error) { entry.requestedEnds.delete(requestKey); throw error; }
        finally { entry.loading = null; }
      })();
      return entry.loading;
    }
    updateLive(market, timeframe, candle) {
      const entry = this.entry(market, timeframe), lastIndex = entry.candles.length - 1;
      if (lastIndex >= 0 && entry.candles[lastIndex].time === candle.time) entry.candles[lastIndex] = candle;
      else if (!entry.times.has(candle.time)) { entry.times.add(candle.time); entry.candles.push(candle); }
    }
  }

  global.ZychChartHistory = { ChartHistoryService, INITIAL_CANDLES, PAGE_LIMIT, MAX_CACHE_ENTRIES, keyFor };
})(window);
