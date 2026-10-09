// Swipe's service worker. It does two things: makes the site installable as
// an app, and shows a notification when the server says it is your turn.
// It caches nothing: the game is live and needs its server either way.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

// A push arrives encrypted from the game server by way of the browser
// vendor's push service. It is always shown: phones withdraw the permission
// from sites that receive pushes and show nothing.
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }
  const title = data.title || 'Swipe';
  const options = {
    body: data.body || '',
    tag: data.tag || 'swipe', // one notification per room: a newer one replaces the older
    renotify: true,
    icon: 'icons/icon-192.png',
    badge: 'icons/badge-96.png',
    data: { url: data.url || '.', kind: data.kind || '' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// Tapping it brings the game to the front: the tab or app already on that
// room if there is one, otherwise a new window opened on it.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || '.', self.registration.scope);
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const there = windows.find((w) => new URL(w.url).pathname === target.pathname);
      if (there) return there.focus();
      return self.clients.openWindow(target.href);
    })(),
  );
});
