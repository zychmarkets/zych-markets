(function (global, factory) {
  'use strict';
  const api=factory(global);
  if(typeof module==='object'&&module.exports)module.exports=api;
  else global.ZychAlerts={...(global.ZychAlerts||{}),...api};
})(typeof window!=='undefined'?window:globalThis,function(global){
  const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
  function resolveAlertApiBase(location=global.location){
    if(!location)return'/api';
    const hostname=String(location.hostname||'').toLowerCase(),port=String(location.port||''),protocol=String(location.protocol||'');
    if(protocol==='file:')return'http://127.0.0.1:4178/api';
    if(protocol==='http:'&&['localhost','127.0.0.1'].includes(hostname)&&port&&port!=='4178')return'http://127.0.0.1:4178/api';
    return'/api';
  }
  const networkFailure=error=>error?.name==='TypeError'||error?.name==='AbortError';
  class ServerAlertClient {
    constructor({ baseUrl = null, notifier = null, legacyStorage = null, onChange = () => {}, onStatus = () => {}, pollMs = 5000 } = {}) {
      this.baseUrl = baseUrl || resolveAlertApiBase(); this.notifier = notifier; this.legacyStorage = legacyStorage; this.onChange = onChange; this.onStatus = onStatus; this.pollMs = pollMs; this.alerts = []; this.history = []; this.health = null; this.knownTriggers = new Set(); this.running = false; this.initialized = false; this.syncVersion = 0;
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
      const version = ++this.syncVersion;
      const [alerts, triggers, health] = await Promise.all([this.request('/alerts'), this.request('/triggers'),this.request('/health')]);
      if (version !== this.syncVersion) return false;
      const incoming = triggers.triggers || [];
      const unseen=incoming.slice().reverse().filter(event=>{if(this.knownTriggers.has(event.id))return false;this.knownTriggers.add(event.id);return true;});
      if (this.initialized && notify) unseen.forEach(event => this.notifier?.notify(event));
      this.alerts = alerts.alerts || []; this.history = incoming; this.health=health; this.initialized = true; this.onStatus(health.alerts?.monitoringStatus||'OFFLINE',health); this.onChange(this.list(), this.events());
      return true;
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
    async create(definition) { try { const result = await this.request('/alerts', { method: 'POST', body: JSON.stringify(definition) }); await this.sync({ notify: false }); return result; } catch (error) { return { error: networkFailure(error) ? 'Alert service unavailable' : error.message, errorCode: networkFailure(error) ? 'NETWORK_UNAVAILABLE' : error.code || 'REQUEST_FAILED' }; } }
    updatePrice(id, value) { return this.request(`/alerts/${encodeURIComponent(id)}/price`, { method: 'PATCH', body: JSON.stringify({ value }) }); }
    updateStatus(id, status) { return this.request(`/alerts/${encodeURIComponent(id)}/${status === 'paused' ? 'pause' : 'resume'}`, { method: 'POST' }); }
    deleteAlert(id) { return this.request(`/alerts/${encodeURIComponent(id)}`, { method: 'DELETE' }); }
    async action(id, action) { if (action) await this.updateStatus(id, action === 'pause' ? 'paused' : 'active'); else await this.deleteAlert(id); await this.sync({ notify: false }); }
    pause(id) { return this.action(id, 'pause'); }
    resume(id) { return this.action(id, 'resume'); }
    remove(id) { return this.action(id, ''); }
    async removeEvent(id) { await this.request(`/triggers/${encodeURIComponent(id)}`, { method: 'DELETE' }); await this.sync({ notify: false }); }
  }
  return{ServerAlertClient,resolveAlertApiBase,networkFailure};
});
