(function (global) {
  'use strict';
  const VOLUME_AVERAGE_WINDOW = 20, RECONNECT_DELAY = 2500, MIN_TRIGGER_GAP = 5000, REQUEST_TIMEOUT = 10000;
  const intervalFor = value => value === '24h' ? '1d' : value;
  const uid = () => global.crypto?.randomUUID?.() || `alert-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  class AlertEngine {
    constructor({ storage, evaluate, restBase = 'https://api.binance.com/api/v3', wsBase = 'wss://stream.binance.com:9443', onChange = () => {}, onTrigger = () => {}, onStatus = () => {} }) {
      this.storage = storage; this.evaluate = evaluate; this.restBase = restBase; this.wsBase = wsBase; this.onChange = onChange; this.onTrigger = onTrigger; this.onStatus = onStatus;
      this.alerts = storage.loadAlerts(); this.history = storage.loadHistory(); this.socket = null; this.reconnectTimer = null; this.requestController = null; this.generation = 0; this.intentionalClose = false; this.volumeBaselines = new Map(); this.status = 'OFFLINE'; this.streamCount = 0;
    }
    list() { return [...this.alerts]; }
    events() { return [...this.history].reverse(); }
    activeCount() { return this.alerts.filter(alert => alert.status === 'active').length; }
    create(definition) {
      const duplicate = this.alerts.some(alert => alert.marketId === definition.marketId && alert.mode === definition.mode && alert.status !== 'triggered' && JSON.stringify(alert.condition) === JSON.stringify(definition.condition));
      if (duplicate) return { error: 'This alert already exists.' };
      const alert = { id: uid(), type: definition.condition.type, marketId: definition.marketId, asset: definition.asset, symbol: definition.symbol, exchange: definition.exchange, quoteAsset: definition.quoteAsset, timeframe: definition.condition.timeframe || definition.condition.window || null, condition: definition.condition, mode: definition.mode || 'once', createdAt: Date.now(), status: 'active', lastTriggeredAt: null, triggerCount: 0, armed: true };
      this.alerts.push(alert); this.persist(); this.rebuild(); return { alert };
    }
    pause(id) { this.update(id, alert => { alert.status = 'paused'; }); }
    resume(id) { this.update(id, alert => { alert.status = 'active'; alert.armed = true; }); }
    remove(id) { this.alerts = this.alerts.filter(alert => alert.id !== id); this.persist(); this.rebuild(); }
    removeEvent(id) { const event = this.history.find(item => item.id === id); this.history = this.history.filter(item => item.id !== id); if (event) this.alerts = this.alerts.filter(alert => !(alert.id === event.alertId && alert.status === 'triggered')); this.persist(); this.rebuild(); }
    update(id, mutate) { const alert = this.alerts.find(item => item.id === id); if (!alert) return; mutate(alert); this.persist(); this.rebuild(); }
    persist() { if (Number.isFinite(global.ZychAlerts?.MAX_HISTORY)) this.history = this.history.slice(-global.ZychAlerts.MAX_HISTORY); this.storage.saveAlerts(this.alerts); this.storage.saveHistory(this.history); this.onChange(this.list(), this.events()); }
    start() { this.rebuild(); }
    stop() { this.generation += 1; this.intentionalClose = true; clearTimeout(this.reconnectTimer); this.requestController?.abort(); this.requestController = null; this.socket?.close(1000, 'Alert monitor stopped'); this.socket = null; this.streamCount = 0; this.setStatus('OFFLINE'); }
    setStatus(status) { this.status = status; this.onStatus(status); }
    async prepareVolumeBaselines(active, token, signal) {
      const keys = new Map();
      active.filter(alert => alert.condition.type === 'volume').forEach(alert => keys.set(`${alert.symbol}:${alert.condition.timeframe}`, alert));
      await Promise.all([...keys].map(async ([key, alert]) => {
        try { const response = await fetch(`${this.restBase}/klines?symbol=${encodeURIComponent(alert.symbol)}&interval=${encodeURIComponent(intervalFor(alert.condition.timeframe))}&limit=${VOLUME_AVERAGE_WINDOW + 1}`, { signal }); if (!response.ok) return; const rows = await response.json(); if (token !== this.generation || signal.aborted) return; const closed = rows.slice(0, -1).slice(-VOLUME_AVERAGE_WINDOW).map(row => Number(row[7])).filter(Number.isFinite); if (closed.length) this.volumeBaselines.set(key, closed); } catch {}
      }));
    }
    async rebuild() {
      const token = ++this.generation; this.intentionalClose = true; clearTimeout(this.reconnectTimer); this.requestController?.abort(); if (this.socket && this.socket.readyState < WebSocket.CLOSING) this.socket.close(1000, 'Alert subscriptions changed'); this.socket = null;
      const active = this.alerts.filter(alert => alert.status === 'active'); if (!active.length) { this.setStatus('IDLE'); return; }
      this.requestController = new AbortController(); const requestController = this.requestController, timeout = setTimeout(() => requestController.abort(new DOMException('Alert baseline request timed out', 'TimeoutError')), REQUEST_TIMEOUT);
      this.setStatus('CONNECTING'); try { await this.prepareVolumeBaselines(active, token, requestController.signal); } finally { clearTimeout(timeout); if (this.requestController === requestController) this.requestController = null; } if (token !== this.generation) return;
      const streams = new Set(); active.forEach(alert => { streams.add(`${alert.symbol.toLowerCase()}@ticker`); if (alert.condition.type === 'movement') streams.add(`${alert.symbol.toLowerCase()}@kline_${intervalFor(alert.condition.window)}`); if (alert.condition.type === 'volume') streams.add(`${alert.symbol.toLowerCase()}@kline_${intervalFor(alert.condition.timeframe)}`); });
      this.intentionalClose = false; this.streamCount = streams.size; const socket = new WebSocket(`${this.wsBase}/ws`); this.socket = socket;
      socket.addEventListener('open', () => { if (token !== this.generation) return; socket.send(JSON.stringify({ method: 'SUBSCRIBE', params: [...streams], id: token })); this.setStatus('LIVE'); });
      socket.addEventListener('message', event => { if (token !== this.generation) return; try { this.handleMessage(JSON.parse(event.data)); } catch {} });
      socket.addEventListener('error', () => token === this.generation && this.setStatus('OFFLINE'));
      socket.addEventListener('close', () => { if (this.intentionalClose || token !== this.generation) return; this.setStatus('RECONNECTING'); this.reconnectTimer = setTimeout(() => token === this.generation && this.rebuild(), RECONNECT_DELAY); });
    }
    handleMessage(message) {
      const payload = message.data || message; if (!payload || !payload.s) return;
      if (payload.e === '24hrTicker') this.alerts.filter(alert => alert.status === 'active' && alert.symbol === payload.s && alert.condition.type === 'price').forEach(alert => this.check(alert, { price: Number(payload.c) }));
      if (payload.e === 'kline' && payload.k) {
        const kline = payload.k, interval = kline.i, symbol = payload.s, price = Number(kline.c);
        this.alerts.filter(alert => alert.status === 'active' && alert.symbol === symbol && alert.condition.type === 'movement' && intervalFor(alert.condition.window) === interval).forEach(alert => this.check(alert, { price, referencePrice: Number(kline.o) }));
        this.alerts.filter(alert => alert.status === 'active' && alert.symbol === symbol && alert.condition.type === 'volume' && intervalFor(alert.condition.timeframe) === interval).forEach(alert => { const key = `${symbol}:${alert.condition.timeframe}`, baseline = this.volumeBaselines.get(key) || [], averageVolume = baseline.length ? baseline.reduce((sum, value) => sum + value, 0) / baseline.length : NaN; this.check(alert, { currentVolume: Number(kline.q), averageVolume }); if (kline.x && Number.isFinite(Number(kline.q))) this.volumeBaselines.set(key, [...baseline, Number(kline.q)].slice(-VOLUME_AVERAGE_WINDOW)); });
      }
    }
    check(alert, data) {
      const result = this.evaluate(alert, data); if (result.unavailable) return;
      if (!result.met) { if (!alert.armed) { alert.armed = true; this.persist(); } return; }
      if (!alert.armed || (alert.lastTriggeredAt && Date.now() - alert.lastTriggeredAt < MIN_TRIGGER_GAP)) return;
      alert.armed = false; alert.lastTriggeredAt = Date.now(); alert.triggerCount += 1; if (alert.mode === 'once') alert.status = 'triggered';
      const event = { id: uid(), alertId: alert.id, triggeredAt: alert.lastTriggeredAt, asset: alert.asset, marketId: alert.marketId, symbol: alert.symbol, exchange: alert.exchange, currentPrice: result.details.currentPrice ?? null, alertType: alert.type, condition: alert.condition, threshold: alert.condition.value ?? alert.condition.percent ?? alert.condition.multiplier, timeframe: alert.timeframe, ...result.details };
      this.history.push(event); this.persist(); this.onTrigger(event, { ...alert }); if (alert.mode === 'once') this.rebuild();
    }
  }
  global.ZychAlerts = { ...(global.ZychAlerts || {}), AlertEngine, VOLUME_AVERAGE_WINDOW };
})(window);
