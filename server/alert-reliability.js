'use strict';
const { evidence } = require('../js/services/reliability-contract');
const { reduceFeed, domainPolicy, diagnostics } = require('../js/services/reliability-reducer');
const { normalizedProductCapabilities } = require('./product-capabilities');
const capabilities = normalizedProductCapabilities();
const epochs = new WeakMap(); let nextEpoch = 0;
const epoch = socket => { if (!socket) return null; if (!epochs.has(socket)) epochs.set(socket, ++nextEpoch); return epochs.get(socket); };
const frame = alert => (alert.condition.window || alert.condition.timeframe || '').replace('24h', '1d');

// Read existing protocol-owned facts; never turn a legacy `live` into an ACK.
function transportFacts(root, alert) {
  let transport = root.transports?.[alert.exchange] || root;
  const parent = transport;
  const type = alert.type === 'price' ? 'ticker' : 'candle', interval = frame(alert);
  let topic, socket = transport.socket, ack = 'unknown', requested = null, ackAt = null;
  if (alert.exchange === 'kraken') {
    transport = transport.channels?.find(c => c.channel === (type === 'ticker' ? 'trade' : 'ohlc') && (type === 'ticker' || c.interval === ({'5m':5,'15m':15,'30m':30,'1h':60,'4h':240,'1d':1440})[interval])) || {};
    socket = transport.socket;
    topic = [...(transport.markets || [])].find(([, row]) => row.nativeSymbol === alert.symbol)?.[0];
  } else if (alert.exchange === 'coinbase') topic = `market_trades:${alert.symbol}`;
  else if (alert.exchange === 'bingx') topic = type === 'ticker' ? `${alert.symbol}@lastPrice` : `${alert.symbol}@kline_${({'5m':'5min','15m':'15min','30m':'30min'})[interval] || interval}`;
  else if (alert.exchange === 'binance') topic = `${alert.symbol.toLowerCase()}@${type === 'ticker' ? 'ticker' : `kline_${interval}`}`;
  else if (alert.exchange === 'bybit') topic = type === 'ticker' ? `tickers.${alert.symbol}` : `kline.${({'5m':'5','15m':'15','30m':'30','1h':'60','4h':'240','1d':'D'})[interval]}.${alert.symbol}`;
  else if (alert.exchange === 'okx') {
    socket = transport.sockets?.get(type === 'ticker' ? 'public' : 'business');
    topic = `${type === 'ticker' ? 'tickers' : `candle${({'1h':'1H','4h':'4H','1d':'1D'})[interval] || interval}`}:${alert.symbol}`;
  }
  const ctx = transport.context;
  const fact = transport.topicEvidence?.get(topic);
  if (fact && fact.socket === socket) { ack = fact.acknowledgement; requested = fact.requestedAt; ackAt = fact.lastAckAt; }
  else if (ctx && ctx.socket === socket && !ctx.closed) {
    requested = transport.connectedAt;
    ack = ctx.acked.has(topic) ? 'acknowledged' : 'pending';
    // Only the protocol handler may supply a correlated ACK timestamp.
    ackAt = ctx.ackTimes?.get(topic) ?? null;
  }
  const generation = epoch(socket), connectionId = `${alert.exchange}:${type === 'ticker' ? 'price' : interval}`;
  return { current: { connectionId, generation }, topic, transport, socket, failed: !socket && (transport.status === 'failed' || parent.status === 'failed'), subscription: { requestedAt: requested, acknowledgement: ack, lastAckAt: ackAt }, connection: { state: socket?.readyState === 1 ? 'OPEN' : socket?.readyState === 0 ? 'CONNECTING' : 'CLOSED', reconnecting: socket?.readyState !== 1 && transport.status === 'reconnecting', reconnectCount: transport.reconnectCount ?? null, lastReconnectAt: transport.lastReconnectAt ?? null } };
}

function freshnessPolicy(alert) {
  const trade = ['coinbase', 'kraken'].includes(alert.exchange);
  // Trade/OHLC updates are activity driven: silence is stale evidence, not an outage.
  const budget = trade ? 30000 : alert.type === 'price' ? (alert.exchange === 'bybit' ? 15000 : 30000) : 60000;
  return domainPolicy('alerts', { maxReceiptAgeMs: budget, maxSourceAgeMs: alert.type === 'price' ? budget : null, ackTimeoutMs:15000, cadence: trade ? 'activity-driven' : 'periodic', dataField: alert.type === 'price' ? 'lastPriceAt' : 'lastCandleAt' });
}

function readiness(runner, alert) {
  const now = runner.now(), facts = transportFacts(runner.transport, alert), seen = runner.marketEvidence.get(alert.id);
  const current = seen && seen.generation === facts.current.generation && seen.connectionId === facts.current.connectionId;
  const evaluation = current ? runner.evaluations.get(alert.id) : null;
  const storage = runner.storage.status?.();
  const persistence = runner.persistence.state === 'FAILED' || storage?.healthy === false ? { state: 'FAILED' } : storage?.healthy === true ? { state: 'READY' } : runner.persistence;
  const value = evidence({ identity: { domain: 'alerts', exchange: alert.exchange, marketId: alert.marketId, nativeSymbol: alert.symbol, channel: alert.type === 'price' ? 'ticker' : 'candle', timeframe: frame(alert) || null, ...facts.current }, capability: capabilities.exchanges[alert.exchange]?.alerts[alert.type], connection: facts.connection, subscription: facts.subscription, data: current ? seen.data : {}, heartbeat: { lastHeartbeatAt: facts.transport.lastHeartbeatAt }, processing: evaluation || {}, persistence, error: { code: facts.transport.lastError?.code, lastErrorAt: facts.transport.lastError?.at } });
  const result = reduceFeed(value, { policy: freshnessPolicy(alert), now, current: facts.current });
  let state = result.state === 'LIVE' ? 'READY' : result.state, reasons = result.reasons;
  const baseline = current && Boolean(evaluation?.baseline);
  if (state !== 'UNSUPPORTED') {
    if (alert.status !== 'active') { state = 'PAUSED'; reasons = ['ALERT_INACTIVE']; }
    else if (runner.status !== 'running') { state = 'WAITING_FOR_DATA'; reasons = ['RUNNER_NOT_RUNNING']; }
    else if (persistence.state === 'FAILED') { state = 'FAILED'; reasons = ['PERSISTENCE_FAILED']; }
    else if (evaluation?.state === 'FAILED') { state = 'FAILED'; reasons = ['EVALUATION_FAILED']; }
    else if (facts.failed) { state = 'FAILED'; reasons = ['TRANSPORT_FAILED']; }
    else if (facts.connection.reconnecting) { state = 'RECONNECTING'; reasons = ['CONNECTION_RECOVERING']; }
    else if (result.freshness.state === 'FRESH' && !baseline && !result.subscription.failed) { state = 'WAITING_FOR_BASELINE'; reasons = ['BASELINE_UNPROVEN']; }
  }
  return { alertId: alert.id, exchange: alert.exchange, marketId: alert.marketId, type: alert.type, active: alert.status === 'active', state, reasons, lastMarketDataAgeMs: result.freshness.ageMs, baseline: baseline ? 'READY' : 'PENDING', lastEvaluation: evaluation || null, persistence: persistence.state, transport: {topic:facts.topic ?? null,lastMessageAt:facts.transport.lastMessageAt ?? null,lastDisconnectAt:facts.transport.lastDisconnect?.at ?? null,lastDisconnectCode:typeof facts.transport.lastDisconnect?.code==='number'?facts.transport.lastDisconnect.code:null}, evidence: value };
}

function alertDiagnostics(runner) {
  const all = runner.alerts.filter(a => ['active', 'paused'].includes(a.status)).map(a => readiness(runner, a));
  const active = all.filter(a => a.active), applicable = active.filter(a => a.state !== 'UNSUPPORTED');
  const count = state => active.filter(a => a.state === state).length;
  const topics = new Map();
  for (const detail of active) {
    const i = detail.evidence.identity, key = JSON.stringify([i.exchange,i.marketId,i.channel,i.timeframe]);
    const record = { evidence: detail.evidence, current: { connectionId:i.connectionId,generation:i.generation } };
    if (detail.state !== 'READY') record.evidence = evidence({ ...detail.evidence, processing:{state:detail.state === 'FAILED'?'FAILED':'PENDING'} });
    if (!topics.has(key) || detail.state !== 'READY') topics.set(key,record);
  }
  const normalized = diagnostics({domain:'alerts',now:runner.now(),records:[...topics.values()],policy:i=>freshnessPolicy({exchange:i.exchange,type:i.channel==='ticker'?'price':'movement'})});
  return { runner: runner.status, summary: !active.length ? 'IDLE' : !applicable.length ? 'UNSUPPORTED' : new Set(applicable.map(a => a.state)).size === 1 ? applicable[0].state : 'PARTIAL', counts: { total: active.length, ready: count('READY'), stale: count('STALE'), failed: count('FAILED'), unsupported: count('UNSUPPORTED'), waiting: applicable.filter(a => !['READY','STALE','FAILED'].includes(a.state)).length }, transportSummary:normalized, persistence: { ...runner.persistence, storage: runner.storage.status?.() || null }, details: all.slice(0, 200), omittedDetails: Math.max(0, all.length - 200) };
}
module.exports = { transportFacts, readiness, alertDiagnostics, freshnessPolicy };
