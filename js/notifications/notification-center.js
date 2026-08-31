(function (global, factory) {
  'use strict';
  const api=factory(global);if(typeof module==='object'&&module.exports)module.exports=api;else global.ZychNotifications={...(global.ZychNotifications||{}),...api};
})(typeof window!=='undefined'?window:globalThis,function(global){
  class NotificationCenter {
    constructor({ region, sound, describe, formatTime, onOpen, setTimer=global.setTimeout }) { this.region = region; this.sound = sound; this.describe = describe; this.formatTime = formatTime; this.onOpen = onOpen;this.setTimer=setTimer; }
    notify(event) {
      const toast = global.document.createElement('article'); toast.className = 'alert-toast'; toast.tabIndex = 0; toast.setAttribute('role', 'status');
      const title = global.document.createElement('strong'); title.textContent = `${event.asset} ALERT`;
      const copy = global.document.createElement('p'); copy.textContent = this.describe(event);
      const meta = global.document.createElement('small'); meta.textContent = `${event.timeframe ? `${event.timeframe} · ` : ''}${event.exchange} · ${this.formatTime(event.triggeredAt)}`;
      const close = global.document.createElement('button'); close.type = 'button'; close.className = 'alert-toast-close'; close.setAttribute('aria-label', 'Close alert notification'); close.textContent = '×';
      let timer = null; const dismiss = () => { clearTimeout(timer); toast.remove(); };
      close.addEventListener('click', click => { click.stopPropagation(); dismiss(); });
      toast.append(title, copy, meta, close); toast.addEventListener('click', () => this.onOpen(event)); toast.addEventListener('keydown', key => { if (key.key === 'Enter') this.onOpen(event); if (key.key === 'Escape') dismiss(); });
      this.region.append(toast); Promise.resolve(this.sound.play()).catch(error=>global.console?.warn?.('[ZYCH audio] Alert sound dispatch failed',error)); timer = this.setTimer(dismiss, 7000); return toast;
    }
  }
  return{NotificationCenter};
});
