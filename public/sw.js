// Service worker: shows push notifications while BipTrix is closed or in
// the background, and opens the right place when one is clicked. No offline
// caching — the app always talks to the server.
//
// Payloads (core/notify.js, core/calls.js): { type: message | call |
// call-stop | missed | test, tag, title, body, url, ... }.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

const ICON = '/img/icon-192.png';
const BADGE = '/img/badge-96.png';

async function focusedOn(url) {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  return windows.some((c) => c.focused && c.visibilityState === 'visible' && url && c.url.startsWith(url));
}

async function onPush(d) {
  const reg = self.registration;
  if (d.type === 'call-stop') {
    for (const n of await reg.getNotifications({ tag: d.tag })) n.close();
    return;
  }
  // Already looking at that conversation: nothing to show.
  if (d.type === 'message' && (await focusedOn(d.url))) return;
  const call = d.type === 'call';
  return reg.showNotification(d.title || 'BipTrix', {
    body: d.body || '',
    tag: d.tag,
    renotify: true,
    icon: ICON,
    badge: BADGE,
    timestamp: Date.now(),
    requireInteraction: call,
    vibrate: call ? [500, 250, 500, 250, 500] : [120],
    actions: call && d.actions ? [{ action: 'accept', title: d.actions.accept }, { action: 'decline', title: d.actions.decline }] : [],
    data: d,
  });
}

self.addEventListener('push', (event) => {
  let d = {};
  try {
    d = event.data ? event.data.json() : {};
  } catch {
    d = { title: 'BipTrix', body: event.data?.text() || '' };
  }
  event.waitUntil(onPush(d));
});

// Opens `url` in a BipTrix window (focusing one that is already open), or
// a new one. Call rooms always get their own window.
async function open(url, newWindow = false) {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const app = !newWindow && windows.find((c) => new URL(c.url).origin === self.location.origin);
  if (app) {
    await app.focus();
    return app.navigate ? app.navigate(url).catch(() => self.clients.openWindow(url)) : self.clients.openWindow(url);
  }
  return self.clients.openWindow(url);
}

self.addEventListener('notificationclick', (event) => {
  const d = event.notification.data || {};
  event.notification.close();
  if (d.type === 'call' && event.action === 'decline') {
    event.waitUntil(fetch(d.decline_url, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ answer: 'decline' }) }).catch(() => {}));
    return;
  }
  // A ring past its deadline opens the conversation instead of the room.
  const live = d.type === 'call' && (!d.until || Date.parse(d.until) > Date.now());
  event.waitUntil(open(live ? d.accept_url : d.url || '/', live));
});
