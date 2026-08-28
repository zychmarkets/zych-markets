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
const { BinanceCatalogAdapter, BybitCatalogAdapter, OkxCatalogAdapter } = require('./radar/catalog-adapters.js');
const { MarketCatalogService } = require('./radar/market-catalog-service.js');
const { MarketUniverseService } = require('./radar/market-universe-service.js');
const { UnifiedEventStore } = require('./radar/event-store.js');
const { RadarEventPipeline } = require('./radar/event-pipeline.js');
const { MarketStateStore } = require('./radar/market-state-store.js');
const { CandleHistoryAdapter } = require('./radar/candle-history-adapters.js');
const { CandleStreamAdapter } = require('./radar/candle-stream-adapters.js');
const { RecoveryCoordinator } = require('./radar/recovery-coordinator.js');
const { PriceMomentumDetector } = require('./radar/detectors/price-momentum.js');
const { VolumeAnomalyDetector } = require('./radar/detectors/volume-anomaly.js');
const { DetectorRegistry } = require('./radar/detector-registry.js');
const { IngestionSupervisor } = require('./radar/ingestion-supervisor.js');
const { CandidateBuffer } = require('./radar/candidate-buffer.js');
const { QualificationPolicy } = require('./radar/qualification-policy.js');
const { MaterialChangePolicy } = require('./radar/material-change-policy.js');
const { DedupStore } = require('./radar/dedup-store.js');
const { UnifiedEventBuilder } = require('./radar/unified-event-builder.js');
const { QualificationEngine } = require('./radar/qualification-engine.js');

async function createServerApp(options = {}) {
  const config = options.config || loadConfig(), logger = options.logger || createLogger(config.logLevel);
  const storage = options.storage || new JsonStorageAdapter({ directory: config.dataDir, core, historyLimit: config.historyLimit, logger }); await storage.init();
  const transport = options.transport || new MultiExchangeMarketTransport({ logger, transports: { binance: new BinanceMarketTransport({ restBase: config.binanceRestBase, wsBase: config.binanceWsBase, logger }), bybit: new BybitMarketTransport({ restBase: config.bybitRestBase, wsBase: config.bybitWsBase, logger }), okx: new OkxMarketTransport({ restBase: config.okxRestBase, wsPublicBase: config.okxWsPublicBase, wsBusinessBase: config.okxWsBusinessBase, logger }) } });
  const notifier = options.notifier || new WebPushNotifier({ storage, logger, publicKey: config.vapidPublicKey, privateKey: config.vapidPrivateKey, subject: config.vapidSubject });
  const runner = options.runner || new ServerAlertRunner({ core, storage, transport, notifier, logger }); await runner.start();
  const universe = options.universe || (config.radarEnabled === true ? new MarketUniverseService({ catalog:new MarketCatalogService({ logger,requestTimeoutMs:config.radarRequestTimeoutMs, adapters:[new BinanceCatalogAdapter({restBase:config.binanceRestBase}),new BybitCatalogAdapter({restBase:config.bybitRestBase}),new OkxCatalogAdapter({restBase:config.okxRestBase})] }), policy:config.universePolicy, refreshIntervalMs:config.radarRefreshIntervalMs, logger }) : null);
  if(universe)await universe.initialize();
  const eventStore=options.eventStore||new UnifiedEventStore({limit:config.radarEventStoreLimit||500}),qualificationConfig=config.radarQualification||{},qualification=options.qualification||new QualificationEngine({buffer:new CandidateBuffer({maxSize:qualificationConfig.bufferMaxSize,maxPerKey:qualificationConfig.bufferMaxPerKey,ttlMs:qualificationConfig.bufferTtlMs}),policy:new QualificationPolicy({version:qualificationConfig.policyVersion,windowMs:qualificationConfig.windowMs,momentumMinZScore:qualificationConfig.momentumMinZScore,volumeMinRelativeVolume:qualificationConfig.volumeMinRelativeVolume,volumeMinZScore:qualificationConfig.volumeMinZScore}),dedup:new DedupStore({maxEntries:qualificationConfig.dedupMaxEntries,ttlMs:qualificationConfig.dedupTtlMs,cooldowns:qualificationConfig.cooldowns,materialChangePolicy:new MaterialChangePolicy({momentumZDelta:qualificationConfig.momentumZDelta,volumeRelativeDelta:qualificationConfig.volumeRelativeDelta,volumeZDelta:qualificationConfig.volumeZDelta})}),builder:new UnifiedEventBuilder(),logger}),eventPipeline=options.eventPipeline||new RadarEventPipeline({store:eventStore,queueLimit:config.radarEventQueueLimit||1000,promote:candidate=>qualification.process(candidate),logger});
  let radar=options.radar||null;
  if(!radar&&universe&&config.radarIngestionEnabled===true){const momentum=new PriceMomentumDetector({...config.radarMomentum,timeframes:config.radarTimeframes}),volume=new VolumeAnomalyDetector({...config.radarVolumeAnomaly}),minimumLookback=Math.max(config.radarMomentum.minimumWarmup,config.radarVolumeAnomaly.baselineWindow+1),store=new MarketStateStore({historyLimit:config.radarStateHistoryLimit,minimumLookback}),history={binance:new CandleHistoryAdapter({exchange:'binance',restBase:config.binanceRestBase}),bybit:new CandleHistoryAdapter({exchange:'bybit',restBase:config.bybitRestBase}),okx:new CandleHistoryAdapter({exchange:'okx',restBase:config.okxRestBase})},streams={binance:new CandleStreamAdapter({exchange:'binance',wsBase:config.binanceWsBase,logger}),bybit:new CandleStreamAdapter({exchange:'bybit',wsBase:config.bybitWsBase,logger}),okx:new CandleStreamAdapter({exchange:'okx',wsBase:config.okxWsBusinessBase,logger})},recovery=new RecoveryCoordinator({store,adapters:history,concurrency:config.radarRecoveryConcurrency,retries:config.radarRecoveryRetries,requestTimeoutMs:config.radarRequestTimeoutMs,logger}),registry=new DetectorRegistry({detectors:[momentum,volume],pipeline:eventPipeline,logger});radar=new IngestionSupervisor({universe,store,recovery,registry,streams,timeframes:config.radarTimeframes,warmupLimit:Math.min(config.radarStateHistoryLimit,minimumLookback+5),staleCheckMs:config.radarStaleCheckMs,logger});await radar.start()}
  const httpServer = createHttpServer({ runner, storage, notifier, universe, eventStore, eventPipeline, radar, qualification, config, logger });
  let stopped = false;
  return {
    config, logger, storage, transport, runner, universe, eventStore, eventPipeline, radar, qualification, server: httpServer.server,
    async listen() { await new Promise((resolve, reject) => { httpServer.server.once('error', reject); httpServer.server.listen(config.port, config.host, resolve); }); const address = httpServer.server.address(); logger.info('server_started', { host: config.host, port: address.port }); return address; },
    async stop() { if (stopped) return; stopped = true; httpServer.stopAccepting(); await new Promise(resolve => httpServer.server.listening ? httpServer.server.close(resolve) : resolve()); await radar?.stop(); await universe?.stop(); await eventPipeline.idle(); qualification.stop(); await eventPipeline.stop(); eventStore.stop(); await runner.stop(); logger.info('server_stopped'); }
  };
}
module.exports = { createServerApp };
