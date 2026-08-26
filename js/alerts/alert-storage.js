(function (global) {
  'use strict';
  const ALERTS_KEY = 'zych.alerts.v1', HISTORY_KEY = 'zych.alert-history.v1', MAX_HISTORY = 500;
  const safeArray = key => { try { const value = JSON.parse(localStorage.getItem(key)); return Array.isArray(value) ? value : []; } catch { return []; } };
  const finitePositive = value => Number.isFinite(Number(value)) && Number(value) > 0;
  const validCondition = condition => {
    if (!condition || typeof condition !== 'object') return false;
    if (condition.type === 'price') return ['above', 'below'].includes(condition.operator) && finitePositive(condition.value);
    if (condition.type === 'movement') return ['up', 'down'].includes(condition.direction) && finitePositive(condition.percent) && ['5m', '15m', '30m', '1h', '4h', '24h'].includes(condition.window);
    if (condition.type === 'volume') return finitePositive(condition.multiplier) && Number(condition.multiplier) > 1 && ['5m', '15m', '1h', '4h'].includes(condition.timeframe);
    return false;
  };
  const validAlert = item => item && typeof item.id === 'string' && typeof item.marketId === 'string' && typeof item.asset === 'string' && typeof item.symbol === 'string' && typeof item.exchange === 'string' && ['once', 'recurring'].includes(item.mode) && ['active', 'paused', 'triggered'].includes(item.status) && Number.isFinite(Number(item.createdAt)) && validCondition(item.condition);
  const validEvent = item => item && typeof item.id === 'string' && typeof item.alertId === 'string' && typeof item.marketId === 'string' && typeof item.asset === 'string' && Number.isFinite(Number(item.triggeredAt)) && item.condition && typeof item.condition === 'object';
  const uniqueById = items => [...new Map(items.map(item => [item.id, item])).values()];
  class AlertStorage {
    loadAlerts() { return uniqueById(safeArray(ALERTS_KEY).filter(validAlert)); }
    saveAlerts(alerts) { try { localStorage.setItem(ALERTS_KEY, JSON.stringify(uniqueById(alerts.filter(validAlert)))); } catch {} }
    loadHistory() { return uniqueById(safeArray(HISTORY_KEY).filter(validEvent)).slice(-MAX_HISTORY); }
    saveHistory(history) { try { localStorage.setItem(HISTORY_KEY, JSON.stringify(uniqueById(history.filter(validEvent)).slice(-MAX_HISTORY))); } catch {} }
  }
  global.ZychAlerts = { ...(global.ZychAlerts || {}), AlertStorage, ALERTS_KEY, HISTORY_KEY, MAX_HISTORY, validAlert, validEvent };
})(window);
