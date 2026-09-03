'use strict';
const crypto = require('node:crypto');
const { transportFacts, alertDiagnostics } = require('./alert-reliability');

class ServerAlertRunner {
  constructor({ core, storage, transport, notifier, logger, now = Date.now, debug = false }) {
    this.core = core; this.storage = storage; this.transport = transport; this.notifier = notifier; this.logger = logger; this.now = now; this.debug = debug; this.alerts = []; this.history = []; this.previousPrices = new Map(); this.status = 'stopped'; this.queue = Promise.resolve();
    this.deliveries = new Map(); this.pendingTriggers = new Map(); this.marketEvidence = new Map(); this.priceEpochs = new Map(); this.processing = { depth: 0, lastEvaluatedAt: null, lastSuccessAt: null, lastError: null }; this.persistence = { state: 'UNKNOWN', lastSuccessAt: null }; this.evaluations = new Map();
  }
  async start() { this.alerts = this.storage.loadAlerts(); this.history = this.storage.loadTriggerHistory(); this.previousPrices.clear(); this.priceEpochs.clear(); this.marketEvidence.clear(); this.evaluations.clear(); this.deliveries.clear(); this.status = 'running'; await this.rebuild(); this.logger.info('runner_started', { alerts: this.alerts.length, active: this.active().length }); }
  active() { return this.alerts.filter(item => item.status === 'active'); }
  list() { return structuredClone(this.alerts); }
  events() { return structuredClone(this.history.filter(event => !this.pendingTriggers.has(event.id))).reverse(); }
  async create(definition) {
    const alert = this.core.createAlert(definition, { id: crypto.randomUUID(), now: this.now() });
    if (!alert) return { error: 'INVALID_ALERT', message: 'Invalid alert definition.' };
    const unsupported=await this.transport.validateAlert?.(alert,definition);if(unsupported)return unsupported;
    if (this.alerts.some(item => item.status !== 'triggered' && this.core.alertFingerprint(item) === this.core.alertFingerprint(alert))) return { error: 'DUPLICATE_ALERT', message: 'This alert already exists.' };
    this.alerts.push(alert); await this.persist(); await this.rebuild();
    const currentPrice=this.previousPrices.get(this.core.marketIdentity(alert)),target=Number(alert.condition?.value),alreadySatisfied=alert.type==='price'&&Number.isFinite(currentPrice)&&(alert.condition.operator==='above'?currentPrice>target:currentPrice<target);
    return { alert: structuredClone(alert), ...(alreadySatisfied?{warning:{code:'WAITING_FOR_RECROSS',message:`Current price ${currentPrice} already satisfies this condition. The alert will wait for a future directional recross of ${target}.`,currentPrice,target}}:{}) };
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
  async persist() {
    const pending = [...this.pendingTriggers.values()];
    try { await this.storage.save(this.alerts, this.history); this.persistence = { state: 'READY', lastSuccessAt: this.now() }; for (const event of pending) { this.dispatch(event); this.pendingTriggers.delete(event.id); } }
    catch (error) { this.persistence = { ...this.persistence, state: 'FAILED', lastErrorAt: this.now(), reasonCode: 'STORAGE_WRITE_FAILED' }; throw error; }
  }
  dispatch(event) {
    const outcome = { triggerId: event.id, trigger: 'PERSISTED', execution: 'SUCCESS', inApp: 'UNKNOWN', toast: 'UNKNOWN', sound: 'UNKNOWN', push: 'PENDING' };
    if (this.deliveries.get(event.id)?.trigger === 'PERSISTED') return;
    this.deliveries.set(event.id, outcome);
    while (this.deliveries.size > 200) this.deliveries.delete(this.deliveries.keys().next().value);
    // Deliberately not part of the evaluation queue. Undefined is not provider acceptance.
    Promise.resolve().then(() => this.notifier.notify(event)).then(result => { outcome.push = result?.outcome || 'UNKNOWN'; }, () => { outcome.push = 'FAILED'; });
  }
  async rebuild() { if (this.status !== 'running') return; await this.transport.start(this.active(), { onBaselineReset: market => { this.queue=this.queue.then(()=>{ this.previousPrices.delete(this.core.marketIdentity(market)); for (const alert of this.active()) if (this.core.marketIdentity(alert) === this.core.marketIdentity(market)) this.evaluations.delete(alert.id); }); }, onEvent: event => this.enqueue(event), onStatus: status => { this.transportStatus = status; } }); }
  enqueue(event) {
    const queuedAt = this.now(), observations = this.observations(event, queuedAt); this.processing.depth++;
    this.queue = this.queue.then(async () => { this.processing.queueAgeMs = this.now() - queuedAt; await this.handle(event, observations); }).catch(error => { this.processing.lastError = { code: 'ALERT_PROCESSING_FAILED', at: this.now() }; this.logger.error('runner_event_error', { message: error.message }); }).finally(() => { this.processing.depth--; }); return this.queue;
  }
  observations(event, receiptAt = this.now()) {
    return new Map(this.active().filter(alert => this.core.matchesEvent(alert, event) && Number(event.price) > 0).map(alert => [alert.id, { ...transportFacts(this.transport, alert).current, data: { lastReceiptAt: receiptAt, lastMarketDataAt: receiptAt, [alert.type === 'price' ? 'lastPriceAt' : 'lastCandleAt']: receiptAt, sourceTimestamp: alert.type === 'price' ? (typeof event.sourceTimestamp === 'string' ? Date.parse(event.sourceTimestamp) : event.sourceTimestamp ?? null) : null } }]));
  }
  async handle(event, observations = this.observations(event)) {
    if (observations.size && !this.active().some(alert => observations.has(alert.id) && observations.get(alert.id).generation === transportFacts(this.transport, alert).current.generation)) return;
    let changed = false, subscriptionsChanged = false, evaluationError = null, evaluatedSuccessfully = false;
    const triggers = []; this.processing.lastEvaluatedAt = this.now();
    const observedEpoch = observations.values().next().value?.generation;
    if (event.eventType === 'ticker' && observedEpoch != null) {
      const market = this.core.marketIdentity(event), oldEpoch = this.priceEpochs.get(market);
      if (oldEpoch !== undefined && oldEpoch !== observedEpoch) this.previousPrices.delete(market);
      this.priceEpochs.set(market, observedEpoch);
    }
    for (const alert of this.active()) {
      if (!this.core.matchesEvent(alert, event) || !(Number(event.price) > 0)) continue;
      const facts = transportFacts(this.transport, alert), previous = this.marketEvidence.get(alert.id), observed = observations.get(alert.id);
      if (!observed || observed.generation !== facts.current.generation) continue;
      if (alert.type === 'price' && previous && previous.generation !== facts.current.generation) this.previousPrices.delete(this.core.marketIdentity(alert));
      this.marketEvidence.set(alert.id, observed);
    }
    const identity = this.core.marketIdentity(event), currentPrice = Number(event?.price), previousPrice = identity ? this.previousPrices.get(identity) : undefined;
    if(this.debug&&event?.eventType==='ticker')this.logger.debug('alert-runner-tick',{marketId:identity,price:currentPrice,activeAlerts:this.active().filter(alert=>this.core.marketIdentity(alert)===identity).length,previousPrice:Number.isFinite(previousPrice)?previousPrice:null});
    for (let index = 0; index < this.alerts.length; index += 1) {
      const alert = this.alerts[index]; if (!this.core.matchesEvent(alert, event)) continue;
      const observed = observations.get(alert.id); if (observed && observed.generation !== transportFacts(this.transport, alert).current.generation) continue;
      let result;
      try { result = this.core.processMarketEvent(alert, event, { now: this.now(), eventId: crypto.randomUUID(), previousPrice }); }
      catch (error) { this.evaluations.set(alert.id, { lastEvaluatedAt: this.now(), lastSuccessAt: this.evaluations.get(alert.id)?.lastSuccessAt ?? null, state: 'FAILED', reasonCode: 'EVALUATION_FAILED' }); evaluationError = error; continue; }
      evaluatedSuccessfully ||= !result.unavailable;
      let baseline = !result.unavailable;
      if (alert.type === 'volume') {
        const volumes = transportFacts(this.transport, alert).transport.baselines?.get(`${alert.symbol}:${alert.condition.timeframe}`);
        baseline = baseline && (volumes?.size ?? volumes?.length ?? 0) >= 20;
      }
      this.evaluations.set(alert.id, { lastEvaluatedAt: this.now(), lastSuccessAt: result.unavailable ? null : this.now(), state: result.unavailable ? 'PENDING' : 'READY', baseline });
      if(this.debug&&alert.type==='price')this.logger.debug('alert-eval',{alertId:alert.id,marketId:identity,previousPrice:Number.isFinite(previousPrice)?previousPrice:null,currentPrice,target:Number(alert.condition.value),condition:alert.condition.operator,crossed:result.triggered});
      if (!result.stateChanged) continue;
      changed = true; this.alerts[index] = result.alert;
      if (result.triggered) {
        this.history.push(result.triggerEvent); triggers.push(result.triggerEvent); this.pendingTriggers.set(result.triggerEvent.id, result.triggerEvent);
        this.deliveries.set(result.triggerEvent.id, {triggerId:result.triggerEvent.id,trigger:'CREATED',execution:'PENDING',push:'UNKNOWN',inApp:'UNKNOWN',toast:'UNKNOWN',sound:'UNKNOWN'});
        while (this.deliveries.size > 200) this.deliveries.delete(this.deliveries.keys().next().value);
        if (result.alert.status === 'triggered') subscriptionsChanged = true;
      }
    }
    // Kraken crossings must remain trade-to-trade when OHLC Movement shares a market.
    if (identity && Number.isFinite(currentPrice) && (event.exchange !== 'kraken' || event.eventType === 'ticker')) this.previousPrices.set(identity, currentPrice);
    if (changed || this.pendingTriggers.size) {
      try { await this.persist(); }
      catch (error) { for (const event of triggers) this.deliveries.set(event.id, { triggerId: event.id, trigger: 'FAILED', execution: 'FAILED', push: 'UNKNOWN', inApp: 'UNKNOWN', sound: 'UNKNOWN' }); throw error; }
    }
    if (subscriptionsChanged) await this.rebuild();
    if (evaluationError) throw evaluationError;
    if (evaluatedSuccessfully) { this.processing.lastSuccessAt = this.now(); this.processing.lastError = null; }
  }
  async stop() { this.status = 'stopping'; try { await this.queue; await this.persist(); } finally { await this.transport.stop(); this.status = 'stopped'; } await this.storage.close(); }
  diagnostics() {
    const active=this.active(),markets=new Set(active.map(item=>this.core.marketIdentity(item))),transport=this.transport.diagnostics();
    const reliability = alertDiagnostics(this);
    const monitoringStatus = reliability.summary === 'READY' ? 'LIVE' : reliability.summary;
    return { ...transport,status:this.status,monitoringStatus,activeAlerts:active.length,activeMarkets:markets.size,reliability,processing:{...this.processing},persistence:{...this.persistence},notificationDelivery:{ latest:[...this.deliveries.values()].slice(-50),inApp:'UNKNOWN',toast:'UNKNOWN',sound:'UNKNOWN' } };
  }
}
module.exports = { ServerAlertRunner };
