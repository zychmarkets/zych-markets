(function (global) {
  'use strict';
  const ALERTS_KEY = 'zych.alerts.v1', HISTORY_KEY = 'zych.alert-history.v1', MAX_HISTORY = 500;
  const safeArray = key => { try { const value = JSON.parse(localStorage.getItem(key)); return Array.isArray(value) ? value : []; } catch { return []; } };
  const uniqueById = items => [...new Map(items.map(item => [item.id, item])).values()];
  const validEvent = item => item && typeof item.id === 'string' && typeof item.alertId === 'string' && typeof item.marketId === 'string' && typeof item.asset === 'string' && Number.isFinite(Number(item.triggeredAt ?? item.timestamp)) && item.condition && typeof item.condition === 'object';

  class BrowserLocalStorageAdapter {
    constructor({ core = global.ZychAlertCore } = {}) { this.core = core; this.maxHistory = MAX_HISTORY; }
    loadAlerts() { return uniqueById(safeArray(ALERTS_KEY).map(item => this.core.migrateAlert(item)).filter(item => this.core.validateAlert(item))); }
    saveAlerts(alerts) { try { const valid = uniqueById(alerts.map(item => this.core.migrateAlert(item)).filter(item => this.core.validateAlert(item))); localStorage.setItem(ALERTS_KEY, JSON.stringify(valid)); } catch {} }
    saveAlert(alert) { const alerts = this.loadAlerts(), index = alerts.findIndex(item => item.id === alert.id); if (index >= 0) alerts[index] = alert; else alerts.push(alert); this.saveAlerts(alerts); return alert; }
    updateAlert(id, changes) { const alerts = this.loadAlerts(), index = alerts.findIndex(item => item.id === id); if (index < 0) return null; alerts[index] = { ...alerts[index], ...changes }; this.saveAlerts(alerts); return alerts[index]; }
    deleteAlert(id) { this.saveAlerts(this.loadAlerts().filter(item => item.id !== id)); }
    loadTriggerHistory() { return uniqueById(safeArray(HISTORY_KEY).filter(validEvent)).slice(-MAX_HISTORY); }
    saveTriggerEvent(event) { const history = this.loadTriggerHistory(); history.push(event); this.saveHistory(history); return event; }
    deleteTriggerEvent(id) { this.saveHistory(this.loadTriggerHistory().filter(item => item.id !== id)); }
    loadHistory() { return this.loadTriggerHistory(); }
    saveHistory(history) { try { localStorage.setItem(HISTORY_KEY, JSON.stringify(uniqueById(history.filter(validEvent)).slice(-MAX_HISTORY))); } catch {} }
  }

  global.ZychAlerts = { ...(global.ZychAlerts || {}), BrowserLocalStorageAdapter, AlertStorage: BrowserLocalStorageAdapter, ALERTS_KEY, HISTORY_KEY, MAX_HISTORY, validEvent };
})(window);
