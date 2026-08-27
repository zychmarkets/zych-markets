(function (global) {
  'use strict';
  const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
  class ServerAlertClient {
    constructor({ baseUrl = '/api', notifier = null, legacyStorage = null, onChange = () => {}, onStatus = () => {}, pollMs = 5000 } = {}) {
      this.baseUrl = baseUrl; this.notifier = notifier; this.legacyStorage = legacyStorage; this.onChange = onChange; this.onStatus = onStatus; this.pollMs = pollMs; this.alerts = []; this.history = []; this.knownTriggers = new Set(); this.running = false; this.initialized = false;
    }
    list() { return [...this.alerts]; }
    events() { return [...this.history]; }
    activeCount() { return this.alerts.filter(alert => alert.status === 'active').length; }
    async request(path, options = {}) {
      const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 8000);
      try {
        const response = await fetch(`${this.baseUrl}${path}`, { ...options, signal: controller.signal, headers: { 'content-type': 'application/json', ...(options.headers || {}) } });
        const value = response.status === 204 ? {} : await response.json();
        if (!response.ok) throw Object.assign(new Error(value.error?.message || `Request failed (${response.status})`), { code: value.error?.code, status: response.status });
        return value;
      } finally { clearTimeout(timeout); }
    }
    async sync({ notify = true } = {}) {
      const [alerts, triggers] = await Promise.all([this.request('/alerts'), this.request('/triggers')]);
      const incoming = triggers.triggers || [];
      if (this.initialized && notify) incoming.slice().reverse().filter(event => !this.knownTriggers.has(event.id)).forEach(event => this.notifier?.notify(event));
      this.alerts = alerts.alerts || []; this.history = incoming; this.knownTriggers = new Set(incoming.map(item => item.id)); this.initialized = true; this.onStatus(this.activeCount() ? 'LIVE' : 'IDLE'); this.onChange(this.list(), this.events());
    }
    async migrateLegacy() {
      if (!this.legacyStorage || this.alerts.length) return;
      const legacy = this.legacyStorage.loadAlerts().filter(alert => alert.status !== 'triggered');
      for (const alert of legacy) { try { await this.request('/alerts', { method: 'POST', body: JSON.stringify({ marketId: alert.marketId, exchange: alert.exchange, symbol: alert.symbol, baseAsset: alert.baseAsset, asset: alert.asset, quoteAsset: alert.quoteAsset, condition: alert.condition, mode: alert.mode, cooldownMs: alert.cooldownMs }) }); } catch (error) { if (error.code !== 'DUPLICATE_ALERT') throw error; } }
      if (legacy.length) await this.sync({ notify: false });
    }
    async start() {
      if (this.running) return; this.running = true; this.onStatus('CONNECTING');
      while (this.running) { try { await this.sync(); await this.migrateLegacy(); } catch { this.onStatus('OFFLINE'); } await sleep(this.pollMs); }
    }
    stop() { this.running = false; }
    async create(definition) { try { const result = await this.request('/alerts', { method: 'POST', body: JSON.stringify(definition) }); await this.sync({ notify: false }); return result; } catch (error) { return { error: error.message }; } }
    async action(id, action) { await this.request(`/alerts/${encodeURIComponent(id)}${action ? `/${action}` : ''}`, { method: action ? 'POST' : 'DELETE' }); await this.sync({ notify: false }); }
    pause(id) { return this.action(id, 'pause'); }
    resume(id) { return this.action(id, 'resume'); }
    remove(id) { return this.action(id, ''); }
    async removeEvent(id) { await this.request(`/triggers/${encodeURIComponent(id)}`, { method: 'DELETE' }); await this.sync({ notify: false }); }
  }
  global.ZychAlerts = { ...(global.ZychAlerts || {}), ServerAlertClient };
})(window);
