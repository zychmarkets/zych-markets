(function (global, factory) {
  'use strict';
  const api=factory(global);if(typeof module==='object'&&module.exports)module.exports=api;else global.ZychNotifications={...(global.ZychNotifications||{}),...api};
})(typeof window!=='undefined'?window:globalThis,function(global){
  const deliveredTriggerIds=new Set();
  const foregroundAuthority=()=>global.document?.visibilityState!=='hidden'&&(typeof global.document?.hasFocus!=='function'||global.document.hasFocus());
  class NotificationCenter {
    constructor({ region, sound, describe, formatTime, onOpen, canDeliver=foregroundAuthority, setTimer=(callback,delay)=>global.setTimeout(callback,delay),clearTimer=timer=>global.clearTimeout(timer),dismissAfterMs=8000 }) { this.region = region; this.sound = sound; this.describe = describe; this.formatTime = formatTime; this.onOpen = onOpen;this.canDeliver=canDeliver;this.setTimer=setTimer;this.clearTimer=clearTimer;this.dismissAfterMs=dismissAfterMs;this.seen=deliveredTriggerIds;this.deliveryOutcomes=new Map();this.duplicatesSuppressed=0; }
    diagnostics() { return {latest:[...this.deliveryOutcomes.values()].map(item=>({...item})),duplicatesSuppressed:this.duplicatesSuppressed}; }
    play(event) {
      const outcome=event?.id?this.deliveryOutcomes.get(event.id):null;
      try { Promise.resolve(this.sound.play()).then(scheduled=>{const state=this.sound.state?.();if(outcome)outcome.sound=scheduled===true?'SCHEDULED':state?.enabled===false||this.sound.enabled===false?'DISABLED':state&&state.contextState!=='running'?'BLOCKED':state?.lastError?'FAILED':'UNKNOWN';}).catch(error=>{if(outcome)outcome.sound='FAILED';global.console?.warn?.('[ZYCH audio] Alert sound dispatch failed',error);}); } catch { if(outcome)outcome.sound='FAILED'; }
    }
    notify(event,{playSound=true}={}) {
      if(event?.id&&this.seen.has(event.id)){this.duplicatesSuppressed++;return null;}if(event?.id)this.seen.add(event.id);
      if(!this.canDeliver(event))return null;
      const outcome={triggerId:event?.id||null,inApp:'OBSERVED',toast:'UNKNOWN',sound:'UNKNOWN'};
      if(event?.id){this.deliveryOutcomes.set(event.id,outcome);while(this.deliveryOutcomes.size>200)this.deliveryOutcomes.delete(this.deliveryOutcomes.keys().next().value);}
      const toast = global.document.createElement('article'); toast.className = 'alert-toast'; toast.tabIndex = 0; toast.setAttribute('role', 'status');
      const title = global.document.createElement('strong'); title.textContent = `${event.asset} ALERT`;
      const copy = global.document.createElement('p'); copy.textContent = this.describe(event);
      const meta = global.document.createElement('small'); meta.textContent = `${event.timeframe ? `${event.timeframe} · ` : ''}${event.exchange} · ${this.formatTime(event.triggeredAt)}`;
      const close = global.document.createElement('button'); close.type = 'button'; close.className = 'alert-toast-close'; close.setAttribute('aria-label', 'Close alert notification'); close.textContent = '×';
      let timer = null,dismissed=false; const dismiss = () => { if(dismissed)return;dismissed=true;this.clearTimer(timer);toast.remove(); };
      close.addEventListener('click', click => { click.stopPropagation(); dismiss(); });
      toast.append(title, copy, meta, close); toast.addEventListener('click', () => this.onOpen(event)); toast.addEventListener('keydown', key => { if (key.key === 'Enter') this.onOpen(event); if (key.key === 'Escape') dismiss(); });
      this.region.append(toast); outcome.toast='OBSERVED';
      if(playSound)this.play(event);
      timer = this.setTimer(dismiss, this.dismissAfterMs); return toast;
    }
  }
  return{NotificationCenter};
});
