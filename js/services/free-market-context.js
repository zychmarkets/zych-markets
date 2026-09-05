(function (global, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else global.ZychFreeMarketContext = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  const escape = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const links = { fearGreed: 'https://alternative.me/crypto/fear-and-greed-index/', totalCap: 'https://alternative.me/crypto/api/', btcDominance: 'https://alternative.me/crypto/api/' };
  function presentation(key, metric, { now = Date.now(), locale = 'en-US', t = key => key } = {}) {
    let status = metric?.status || 'loading';
    const valid = Number.isFinite(metric?.value) && Number.isFinite(metric?.asOf) && metric.asOf > 0 && metric.asOf <= now + 300000 &&
      (key === 'totalCap' ? metric.value > 0 : metric.value >= 0 && metric.value <= 100);
    if (metric && (!valid || !['current', 'stale'].includes(status))) status = 'unavailable';
    if (valid && status === 'current' && now - metric.asOf > (key === 'fearGreed' ? 172800000 : 1800000)) status = 'stale';
    const available = valid && ['current', 'stale'].includes(status);
    const value = !available ? '—' : key === 'totalCap'
      ? `${new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 2 }).format(metric.value)} USD`
      : `${new Intl.NumberFormat(locale, { maximumFractionDigits: key === 'fearGreed' ? 0 : 1 }).format(metric.value)}${key === 'fearGreed' ? '/100' : '%'}`;
    const scope = key === 'fearGreed' ? t('context.bitcoinDaily') : t('context.coverage').replace('{count}', Number.isSafeInteger(metric?.coverage) ? metric.coverage : '—');
    const asOf = available ? new Date(metric.asOf).toLocaleString(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC' : '';
    const classification = key === 'fearGreed' && available && ['Extreme Fear','Fear','Neutral','Greed','Extreme Greed'].includes(metric.classification)
      ? t(`context.${metric.classification.replaceAll(' ', '')}`) : '';
    return { status, value, scope, asOf, classification, number: available ? metric.value : null };
  }
  function render(root, payload, options = {}) {
    const t = options.t || (key => key);
    for (const node of root.querySelectorAll('[data-free-context]')) {
      const key = node.dataset.freeContext;
      if (!Object.hasOwn(links, key)) continue;
      const view = presentation(key, payload?.metrics?.[key], options);
      node.dataset.contextStatus = view.status;
      const sentiment = payload?.metrics?.[key]?.classification;
      node.dataset.contextTone = key === 'fearGreed' && view.number !== null
        ? ({'Extreme Fear':'fear','Fear':'fear','Neutral':'neutral','Greed':'greed','Extreme Greed':'greed'}[sentiment] || 'unknown') : 'unknown';
      node.classList.toggle('markets-source-missing', view.number === null);
      const value = node.querySelector('[data-context-value]'), detail = node.querySelector('[data-context-detail]');
      if (value) value.textContent = view.value;
      if (detail) {
        detail.innerHTML = `${view.classification ? `<span class="context-classification">${escape(view.classification)}</span> · ` : ''}${escape(view.scope)}<br>` +
          `${view.status !== 'current' ? escape(t(`context.${view.status}`)) + ' · ' : ''}` +
          `<a href="${links[key]}" target="_blank" rel="noopener noreferrer">Alternative.me</a>` +
          (view.asOf ? `<br>${escape(view.asOf)}` : '');
      }
      const needle = node.querySelector('.context-needle');
      if (needle) { needle.hidden = view.number === null; needle.style.transform = `rotate(${(view.number ?? 50) * 1.8 - 90}deg)`; }
      const ring = node.querySelector('.context-dominance-ring');
      if (ring) ring.style.backgroundImage = view.number === null ? 'none' : `conic-gradient(var(--context-btc-color, #ff9900) ${view.number}%, #253841 0)`;
    }
  }
  class Client {
    // Browser host functions must retain their global receiver when stored on a client.
    constructor({ fetchImpl = (...args) => globalThis.fetch(...args), onChange = () => {}, setTimer = (...args) => globalThis.setTimeout(...args), clearTimer = (...args) => globalThis.clearTimeout(...args) } = {}) {
      Object.assign(this, { fetchImpl, onChange, setTimer, clearTimer, payload: null, pending: null, timer: null, stopped: false });
    }
    refresh() {
      if (this.stopped) return Promise.resolve();
      if (this.pending) return this.pending;
      this.clearTimer(this.timer);
      this.controller = new AbortController();
      const timeout = this.setTimer(() => this.controller.abort(), 12000);
      this.pending = (async () => {
        try {
          const response = await this.fetchImpl('/api/market-context/free', { signal: this.controller.signal });
          if (!response.ok) throw new Error('Context unavailable');
          const payload = await response.json();
          if (!payload?.metrics || !Object.keys(links).every(key => payload.metrics[key] && typeof payload.metrics[key].status === 'string') || !Number.isFinite(payload.generatedAt)) throw new Error('Invalid context');
          if (!this.stopped) this.payload = payload;
        } catch {
          if (!this.stopped) {
            const metrics = {};
            for (const key of Object.keys(links)) metrics[key] = this.payload?.metrics?.[key]?.value != null
              ? { ...this.payload.metrics[key], status: 'stale' } : { value: null, status: 'unavailable' };
            this.payload = { metrics };
          }
        } finally {
          this.clearTimer(timeout);
          if (!this.stopped) { this.onChange(this.payload); this.timer = this.setTimer(() => this.refresh(), 60000); }
        }
      })().finally(() => { this.pending = null; });
      return this.pending;
    }
    dispose() { this.stopped = true; this.clearTimer(this.timer); this.controller?.abort(); }
  }
  return { presentation, render, Client };
});
