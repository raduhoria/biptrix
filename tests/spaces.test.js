import assert from 'node:assert/strict';
import { createECDH, randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { MIGRATIONS } from '../db/migrate.js';
import { generateVapidKeys } from '../core/webpush.js';
import { nowIso } from '../core/util.js';
import { client, socket, startApp } from './helpers.js';

// Spaces replace groups: settings editable after creation, archiving by
// moderators, per-person notification levels, small Spaces ring.
describe('spaces (groups are gone)', () => {
  let app;
  let org;
  let users;
  let clients;
  const pushedTo = []; // user emails a push went to (by endpoint)
  const endpoints = new Map();
  const realFetch = globalThis.fetch;
  const API = () => `/api/o/${org.slug}`;

  before(async () => {
    globalThis.fetch = async (url, opts = {}) => {
      if (!String(url).startsWith('https://fcm.googleapis.com/')) return realFetch(url, opts);
      pushedTo.push(endpoints.get(String(url)));
      return new Response('', { status: 201 });
    };
    const keys = generateVapidKeys();
    app = await startApp({ VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey });
    org = await app.org('Spaces');
    users = {};
    clients = {};
    for (const n of ['ana', 'bob', 'cora']) {
      users[n] = await app.user(org, { email: `${n}@s.ro`, name: n });
      clients[n] = client(app.base);
      await clients[n].login(`${n}@s.ro`);
      // A push device per person.
      const ecdh = createECDH('prime256v1');
      ecdh.generateKeys();
      const endpoint = `https://fcm.googleapis.com/fcm/send/${n}-${randomBytes(4).toString('hex')}`;
      endpoints.set(endpoint, n);
      await clients[n].post('/api/push/subscribe', { json: { endpoint, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } } });
    }
  });
  after(async () => {
    await app.stop();
    globalThis.fetch = realFetch;
  });

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const send = (who, spaceId, body) => clients[who].post(`${API()}/conversations/${spaceId}/messages`, { json: { client_message_id: `m-${randomBytes(6).toString('hex')}`, body } });

  test('groups cannot be created any more', async () => {
    assert.equal((await clients.ana.post(`${API()}/groups`, { json: { user_ids: [users.bob.id] } })).status, 404);
  });

  test('moderators edit name, description and visibility after creation; others cannot', async () => {
    const space = (await clients.ana.post(`${API()}/spaces`, { json: { name: 'Proiect', visibility: 'private', user_ids: [users.bob.id] } })).data.conversation;
    assert.equal((await clients.bob.post(`${API()}/conversations/${space.id}/update`, { json: { visibility: 'public' } })).status, 403);
    assert.equal((await clients.ana.post(`${API()}/conversations/${space.id}/update`, { json: { name: 'Proiect X', description: 'Despre X', visibility: 'public' } })).status, 200);
    const row = await app.db.get('SELECT name, description, visibility FROM conversations WHERE id = ?', [space.id]);
    assert.deepEqual({ ...row }, { name: 'Proiect X', description: 'Despre X', visibility: 'public' });
    assert.ok(await app.db.get("SELECT 1 FROM audit_events WHERE action = 'conversation.update' AND resource_id = ? AND data LIKE '%visibility%'", [space.id]));
    // Now public: Cora finds it and joins on her own.
    assert.ok((await clients.cora.get(`${API()}/spaces`)).data.spaces.some((s) => s.id === space.id));
  });

  test('moderators archive their Space; members cannot', async () => {
    const space = (await clients.ana.post(`${API()}/spaces`, { json: { name: 'De arhivat', user_ids: [users.bob.id] } })).data.conversation;
    assert.equal((await clients.bob.post(`${API()}/conversations/${space.id}/archive`, { json: {} })).status, 403);
    assert.equal((await clients.ana.post(`${API()}/conversations/${space.id}/archive`, { json: {} })).status, 200);
    assert.ok(!(await clients.bob.get(`${API()}/conversations`)).data.conversations.some((c) => c.id === space.id));
  });

  test('notification levels: everything in a small Space by default; mentions; none', async () => {
    const space = (await clients.ana.post(`${API()}/spaces`, { json: { name: 'Mic', visibility: 'private', user_ids: [users.bob.id, users.cora.id] } })).data.conversation;
    assert.equal((await clients.bob.get(`${API()}/conversations/${space.id}`)).data.conversation.notify, 'all');
    pushedTo.length = 0;
    await send('ana', space.id, 'salut tuturor');
    await wait(300);
    assert.deepEqual(pushedTo.sort(), ['bob', 'cora']);

    await clients.bob.post(`${API()}/conversations/${space.id}/notify`, { json: { level: 'mentions' } });
    const cora = await clients.cora.post(`${API()}/conversations/${space.id}/notify`, { json: { level: 'none' } });
    assert.equal(cora.data.conversation.notify, 'none');
    pushedTo.length = 0;
    await send('ana', space.id, 'fără mențiune');
    await wait(300);
    assert.deepEqual(pushedTo, []);
    await send('ana', space.id, `<@${users.bob.id}> <@${users.cora.id}> vă rog`);
    await wait(300);
    assert.deepEqual(pushedTo, ['bob'], 'Cora chose none: not even mentions');

    // A call rings the small Space, except whoever chose none.
    const bobWs = socket(app.base, `/ws?org=${org.slug}`, clients.bob);
    const coraWs = socket(app.base, `/ws?org=${org.slug}`, clients.cora);
    await Promise.all([bobWs.opened, coraWs.opened]);
    const call = await clients.ana.post(`${API()}/meetings`, { json: { conversation_id: space.id, notify_members: false, call: 'video' } });
    assert.equal(call.data.ringing, 1);
    await bobWs.next('call.ring');
    await wait(200);
    assert.ok(!coraWs.frames.some((f) => f.type === 'call.ring'));
    bobWs.ws.close();
    coraWs.ws.close();
  });

  test('a big Space notifies only mentions by default and does not ring', async () => {
    const ids = [];
    for (let i = 0; i < 20; i++) ids.push((await app.user(org, { email: `m${i}@s.ro` })).id);
    const space = (await clients.ana.post(`${API()}/spaces`, { json: { name: 'Mare', user_ids: [users.bob.id, ...ids] } })).data.conversation;
    assert.equal((await clients.bob.get(`${API()}/conversations/${space.id}`)).data.conversation.notify, 'mentions');
    pushedTo.length = 0;
    await send('ana', space.id, 'anunț');
    await wait(300);
    assert.deepEqual(pushedTo, []);
    await send('ana', space.id, `<@${users.bob.id}> tu`);
    await wait(300);
    assert.deepEqual(pushedTo, ['bob']);
    assert.equal((await clients.ana.post(`${API()}/meetings`, { json: { conversation_id: space.id, notify_members: false, call: 'audio' } })).data.ringing, 0);
  });

  test('old groups become private Spaces whose members are moderators', async () => {
    const id = 'old-group-0001';
    const at = nowIso();
    await app.db.run("INSERT INTO conversations (id, org_id, type, created_by, created_at) VALUES (?, ?, 'group', ?, ?)", [id, org.id, users.ana.id, at]);
    for (const u of ['ana', 'bob']) await app.db.run("INSERT INTO conversation_members (conversation_id, user_id, role, last_read_seq, joined_at, muted) VALUES (?, ?, 'member', 0, ?, ?)", [id, users[u].id, at, u === 'bob' ? 1 : 0]);
    const [, statements] = MIGRATIONS.find(([v]) => v === 8);
    for (const sql of statements.slice(1)) await app.db.run(sql);
    const conv = await app.db.get('SELECT type, visibility, name FROM conversations WHERE id = ?', [id]);
    assert.deepEqual({ ...conv }, { type: 'space', visibility: 'private', name: 'ana, bob' });
    const roles = await app.db.all('SELECT role, notify FROM conversation_members WHERE conversation_id = ? ORDER BY user_id', [id]);
    assert.ok(roles.every((r) => r.role === 'moderator'));
    assert.ok(roles.some((r) => r.notify === 'none'), 'muted became none');
  });
});
