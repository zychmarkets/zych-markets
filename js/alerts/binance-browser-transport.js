(function (global) {
  'use strict';
  const VOLUME_AVERAGE_WINDOW = 20, RECONNECT_DELAY = 2500, REQUEST_TIMEOUT = 10000;
  const intervalFor = value => value === '24h' ? '1d' : value;

  class BinanceBrowserTransport {
    constructor({ restBase = 'https://api.binance.com/api/v3', wsBase = 'wss://stream.binance.com:9443', onDiagnostic = () => {} } = {}) {
      this.restBase = restBase; this.wsBase = wsBase; this.onDiagnostic = onDiagnostic; this.socket = null; this.requestController = null; this.reconnectTimer = null; this.generation = 0; this.activeAlerts = []; this.handlers = null; this.volumeBaselines = new Map(); this.streamCount = 0;
    }
    async prepareVolumeBaselines(alerts, token, signal) {
      const keys = new Map();
      alerts.filter(alert => alert.type === 'volume').forEach(alert => keys.set(`${alert.symbol}:${alert.condition.timeframe}`, alert));
      await Promise.all([...keys].map(async ([key, alert]) => {
        try {
          const response = await fetch(`${this.restBase}/klines?symbol=${encodeURIComponent(alert.symbol)}&interval=${encodeURIComponent(intervalFor(alert.condition.timeframe))}&limit=${VOLUME_AVERAGE_WINDOW + 1}`, { signal });
          if (!response.ok) return;
          const rows = await response.json(); if (token !== this.generation || signal.aborted) return;
          const closed = rows.slice(0, -1).slice(-VOLUME_AVERAGE_WINDOW).map(row => Number(row[7])).filter(Number.isFinite);
          if (closed.length) this.volumeBaselines.set(key, closed);
        } catch {}
      }));
    }
    streamsFor(alerts) {
      const streams = new Set();
      alerts.forEach(alert => { streams.add(`${alert.symbol.toLowerCase()}@ticker`); if (alert.type === 'movement') streams.add(`${alert.symbol.toLowerCase()}@kline_${intervalFor(alert.condition.window)}`); if (alert.type === 'volume') streams.add(`${alert.symbol.toLowerCase()}@kline_${intervalFor(alert.condition.timeframe)}`); });
      return [...streams];
    }
    marketIdentity(symbol) {
      const alert = this.activeAlerts.find(item => item.symbol === symbol);
      return { exchange: alert?.exchange || 'binance', symbol, baseAsset: alert?.baseAsset || alert?.asset || '', quoteAsset: alert?.quoteAsset || '' };
    }
    normalize(payload) {
      if (!payload?.s) return null;
      const identity = this.marketIdentity(payload.s), timestamp = Number(payload.E) || Date.now();
      if (payload.e === '24hrTicker') return { ...identity, eventType: 'ticker', price: Number(payload.c), timestamp };
      if (payload.e !== 'kline' || !payload.k) return null;
      const kline = payload.k, interval = kline.i, key = `${payload.s}:${interval}`, baseline = this.volumeBaselines.get(key) || [], averageVolume = baseline.length ? baseline.reduce((sum, value) => sum + value, 0) / baseline.length : null;
      const event = { ...identity, eventType: 'candle', interval, price: Number(kline.c), open: Number(kline.o), high: Number(kline.h), low: Number(kline.l), volume: Number(kline.q), averageVolume, closed: Boolean(kline.x), timestamp: Number(kline.T) || timestamp };
      if (kline.x && Number.isFinite(event.volume)) this.volumeBaselines.set(key, [...baseline, event.volume].slice(-VOLUME_AVERAGE_WINDOW));
      return event;
    }
    async start(alerts, handlers) {
      this.stop({ notify: false });
      const token = ++this.generation; this.activeAlerts = alerts.map(alert => ({ ...alert })); this.handlers = handlers; handlers.onStatus('CONNECTING');
      this.requestController = new AbortController(); const requestController = this.requestController, timer = setTimeout(() => requestController.abort(new DOMException('Alert baseline request timed out', 'TimeoutError')), REQUEST_TIMEOUT);
      try { await this.prepareVolumeBaselines(this.activeAlerts, token, requestController.signal); }
      finally { clearTimeout(timer); if (this.requestController === requestController) this.requestController = null; }
      if (token !== this.generation) return;
      this.openSocket(token);
    }
    openSocket(token) {
      const streams = this.streamsFor(this.activeAlerts); this.streamCount = streams.length; this.onDiagnostic({ sockets: 1, streams: this.streamCount });
      const socket = new WebSocket(`${this.wsBase}/ws`); this.socket = socket;
      socket.addEventListener('open', () => { if (token !== this.generation) return; socket.send(JSON.stringify({ method: 'SUBSCRIBE', params: streams, id: token })); this.handlers?.onStatus('LIVE'); });
      socket.addEventListener('message', message => { if (token !== this.generation) return; try { const event = this.normalize(JSON.parse(message.data)); if (event) this.handlers?.onEvent(event); } catch {} });
      socket.addEventListener('error', () => token === this.generation && this.handlers?.onStatus('OFFLINE'));
      socket.addEventListener('close', () => { if (token !== this.generation) return; this.socket = null; this.onDiagnostic({ sockets: 0, streams: this.streamCount }); this.handlers?.onStatus('RECONNECTING'); this.reconnectTimer = setTimeout(() => token === this.generation && this.openSocket(token), RECONNECT_DELAY); });
    }
    stop({ notify = true } = {}) {
      this.generation += 1; clearTimeout(this.reconnectTimer); this.reconnectTimer = null; this.requestController?.abort(); this.requestController = null;
      const socket = this.socket; this.socket = null; if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, 'Alert monitor stopped');
      this.streamCount = 0; this.activeAlerts = []; this.onDiagnostic({ sockets: 0, streams: 0 }); if (notify) this.handlers?.onStatus('OFFLINE'); this.handlers = null;
    }
  }

  global.ZychAlerts = { ...(global.ZychAlerts || {}), BinanceBrowserTransport, VOLUME_AVERAGE_WINDOW };
})(window);
