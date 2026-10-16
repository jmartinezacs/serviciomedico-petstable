// Service worker de Servicio Médico · Pet's Table
// Solo muestra notificaciones push. No guarda caché ni funciona sin conexión.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Servicio Médico', {
    body: d.body || '',
    icon: '/apple-touch-icon.png',
    badge: '/apple-touch-icon.png',
    tag: d.tag || undefined,
    renotify: !!d.tag,
    data: { url: d.url || '/' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || '/', self.location.origin).href;
  e.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of list) {
      if (new URL(c.url).origin === self.location.origin) {
        if ('navigate' in c) await c.navigate(url).catch(() => {});
        return c.focus();
      }
    }
    return self.clients.openWindow(url);
  })());
});
