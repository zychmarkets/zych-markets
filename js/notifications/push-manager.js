(function (global, factory) {
  'use strict';
  const api=factory(global);if(typeof module==='object'&&module.exports)module.exports=api;else global.ZychNotifications={...(global.ZychNotifications||{}),...api};
})(typeof window!=='undefined'?window:globalThis,function(global){
  'use strict';
  const decodeKey = value => { const padding = '='.repeat((4 - value.length % 4) % 4), raw = atob((value + padding).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(raw, character => character.charCodeAt(0)); };
  const activateWaiting=async registration=>{if(!registration?.waiting)return false;const changed=new Promise(resolve=>{const timeout=setTimeout(()=>resolve(false),3000);navigator.serviceWorker.addEventListener('controllerchange',()=>{clearTimeout(timeout);resolve(true)},{once:true})});registration.waiting.postMessage({type:'ZYCH_SW_ACTIVATE'});return changed};
  const resolvePushApiBase=location=>{if(global.ZychAlerts?.resolveAlertApiBase)return global.ZychAlerts.resolveAlertApiBase(location);return location?.protocol==='file:'?'http://127.0.0.1:4178/api':'/api'};
  class PushManagerController {
    constructor({ button, baseUrl = null, location=global.location }) { this.button = button; this.baseUrl = baseUrl || resolvePushApiBase(location); this.registration = null; this.state = 'off'; this.render(); }
    render(message = '') { const labels = { on: 'Push ON', off: 'Push OFF', blocked: 'Push BLOCKED', unavailable: 'Push N/A', disabled:'Push NOT CONFIGURED',error: 'Push ERROR' }; this.button.textContent = message || labels[this.state]; this.button.dataset.pushStatus = this.state; this.button.setAttribute('aria-pressed', String(this.state === 'on')); }
    async init() {
      if (!('serviceWorker' in navigator) || !('PushManager' in global) || !('Notification' in global)) { this.state = 'unavailable'; this.render(); this.button.disabled = true; return; }
      try { const status=await fetch(`${this.baseUrl}/push/status`).then(response=>response.ok?response.json():null);this.registration = await navigator.serviceWorker.register('/sw.js', { scope: '/',updateViaCache:'none' });await this.registration.update();await activateWaiting(this.registration);await navigator.serviceWorker.ready;this.registration=await navigator.serviceWorker.getRegistration('/')||this.registration;if(status&&!status.pushEnabled){this.state='disabled';this.render();this.button.disabled=true;return}const subscription = await this.registration.pushManager.getSubscription(); this.state = Notification.permission === 'denied' ? 'blocked' : subscription ? 'on' : 'off'; this.render(); }
      catch { this.state = 'error'; this.render(); }
    }
    async toggle() {
      if (this.state === 'blocked') return this.render('Notifications blocked');
      this.button.disabled = true;
      try {
        if (!this.registration) await this.init();
        const existing = await this.registration.pushManager.getSubscription();
        if (existing) { await fetch(`${this.baseUrl}/push/unsubscribe`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: existing.endpoint }) }); await existing.unsubscribe(); this.state = 'off'; }
        else {
          const permission = await Notification.requestPermission(); if (permission === 'denied') { this.state = 'blocked'; return; } if (permission !== 'granted') { this.state = 'off'; return; }
          const response = await fetch(`${this.baseUrl}/push/public-key`), config = await response.json(); if (!response.ok || !config.publicKey) throw new Error('Push is not configured');
          const subscription = await this.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: decodeKey(config.publicKey) });
          const saved = await fetch(`${this.baseUrl}/push/subscribe`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(subscription.toJSON()) }); if (!saved.ok) { await subscription.unsubscribe(); throw new Error('Subscription could not be saved'); } this.state = 'on';
        }
      } catch { this.state = navigator.onLine ? 'error' : 'off'; }
      finally { this.button.disabled = false; this.render(); }
    }
  }
  return{PushManagerController,resolvePushApiBase,activateWaiting};
});
