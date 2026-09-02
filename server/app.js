'use strict';
const core = require('../js/alerts/alert-core.js');
const { loadConfig } = require('./config.js');
const { createLogger } = require('./logger.js');
const { JsonStorageAdapter } = require('./storage/json-storage.js');
const { BinanceMarketTransport } = require('./transports/binance-market-transport.js');
const { BybitMarketTransport } = require('./transports/bybit-market-transport.js');
const { OkxMarketTransport } = require('./transports/okx-market-transport.js');
const { BingxMarketTransport } = require('./transports/bingx-market-transport.js');
const { CoinbaseMarketTransport } = require('./transports/coinbase-market-transport.js');
const { MultiExchangeMarketTransport } = require('./transports/multi-exchange-market-transport.js');
const { WebPushNotifier } = require('./notifiers/web-push-notifier.js');
const { ServerAlertRunner } = require('./alert-runner.js');
const { createHttpServer } = require('./http-server.js');
const { BinanceCatalogAdapter, BybitCatalogAdapter, OkxCatalogAdapter, BingxCatalogAdapter } = require('./radar/catalog-adapters.js');
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
const { BreadthCalculator } = require('./radar/breadth-calculator.js');
const { BreadthService } = require('./radar/breadth-service.js');
const { ScorePolicy } = require('./radar/score-policy.js');
const { InterpretationPolicy } = require('./radar/interpretation-policy.js');
const { validateConfig, validateEnvironment } = require('./config-validation.js');
const { ApplicationLifecycle } = require('./lifecycle.js');
const { ProcessMetrics } = require('./process-metrics.js');
const { HealthService } = require('./health-service.js');

async function createServerApp(options = {}) {
  const config = options.config || (validateEnvironment(),validateConfig(loadConfig())), logger = options.logger || createLogger(config.logLevel), lifecycle=options.lifecycle||new ApplicationLifecycle(),metrics=options.metrics||new ProcessMetrics().start(),cleanups=[];
  try {
  const storage = options.storage || new JsonStorageAdapter({ directory: config.dataDir, core, historyLimit: config.historyLimit, logger });cleanups.push(()=>storage.close?.());await storage.init();
  const transport = options.transport || new MultiExchangeMarketTransport({ logger, debug:config.alertFeedDebug, transports: { binance: new BinanceMarketTransport({ restBase: config.binanceRestBase, wsBase: config.binanceWsBase, logger }), bybit: new BybitMarketTransport({ restBase: config.bybitRestBase, wsBase: config.bybitWsBase, logger }), okx: new OkxMarketTransport({ restBase: config.okxRestBase, wsPublicBase: config.okxWsPublicBase, wsBusinessBase: config.okxWsBusinessBase, logger }), bingx: new BingxMarketTransport({restBase:config.bingxRestBase,wsBase:config.bingxWsBase,logger}), coinbase: new CoinbaseMarketTransport({logger}) } });
  const notifier = options.notifier || new WebPushNotifier({ storage, logger, publicKey: config.vapidPublicKey, privateKey: config.vapidPrivateKey, subject: config.vapidSubject });
  const runner = options.runner || new ServerAlertRunner({ core, storage, transport, notifier, logger, debug:config.alertFeedDebug });cleanups.push(()=>runner.stop());await runner.start();
  const universe = options.universe || (config.radarEnabled === true ? new MarketUniverseService({ catalog:new MarketCatalogService({ logger,requestTimeoutMs:config.radarRequestTimeoutMs, adapters:[new BinanceCatalogAdapter({restBase:config.binanceRestBase}),new BybitCatalogAdapter({restBase:config.bybitRestBase}),new OkxCatalogAdapter({restBase:config.okxRestBase}),new BingxCatalogAdapter({restBase:config.bingxRestBase})] }), policy:config.universePolicy, refreshIntervalMs:config.radarRefreshIntervalMs, logger }) : null);
  if(universe){cleanups.push(()=>universe.stop());await universe.initialize()}
  let breadth=options.breadth||null;const contextProvider={getForEnrichment:()=>breadth?.getForEnrichment?.()||null},scorePolicy=options.scorePolicy||new ScorePolicy(config.radarScore||{}),interpretationPolicy=options.interpretationPolicy||new InterpretationPolicy({version:config.radarScore?.interpretationVersion}),eventStore=options.eventStore||new UnifiedEventStore({limit:config.radarEventStoreLimit||500}),qualificationConfig=config.radarQualification||{},qualification=options.qualification||new QualificationEngine({buffer:new CandidateBuffer({maxSize:qualificationConfig.bufferMaxSize,maxPerKey:qualificationConfig.bufferMaxPerKey,ttlMs:qualificationConfig.bufferTtlMs}),policy:new QualificationPolicy({version:qualificationConfig.policyVersion,windowMs:qualificationConfig.windowMs,momentumMinZScore:qualificationConfig.momentumMinZScore,volumeMinRelativeVolume:qualificationConfig.volumeMinRelativeVolume,volumeMinZScore:qualificationConfig.volumeMinZScore}),dedup:new DedupStore({maxEntries:qualificationConfig.dedupMaxEntries,ttlMs:qualificationConfig.dedupTtlMs,cooldowns:qualificationConfig.cooldowns,materialChangePolicy:new MaterialChangePolicy({momentumZDelta:qualificationConfig.momentumZDelta,volumeRelativeDelta:qualificationConfig.volumeRelativeDelta,volumeZDelta:qualificationConfig.volumeZDelta})}),builder:new UnifiedEventBuilder({contextProvider,scorePolicy,interpretationPolicy}),logger}),eventPipeline=options.eventPipeline||new RadarEventPipeline({store:eventStore,queueLimit:config.radarEventQueueLimit||1000,promote:candidate=>qualification.process(candidate),logger});
  let radar=options.radar||null;
  if(!radar&&universe&&config.radarIngestionEnabled===true){const momentum=new PriceMomentumDetector({...config.radarMomentum,timeframes:config.radarTimeframes}),volume=new VolumeAnomalyDetector({...config.radarVolumeAnomaly}),minimumLookback=Math.max(config.radarMomentum.minimumWarmup,config.radarVolumeAnomaly.baselineWindow+1),store=new MarketStateStore({historyLimit:config.radarStateHistoryLimit,minimumLookback}),history={binance:new CandleHistoryAdapter({exchange:'binance',restBase:config.binanceRestBase}),bybit:new CandleHistoryAdapter({exchange:'bybit',restBase:config.bybitRestBase}),okx:new CandleHistoryAdapter({exchange:'okx',restBase:config.okxRestBase}),bingx:new CandleHistoryAdapter({exchange:'bingx',restBase:config.bingxRestBase})},streams={binance:new CandleStreamAdapter({exchange:'binance',wsBase:config.binanceWsBase,logger}),bybit:new CandleStreamAdapter({exchange:'bybit',wsBase:config.bybitWsBase,logger}),okx:new CandleStreamAdapter({exchange:'okx',wsBase:config.okxWsBusinessBase,logger}),bingx:new CandleStreamAdapter({exchange:'bingx',wsBase:config.bingxWsBase,logger})},recovery=new RecoveryCoordinator({store,adapters:history,concurrency:config.radarRecoveryConcurrency,retries:config.radarRecoveryRetries,requestTimeoutMs:config.radarRequestTimeoutMs,isMarketActive:id=>radar?.selected?.has(id)===true,logger}),registry=new DetectorRegistry({detectors:[momentum,volume],pipeline:eventPipeline,logger});radar=new IngestionSupervisor({universe,store,recovery,registry,streams,timeframes:config.radarTimeframes,warmupLimit:Math.min(config.radarStateHistoryLimit,minimumLookback+5),staleCheckMs:config.radarStaleCheckMs,logger});await radar.start();cleanups.push(()=>radar.stop())}
  if(!breadth&&universe&&radar?.store&&config.radarBreadth?.enabled){breadth=new BreadthService({universe,store:radar.store,calculator:new BreadthCalculator(config.radarBreadth),enabled:true,intervalMs:config.radarBreadth.intervalMs,maxAgeMs:config.radarBreadth.maxAgeMs,logger});await breadth.start();cleanups.push(()=>breadth.stop())}else if(breadth){await breadth.start?.();cleanups.push(()=>breadth.stop?.())}
  lifecycle.transition(radar?'WARMING_UP':'DEGRADED',radar?['RADAR_WARMING_UP']:['RADAR_DISABLED']);
  const health=options.health||new HealthService({lifecycle,universe,radar,eventPipeline,minimumCompleteRatio:config.radarReadinessMinCompleteRatio,maximumHealthyAgeMs:config.radarReadinessMaxHealthyAgeMs});
  if(radar)health.start?.();
  const httpServer = createHttpServer({ runner, storage, notifier, universe, eventStore, eventPipeline, radar, qualification, breadth, scorePolicy, interpretationPolicy, health, metrics, config, logger });
  let stopped = false;
  return {
    config, logger, storage, transport, runner, universe, eventStore, eventPipeline, radar, qualification, breadth, scorePolicy, interpretationPolicy, lifecycle, health, metrics, server: httpServer.server,
    async listen() { try{await new Promise((resolve, reject) => { httpServer.server.once('error', reject); httpServer.server.listen(config.port, config.host, resolve); }); const address = httpServer.server.address(); logger.info('server_started', { host: config.host, port: address.port }); return address}catch(error){await this.stop();throw error} },
    async stop(signal='APPLICATION_STOP') { if (stopped) return; stopped = true;lifecycle.transition('STOPPING',[/^SIG(INT|TERM)$/.test(signal)?`SIGNAL_${signal}`:'SHUTDOWN_REQUESTED']);health.stop?.();httpServer.stopAccepting();const graceful=(async()=>{await breadth?.stop?.();await radar?.stop();await universe?.stop();await eventPipeline.idle();qualification.stop();await eventPipeline.stop();eventStore.stop();await runner.stop();await new Promise(resolve=>httpServer.server.listening?httpServer.server.close(resolve):resolve())})();const shutdownTimeoutMs=config.shutdownTimeoutMs||15000;let timer;const timeout=new Promise(resolve=>timer=setTimeout(()=>resolve('timeout'),shutdownTimeoutMs));const result=await Promise.race([graceful.then(()=> 'graceful'),timeout]);clearTimeout(timer);if(result==='timeout'){logger.error('shutdown_timeout',{timeoutMs:shutdownTimeoutMs});httpServer.forceClose();await Promise.race([graceful,new Promise(resolve=>setTimeout(resolve,100))])}metrics.stop();lifecycle.transition('STOPPED',['SHUTDOWN_COMPLETE']);logger.info('server_stopped',{mode:result}); }
  };
  }catch(error){lifecycle.transition('STOPPING',['STARTUP_FAILED']);for(const cleanup of cleanups.reverse())try{await cleanup()}catch(cleanupError){logger.warn('startup_cleanup_failed',{name:cleanupError.name,code:cleanupError.code,message:cleanupError.message})}metrics.stop();lifecycle.transition('STOPPED',['STARTUP_FAILED']);throw error}
}
module.exports = { createServerApp };
