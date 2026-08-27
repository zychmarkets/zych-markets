'use strict';
const webpush = require('web-push');
const clean = (value, max = 120) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max);
const safeHost = endpoint => { try { return new URL(endpoint).host; } catch { return 'invalid'; } };

function notificationText(event) {
  const asset = clean(event.asset || event.baseAsset || 'Market', 20), price = Number(event.triggerPrice);
  let label = 'Alert', body = 'Market alert triggered';
  if (event.alertType === 'price') body = `Price crossed ${event.condition?.operator === 'below' ? 'below' : 'above'} $${Number.isFinite(price) ? price.toLocaleString('en-US', { maximumFractionDigits: 8 }) : clean(event.threshold)}`;
  if (event.alertType === 'movement') { label = 'Movement Alert'; body = `${asset} moved ${Number(event.percentMove) >= 0 ? '+' : ''}${Number(event.percentMove).toFixed(2)}% in ${clean(event.window || event.timeframe, 10)}`; }
  if (event.alertType === 'volume') { label = 'Volume Spike'; body = `Volume is ${Number(event.multiplier).toFixed(2)}× above baseline`; }
  return { type: 'alert-triggered', alertId: clean(event.alertId, 100), triggerId: clean(event.id, 100), asset, symbol: clean(event.symbol, 30), exchange: clean(event.exchange, 30), alertType: clean(event.alertType, 20), title: `ZYCH Markets — ${asset} ${label}`, body, triggerPrice: Number.isFinite(price) ? price : null, timestamp: Number(event.triggeredAt || event.timestamp), url: `/?trigger=${encodeURIComponent(clean(event.id, 100))}` };
}

class WebPushNotifier {
  constructor({ storage, logger, publicKey, privateKey, subject, sendNotification = webpush.sendNotification }) {
    this.storage = storage; this.logger = logger; this.enabled = Boolean(publicKey && privateKey); this.sendNotification = sendNotification; this.lastPushSuccessAt = null; this.lastPushFailureAt = null;
    if (this.enabled) webpush.setVapidDetails(subject, publicKey, privateKey);
  }
  async notify(event) {
    if (!this.enabled) return;
    const payload = JSON.stringify(notificationText(event)), subscriptions = this.storage.loadPushSubscriptions();
    await Promise.allSettled(subscriptions.map(async subscription => {
      try { await this.sendNotification({ endpoint: subscription.endpoint, keys: subscription.keys }, payload, { TTL: 300, urgency: 'high' }); this.lastPushSuccessAt = Date.now(); this.logger.info('push_sent', { triggerId: event.id, endpointHost: safeHost(subscription.endpoint) }); }
      catch (error) { this.lastPushFailureAt = Date.now(); if ([404, 410].includes(error.statusCode)) { await this.storage.removePushSubscription(subscription.endpoint); this.logger.warn('push_subscription_expired', { endpointHost: safeHost(subscription.endpoint), statusCode: error.statusCode }); } else this.logger.warn('push_failed', { endpointHost: safeHost(subscription.endpoint), statusCode: error.statusCode || null, message: clean(error.message) }); }
    }));
  }
  status() { return { pushEnabled: this.enabled, pushSubscriptionsCount: this.storage.loadPushSubscriptions().length, lastPushSuccessAt: this.lastPushSuccessAt, lastPushFailureAt: this.lastPushFailureAt }; }
}
module.exports = { WebPushNotifier, notificationText };
