import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { client, socket, startApp } from './helpers.js';

const tokenFrom = (mail) => mail.text.match(/\/join\/([A-Za-z0-9_-]+)/)[1];
const codeFrom = (mail) => mail.text.match(/\b(\d{6})\b/)[1];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// In-call chat (conversation or meeting chat) and ringing calls.
describe('in-call chat and calls', () => {
  let app;
  let org;
  let ana;
  let bob;
  let anaClient;
  let bobClient;
  let dm;
  const API = () => `/api/o/${org.slug}`;

  before(async () => {
    app = await startApp();
    org = await app.org('Calls');
    ana = await app.user(org, { email: 'ana@c.ro', name: 'Ana' });
    bob = await app.user(org, { email: 'bob@c.ro', name: 'Bob' });
    await app.user(org, { email: 'cora@c.ro', name: 'Cora' });
    anaClient = client(app.base);
    await anaClient.login('ana@c.ro');
    bobClient = client(app.base);
    await bobClient.login('bob@c.ro');
    dm = (await anaClient.post(`${API()}/dms`, { json: { user_id: bob.id } })).data.conversation;
  });
  after(() => app.stop());

  async function room(c, meetingId, name) {
    const ws = socket(app.base, `/ws/meeting?id=${meetingId}`, c);
    await ws.opened;
    ws.send('join', { name });
    return { ws, joined: await ws.next('joined') };
  }

  async function chatSocket(c) {
    const ws = socket(app.base, `/ws?org=${org.slug}`, c);
    await ws.opened;
    await ws.next('hello');
    return ws;
  }

  test('a call from a DM rings the other person; joining answers it and the chat is the conversation', async () => {
    const bobWs = await chatSocket(bobClient);
    const res = await anaClient.post(`${API()}/meetings`, { json: { conversation_id: dm.id, notify_members: false, call: 'audio' } });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.data.ringing, 1);
    const meeting = res.data.meeting;
    const ring = await bobWs.next('call.ring');
    assert.equal(ring.data.meeting_id, meeting.id);
    assert.equal(ring.data.kind, 'audio');
    assert.equal(ring.data.from, ana.id);

    const a = await room(anaClient, meeting.id, 'Ana');
    assert.equal(a.joined.data.call.ringing, true);
    assert.equal(a.joined.data.chat.mode, 'conversation');
    const b = await room(bobClient, meeting.id, 'Bob');
    await bobWs.next('call.stop', 3000, (m) => m.data.meeting_id === meeting.id);
    assert.equal((await app.db.get('SELECT ring_state FROM meetings WHERE id = ?', [meeting.id])).ring_state, 'answered');

    // A message in the call is a conversation message, and one written in
    // the conversation (outside the call) reaches the call.
    a.ws.send('chat.send', { client_id: 'callmsg-0001', body: 'Salut din apel' });
    const inBob = await b.ws.next('chat.message', 3000, (m) => m.data.body === 'Salut din apel');
    assert.equal(inBob.data.name, 'Ana');
    const stored = await app.db.get("SELECT kind, author_id FROM messages WHERE conversation_id = ? AND body = 'Salut din apel'", [dm.id]);
    assert.deepEqual({ ...stored }, { kind: 'text', author_id: ana.id });
    await bobClient.post(`${API()}/conversations/${dm.id}/messages`, { json: { client_message_id: 'outside-0001', body: 'scris din aplicație' } });
    await a.ws.next('chat.message', 3000, (m) => m.data.body === 'scris din aplicație');
    // Sent twice with the same client id: stored once.
    a.ws.send('chat.send', { client_id: 'callmsg-0001', body: 'Salut din apel' });
    await wait(150);
    assert.equal((await app.db.get("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND body = 'Salut din apel'", [dm.id])).n, 1);
    for (const w of [a.ws, b.ws, bobWs]) w.ws.close();
  });

  test('declining stops the ringing everywhere and tells the caller', async () => {
    const bobWs = await chatSocket(bobClient);
    const meeting = (await anaClient.post(`${API()}/meetings`, { json: { conversation_id: dm.id, notify_members: false, call: 'video' } })).data.meeting;
    await bobWs.next('call.ring', 3000, (m) => m.data.meeting_id === meeting.id);
    const a = await room(anaClient, meeting.id, 'Ana');
    assert.equal((await bobClient.post(`${API()}/meetings/${meeting.id}/ring`, { json: { answer: 'decline' } })).status, 200);
    await bobWs.next('call.stop', 3000, (m) => m.data.meeting_id === meeting.id);
    assert.equal((await a.ws.next('call.declined')).data.name, 'Bob');
    assert.equal((await app.db.get('SELECT ring_state FROM meetings WHERE id = ?', [meeting.id])).ring_state, 'declined');
    // Someone outside the conversation cannot answer for it.
    const cora = client(app.base);
    await cora.login('cora@c.ro');
    assert.equal((await cora.post(`${API()}/meetings/${meeting.id}/ring`, { json: { answer: 'decline' } })).status, 404);
    a.ws.ws.close();
    bobWs.ws.close();
  });

  test('the caller hangs up while it rings: a missed call, an e-mail if offline, the meeting closed', async () => {
    const meeting = (await anaClient.post(`${API()}/meetings`, { json: { conversation_id: dm.id, notify_members: false, call: 'video' } })).data.meeting;
    const before = app.mailer.sent.filter((m) => m.to === 'bob@c.ro').length;
    const a = await room(anaClient, meeting.id, 'Ana');
    a.ws.ws.close();
    await wait(300);
    const m = await app.db.get('SELECT state, ring_state FROM meetings WHERE id = ?', [meeting.id]);
    assert.deepEqual({ ...m }, { state: 'ended', ring_state: 'missed' });
    const missed = await app.db.get("SELECT author_id, meta FROM messages WHERE conversation_id = ? AND kind = 'call_missed' ORDER BY seq DESC", [dm.id]);
    assert.equal(missed.author_id, ana.id);
    assert.equal(JSON.parse(missed.meta).meeting_id, meeting.id);
    const mails = app.mailer.sent.filter((x) => x.to === 'bob@c.ro');
    assert.equal(mails.length, before + 1);
    assert.match(mails.at(-1).subject, /Ana/);
  });

  test('nobody answers by the deadline: missed (maintenance fallback)', async () => {
    const meeting = (await anaClient.post(`${API()}/meetings`, { json: { conversation_id: dm.id, notify_members: false, call: 'audio' } })).data.meeting;
    const a = await room(anaClient, meeting.id, 'Ana');
    await app.db.run('UPDATE meetings SET ring_until = ? WHERE id = ?', [new Date(Date.now() - 10_000).toISOString(), meeting.id]);
    await app.maintenance();
    assert.equal((await app.db.get('SELECT ring_state FROM meetings WHERE id = ?', [meeting.id])).ring_state, 'missed');
    await a.ws.next('call.missed');
    a.ws.ws.close();
  });

  test('Spaces do not ring; a meeting without a conversation has its own chat, shared with guests', async () => {
    const space = (await anaClient.post(`${API()}/spaces`, { json: { name: 'Mare' } })).data.conversation;
    const call = await anaClient.post(`${API()}/meetings`, { json: { conversation_id: space.id, notify_members: false, call: 'video' } });
    assert.equal(call.data.ringing, 0);

    const res = await anaClient.post(`${API()}/meetings`, { json: { title: 'Ofertă', guests: [{ email: 'g@extern.com', name: 'Guest' }] } });
    const meeting = res.data.meeting;
    const g = client(app.base);
    const token = tokenFrom(app.mailer.sent.filter((m) => m.to === 'g@extern.com').at(-1));
    await g.post(`/join/${token}/code`);
    await g.post(`/join/${token}/verify`, { form: { code: codeFrom(app.mailer.sent.filter((m) => m.to === 'g@extern.com').at(-1)) } });

    const a = await room(anaClient, meeting.id, 'Ana');
    assert.equal(a.joined.data.chat.mode, 'meeting');
    a.ws.send('chat.send', { client_id: 'before-guest-1', body: 'înainte de invitat' });
    await a.ws.next('chat.message');

    const gws = socket(app.base, `/ws/meeting?id=${meeting.id}`, g);
    await gws.opened;
    gws.send('join', { name: 'Guest' });
    await gws.next('lobby');
    const waiting = (await a.ws.next('lobby.update', 3000, (m) => m.data.waiting.length === 1)).data.waiting[0];
    a.ws.send('admit', { participant_id: waiting.id, accept: true });
    await gws.next('admitted');
    gws.send('join', { name: 'Guest' });
    const gj = await gws.next('joined');
    assert.equal(gj.data.chat.mode, 'meeting');
    assert.deepEqual(gj.data.chat.messages.map((m) => m.body), ['înainte de invitat'], 'history for late joiners');
    gws.send('chat.send', { client_id: 'from-guest-01', body: 'mulțumesc' });
    const fromGuest = await a.ws.next('chat.message', 3000, (m) => m.data.body === 'mulțumesc');
    assert.equal(fromGuest.data.name, 'Guest');
    assert.equal(fromGuest.data.author_id, null);
    gws.ws.close();
    a.ws.ws.close();
  });

  test('in a conversation call, people outside the conversation get no chat', async () => {
    const meeting = (await anaClient.post(`${API()}/meetings`, { json: { conversation_id: dm.id, notify_members: false, call: 'video' } })).data.meeting;
    const a = await room(anaClient, meeting.id, 'Ana');
    const colleague = await app.user(org, { email: 'boss@c.ro' });
    const boss = client(app.base);
    await boss.login(colleague.email);
    // A colleague outside the DM, let in from the lobby.
    const bws = socket(app.base, `/ws/meeting?id=${meeting.id}`, boss);
    await bws.opened;
    bws.send('join', {});
    await bws.next('lobby');
    const waiting = (await a.ws.next('lobby.update', 3000, (m) => m.data.waiting.length === 1)).data.waiting[0];
    a.ws.send('admit', { participant_id: waiting.id, accept: true });
    await bws.next('admitted');
    bws.send('join', {});
    const joined = await bws.next('joined');
    assert.equal(joined.data.chat.mode, 'none');
    assert.deepEqual(joined.data.chat.messages, []);
    a.ws.send('chat.send', { client_id: 'private-msg-1', body: 'doar pentru noi' });
    await wait(200);
    assert.ok(!bws.frames.some((f) => f.type === 'chat.message'));
    bws.send('chat.send', { client_id: 'outsider-msg1', body: 'x' });
    assert.equal((await bws.next('error')).data.code, 'forbidden');
    bws.ws.close();
    a.ws.ws.close();
  });
  test('an ended call stops offering "Join": the card shows how it ended, live', async () => {
    const card = (meetingId) => app.db.get("SELECT meta, version FROM messages WHERE conversation_id = ? AND kind = 'meeting' AND json_extract(meta, '$.meeting_id') = ?", [dm.id, meetingId]).then((r) => ({ ...JSON.parse(r.meta), version: r.version }));
    // Missed (earlier test): the card says so.
    const missedId = (await app.db.get("SELECT id FROM meetings WHERE ring_state = 'missed' ORDER BY created_at LIMIT 1")).id;
    assert.deepEqual([(await card(missedId)).state, (await card(missedId)).outcome], ['ended', 'missed']);

    // Ended by the host, with a duration; open chat sockets get message.updated.
    const bobWs = await chatSocket(bobClient);
    const meeting = (await anaClient.post(`${API()}/meetings`, { json: { conversation_id: dm.id, notify_members: false, call: 'video' } })).data.meeting;
    const a = await room(anaClient, meeting.id, 'Ana');
    await room(bobClient, meeting.id, 'Bob');
    await app.db.run('UPDATE meetings SET started_at = ? WHERE id = ?', [new Date(Date.now() - 125_000).toISOString(), meeting.id]);
    assert.equal((await anaClient.post(`${API()}/meetings/${meeting.id}/end`, { json: {} })).status, 200);
    const updated = await bobWs.next('message.updated', 3000, (m) => m.data.meta?.meeting_id === meeting.id);
    assert.equal(updated.data.meta.state, 'ended');
    assert.equal(updated.data.meta.outcome, 'answered');
    assert.ok(updated.data.meta.duration_s >= 124 && updated.data.meta.duration_s <= 127);
    assert.equal(updated.data.version, 2);
    // Closing again changes nothing.
    await app.services.meetings.close(await app.services.meetings.byId(meeting.id), { label: 'x' }, 'ended', null);
    assert.equal((await card(meeting.id)).version, 2);

    // Nobody ended it: past its end time, maintenance closes it.
    const old = (await anaClient.post(`${API()}/meetings`, { json: { conversation_id: dm.id, notify_members: false } })).data.meeting;
    await app.db.run('UPDATE meetings SET expires_at = ? WHERE id = ?', [new Date(Date.now() - 1000).toISOString(), old.id]);
    await app.maintenance();
    assert.equal((await card(old.id)).state, 'ended');
    assert.equal((await app.db.get('SELECT state FROM meetings WHERE id = ?', [old.id])).state, 'ended');
    a.ws.ws.close();
    bobWs.ws.close();
  });
});
