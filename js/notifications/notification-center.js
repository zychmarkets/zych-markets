(function (global) {
  'use strict';
  class NotificationCenter {
    constructor({ region, sound, describe, formatTime, onOpen }) { this.region = region; this.sound = sound; this.describe = describe; this.formatTime = formatTime; this.onOpen = onOpen; }
    notify(event) {
      const toast = document.createElement('article'); toast.className = 'alert-toast'; toast.tabIndex = 0; toast.setAttribute('role', 'status');
      const title = document.createElement('strong'); title.textContent = `${event.asset} ALERT`;
      const copy = document.createElement('p'); copy.textContent = this.describe(event);
      const meta = document.createElement('small'); meta.textContent = `${event.timeframe ? `${event.timeframe} · ` : ''}${event.exchange} · ${this.formatTime(event.triggeredAt)}`;
      const close = document.createElement('button'); close.type = 'button'; close.className = 'alert-toast-close'; close.setAttribute('aria-label', 'Close alert notification'); close.textContent = '×';
      let timer = null; const dismiss = () => { clearTimeout(timer); toast.remove(); };
      close.addEventListener('click', click => { click.stopPropagation(); dismiss(); });
      toast.append(title, copy, meta, close); toast.addEventListener('click', () => this.onOpen(event)); toast.addEventListener('keydown', key => { if (key.key === 'Enter') this.onOpen(event); if (key.key === 'Escape') dismiss(); });
      this.region.append(toast); this.sound.play(); timer = setTimeout(dismiss, 7000); return toast;
    }
  }
  global.ZychNotifications = { ...(global.ZychNotifications || {}), NotificationCenter };
})(window);
