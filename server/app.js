'use strict';
const core = require('../js/alerts/alert-core.js');
const { loadConfig } = require('./config.js');
const { createLogger } = require('./logger.js');
const { JsonStorageAdapter } = require('./storage/json-storage.js');
const { BinanceMarketTransport } = require('./transports/binance-market-transport.js');
const { BybitMarketTransport } = require('./transports/bybit-market-transport.js');
const { OkxMarketTransport } = require('./transports/okx-market-transport.js');
const { MultiExchangeMarketTransport } = require('./transports/multi-exchange-market-transport.js');
const { WebPushNotifier } = require('./notifiers/web-push-notifier.js');
const { ServerAlertRunner } = require('./alert-runner.js');
const { createHttpServer } = require('./http-server.js');

async function createServerApp(options = {}) {
  const config = options.config || loadConfig(), logger = options.logger || createLogger(config.logLevel);
  const storage = options.storage || new JsonStorageAdapter({ directory: config.dataDir, core, historyLimit: config.historyLimit, logger }); await storage.init();
  const transport = options.transport || new MultiExchangeMarketTransport({ logger, transports: { binance: new BinanceMarketTransport({ restBase: config.binanceRestBase, wsBase: config.binanceWsBase, logger }), bybit: new BybitMarketTransport({ restBase: config.bybitRestBase, wsBase: config.bybitWsBase, logger }), okx: new OkxMarketTransport({ restBase: config.okxRestBase, wsPublicBase: config.okxWsPublicBase, wsBusinessBase: config.okxWsBusinessBase, logger }) } });
  const notifier = options.notifier || new WebPushNotifier({ storage, logger, publicKey: config.vapidPublicKey, privateKey: config.vapidPrivateKey, subject: config.vapidSubject });
  const runner = options.runner || new ServerAlertRunner({ core, storage, transport, notifier, logger }); await runner.start();
  const httpServer = createHttpServer({ runner, storage, notifier, config, logger });
  let stopped = false;
  return {
    config, logger, storage, transport, runner, server: httpServer.server,
    async listen() { await new Promise((resolve, reject) => { httpServer.server.once('error', reject); httpServer.server.listen(config.port, config.host, resolve); }); const address = httpServer.server.address(); logger.info('server_started', { host: config.host, port: address.port }); return address; },
    async stop() { if (stopped) return; stopped = true; httpServer.stopAccepting(); await new Promise(resolve => httpServer.server.listening ? httpServer.server.close(resolve) : resolve()); await runner.stop(); logger.info('server_stopped'); }
  };
}
module.exports = { createServerApp };
