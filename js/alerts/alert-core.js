(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ZychAlertCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const ALERT_SCHEMA_VERSION = 1;
  const DEFAULT_COOLDOWN_MS = 5000;
  const MOVEMENT_WINDOWS = Object.freeze(['5m', '15m', '30m', '1h', '4h', '24h']);
  const VOLUME_TIMEFRAMES = Object.freeze(['5m', '15m', '1h', '4h']);
  const ALERT_TYPES = Object.freeze(['price', 'movement', 'volume']);
  const ALERT_MODES = Object.freeze(['once', 'recurring']);
  const ALERT_STATUSES = Object.freeze(['active', 'paused', 'triggered']);
  const SUPPORTED_EXCHANGES = Object.freeze(['binance', 'bybit', 'okx', 'bingx']);
  const finite = value => value !== null && value !== '' && Number.isFinite(Number(value));
  const positive = value => finite(value) && Number(value) > 0;
  const safeTicker = value => typeof value === 'string' && /^[A-Z0-9]{1,20}$/.test(value);
  const safeSymbol = value => typeof value === 'string' && /^[A-Z0-9-]{1,30}$/.test(value);

  function marketIdentity(value) {
    if (!value || typeof value.exchange !== 'string' || !safeSymbol(value.symbol)) return null;
    return `${value.exchange.toLowerCase()}:${value.marketType || 'spot'}:${value.symbol}`;
  }

  function canonicalMarketId(value) { return marketIdentity(value); }

  function validateCondition(condition) {
    if (!condition || typeof condition !== 'object') return false;
    if (condition.type === 'price') return ['above', 'below'].includes(condition.operator) && positive(condition.value);
    if (condition.type === 'movement') return ['up', 'down'].includes(condition.direction) && positive(condition.percent) && MOVEMENT_WINDOWS.includes(condition.window);
    if (condition.type === 'volume') return positive(condition.multiplier) && Number(condition.multiplier) > 1 && VOLUME_TIMEFRAMES.includes(condition.timeframe);
    return false;
  }

  function migrateAlert(record) {
    if (!record || typeof record !== 'object') return null;
    const condition = record.condition && typeof record.condition === 'object' ? { ...record.condition } : null;
    const createdAt = Number(record.createdAt);
    const canonicalId = canonicalMarketId(record);
    return {
      ...record,
      version: ALERT_SCHEMA_VERSION,
      type: record.type || condition?.type,
      baseAsset: record.baseAsset || record.asset,
      asset: record.asset || record.baseAsset,
      quoteAsset: record.quoteAsset || 'USDT',
      marketType: record.marketType || 'spot',
      marketId: canonicalId || record.marketId,
      condition,
      mode: ALERT_MODES.includes(record.mode) ? record.mode : 'once',
      status: ALERT_STATUSES.includes(record.status) ? record.status : 'active',
      armed: record.armed !== false,
      cooldownMs: finite(record.cooldownMs) && Number(record.cooldownMs) >= 0 ? Number(record.cooldownMs) : DEFAULT_COOLDOWN_MS,
      createdAt,
      updatedAt: finite(record.updatedAt) ? Number(record.updatedAt) : createdAt,
      lastTriggeredAt: finite(record.lastTriggeredAt) ? Number(record.lastTriggeredAt) : null,
      triggerCount: finite(record.triggerCount) && Number(record.triggerCount) >= 0 ? Number(record.triggerCount) : 0
    };
  }

  function validateAlert(record) {
    const alert = migrateAlert(record);
    return Boolean(alert && typeof alert.id === 'string' && alert.id && typeof alert.marketId === 'string' && alert.marketId && typeof alert.exchange === 'string' && alert.exchange && safeSymbol(alert.symbol) && safeTicker(alert.baseAsset) && safeTicker(alert.quoteAsset) && ALERT_TYPES.includes(alert.type) && ALERT_MODES.includes(alert.mode) && ALERT_STATUSES.includes(alert.status) && finite(alert.createdAt) && validateCondition(alert.condition));
  }

  function createAlert(definition, { id, now = Date.now() } = {}) {
    if (!definition || !SUPPORTED_EXCHANGES.includes(String(definition.exchange || '').toLowerCase())) return null;
    const alert = migrateAlert({
      id,
      version: ALERT_SCHEMA_VERSION,
      marketId: definition.marketId,
      exchange: definition.exchange,
      symbol: definition.symbol,
      baseAsset: definition.baseAsset || definition.asset,
      asset: definition.asset || definition.baseAsset,
      quoteAsset: definition.quoteAsset,
      type: definition.condition?.type,
      condition: definition.condition,
      timeframe: definition.condition?.timeframe || definition.condition?.window || null,
      mode: definition.mode || 'once',
      status: 'active',
      armed: true,
      cooldownMs: definition.cooldownMs ?? DEFAULT_COOLDOWN_MS,
      createdAt: now,
      updatedAt: now,
      lastTriggeredAt: null,
      triggerCount: 0
    });
    return validateAlert(alert) ? alert : null;
  }

  function validateMarketEvent(event) {
    if (!event || typeof event !== 'object' || !['ticker', 'candle'].includes(event.eventType) || typeof event.exchange !== 'string' || !safeSymbol(event.symbol) || !finite(event.timestamp)) return false;
    if (event.eventType === 'ticker') return finite(event.price);
    return finite(event.price) && finite(event.open) && finite(event.volume) && typeof event.interval === 'string';
  }

  function matchesEvent(alert, event) {
    if (!validateAlert(alert) || !validateMarketEvent(event) || alert.status !== 'active' || marketIdentity(alert) !== marketIdentity(event)) return false;
    if (alert.type === 'price') return event.eventType === 'ticker';
    if (alert.type === 'movement') return event.eventType === 'candle' && (alert.condition.window === '24h' ? '1d' : alert.condition.window) === event.interval;
    return event.eventType === 'candle' && alert.condition.timeframe === event.interval;
  }

  function evaluateAlert(alert, event, { previousPrice } = {}) {
    const condition = alert?.condition || {};
    if (condition.type === 'price' && finite(event.price)) {
      const price = Number(event.price), threshold = Number(condition.value);
      if (!finite(previousPrice)) return { met: false, baseline: true, rearm: false, details: { currentPrice: price, previousPrice: null } };
      const previous = Number(previousPrice), above = condition.operator === 'above';
      return { met: above ? previous <= threshold && price > threshold : previous >= threshold && price < threshold, rearm: above ? price <= threshold : price >= threshold, details: { currentPrice: price, previousPrice: previous } };
    }
    if (condition.type === 'movement' && finite(event.price) && finite(event.open) && Number(event.open) > 0) {
      const price = Number(event.price), referencePrice = Number(event.open), percentMove = ((price - referencePrice) / referencePrice) * 100, threshold = Number(condition.percent);
      return { met: condition.direction === 'up' ? percentMove >= threshold : percentMove <= -threshold, details: { currentPrice: price, referencePrice, percentMove, window: condition.window } };
    }
    if (condition.type === 'volume' && finite(event.volume) && finite(event.averageVolume) && Number(event.averageVolume) > 0) {
      const currentVolume = Number(event.volume), averageVolume = Number(event.averageVolume), ratio = currentVolume / averageVolume;
      return { met: ratio >= Number(condition.multiplier), details: { currentVolume, averageVolume, multiplier: ratio, timeframe: condition.timeframe } };
    }
    return { met: false, unavailable: true, details: {} };
  }

  const reasonFor = alert => alert.type === 'price' ? `price_${alert.condition.operator}` : alert.type === 'movement' ? `movement_${alert.condition.direction}` : 'volume_spike';
  function createTriggerEvent(alert, event, details, { id, now }) {
    const threshold = alert.condition.value ?? alert.condition.percent ?? alert.condition.multiplier;
    return {
      id,
      version: ALERT_SCHEMA_VERSION,
      alertId: alert.id,
      exchange: alert.exchange,
      marketId: alert.marketId,
      symbol: alert.symbol,
      baseAsset: alert.baseAsset,
      asset: alert.baseAsset,
      quoteAsset: alert.quoteAsset,
      alertType: alert.type,
      triggerPrice: details.currentPrice ?? event.price ?? null,
      currentPrice: details.currentPrice ?? event.price ?? null,
      timestamp: now,
      triggeredAt: now,
      reason: reasonFor(alert),
      threshold,
      timeframe: alert.timeframe,
      condition: { ...alert.condition },
      marketSnapshot: {
        eventType: event.eventType,
        price: Number(event.price),
        open: finite(event.open) ? Number(event.open) : null,
        high: finite(event.high) ? Number(event.high) : null,
        low: finite(event.low) ? Number(event.low) : null,
        volume: finite(event.volume) ? Number(event.volume) : null,
        interval: event.interval || null,
        sourceTimestamp: Number(event.timestamp)
      },
      ...details
    };
  }

  function processMarketEvent(alertRecord, event, { now = Date.now(), eventId, previousPrice } = {}) {
    const alert = migrateAlert(alertRecord);
    if (!validateAlert(alert) || !matchesEvent(alert, event)) return { alert, triggered: false, stateChanged: false, unavailable: true, triggerEvent: null };
    const result = evaluateAlert(alert, event, { previousPrice });
    if (result.unavailable) return { alert, triggered: false, stateChanged: false, unavailable: true, triggerEvent: null };
    if (!result.met) {
      if (!alert.armed && result.rearm !== false) return { alert: { ...alert, armed: true, updatedAt: now }, triggered: false, stateChanged: true, unavailable: false, triggerEvent: null };
      return { alert, triggered: false, stateChanged: false, unavailable: false, triggerEvent: null };
    }
    if (!alert.armed || alert.lastTriggeredAt && now - alert.lastTriggeredAt < alert.cooldownMs) return { alert, triggered: false, stateChanged: false, unavailable: false, triggerEvent: null };
    const nextAlert = { ...alert, armed: false, lastTriggeredAt: now, triggerCount: alert.triggerCount + 1, updatedAt: now, status: alert.mode === 'once' ? 'triggered' : 'active' };
    const id = eventId || `trigger-${alert.id}-${now}-${nextAlert.triggerCount}`;
    return { alert: nextAlert, triggered: true, stateChanged: true, unavailable: false, triggerEvent: createTriggerEvent(nextAlert, event, result.details, { id, now }) };
  }

  function alertFingerprint(alert) { return `${marketIdentity(alert)}|${alert.mode}|${JSON.stringify(alert.condition)}`; }

  return { ALERT_SCHEMA_VERSION, DEFAULT_COOLDOWN_MS, MOVEMENT_WINDOWS, VOLUME_TIMEFRAMES, SUPPORTED_EXCHANGES, marketIdentity, canonicalMarketId, validateCondition, migrateAlert, validateAlert, createAlert, validateMarketEvent, matchesEvent, evaluateAlert, createTriggerEvent, processMarketEvent, alertFingerprint };
});
