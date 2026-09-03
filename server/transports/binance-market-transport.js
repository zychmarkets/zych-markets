'use strict';
const VOLUME_WINDOW = 20;
const intervalFor = value => value === '24h' ? '1d' : value;

class BinanceMarketTransport {
  constructor({ restBase, wsBase, logger, WebSocketImpl = globalThis.WebSocket, fetchImpl = globalThis.fetch, reconnectBaseMs = 1000, reconnectMaxMs = 30000 }) {
    this.restBase = restBase; this.wsBase = wsBase; this.logger = logger; this.WebSocketImpl = WebSocketImpl; this.fetchImpl = fetchImpl; this.reconnectBaseMs = reconnectBaseMs; this.reconnectMaxMs = reconnectMaxMs;
    this.alerts = []; this.handlers = {}; this.socket = null; this.timer = null; this.generation = 0; this.reconnectAttempt = 0; this.baselines = new Map(); this.streams = []; this.status = 'idle'; this.topicEvidence = new Map();
  }
  streamsFor(alerts) {
    const streams = new Set();
    alerts.forEach(alert => {
      streams.add(`${alert.symbol.toLowerCase()}@ticker`);
      if (alert.type === 'movement') streams.add(`${alert.symbol.toLowerCase()}@kline_${intervalFor(alert.condition.window)}`);
      if (alert.type === 'volume') streams.add(`${alert.symbol.toLowerCase()}@kline_${intervalFor(alert.condition.timeframe)}`);
    });
    return [...streams].sort();
  }
  identity(symbol) {
    const alert = this.alerts.find(item => item.symbol === symbol);
    const exchange = alert?.exchange || 'binance';
    return { marketId: `${exchange}:spot:${symbol}`, exchange, marketType: 'spot', symbol, baseAsset: alert?.baseAsset || '', quoteAsset: alert?.quoteAsset || '' };
  }
  normalize(payload) {
    if (!payload?.s) return null;
    const identity = this.identity(payload.s), timestamp = Number(payload.E) || Date.now();
    if (payload.e === '24hrTicker' && Number(payload.c) > 0) return { ...identity, eventType: 'ticker', price: Number(payload.c), timestamp, sourceTimestamp: Number(payload.E) || null };
    if (payload.e !== 'kline' || !payload.k) return null;
    const candle = payload.k, key = `${payload.s}:${candle.i}`, baseline = this.baselines.get(key) || [];
    const averageVolume = baseline.length ? baseline.reduce((sum, value) => sum + value, 0) / baseline.length : null;
    const event = { ...identity, eventType: 'candle', interval: candle.i, price: Number(candle.c), open: Number(candle.o), high: Number(candle.h), low: Number(candle.l), volume: Number(candle.q), averageVolume, closed: Boolean(candle.x), timestamp: Number(candle.T) || timestamp };
    if (event.closed && Number.isFinite(event.volume)) this.baselines.set(key, [...baseline, event.volume].slice(-VOLUME_WINDOW));
    return event;
  }
  async prepareBaselines(token) {
    const volumeAlerts = new Map(this.alerts.filter(a => a.type === 'volume').map(a => [`${a.symbol}:${a.condition.timeframe}`, a]));
    await Promise.all([...volumeAlerts].map(async ([key, alert]) => {
      try {
        const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 10000);
        const response = await this.fetchImpl(`${this.restBase}/klines?symbol=${encodeURIComponent(alert.symbol)}&interval=${encodeURIComponent(intervalFor(alert.condition.timeframe))}&limit=${VOLUME_WINDOW + 1}`, { signal: controller.signal }); clearTimeout(timeout);
        if (!response.ok || token !== this.generation) return;
        const rows = await response.json(), values = rows.slice(0, -1).slice(-VOLUME_WINDOW).map(row => Number(row[7])).filter(Number.isFinite);
        if (values.length) this.baselines.set(key, values);
      } catch (error) { if (token === this.generation) this.logger.warn('binance_baseline_failed', { marketId: alert.marketId, message: error.message }); }
    }));
  }
  async start(alerts, handlers = {}) {
    await this.stop();
    this.alerts = alerts.map(item => ({ ...item })); this.handlers = handlers; this.streams = this.streamsFor(this.alerts);
    if (!this.streams.length) { this.status = 'idle'; return; }
    const token = ++this.generation; this.status = 'connecting'; await this.prepareBaselines(token); if (token === this.generation) this.open(token);
  }
  open(token) {
    if (token !== this.generation || !this.streams.length) return;
    const socket = new this.WebSocketImpl(`${this.wsBase}/ws`); this.socket = socket;
    socket.addEventListener('open', () => {
      if (token !== this.generation) return socket.close();
      this.connectedAt=Date.now(); this.topicEvidence.clear(); for (const topic of this.streams) this.topicEvidence.set(topic, { socket, requestedAt: Date.now(), acknowledgement: 'pending', lastAckAt: null });
      socket.send(JSON.stringify({ method: 'SUBSCRIBE', params: this.streams, id: token })); this.reconnectAttempt = 0; this.status = 'live'; this.logger.info('binance_connected', { subscriptions: this.streams.length }); this.handlers.onStatus?.('live');
    });
    socket.addEventListener('message', message => { if (token !== this.generation || socket !== this.socket) return; try { const payload = JSON.parse(message.data); this.lastMessageAt = Date.now(); if (payload.id === token) { for (const fact of this.topicEvidence.values()) { fact.acknowledgement = payload.result === null && !payload.code ? 'acknowledged' : 'rejected'; fact.lastAckAt = fact.acknowledgement === 'acknowledged' ? Date.now() : null; } return; } const event = this.normalize(payload); if (event && this.alerts.some(a => a.symbol === event.symbol)) this.handlers.onEvent?.(event); } catch (error) { this.logger.warn('binance_message_invalid', { message: error.message }); } });
    socket.addEventListener('error', () => { if (token === this.generation) { this.status = 'offline'; this.lastError={code:'SOCKET_ERROR',at:Date.now()}; } });
    socket.addEventListener('close', event => {
      if (token !== this.generation) return;
      this.lastDisconnect={code:event?.code??null,at:Date.now()};this.reconnectCount=(this.reconnectCount||0)+1;this.lastReconnectAt=Date.now();this.socket = null; this.status = 'reconnecting'; this.handlers.onStatus?.('reconnecting');
      const delay = Math.min(this.reconnectMaxMs, this.reconnectBaseMs * 2 ** this.reconnectAttempt++); this.logger.warn('binance_reconnect', { delay });
      this.timer = setTimeout(() => this.open(token), delay);
    });
  }
  async stop() {
    this.generation += 1; clearTimeout(this.timer); this.timer = null;
    const socket = this.socket; this.socket = null; if (socket && socket.readyState < 2) socket.close(1000, 'shutdown');
    this.status = 'idle'; this.streams = []; this.alerts = [];
  }
  diagnostics() { return { status: this.status, connections: this.socket && this.socket.readyState <= 1 ? 1 : 0, subscriptions: this.streams.length }; }
}
module.exports = { BinanceMarketTransport, VOLUME_WINDOW };
