/*
 * Service worker for phone alerts.
 *
 * It shows a short notification and opens the app at the project that needs attention.
 * It never fetches, caches or stores anything: the payload carries only a title, one line
 * of context and a link.
 */
self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', event => { event.waitUntil(self.clients.claim()); });

self.addEventListener('push', event => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch { payload = {}; }
  const title = typeof payload.title === 'string' ? payload.title : 'Project dashboard';
  event.waitUntil(self.registration.showNotification(title, {
    body: typeof payload.body === 'string' ? payload.body : '',
    tag: typeof payload.tag === 'string' ? payload.tag : 'dashboard',
    renotify: false,
    data: { url: typeof payload.url === 'string' ? payload.url : '/' }
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find(client => client.url.startsWith(self.location.origin));
    if (existing) {
      await existing.focus();
      existing.postMessage({ type: 'dashboard-alert', url });
      return;
    }
    await self.clients.openWindow(url);
  })());
});
