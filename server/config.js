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
    radarRefreshIntervalMs: integer(env.RADAR_UNIVERSE_REFRESH_MS, 60000, 5000, 3600000),
    radarRequestTimeoutMs: integer(env.RADAR_REQUEST_TIMEOUT_MS, 10000, 100, 120000),
    radarEventStoreLimit: integer(env.RADAR_EVENT_STORE_LIMIT, 500, 10, 10000),
    radarEventQueueLimit: integer(env.RADAR_EVENT_QUEUE_LIMIT, 1000, 10, 10000),
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
