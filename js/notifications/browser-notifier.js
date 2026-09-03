(function (global) {
  'use strict';
  class BrowserNotifier {
    constructor({ notificationCenter }) { this.notificationCenter = notificationCenter; }
    notify(triggerEvent) { const toast=this.notificationCenter.notify(triggerEvent,{playSound:false});if(toast)this.notificationCenter.play(triggerEvent);return toast; }
  }
  global.ZychNotifications = { ...(global.ZychNotifications || {}), BrowserNotifier };
})(window);
