import { appError, nowIso } from './util.js';
import { sendPush } from './webpush.js';

// Push notifications to a user's devices (Web Push, core/webpush.js). Each
// subscription belongs to the session that made it: a device stops getting
// notifications when that session ends (sign-out, revocation, expiry), and
// one of an MFA account only while the session has passed MFA.
//
// Endpoints are accepted only at the browsers' push services, so a
// subscription cannot make this server send requests anywhere else (SSRF).
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^jmt\d*\.google\.com$/, /^updates\.push\.services\.mozilla\.com$/, /^[a-z0-9.-]*push\.services\.mozilla\.com$/, /^web\.push\.apple\.com$/, /^[a-z0-9-]+\.notify\.windows\.com$/];
const MAX_FAILURES = 10;
const MAX_PER_USER = 20;

export function pushEndpointAllowed(endpoint) {
  try {
    const url = new URL(endpoint);
    return url.protocol === 'https:' && !url.port && PUSH_HOSTS.some((re) => re.test(url.hostname));
  } catch {
    return false;
  }
}

// "Chrome · Android", "Safari · iPhone", … for the device list.
export function deviceLabel(ua = '') {
  const s = String(ua);
  const browser = /Edg\//.test(s) ? 'Edge' : /OPR\//.test(s) ? 'Opera' : /Firefox\//.test(s) ? 'Firefox' : /Chrome\//.test(s) ? 'Chrome' : /Safari\//.test(s) ? 'Safari' : 'Browser';
  const os = /iPhone/.test(s) ? 'iPhone' : /iPad/.test(s) ? 'iPad' : /Android/.test(s) ? 'Android' : /Windows/.test(s) ? 'Windows' : /Mac OS X/.test(s) ? 'macOS' : /Linux/.test(s) ? 'Linux' : '';
  return os ? `${browser} · ${os}` : browser;
}

export function createPush({ db, config }) {
  const vapid = config.push;
  const enabled = !!(vapid.publicKey && vapid.privateKey);

  async function subscribe(user, session, { endpoint, keys = {} }, userAgent) {
    if (!enabled) throw appError('invalid', 'Push notifications are not configured');
    if (!pushEndpointAllowed(endpoint)) throw appError('invalid', 'Unknown push service');
    if (!/^[A-Za-z0-9_-]{80,100}$/.test(keys.p256dh || '') || !/^[A-Za-z0-9_-]{16,32}$/.test(keys.auth || '')) throw appError('invalid', 'Invalid subscription keys');
    const at = nowIso();
    // The same browser re-subscribing (or another account signing in on it)
    // takes the endpoint over; an account keeps at most MAX_PER_USER devices.
    await db.batch([
      [
        `INSERT INTO push_subscriptions (endpoint, user_id, session_hash, p256dh, auth, device, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, session_hash = excluded.session_hash, p256dh = excluded.p256dh, auth = excluded.auth, device = excluded.device, failures = 0`,
        [endpoint, user.id, session.id_hash, keys.p256dh, keys.auth, deviceLabel(userAgent), at],
      ],
      [
        `DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint NOT IN (SELECT endpoint FROM push_subscriptions WHERE user_id = ? ORDER BY created_at DESC LIMIT ${MAX_PER_USER})`,
        [user.id, user.id],
      ],
    ]);
  }

  const unsubscribe = (userId, endpoint) => db.run('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?', [userId, String(endpoint || '')]);

  const devices = (userId) =>
    db.all(
      `SELECT ps.endpoint, ps.device, ps.created_at, ps.last_sent_at, ps.session_hash, (s.id_hash IS NOT NULL) AS active
       FROM push_subscriptions ps LEFT JOIN sessions s ON s.id_hash = ps.session_hash AND s.expires_at > ?
       WHERE ps.user_id = ? ORDER BY ps.created_at DESC`,
      [nowIso(), userId]
    );

  // Sends to every live device of the user. Never throws (a notification is
  // best effort); returns how many devices accepted it.
  async function toUser(userId, payload, options = {}) {
    if (!enabled) return 0;
    const subs = await db.all(
      `SELECT ps.* FROM push_subscriptions ps
       JOIN sessions s ON s.id_hash = ps.session_hash AND s.expires_at > ?
       JOIN users u ON u.id = ps.user_id
       WHERE ps.user_id = ? AND u.status = 'active' AND (u.totp_secret IS NULL OR s.mfa_ok = 1)`,
      [nowIso(), userId]
    );
    let delivered = 0;
    await Promise.all(
      subs.map(async (sub) => {
        try {
          const res = await sendPush(sub, payload, vapid, options);
          if (res.ok) {
            delivered++;
            await db.run('UPDATE push_subscriptions SET last_sent_at = ?, failures = 0 WHERE endpoint = ?', [nowIso(), sub.endpoint]);
          } else if (res.gone || sub.failures + 1 >= MAX_FAILURES) {
            await db.run('DELETE FROM push_subscriptions WHERE endpoint = ?', [sub.endpoint]);
          } else {
            console.error(`Push to ${new URL(sub.endpoint).hostname} refused: ${res.status}`);
            await db.run('UPDATE push_subscriptions SET failures = failures + 1 WHERE endpoint = ?', [sub.endpoint]);
          }
        } catch (err) {
          console.error('Push failed:', err.message);
          await db.run('UPDATE push_subscriptions SET failures = failures + 1 WHERE endpoint = ?', [sub.endpoint]).catch(() => {});
        }
      })
    );
    return delivered;
  }

  // Maintenance: subscriptions whose session is gone.
  const prune = () => db.run('DELETE FROM push_subscriptions WHERE session_hash NOT IN (SELECT id_hash FROM sessions)');

  return { enabled, publicKey: vapid.publicKey, subscribe, unsubscribe, devices, toUser, prune };
}
