import { createCipheriv, createECDH, createHmac, createPrivateKey, randomBytes, sign } from 'node:crypto';

// Web Push (RFC 8030) with VAPID (RFC 8292) and aes128gcm payload
// encryption (RFC 8291, RFC 8188), on node:crypto alone. The push service
// (Google, Apple, Mozilla, Microsoft — whichever the browser uses) only
// carries the encrypted bytes; only that browser can read them.

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (s) => Buffer.from(String(s || ''), 'base64url');
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();

// A new VAPID key pair (P-256): { publicKey, privateKey } as base64url —
// the public key is the browser's applicationServerKey.
export function generateVapidKeys() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(ecdh.getPrivateKey()) };
}

// The encrypted body for one subscription (keys.p256dh, keys.auth), with
// the sender key pair and salt injectable for the RFC test vector.
export function encrypt(payload, { p256dh, auth }, { senderPrivate = null, salt = randomBytes(16) } = {}) {
  const uaPublic = fromB64u(p256dh);
  const authSecret = fromB64u(auth);
  if (uaPublic.length !== 65 || authSecret.length < 16) throw new Error('Invalid subscription keys');
  const ecdh = createECDH('prime256v1');
  if (senderPrivate) ecdh.setPrivateKey(senderPrivate);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  // RFC 8291 §3.4: IKM from the ECDH secret and the auth secret.
  const prkKey = hmac(authSecret, shared);
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]));
  // RFC 8188: content encryption key and nonce from the salt.
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  // One record: the payload, then the last-record delimiter 0x02.
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, body]);
}

// VAPID: a JWT (ES256) for the push service's origin, signed with our key.
export function vapidAuthorization(endpoint, { publicKey, privateKey, subject }, now = Date.now()) {
  const pub = fromB64u(publicKey);
  const key = createPrivateKey({ key: { kty: 'EC', crv: 'P-256', d: privateKey, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) }, format: 'jwk' });
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject }));
  const signature = sign('sha256', Buffer.from(`${head}.${claims}`), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${head}.${claims}.${b64u(signature)}, k=${publicKey}`;
}

// Sends one message. Returns { ok, gone } — gone: the subscription no
// longer exists (404/410) and should be forgotten.
export async function sendPush(subscription, payload, vapid, { ttl = 3600, urgency = 'normal', topic = null } = {}) {
  const headers = {
    'Content-Type': 'application/octet-stream',
    'Content-Encoding': 'aes128gcm',
    TTL: String(ttl),
    Urgency: urgency,
    Authorization: vapidAuthorization(subscription.endpoint, vapid),
  };
  // A topic replaces an undelivered message with the same topic (e.g. a
  // ring superseded by "call over" while the phone was offline).
  if (topic) headers.Topic = String(topic).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
  const res = await fetch(subscription.endpoint, { method: 'POST', headers, body: encrypt(JSON.stringify(payload), subscription), signal: AbortSignal.timeout(10_000) });
  await res.arrayBuffer().catch(() => {});
  return { ok: res.ok, gone: res.status === 404 || res.status === 410, status: res.status };
}
