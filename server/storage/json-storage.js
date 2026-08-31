'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');

const validTrigger = item => item && typeof item.id === 'string' && item.id && typeof item.alertId === 'string' && typeof item.marketId === 'string' && Number.isFinite(Number(item.triggeredAt ?? item.timestamp));
const unique = records => [...new Map(records.map(item => [item.id, item])).values()];
const validSubscription = item => item && typeof item.endpoint === 'string' && /^https:\/\//.test(item.endpoint) && item.keys && typeof item.keys.p256dh === 'string' && item.keys.p256dh.length >= 16 && typeof item.keys.auth === 'string' && item.keys.auth.length >= 8;
const uniqueSubscriptions = records => [...new Map(records.map(item => [item.endpoint, item])).values()];

class JsonStorageAdapter {
  constructor({ directory, core, historyLimit = 500, logger }) {
    this.directory = directory; this.core = core; this.historyLimit = historyLimit; this.logger = logger;
    this.file = path.join(directory, 'alerts-state.json'); this.state = { version: 1, alerts: [], history: [], pushSubscriptions: [], updatedAt: null }; this.healthy = false; this.writeChain = Promise.resolve();
  }
  async init() {
    await fs.mkdir(this.directory, { recursive: true });
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8'));
      const alerts = unique((Array.isArray(parsed.alerts) ? parsed.alerts : []).map(item => this.core.migrateAlert(item)).filter(item => this.core.validateAlert(item)));
      const history = unique((Array.isArray(parsed.history) ? parsed.history : []).filter(validTrigger).map(item=>{const marketId=this.core.canonicalMarketId(item);return marketId?{...item,marketType:item.marketType||'spot',marketId}:item})).slice(-this.historyLimit);
      const pushSubscriptions = uniqueSubscriptions((Array.isArray(parsed.pushSubscriptions) ? parsed.pushSubscriptions : []).filter(validSubscription));
      this.state = { version: 1, alerts, history, pushSubscriptions, updatedAt: Number(parsed.updatedAt) || null };
      this.logger.info('storage_loaded', { alerts: alerts.length, history: history.length, pushSubscriptions: pushSubscriptions.length });
    } catch (error) {
      if (error.code !== 'ENOENT') {
        const backup = `${this.file}.corrupt-${Date.now()}`;
        await fs.rename(this.file, backup).catch(() => {});
        this.logger.warn('storage_corrupt', { backup: path.basename(backup) });
      }
      await this.flush();
    }
    this.healthy = true;
    return this.snapshot();
  }
  snapshot() { return structuredClone(this.state); }
  loadAlerts() { return structuredClone(this.state.alerts); }
  loadTriggerHistory() { return structuredClone(this.state.history); }
  loadPushSubscriptions() { return structuredClone(this.state.pushSubscriptions); }
  async save(alerts, history = this.state.history) {
    this.state = {
      version: 1,
      alerts: unique(alerts.map(item => this.core.migrateAlert(item)).filter(item => this.core.validateAlert(item))),
      history: unique(history.filter(validTrigger)).slice(-this.historyLimit),
      pushSubscriptions: this.state.pushSubscriptions,
      updatedAt: Date.now()
    };
    return this.flush();
  }
  async savePushSubscription(subscription) {
    if (!validSubscription(subscription)) return null;
    const now = Date.now(), existing = this.state.pushSubscriptions.find(item => item.endpoint === subscription.endpoint);
    const record = { endpoint: subscription.endpoint, keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth }, createdAt: existing?.createdAt || now, updatedAt: now, enabled: true, clientId: typeof subscription.clientId === 'string' ? subscription.clientId.slice(0, 100) : null };
    this.state.pushSubscriptions = uniqueSubscriptions([...this.state.pushSubscriptions.filter(item => item.endpoint !== record.endpoint), record]); await this.flush(); return structuredClone(record);
  }
  async removePushSubscription(endpoint) { const before = this.state.pushSubscriptions.length; this.state.pushSubscriptions = this.state.pushSubscriptions.filter(item => item.endpoint !== endpoint); if (before !== this.state.pushSubscriptions.length) await this.flush(); return before !== this.state.pushSubscriptions.length; }
  async flush() {
    const snapshot = JSON.stringify(this.state, null, 2);
    this.writeChain = this.writeChain.then(async () => {
      const temporary = `${this.file}.${process.pid}.tmp`;
      await fs.writeFile(temporary, snapshot, { encoding: 'utf8', mode: 0o600 });
      await fs.rename(temporary, this.file);
    });
    await this.writeChain;
  }
  async close() { await this.writeChain; }
  status() { return { healthy: this.healthy, type: 'json-file' }; }
}
module.exports = { JsonStorageAdapter, validTrigger, validSubscription };
