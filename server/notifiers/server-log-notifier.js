'use strict';
class ServerLogNotifier {
  constructor({ logger }) { this.logger = logger; }
  async notify(event) { this.logger.info('alert_triggered', { triggerId: event.id, alertId: event.alertId, marketId: event.marketId, reason: event.reason }); }
}
module.exports = { ServerLogNotifier };
