import assert from 'node:assert/strict';
import { createDecipheriv, createECDH, createHmac, createPublicKey, randomBytes, verify } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { encrypt, generateVapidKeys, vapidAuthorization } from '../core/webpush.js';
import { client, socket, startApp } from './helpers.js';

const hmac = (key, data) => createHmac('sha256', key).update(data).digest();

// The browser's side of RFC 8291: decrypts what the server sent.
function decrypt(body, { privateKey, publicKey, auth }) {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(privateKey);
  const shared = ecdh.computeSecret(asPublic);
  const ikm = hmac(hmac(auth, shared), Buffer.concat([Buffer.from('WebPush: info\0'), publicKey, asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const data = body.subarray(21 + idlen);
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(data.subarray(-16));
  const plain = Buffer.concat([decipher.update(data.subarray(0, -16)), decipher.final()]);
  assert.equal(plain.at(-1), 2, 'last-record delimiter');
  return JSON.parse(plain.subarray(0, -1).toString());
}

// A fake browser subscription (its own key pair and auth secret).
function device(n) {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return {
    secret: { privateKey: ecdh.getPrivateKey(), publicKey: ecdh.getPublicKey(), auth },
    subscription: { endpoint: `https://fcm.googleapis.com/fcm/send/device-${n}-${randomBytes(6).toString('hex')}`, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } },
  };
}

describe('web push primitives', () => {
  test('encryption matches the RFC 8291 example', () => {
    const body = encrypt(
      'When I grow up, I want to be a watermelon',
      { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' },
      { senderPrivate: Buffer.from('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', 'base64url'), salt: Buffer.from('DGv6ra1nlYgDCS1FRnbzlw', 'base64url') }
    );
    assert.equal(
      body.toString('base64url'),
      'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN'
    );
  });

  test('the VAPID token is a valid ES256 JWT for the push service origin', () => {
    const keys = generateVapidKeys();
    const header = vapidAuthorization('https://fcm.googleapis.com/fcm/send/x', { ...keys, subject: 'mailto:tech@unicorndev.eu' });
    const [, jwt, k] = header.match(/^vapid t=([^,]+), k=(.+)$/);
    assert.equal(k, keys.publicKey);
    const [h, c, sig] = jwt.split('.');
    const claims = JSON.parse(Buffer.from(c, 'base64url'));
    assert.equal(claims.aud, 'https://fcm.googleapis.com');
    assert.equal(claims.sub, 'mailto:tech@unicorndev.eu');
    const pub = Buffer.from(keys.publicKey, 'base64url');
    const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') }, format: 'jwk' });
    assert.ok(verify('sha256', Buffer.from(`${h}.${c}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')));
  });
});

describe('push notifications', () => {
  let app;
  let org;
  let ana;
  let bob;
  let anaClient;
  let bobClient;
  let dm;
  const sent = []; // { endpoint, headers, payload }
  const realFetch = globalThis.fetch;
  const devices = new Map(); // endpoint → secret
  let status = 201;
  const API = () => `/api/o/${org.slug}`;

  before(async () => {
    globalThis.fetch = async (url, opts = {}) => {
      if (!String(url).startsWith('https://fcm.googleapis.com/')) return realFetch(url, opts);
      sent.push({ endpoint: String(url), headers: opts.headers, payload: decrypt(Buffer.from(opts.body), devices.get(String(url))) });
      return new Response('', { status });
    };
    const keys = generateVapidKeys();
    app = await startApp({ VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey });
    org = await app.org('Push');
    ana = await app.user(org, { email: 'ana@p.ro', name: 'Ana' });
    bob = await app.user(org, { email: 'bob@p.ro', name: 'Bob' });
    anaClient = client(app.base);
    await anaClient.login('ana@p.ro');
    bobClient = client(app.base);
    await bobClient.login('bob@p.ro');
    dm = (await anaClient.post(`${API()}/dms`, { json: { user_id: bob.id } })).data.conversation;
  });
  after(async () => {
    await app.stop();
    globalThis.fetch = realFetch;
  });

  async function subscribe(c, n) {
    const d = device(n);
    devices.set(d.subscription.endpoint, d.secret);
    assert.equal((await c.post('/api/push/subscribe', { json: d.subscription })).status, 200);
    return d;
  }
  const until = async (fn, ms = 2000) => {
    for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 25))) if (fn()) return true;
    return false;
  };

  test('only push services are accepted as endpoints', async () => {
    const d = device(0);
    for (const endpoint of ['http://127.0.0.1:3400/x', 'https://evil.example/push', 'https://fcm.googleapis.com:8443/x']) {
      assert.equal((await bobClient.post('/api/push/subscribe', { json: { ...d.subscription, endpoint } })).status, 400);
    }
  });

  test('a direct message reaches the devices, encrypted, unless the app is on screen', async () => {
    const d = await subscribe(bobClient, 1);
    sent.length = 0;
    await anaClient.post(`${API()}/conversations/${dm.id}/messages`, { json: { client_message_id: 'push-msg-1', body: 'Salut Bob' } });
    assert.ok(await until(() => sent.length === 1));
    assert.equal(sent[0].endpoint, d.subscription.endpoint);
    assert.equal(sent[0].payload.type, 'message');
    assert.equal(sent[0].payload.title, 'Ana');
    assert.equal(sent[0].payload.body, 'Salut Bob');
    assert.match(sent[0].headers.Authorization, /^vapid t=.+, k=/);
    assert.equal(sent[0].headers['Content-Encoding'], 'aes128gcm');

    // Bob is looking at the app: no push.
    const ws = socket(app.base, `/ws?org=${org.slug}`, bobClient);
    await ws.opened;
    await ws.next('hello');
    ws.send('client.visible', { visible: true });
    await new Promise((r) => setTimeout(r, 100));
    sent.length = 0;
    await anaClient.post(`${API()}/conversations/${dm.id}/messages`, { json: { client_message_id: 'push-msg-2', body: 'Vezi?' } });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(sent.length, 0);
    ws.send('client.visible', { visible: false });
    await new Promise((r) => setTimeout(r, 100));
    await anaClient.post(`${API()}/conversations/${dm.id}/messages`, { json: { client_message_id: 'push-msg-3', body: 'Acum?' } });
    assert.ok(await until(() => sent.length === 1));
    ws.ws.close();
  });

  test('previews off: the text stays out of the notification', async () => {
    await bobClient.post('/account/push/preview', { form: { preview: '0' } });
    sent.length = 0;
    await anaClient.post(`${API()}/conversations/${dm.id}/messages`, { json: { client_message_id: 'push-msg-4', body: 'secret' } });
    assert.ok(await until(() => sent.length === 1));
    assert.doesNotMatch(JSON.stringify(sent[0].payload), /secret/);
    assert.match(sent[0].payload.body, /Ana/);
    await bobClient.post('/account/push/preview', { form: { preview: '1' } });
  });

  test('a call rings the devices with answer/decline; a missed call replaces it', async () => {
    sent.length = 0;
    const meeting = (await anaClient.post(`${API()}/meetings`, { json: { conversation_id: dm.id, notify_members: false, call: 'audio' } })).data.meeting;
    assert.ok(await until(() => sent.some((s) => s.payload.type === 'call')));
    const ring = sent.find((s) => s.payload.type === 'call');
    assert.equal(ring.headers.Urgency, 'high');
    assert.equal(ring.payload.tag, `call-${meeting.id}`);
    assert.match(ring.payload.accept_url, new RegExp(`/meet/${meeting.id}\\?call=audio$`));
    assert.match(ring.payload.decline_url, new RegExp(`/meetings/${meeting.id}/ring$`));
    assert.ok(ring.payload.actions.accept && ring.payload.actions.decline);
    // The caller hangs up before an answer: "missed" on Bob's devices.
    const room = socket(app.base, `/ws/meeting?id=${meeting.id}`, anaClient);
    await room.opened;
    room.send('join', {});
    await room.next('joined');
    room.ws.close();
    assert.ok(await until(() => sent.some((s) => s.payload.type === 'missed')));
    assert.equal(sent.find((s) => s.payload.type === 'missed').payload.tag, `call-${meeting.id}`);
  });

  test('signing out stops the device; a gone subscription is forgotten; the account page lists devices', async () => {
    const page = await bobClient.get('/account');
    assert.match(page.text, /Notifications on devices|Notificări pe dispozitive/);
    assert.match(page.text, /data-push-enable/);
    assert.equal((await bobClient.post('/account/push/test', { form: {} })).location, '/account?notice=pushTestSent#push');

    // 410 from the push service: the subscription is dropped.
    status = 410;
    sent.length = 0;
    await anaClient.post(`${API()}/conversations/${dm.id}/messages`, { json: { client_message_id: 'push-msg-5', body: 'x' } });
    assert.ok(await until(() => sent.length === 1));
    await new Promise((r) => setTimeout(r, 100));
    assert.equal((await app.db.get('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?', [bob.id])).n, 0);
    status = 201;

    // Signed out: the session is gone, so is the device's notification.
    const other = client(app.base);
    await other.login('bob@p.ro');
    await subscribe(other, 2);
    await other.post('/logout', { form: {} });
    sent.length = 0;
    await anaClient.post(`${API()}/conversations/${dm.id}/messages`, { json: { client_message_id: 'push-msg-6', body: 'y' } });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(sent.length, 0);
    await app.maintenance();
    assert.equal((await app.db.get('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?', [bob.id])).n, 0);
    void ana;
  });

  test('the service worker and the manifest are served from the root', async () => {
    const sw = await client(app.base).get('/sw.js');
    assert.equal(sw.status, 200);
    assert.match(sw.text, /addEventListener\('push'/);
    const manifest = await client(app.base).get('/manifest.webmanifest');
    assert.equal(manifest.data.display, 'standalone');
    assert.ok(manifest.data.icons.some((i) => i.sizes === '512x512'));
  });
});
