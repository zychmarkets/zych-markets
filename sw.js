'use strict';
self.addEventListener('push', event => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch { payload = {}; }
  const title = typeof payload.title === 'string' ? payload.title.slice(0, 120) : 'ZYCH Markets Alert';
  const body = typeof payload.body === 'string' ? payload.body.slice(0, 240) : 'A market alert was triggered.';
  const triggerId = typeof payload.triggerId === 'string' ? payload.triggerId.slice(0, 100) : `push-${Date.now()}`;
  const url = typeof payload.url === 'string' && /^\/(?:\?|$)/.test(payload.url) ? payload.url : `/?trigger=${encodeURIComponent(triggerId)}`;
  event.waitUntil(self.registration.showNotification(title, { body, tag: `zych-alert-${triggerId}`, data: { url, triggerId }, requireInteraction: false }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const requested = event.notification.data?.url, safePath = typeof requested === 'string' && /^\/(?:\?|$)/.test(requested) ? requested : '/';
  event.waitUntil((async () => {
    const target = new URL(safePath, self.location.origin).href, windows = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) { if (new URL(client.url).origin === self.location.origin) { await client.navigate(target); return client.focus(); } }
    return clients.openWindow(target);
  })());
});
