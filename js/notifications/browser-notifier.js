(function (global) {
  'use strict';
  class BrowserNotifier {
    constructor({ notificationCenter }) { this.notificationCenter = notificationCenter; }
    notify(triggerEvent) { return this.notificationCenter.notify(triggerEvent); }
  }
  global.ZychNotifications = { ...(global.ZychNotifications || {}), BrowserNotifier };
})(window);
