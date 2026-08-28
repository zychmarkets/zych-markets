'use strict';
const path = require('node:path');

const integer = (value, fallback, min, max) => {
  const number = Number(value);
  return Number.isInteger(number) && number >= min && number <= max ? number : fallback;
};
const number = (value, fallback, min = 0) => { const parsed=Number(value); return Number.isFinite(parsed)&&parsed>=min?parsed:fallback; };
const list = (value, fallback) => String(value || fallback).split(',').map(item=>item.trim().toUpperCase()).filter(Boolean);

function loadConfig(env = process.env, root = path.resolve(__dirname, '..')) {
  return Object.freeze({
    host: env.ZYCH_HOST || '127.0.0.1',
    port: integer(env.ZYCH_PORT, 4178, 1, 65535),
    dataDir: path.resolve(root, env.ZYCH_DATA_DIR || 'server-data'),
    historyLimit: integer(env.ZYCH_HISTORY_LIMIT, 500, 10, 5000),
    logLevel: env.ZYCH_LOG_LEVEL || 'info',
    binanceRestBase: env.BINANCE_REST_BASE || 'https://api.binance.com/api/v3',
    binanceWsBase: env.BINANCE_WS_BASE || 'wss://stream.binance.com:9443',
    bybitRestBase: env.BYBIT_REST_BASE || 'https://api.bybit.com/v5/market',
    bybitWsBase: env.BYBIT_WS_BASE || 'wss://stream.bybit.com/v5/public/spot',
    okxRestBase: env.OKX_REST_BASE || 'https://www.okx.com/api/v5',
    okxWsPublicBase: env.OKX_WS_PUBLIC_BASE || 'wss://ws.okx.com:8443/ws/v5/public',
    okxWsBusinessBase: env.OKX_WS_BUSINESS_BASE || 'wss://ws.okx.com:8443/ws/v5/business',
    radarEnabled: env.RADAR_UNIVERSE_ENABLED !== 'false',
    radarIngestionEnabled: env.RADAR_INGESTION_ENABLED !== 'false',
    radarRefreshIntervalMs: integer(env.RADAR_UNIVERSE_REFRESH_MS, 60000, 5000, 3600000),
    radarRequestTimeoutMs: integer(env.RADAR_REQUEST_TIMEOUT_MS, 10000, 100, 120000),
    radarEventStoreLimit: integer(env.RADAR_EVENT_STORE_LIMIT, 500, 10, 10000),
    radarEventQueueLimit: integer(env.RADAR_EVENT_QUEUE_LIMIT, 1000, 10, 10000),
    radarTimeframes: Object.freeze(list(env.RADAR_TIMEFRAMES, '1m,5m,15m').map(item=>item.toLowerCase()).filter(item=>['1m','5m','15m'].includes(item))),
    radarStateHistoryLimit: integer(env.RADAR_STATE_HISTORY_LIMIT, 300, 70, 2000),
    radarRecoveryConcurrency: integer(env.RADAR_RECOVERY_CONCURRENCY, 4, 1, 32),
    radarRecoveryRetries: integer(env.RADAR_RECOVERY_RETRIES, 2, 0, 5),
    radarStaleCheckMs: integer(env.RADAR_STALE_CHECK_MS, 30000, 1000, 300000),
    radarMomentum: Object.freeze({enabled:env.RADAR_PRICE_MOMENTUM_ENABLED!=='false',signalWindow:integer(env.RADAR_MOMENTUM_SIGNAL_WINDOW,3,1,20),baselineWindow:integer(env.RADAR_MOMENTUM_BASELINE_WINDOW,60,20,500),minimumWarmup:integer(env.RADAR_MOMENTUM_MINIMUM_WARMUP,65,25,1000),threshold:number(env.RADAR_MOMENTUM_Z_THRESHOLD,3,0.5)}),
    radarVolumeAnomaly: Object.freeze({enabled:env.RADAR_VOLUME_ANOMALY_ENABLED!=='false',timeframes:Object.freeze(list(env.RADAR_VOLUME_ANOMALY_TIMEFRAMES,'1m,5m,15m').map(item=>item.toLowerCase()).filter(item=>['1m','5m','15m'].includes(item))),baselineWindow:integer(env.RADAR_VOLUME_BASELINE_WINDOW,60,20,500),minimumRelativeVolume:number(env.RADAR_VOLUME_MIN_RELATIVE_VOLUME,2,1),minimumZScore:number(env.RADAR_VOLUME_MIN_ZSCORE,3,0.5)}),
    radarQualification: Object.freeze({policyVersion:env.RADAR_QUALIFICATION_POLICY_VERSION||'qualification-v1',windowMs:integer(env.RADAR_QUALIFICATION_WINDOW_MS,90000,1000,3600000),momentumMinZScore:number(env.RADAR_QUALIFY_MOMENTUM_MIN_ZSCORE,4,0.5),volumeMinRelativeVolume:number(env.RADAR_QUALIFY_VOLUME_MIN_RELATIVE_VOLUME,3,1),volumeMinZScore:number(env.RADAR_QUALIFY_VOLUME_MIN_ZSCORE,4,0.5),bufferMaxSize:integer(env.RADAR_CANDIDATE_BUFFER_MAX_SIZE,2000,10,20000),bufferMaxPerKey:integer(env.RADAR_CANDIDATE_BUFFER_MAX_PER_KEY,20,2,200),bufferTtlMs:integer(env.RADAR_CANDIDATE_BUFFER_TTL_MS,120000,1000,3600000),dedupMaxEntries:integer(env.RADAR_DEDUP_MAX_ENTRIES,2000,10,20000),dedupTtlMs:integer(env.RADAR_DEDUP_TTL_MS,86400000,60000,604800000),cooldowns:Object.freeze({'1m':integer(env.RADAR_DEDUP_COOLDOWN_1M_MS,300000,0,86400000),'5m':integer(env.RADAR_DEDUP_COOLDOWN_5M_MS,900000,0,86400000),'15m':integer(env.RADAR_DEDUP_COOLDOWN_15M_MS,1800000,0,86400000)}),momentumZDelta:number(env.RADAR_MATERIAL_MOMENTUM_Z_DELTA,1,0),volumeRelativeDelta:number(env.RADAR_MATERIAL_VOLUME_RELATIVE_DELTA,1,0),volumeZDelta:number(env.RADAR_MATERIAL_VOLUME_Z_DELTA,1,0)}),
    universePolicy: Object.freeze({
      version: env.RADAR_POLICY_VERSION || 'universe-v1',
      marketType: 'spot',
      allowedQuotes: Object.freeze(list(env.RADAR_ALLOWED_QUOTES, 'USDT')),
      targetUniverseSize: integer(env.RADAR_TARGET_SIZE, 100, 1, 200),
      minimumQuoteVolume24h: number(env.RADAR_MIN_QUOTE_VOLUME_24H, 1000000),
      staleSnapshotTimeoutMs: integer(env.RADAR_STALE_SNAPSHOT_MS, 180000, 10000, 86400000),
      maximumSpreadPct: env.RADAR_MAX_SPREAD_PCT ? number(env.RADAR_MAX_SPREAD_PCT, null) : null,
      missingSpreadPolicy: env.RADAR_MISSING_SPREAD_POLICY === 'exclude' ? 'exclude' : 'allow',
      liquidityTiers: Object.freeze({ A:number(env.RADAR_TIER_A_VOLUME,100000000), B:number(env.RADAR_TIER_B_VOLUME,10000000), C:number(env.RADAR_TIER_C_VOLUME,1000000) })
    }),
    vapidPublicKey: env.VAPID_PUBLIC_KEY || '',
    vapidPrivateKey: env.VAPID_PRIVATE_KEY || '',
    vapidSubject: env.VAPID_SUBJECT || 'mailto:admin@localhost',
    root
  });
}
module.exports = { loadConfig };
