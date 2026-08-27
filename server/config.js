'use strict';
const path = require('node:path');

const integer = (value, fallback, min, max) => {
  const number = Number(value);
  return Number.isInteger(number) && number >= min && number <= max ? number : fallback;
};

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
    vapidPublicKey: env.VAPID_PUBLIC_KEY || '',
    vapidPrivateKey: env.VAPID_PRIVATE_KEY || '',
    vapidSubject: env.VAPID_SUBJECT || 'mailto:admin@localhost',
    root
  });
}
module.exports = { loadConfig };
