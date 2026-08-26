(function (global) {
  'use strict';
  const finite = value => Number.isFinite(Number(value));
  function evaluateAlert(alert, data) {
    const condition = alert.condition || {};
    if (condition.type === 'price' && finite(data.price)) {
      const price = Number(data.price), threshold = Number(condition.value);
      return { met: condition.operator === 'above' ? price >= threshold : price <= threshold, details: { currentPrice: price } };
    }
    if (condition.type === 'movement' && finite(data.price) && finite(data.referencePrice) && Number(data.referencePrice) > 0) {
      const price = Number(data.price), referencePrice = Number(data.referencePrice), percentMove = ((price - referencePrice) / referencePrice) * 100, threshold = Number(condition.percent);
      return { met: condition.direction === 'up' ? percentMove >= threshold : percentMove <= -threshold, details: { currentPrice: price, referencePrice, percentMove, window: condition.window } };
    }
    if (condition.type === 'volume' && finite(data.currentVolume) && finite(data.averageVolume) && Number(data.averageVolume) > 0) {
      const currentVolume = Number(data.currentVolume), averageVolume = Number(data.averageVolume), ratio = currentVolume / averageVolume, multiplier = Number(condition.multiplier);
      return { met: ratio >= multiplier, details: { currentVolume, averageVolume, multiplier: ratio, timeframe: condition.timeframe } };
    }
    return { met: false, unavailable: true, details: {} };
  }
  global.ZychAlerts = { ...(global.ZychAlerts || {}), evaluateAlert };
})(window);
