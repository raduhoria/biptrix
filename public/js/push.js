// Push notifications on this device: registers the service worker
// (/sw.js), subscribes with the server's VAPID key and sends the
// subscription to the server, which binds it to the current session.
// Used by the chat page (prompt, silent refresh) and the account page.

export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

// iPhone/iPad: push only works in the app added to the home screen.
export const needsInstall = () => /iPhone|iPad|iPod/.test(navigator.userAgent) && !navigator.standalone && !matchMedia('(display-mode: standalone)').matches;

const keyBytes = (key) => Uint8Array.from(atob(key.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function registration() {
  return (await navigator.serviceWorker.getRegistration('/')) || navigator.serviceWorker.register('/sw.js', { scope: '/' });
}

async function send(path, body) {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), credentials: 'same-origin' });
  if (!res.ok) throw new Error(`push ${res.status}`);
}

// Subscribes (asks for permission first if needed — call from a click).
// Returns true when this device will get notifications.
export async function enablePush(key) {
  if (!pushSupported() || !key) return false;
  if (Notification.permission !== 'granted' && (await Notification.requestPermission()) !== 'granted') return false;
  const reg = await registration();
  await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  // A subscription made with another server key cannot be reused.
  if (sub && sub.options?.applicationServerKey && btoa(String.fromCharCode(...new Uint8Array(sub.options.applicationServerKey))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') !== key) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ||= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) });
  await send('/api/push/subscribe', sub.toJSON());
  return true;
}

// On every page load where permission was already given: re-binds the
// device to this session (after a sign-in, a new release, an expiry).
export async function refreshPush(key) {
  if (!pushSupported() || !key || Notification.permission !== 'granted') return false;
  try {
    return await enablePush(key);
  } catch {
    return false;
  }
}

export async function disablePush() {
  const sub = pushSupported() && (await (await navigator.serviceWorker.getRegistration('/'))?.pushManager.getSubscription());
  if (!sub) return;
  await send('/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
  await sub.unsubscribe();
}

// Account page: [data-push-enable] buttons (the key is in data-key).
for (const btn of document.querySelectorAll('[data-push-enable]')) {
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    const ok = await enablePush(btn.dataset.key).catch(() => false);
    location.href = `/account?notice=${ok ? 'pushEnabled' : 'pushBlocked'}#push`;
  });
}
