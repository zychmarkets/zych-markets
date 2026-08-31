'use strict';
const crypto = require('node:crypto');

class ServerAlertRunner {
  constructor({ core, storage, transport, notifier, logger, now = Date.now, debug = false }) {
    this.core = core; this.storage = storage; this.transport = transport; this.notifier = notifier; this.logger = logger; this.now = now; this.debug = debug; this.alerts = []; this.history = []; this.previousPrices = new Map(); this.status = 'stopped'; this.queue = Promise.resolve();
  }
  async start() { this.alerts = this.storage.loadAlerts(); this.history = this.storage.loadTriggerHistory(); this.status = 'running'; await this.rebuild(); this.logger.info('runner_started', { alerts: this.alerts.length, active: this.active().length }); }
  active() { return this.alerts.filter(item => item.status === 'active'); }
  list() { return structuredClone(this.alerts); }
  events() { return structuredClone(this.history).reverse(); }
  async create(definition) {
    const alert = this.core.createAlert(definition, { id: crypto.randomUUID(), now: this.now() });
    if (!alert) return { error: 'INVALID_ALERT', message: 'Invalid alert definition.' };
    if (this.alerts.some(item => item.status !== 'triggered' && this.core.alertFingerprint(item) === this.core.alertFingerprint(alert))) return { error: 'DUPLICATE_ALERT', message: 'This alert already exists.' };
    this.alerts.push(alert); await this.persist(); await this.rebuild(); return { alert: structuredClone(alert) };
  }
  async pause(id) { return this.change(id, alert => ({ ...alert, status: 'paused', updatedAt: this.now() })); }
  async resume(id) { return this.change(id, alert => ({ ...alert, status: 'active', armed: true, updatedAt: this.now() })); }
  async updatePrice(id, value) {
    const index = this.alerts.findIndex(item => item.id === id), price = Number(value);
    if (index < 0) return { error: 'NOT_FOUND', message: 'Alert not found.' };
    const current = this.alerts[index];
    if (current.type !== 'price' || !Number.isFinite(price) || price <= 0) return { error: 'INVALID_PRICE', message: 'A positive price is required.' };
    const next = { ...current, condition: { ...current.condition, value: price } };
    if (!this.core.validateAlert(next)) return { error: 'INVALID_ALERT', message: 'Invalid alert update.' };
    if (this.alerts.some((item, itemIndex) => itemIndex !== index && item.status !== 'triggered' && this.core.alertFingerprint(item) === this.core.alertFingerprint(next))) return { error: 'DUPLICATE_ALERT', message: 'This alert already exists.' };
    this.alerts[index] = next; await this.persist(); await this.rebuild(); return { alert: structuredClone(next) };
  }
  async remove(id) { const before = this.alerts.length; this.alerts = this.alerts.filter(item => item.id !== id); if (before === this.alerts.length) return null; await this.persist(); await this.rebuild(); return true; }
  async removeEvent(id) { const before = this.history.length; this.history = this.history.filter(item => item.id !== id); if (before === this.history.length) return null; await this.persist(); return true; }
  async change(id, mutate) { const index = this.alerts.findIndex(item => item.id === id); if (index < 0) return null; this.alerts[index] = mutate(this.alerts[index]); await this.persist(); await this.rebuild(); return structuredClone(this.alerts[index]); }
  async persist() { await this.storage.save(this.alerts, this.history); }
  async rebuild() { if (this.status !== 'running') return; await this.transport.start(this.active(), { onEvent: event => this.enqueue(event), onStatus: status => { this.transportStatus = status; } }); }
  enqueue(event) { this.queue = this.queue.then(() => this.handle(event)).catch(error => this.logger.error('runner_event_error', { message: error.message })); return this.queue; }
  async handle(event) {
    let changed = false, subscriptionsChanged = false;
    const identity = this.core.marketIdentity(event), currentPrice = Number(event?.price), previousPrice = identity ? this.previousPrices.get(identity) : undefined;
    if(this.debug&&event?.eventType==='ticker')this.logger.debug('alert-runner-tick',{marketId:identity,price:currentPrice,activeAlerts:this.active().filter(alert=>this.core.marketIdentity(alert)===identity).length,previousPrice:Number.isFinite(previousPrice)?previousPrice:null});
    for (let index = 0; index < this.alerts.length; index += 1) {
      const alert = this.alerts[index]; if (!this.core.matchesEvent(alert, event)) continue;
      const result = this.core.processMarketEvent(alert, event, { now: this.now(), eventId: crypto.randomUUID(), previousPrice });
      if(this.debug&&alert.type==='price')this.logger.debug('alert-eval',{alertId:alert.id,marketId:identity,previousPrice:Number.isFinite(previousPrice)?previousPrice:null,currentPrice,target:Number(alert.condition.value),condition:alert.condition.operator,crossed:result.triggered});
      if (!result.stateChanged) continue;
      changed = true; this.alerts[index] = result.alert;
      if (result.triggered) { this.history.push(result.triggerEvent); await this.notifier.notify(result.triggerEvent); if (result.alert.status === 'triggered') subscriptionsChanged = true; }
    }
    if (identity && Number.isFinite(currentPrice)) this.previousPrices.set(identity, currentPrice);
    if (changed) await this.persist(); if (subscriptionsChanged) await this.rebuild();
  }
  async stop() { this.status = 'stopping'; await this.queue; await this.persist(); await this.transport.stop(); await this.storage.close(); this.status = 'stopped'; }
  diagnostics() { const markets = new Set(this.active().map(item => item.marketId)); return { status: this.status, activeAlerts: this.active().length, activeMarkets: markets.size, ...this.transport.diagnostics() }; }
}
module.exports = { ServerAlertRunner };
