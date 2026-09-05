'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');

const validTrigger = item => item && typeof item.id === 'string' && item.id && typeof item.alertId === 'string' && typeof item.marketId === 'string' && Number.isFinite(Number(item.triggeredAt ?? item.timestamp));
const unique = records => [...new Map(records.map(item => [item.id, item])).values()];
const {validEndpoint,validKeys}=require('../notifiers/push-endpoint');
const validSubscription = item => Boolean(item&&validEndpoint(item.endpoint)&&validKeys(item.keys));
const uniqueSubscriptions = records => [...new Map(records.map(item => [item.endpoint, item])).values()];

class JsonStorageAdapter {
  constructor({ directory, core, historyLimit = 500, logger }) {
    this.directory = directory; this.core = core; this.historyLimit = historyLimit; this.logger = logger;
    this.file = path.join(directory, 'alerts-state.json'); this.state = { version: 1, alerts: [], history: [], pushSubscriptions: [], pendingPush: [], updatedAt: null }; this.healthy = false; this.writeChain = Promise.resolve();
  }
  async init() {
    await fs.mkdir(this.directory, { recursive: true });
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8'));
      const alerts = unique((Array.isArray(parsed.alerts) ? parsed.alerts : []).map(item => this.core.migrateAlert(item)).filter(item => this.core.validateAlert(item)));
      const history = unique((Array.isArray(parsed.history) ? parsed.history : []).filter(validTrigger).map(item=>{const marketId=this.core.canonicalMarketId(item);return marketId?{...item,marketType:item.marketType||'spot',marketId}:item})).slice(-this.historyLimit);
      const pushSubscriptions = uniqueSubscriptions((Array.isArray(parsed.pushSubscriptions) ? parsed.pushSubscriptions : []).filter(validSubscription));
      const pendingPush=(Array.isArray(parsed.pendingPush)?parsed.pendingPush:[]).filter(row=>validTrigger(row.event)&&Array.isArray(row.endpoints)&&Number.isFinite(row.expiresAt)&&row.expiresAt>Date.now()).map(row=>({...row,endpoints:row.endpoints.filter(endpoint=>pushSubscriptions.some(sub=>sub.endpoint===endpoint))})).filter(row=>row.endpoints.length);
      this.state = { version: 1, alerts, history, pushSubscriptions, pendingPush, updatedAt: Number(parsed.updatedAt) || null };
      this.logger.info('storage_loaded', { alerts: alerts.length, history: history.length, pushSubscriptions: pushSubscriptions.length });
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
      if (error.code !== 'ENOENT') {
        const backup = `${this.file}.corrupt-${Date.now()}`;
        await fs.rename(this.file, backup);
        this.logger.warn('storage_corrupt', { backup: path.basename(backup) });
      }
      await this.flush();
    }
    this.initialized = true; this.healthy = true;
    return this.snapshot();
  }
  snapshot() { return structuredClone(this.state); }
  loadAlerts() { return structuredClone(this.state.alerts); }
  loadTriggerHistory() { return structuredClone(this.state.history); }
  loadPushSubscriptions() { return structuredClone(this.state.pushSubscriptions); }
  async save(alerts, history) {
    const savedAlerts = unique(alerts.map(item => this.core.migrateAlert(item)).filter(item => this.core.validateAlert(item)));
    const savedHistory = history === undefined ? null : unique(history.filter(validTrigger)).slice(-this.historyLimit);
    return this.transaction(next => {
      next.alerts = structuredClone(savedAlerts);
      if (savedHistory) {
        const existing=new Set(next.history.map(event=>event.id));
        next.pendingPush=(next.pendingPush||[]).filter(row=>row.expiresAt>Date.now());
        for(const event of savedHistory){
          if(existing.has(event.id)||next.pendingPush.some(row=>row.event.id===event.id)||!next.pushSubscriptions.length)continue;
          const expiresAt=Number(event.triggeredAt??event.timestamp)+300000;
          if(expiresAt>Date.now())next.pendingPush.push({event:structuredClone(event),endpoints:next.pushSubscriptions.map(sub=>sub.endpoint),expiresAt});
        }
        next.history = structuredClone(savedHistory);
      }
      next.updatedAt = Date.now();
    });
  }
  loadPendingPush() { return structuredClone((this.state.pendingPush||[]).filter(row=>row.expiresAt>Date.now()&&row.endpoints.length)); }
  async acknowledgePush(id,endpoint) {
    return this.transaction(next=>{
      next.pendingPush=(next.pendingPush||[]).map(row=>row.event.id===id?{...row,endpoints:row.endpoints.filter(value=>value!==endpoint)}:row).filter(row=>row.endpoints.length&&row.expiresAt>Date.now());
    });
  }
  async savePushSubscription(subscription) {
    if (!validSubscription(subscription)) return null;
    const input = structuredClone(subscription);
    return this.transaction(next => {
      const now = Date.now(), existing = next.pushSubscriptions.find(item => item.endpoint === input.endpoint);
      if(!existing&&next.pushSubscriptions.length>=100)return {error:"PUSH_SUBSCRIPTION_LIMIT"};
      const record = { endpoint: input.endpoint, keys: { p256dh: input.keys.p256dh, auth: input.keys.auth }, createdAt: existing?.createdAt || now, updatedAt: now, enabled: true, clientId: typeof input.clientId === 'string' ? input.clientId.slice(0, 100) : null };
      next.pushSubscriptions = uniqueSubscriptions([...next.pushSubscriptions.filter(item => item.endpoint !== record.endpoint), record]);
      return structuredClone(record);
    });
  }
  async removePushSubscription(endpoint) {
    return this.transaction(next => {
      const before = next.pushSubscriptions.length;
      next.pushSubscriptions = next.pushSubscriptions.filter(item => item.endpoint !== endpoint);
      next.pendingPush=(next.pendingPush||[]).map(row=>({...row,endpoints:row.endpoints.filter(value=>value!==endpoint)})).filter(row=>row.endpoints.length);
      return before !== next.pushSubscriptions.length;
    });
  }
  // Serialize draft creation as well as disk writes, so concurrent operations
  // cannot overwrite a newly saved subscription or publish an uncommitted draft.
  transaction(mutate) {
    this.writeChain = this.writeChain.catch(() => {}).then(async () => {
      const next = structuredClone(this.state), result = mutate(next);
      const temporary = `${this.file}.${process.pid}.tmp`;
      await fs.writeFile(temporary, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 });
      await fs.rename(temporary, this.file);
      this.state = next;
      this.healthy = true; this.lastWriteSucceeded = true; this.lastWriteAt = Date.now(); this.lastError = null;
      return result;
    }).catch(error => {
      this.healthy = false; this.lastWriteSucceeded = false; this.lastWriteFailedAt = Date.now(); this.lastError = { code: 'STORAGE_WRITE_FAILED', at: this.lastWriteFailedAt };
      throw error;
    });
    return this.writeChain;
  }
  flush() { return this.transaction(() => {}); }
  async close() { await this.writeChain; }
  status() { return { healthy: this.healthy, type: 'json-file', initialized: Boolean(this.initialized), lastWriteSucceeded: this.lastWriteSucceeded ?? null, lastWriteAt: this.lastWriteAt ?? null, lastWriteFailedAt: this.lastWriteFailedAt ?? null, lastError: this.lastError ?? null }; }
}
module.exports = { JsonStorageAdapter, validTrigger, validSubscription };
