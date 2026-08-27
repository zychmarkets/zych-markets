(function (root, factory) {
  'use strict';
  const AlertEngine = factory();
  if (typeof module === 'object' && module.exports) module.exports = AlertEngine;
  if (root) root.ZychAlerts = { ...(root.ZychAlerts || {}), AlertEngine };
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const fallbackId = prefix => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  class AlertEngine {
    constructor({ storage, core, transport, notifier = null, onChange = () => {}, onTrigger = () => {}, onStatus = () => {}, idFactory = fallbackId }) {
      this.storage = storage; this.core = core; this.transport = transport; this.notifier = notifier; this.onChange = onChange; this.onTrigger = onTrigger; this.onStatus = onStatus; this.idFactory = idFactory; this.maxHistory = Number(storage.maxHistory) || 500;
      this.alerts = storage.loadAlerts(); this.history = storage.loadTriggerHistory ? storage.loadTriggerHistory() : storage.loadHistory(); this.status = 'OFFLINE'; this.generation = 0;
    }
    list() { return [...this.alerts]; }
    events() { return [...this.history].reverse(); }
    activeCount() { return this.alerts.filter(alert => alert.status === 'active').length; }
    create(definition) {
      const alert = this.core.createAlert(definition, { id: this.idFactory('alert'), now: Date.now() });
      if (!alert) return { error: 'Invalid alert definition.' };
      const fingerprint = this.core.alertFingerprint(alert), duplicate = this.alerts.some(item => item.status !== 'triggered' && this.core.alertFingerprint(item) === fingerprint);
      if (duplicate) return { error: 'This alert already exists.' };
      this.alerts.push(alert); this.persist(); this.rebuild(); return { alert };
    }
    pause(id) { this.update(id, alert => ({ ...alert, status: 'paused', updatedAt: Date.now() })); }
    resume(id) { this.update(id, alert => ({ ...alert, status: 'active', armed: true, updatedAt: Date.now() })); }
    remove(id) { this.alerts = this.alerts.filter(alert => alert.id !== id); this.persist(); this.rebuild(); }
    removeEvent(id) {
      const event = this.history.find(item => item.id === id); this.history = this.history.filter(item => item.id !== id);
      if (event) this.alerts = this.alerts.filter(alert => !(alert.id === event.alertId && alert.status === 'triggered'));
      this.persist(); this.rebuild();
    }
    update(id, mutate) { const index = this.alerts.findIndex(item => item.id === id); if (index < 0) return; this.alerts[index] = mutate(this.alerts[index]); this.persist(); this.rebuild(); }
    persist() {
      this.history = this.history.slice(-this.maxHistory);
      this.storage.saveAlerts(this.alerts); this.storage.saveHistory(this.history); this.onChange(this.list(), this.events());
    }
    start() { this.rebuild(); }
    stop() { this.generation += 1; this.transport.stop(); this.setStatus('OFFLINE'); }
    setStatus(status) { this.status = status; this.onStatus(status); }
    rebuild() {
      const token = ++this.generation; this.transport.stop({ notify: false });
      const active = this.alerts.filter(alert => alert.status === 'active');
      if (!active.length) { this.setStatus('IDLE'); return; }
      this.transport.start(active, {
        onStatus: status => token === this.generation && this.setStatus(status),
        onEvent: event => token === this.generation && this.handleMarketEvent(event)
      }).catch(() => token === this.generation && this.setStatus('OFFLINE'));
    }
    handleMarketEvent(event) {
      let changed = false, subscriptionsChanged = false;
      this.alerts = this.alerts.map(alert => {
        if (!this.core.matchesEvent(alert, event)) return alert;
        const result = this.core.processMarketEvent(alert, event, { now: Date.now(), eventId: this.idFactory('trigger') });
        if (!result.stateChanged) return alert;
        changed = true;
        if (result.triggered) {
          this.history.push(result.triggerEvent); this.notifier?.notify(result.triggerEvent); this.onTrigger(result.triggerEvent, result.alert);
          if (result.alert.status === 'triggered') subscriptionsChanged = true;
        }
        return result.alert;
      });
      if (changed) this.persist();
      if (subscriptionsChanged) this.rebuild();
    }
  }
  return AlertEngine;
});
