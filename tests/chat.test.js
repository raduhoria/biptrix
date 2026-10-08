import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { client, sleep, socket, startApp } from './helpers.js';

// Spec §18 criteria 16, 17, 21 and the chat contract (§7, §14).
describe('chat', () => {
  let app;
  let orgA;
  let orgB;
  let ana;
  let bob;
  let eve;
  const A = () => `/api/o/${orgA.slug}`;

  before(async () => {
    app = await startApp();
    orgA = await app.org('Alfa SRL');
    orgB = await app.org('Beta SA');
    ana = await app.user(orgA, { email: 'ana@alfa.ro', name: 'Ana Pop' });
    bob = await app.user(orgA, { email: 'bob@alfa.ro', name: 'Bob Ionescu' });
    eve = await app.user(orgB, { email: 'eve@beta.ro', name: 'Eve' });
    // Bob is also a member of Beta (criterion 17).
    await app.user(orgB, { email: 'bob@alfa.ro' });
  });
  after(() => app.stop());

  test('direct message: idempotent send, ordered seq, unread', async () => {
    const a = client(app.base);
    await a.login('ana@alfa.ro');
    const dm = (await a.post(`${A()}/dms`, { json: { user_id: bob.id } })).data.conversation;
    assert.equal(dm.type, 'dm');
    const again = (await a.post(`${A()}/dms`, { json: { user_id: bob.id } })).data.conversation;
    assert.equal(again.id, dm.id, 'one DM per pair');

    const send = (cid, body) => a.post(`${A()}/conversations/${dm.id}/messages`, { json: { client_message_id: cid, body } });
    const first = await send('cid-0000000001', 'Salut **Bob**');
    assert.equal(first.data.status, 'persisted');
    assert.equal(first.data.message.seq, 1);
    const retry = await send('cid-0000000001', 'Salut **Bob**');
    assert.equal(retry.data.duplicate, true);
    assert.equal(retry.data.message.id, first.data.message.id, 'retry returns the stored message');
    const second = await send('cid-0000000002', 'Ce faci?');
    assert.equal(second.data.message.seq, 2);

    const b = client(app.base);
    await b.login('bob@alfa.ro');
    const list = (await b.get(`${A()}/bootstrap`)).data.conversations;
    assert.equal(list.find((c) => c.id === dm.id).unread, 2);
    const history = (await b.get(`${A()}/conversations/${dm.id}/messages`)).data.messages;
    assert.deepEqual(history.map((m) => m.seq), [1, 2]);
  });

  test('tenant isolation over HTTP (criterion 16)', async () => {
    const a = client(app.base);
    await a.login('ana@alfa.ro');
    const e = client(app.base);
    await e.login('eve@beta.ro');
    const space = (await a.post(`${A()}/spaces`, { json: { name: 'Secret', visibility: 'private' } })).data.conversation;
    // Eve is not a member of Alfa: every Alfa route is forbidden.
    assert.equal((await e.get(`${A()}/bootstrap`)).status, 403);
    assert.equal((await e.get(`${A()}/conversations/${space.id}/messages`)).status, 403);
    // Using her own org in the URL does not reach Alfa's conversation either.
    assert.equal((await e.get(`/api/o/${orgB.slug}/conversations/${space.id}/messages`)).status, 404);
    assert.equal((await e.post(`/api/o/${orgB.slug}/dms`, { json: { user_id: ana.id } })).status, 403);
  });

  test('same user in two organizations keeps separate context (criterion 17)', async () => {
    const b = client(app.base);
    await b.login('bob@alfa.ro');
    const inA = (await b.get(`${A()}/bootstrap`)).data;
    const inB = (await b.get(`/api/o/${orgB.slug}/bootstrap`)).data;
    assert.ok(inA.directory.some((u) => u.id === ana.id));
    assert.ok(!inB.directory.some((u) => u.id === ana.id), 'Ana is not visible from Beta');
    assert.ok(inB.directory.some((u) => u.id === eve.id));
    assert.ok(inA.conversations.every((c) => !inB.conversations.some((x) => x.id === c.id)));
  });

  test('websocket: ACK persisted, live delivery, catch-up after reconnect without duplicates (criterion 21)', async () => {
    const a = client(app.base);
    await a.login('ana@alfa.ro');
    const b = client(app.base);
    await b.login('bob@alfa.ro');
    const space = (await a.post(`${A()}/spaces`, { json: { name: 'Echipa', user_ids: [bob.id] } })).data.conversation;

    const wsA = socket(app.base, `/ws?org=${orgA.slug}`, a);
    const wsB = socket(app.base, `/ws?org=${orgA.slug}`, b);
    await Promise.all([wsA.opened, wsB.opened]);
    const hello = await wsB.next('hello');
    let cursor = hello.data.cursor;

    const ack = await wsA.request('message.send', { conversation_id: space.id, client_message_id: 'ws-msg-000001', body: 'live' });
    assert.equal(ack.type, 'message.ack');
    assert.equal(ack.data.status, 'persisted');
    const live = await wsB.next('message.created');
    assert.equal(live.data.body, 'live');
    assert.ok(live.event_id > cursor);
    cursor = live.event_id;

    // Bob goes offline; Ana sends two messages, one of them retried.
    wsB.close();
    await wsB.closed;
    await wsA.request('message.send', { conversation_id: space.id, client_message_id: 'ws-msg-000002', body: 'offline 1' });
    const dup = await wsA.request('message.send', { conversation_id: space.id, client_message_id: 'ws-msg-000002', body: 'offline 1' });
    assert.equal(dup.data.duplicate, true);
    await wsA.request('message.send', { conversation_id: space.id, client_message_id: 'ws-msg-000003', body: 'offline 2' });

    const wsB2 = socket(app.base, `/ws?org=${orgA.slug}`, b);
    await wsB2.opened;
    const sync = await wsB2.request('system.sync', { since: cursor });
    assert.equal(sync.data.reset, false);
    const created = sync.data.events.filter((e) => e.type === 'message.created').map((e) => e.data.body);
    assert.deepEqual(created, ['offline 1', 'offline 2'], 'each missed message exactly once, in order');
    wsA.close();
    wsB2.close();
  });

  test('websocket upgrade checks origin, session and membership', async () => {
    const e = client(app.base);
    await e.login('eve@beta.ro');
    await assert.rejects(socket(app.base, `/ws?org=${orgA.slug}`, e).opened, /403/);
    await assert.rejects(socket(app.base, `/ws?org=${orgB.slug}`, client(app.base)).opened, /401/);
    await assert.rejects(socket(app.base, `/ws?org=${orgB.slug}`, e, { origin: 'https://evil.example' }).opened, /403/);
    const ok = socket(app.base, `/ws?org=${orgB.slug}`, e);
    await ok.opened;
    ok.close();
  });

  test('threads, mentions, reactions, edit with version, delete', async () => {
    const a = client(app.base);
    await a.login('ana@alfa.ro');
    const space = (await a.post(`${A()}/spaces`, { json: { name: 'Proiect', user_ids: [bob.id] } })).data.conversation;
    const root = (await a.post(`${A()}/conversations/${space.id}/messages`, { json: { client_message_id: 'root-0000001', body: `Salut <@${bob.id}>` } })).data.message;
    const reply = (await a.post(`${A()}/conversations/${space.id}/messages`, { json: { client_message_id: 'reply-000001', body: 'în thread', parent_id: root.id } })).data.message;
    assert.equal(reply.parent_id, root.id);

    const b = client(app.base);
    await b.login('bob@alfa.ro');
    const conv = (await b.get(`${A()}/bootstrap`)).data.conversations.find((c) => c.id === space.id);
    assert.equal(conv.mentions, 1);
    const main = (await b.get(`${A()}/conversations/${space.id}/messages`)).data.messages;
    assert.deepEqual(main.map((m) => m.id), [root.id], 'replies stay out of the main timeline');
    assert.equal(main[0].reply_count, 1);
    const thread = (await b.get(`${A()}/conversations/${space.id}/messages?parent=${root.id}`)).data;
    assert.deepEqual(thread.messages.map((m) => m.id), [reply.id]);

    await b.post(`${A()}/conversations/${space.id}/messages/${root.id}/react`, { json: { emoji: '👍' } });
    const edit = (version) => a.post(`${A()}/conversations/${space.id}/messages/${root.id}/edit`, { json: { body: 'editat', version } });
    assert.equal((await edit(1)).status, 409, 'version 1 is stale after the reaction and reply');
    const current = (await a.get(`${A()}/conversations/${space.id}/messages`)).data.messages[0];
    assert.equal((await edit(current.version)).status, 200);
    assert.equal((await b.post(`${A()}/conversations/${space.id}/messages/${root.id}/edit`, { json: { body: 'x', version: current.version + 1 } })).status, 403, 'only the author edits');

    await a.post(`${A()}/conversations/${space.id}/messages/${reply.id}/delete`, { json: {} });
    const after = (await b.get(`${A()}/conversations/${space.id}/messages?parent=${root.id}`)).data.messages[0];
    assert.ok(after.deleted_at);
    assert.equal(after.body, '');
  });

  test('search is scoped to the caller conversations', async () => {
    const a = client(app.base);
    await a.login('ana@alfa.ro');
    const priv = (await a.post(`${A()}/spaces`, { json: { name: 'Doar Ana', visibility: 'private' } })).data.conversation;
    await a.post(`${A()}/conversations/${priv.id}/messages`, { json: { client_message_id: 'srch-0000001', body: 'Bugetul pentru ședința trimestrială' } });
    const hits = (await a.get(`${A()}/search?q=sedinta`)).data.messages;
    assert.equal(hits.length, 1, 'diacritics-insensitive FTS');
    assert.match(hits[0].snippet, /\[\[ședința\]\]/);
    const b = client(app.base);
    await b.login('bob@alfa.ro');
    assert.equal((await b.get(`${A()}/search?q=sedinta`)).data.messages.length, 0);
  });

  test('files: allowlist, magic bytes, authorized download', async () => {
    const a = client(app.base);
    await a.login('ana@alfa.ro');
    const space = (await a.post(`${A()}/spaces`, { json: { name: 'Fișiere', visibility: 'private' } })).data.conversation;
    const upload = (name, body) => a.post(`${A()}/files`, { body, headers: { 'X-File-Name': encodeURIComponent(name) } });
    assert.equal((await upload('script.exe', 'MZ')).status, 400);
    assert.equal((await upload('poza.png', 'not a png')).status, 400);
    const file = (await upload('notițe.txt', 'conținut confidențial')).data.file;
    assert.equal(file.mime, 'text/plain');
    await a.post(`${A()}/conversations/${space.id}/messages`, { json: { client_message_id: 'file-0000001', body: '', attachment_ids: [file.id] } });
    const got = await a.get(`${A()}/files/${file.id}`);
    assert.equal(got.status, 200);
    assert.equal(got.text, 'conținut confidențial');
    const b = client(app.base);
    await b.login('bob@alfa.ro');
    assert.equal((await b.get(`${A()}/files/${file.id}`)).status, 404, 'not a member of the conversation');
  });

  test('cross-site POST is blocked (CSRF)', async () => {
    const a = client(app.base);
    await a.login('ana@alfa.ro');
    const res = await a.post(`${A()}/spaces`, { json: { name: 'x' }, headers: { Origin: 'https://evil.example' } });
    assert.equal(res.status, 403);
  });

  test('membership revocation closes sockets and blocks access (criterion 20)', async () => {
    const owner = await app.user(orgA, { email: 'owner@alfa.ro', role: 'owner' });
    const tmp = await app.user(orgA, { email: 'tmp@alfa.ro' });
    const c = client(app.base);
    await c.login('tmp@alfa.ro');
    const ws = socket(app.base, `/ws?org=${orgA.slug}`, c);
    await ws.opened;
    await app.services.orgs.revoke(orgA, tmp.id, owner, '127.0.0.1');
    app.services.realtime.disconnectUser(tmp.id, orgA.id);
    const closed = await ws.closed;
    assert.equal(closed.code, 4001);
    assert.equal((await c.get(`${A()}/bootstrap`)).status, 403);
    await sleep(10);
  });
});
