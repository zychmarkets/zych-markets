(function (global) {
  'use strict';
  const timeoutFetch = async (url, signal, timeout = 10000) => {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(new DOMException('Request timed out', 'TimeoutError')), timeout), abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    try { const response = await fetch(url, { signal: controller.signal }); if (!response.ok) throw new Error(`Market HTTP ${response.status}`); return await response.json(); }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  };
  const market = (exchange, symbol, baseAsset, quoteAsset, status = 'TRADING') => ({ id: `${exchange}:${symbol}`, marketId: `${exchange}:${symbol}`, exchange, symbol, baseAsset, quoteAsset, asset: baseAsset, enabled: true, status });
  const snapshot = (lastPrice, changePercent, change, high, low, volume) => ({ lastPrice: Number(lastPrice), changePercent: Number(changePercent), change: Number(change), high: Number(high), low: Number(low), volume: Number(volume) });
  const candle = row => ({ time: Math.floor(Number(row[0]) / 1000), open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]), volume: Number(row[5]) });
  const bybitInterval = Object.freeze({ '1m': '1', '5m': '5', '15m': '15', '30m': '30', '1h': '60', '4h': '240', '1d': 'D', '1w': 'W' });

  class BinanceBrowserAdapter {
    constructor({ restBase = 'https://api.binance.com/api/v3', wsBase = 'wss://stream.binance.com:9443/ws' } = {}) { this.id = 'binance'; this.restBase = restBase; this.wsBase = wsBase; }
    async discover(signal) { const value = await timeoutFetch(`${this.restBase}/exchangeInfo`, signal); return value.symbols.filter(row => row.status === 'TRADING' && row.isSpotTradingAllowed !== false).map(row => market(this.id, row.symbol, row.baseAsset, row.quoteAsset, row.status)); }
    async allSnapshots(signal) { const rows = await timeoutFetch(`${this.restBase}/ticker/24hr`, signal); return rows.map(row => ({ marketId: `${this.id}:${row.symbol}`, symbol: row.symbol, ...snapshot(row.lastPrice, row.priceChangePercent, row.priceChange, row.highPrice, row.lowPrice, row.quoteVolume) })); }
    async snapshots(markets, signal) { const symbols = markets.map(item => item.symbol), rows = await timeoutFetch(`${this.restBase}/ticker/24hr?symbols=${encodeURIComponent(JSON.stringify(symbols))}`, signal); return Object.fromEntries(rows.map(row => [`${this.id}:${row.symbol}`, snapshot(row.lastPrice, row.priceChangePercent, row.priceChange, row.highPrice, row.lowPrice, row.quoteVolume)])); }
    async candles(marketValue, timeframe, endTime, limit, signal) { const end = Number.isFinite(endTime) ? `&endTime=${Math.floor(endTime)}` : ''; const rows = await timeoutFetch(`${this.restBase}/klines?symbol=${encodeURIComponent(marketValue.symbol)}&interval=${encodeURIComponent(timeframe)}&limit=${limit}${end}`, signal); return rows.map(candle); }
    socket(marketValue, timeframe, handlers) { const socket = new WebSocket(`${this.wsBase}/${marketValue.symbol.toLowerCase()}@kline_${timeframe}`); socket.addEventListener('open', handlers.open); socket.addEventListener('close', handlers.close); socket.addEventListener('error', handlers.error); socket.addEventListener('message', event => { try { const row = JSON.parse(event.data).k; if (row) handlers.candle({ time: Math.floor(row.t / 1000), open: +row.o, high: +row.h, low: +row.l, close: +row.c, volume: +row.v }); } catch (error) { handlers.error(error); } }); return socket; }
  }

  class BybitBrowserAdapter {
    constructor({ restBase = 'https://api.bybit.com/v5/market', wsBase = 'wss://stream.bybit.com/v5/public/spot' } = {}) { this.id = 'bybit'; this.restBase = restBase; this.wsBase = wsBase; }
    unwrap(value) { if (Number(value?.retCode) !== 0 || !value?.result) throw new Error(`Bybit API ${value?.retCode ?? 'invalid'}`); return value.result; }
    async discover(signal) { const result = this.unwrap(await timeoutFetch(`${this.restBase}/instruments-info?category=spot&limit=1000`, signal)); return (result.list || []).filter(row => row.status === 'Trading').map(row => market(this.id, row.symbol, row.baseCoin, row.quoteCoin, row.status)); }
    normalizeTicker(row) { const last = Number(row.lastPrice), previous = Number(row.prevPrice24h), change = last - previous; return snapshot(last, previous > 0 ? change / previous * 100 : 0, change, row.highPrice24h, row.lowPrice24h, row.turnover24h); }
    async allSnapshots(signal) { const result = this.unwrap(await timeoutFetch(`${this.restBase}/tickers?category=spot`, signal)); return (result.list || []).map(row => ({ marketId: `${this.id}:${row.symbol}`, symbol: row.symbol, ...this.normalizeTicker(row) })); }
    async snapshots(markets, signal) { const result = this.unwrap(await timeoutFetch(`${this.restBase}/tickers?category=spot`, signal)), wanted = new Map(markets.map(item => [item.symbol, item.id])); return Object.fromEntries((result.list || []).filter(row => wanted.has(row.symbol)).map(row => [wanted.get(row.symbol), this.normalizeTicker(row)])); }
    async candles(marketValue, timeframe, endTime, limit, signal) { const interval = bybitInterval[timeframe]; if (!interval) throw new Error('Unsupported Bybit interval'); const end = Number.isFinite(endTime) ? `&end=${Math.floor(endTime)}` : ''; const result = this.unwrap(await timeoutFetch(`${this.restBase}/kline?category=spot&symbol=${encodeURIComponent(marketValue.symbol)}&interval=${interval}&limit=${Math.min(1000, limit)}${end}`, signal)); return (result.list || []).map(candle).sort((a, b) => a.time - b.time); }
    socket(marketValue, timeframe, handlers) { const interval = bybitInterval[timeframe]; const socket = new WebSocket(this.wsBase); socket.addEventListener('open', () => { socket.send(JSON.stringify({ op: 'subscribe', args: [`kline.${interval}.${marketValue.symbol}`] })); handlers.open(); }); socket.addEventListener('close', handlers.close); socket.addEventListener('error', handlers.error); socket.addEventListener('message', event => { try { const payload = JSON.parse(event.data); if (!String(payload.topic || '').startsWith('kline.')) return; const row = payload.data?.[0]; if (row) handlers.candle({ time: Math.floor(Number(row.start) / 1000), open: +row.open, high: +row.high, low: +row.low, close: +row.close, volume: +row.volume }); } catch (error) { handlers.error(error); } }); return socket; }
  }
  global.ZychExchanges = { BinanceBrowserAdapter, BybitBrowserAdapter, bybitInterval, market, adapters: { binance: new BinanceBrowserAdapter(), bybit: new BybitBrowserAdapter() } };
})(window);
