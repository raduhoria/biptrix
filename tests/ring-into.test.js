import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { client, socket, startApp } from './helpers.js';

// "Ring into": someone in a meeting under way rings colleagues in; they get
// the incoming-call screen, join without the lobby, and stop ringing once
// they join or decline.
describe('ringing colleagues into a meeting', () => {
  let app;
  let org;
  const people = {};
  const clients = {};
  let meeting;
  const API = () => `/api/o/${org.slug}`;

  before(async () => {
    app = await startApp();
    org = await app.org('Ring');
    for (const [name, role] of [['ana', 'owner'], ['bob', 'member'], ['cora', 'member'], ['dan', 'member'], ['ext', 'external']]) {
      people[name] = await app.user(org, { email: `${name}@r.ro`, name, role });
      clients[name] = client(app.base);
      await clients[name].login(`${name}@r.ro`);
    }
    meeting = (await clients.ana.post(`${API()}/meetings`, { json: { title: 'Weekly', notify_members: false } })).data.meeting;
  });
  after(() => app.stop());

  async function room(name) {
    const ws = socket(app.base, `/ws/meeting?id=${meeting.id}`, clients[name]);
    await ws.opened;
    ws.send('join', { name });
    return { ws, first: await Promise.race([ws.next('joined'), ws.next('lobby')]) };
  }

  async function chatSocket(name) {
    const ws = socket(app.base, `/ws?org=${org.slug}`, clients[name]);
    await ws.opened;
    await ws.next('hello');
    return ws;
  }

  const ringInto = (who, ids) => clients[who].post(`${API()}/meetings/${meeting.id}/ring-members`, { json: { user_ids: ids } });

  test('only people in the meeting ring others in; colleagues only', async () => {
    assert.equal((await ringInto('bob', [people.cora.id])).status, 403, 'not in the meeting');
    const ana = await room('ana');
    assert.equal(ana.first.type, 'joined');
    const res = await ringInto('ana', [people.ext.id, people.ana.id]);
    assert.deepEqual(res.data.ringing, [], 'external collaborators and oneself are not rung');
    ana.ws.close();
    assert.equal((await clients.ext.post(`${API()}/meetings/${meeting.id}/ring-members`, { json: { user_ids: [people.bob.id] } })).status, 403);
  });

  test('the colleague rings, joins without the lobby, and stops ringing', async () => {
    const ana = await room('ana');
    const bobChat = await chatSocket('bob');
    const res = await ringInto('ana', [people.bob.id]);
    assert.deepEqual(res.data.ringing, [people.bob.id]);
    const ring = await bobChat.next('call.ring');
    assert.equal(ring.data.meeting_id, meeting.id);
    assert.equal(ring.data.title, 'Weekly');
    assert.equal(ring.data.from, people.ana.id);
    const bob = await room('bob');
    assert.equal(bob.first.type, 'joined', 'no lobby');
    await bobChat.next('call.stop', 3000, (m) => m.data.meeting_id === meeting.id);
    // Already in the call: not rung again.
    assert.deepEqual((await ringInto('ana', [people.bob.id])).data.ringing, []);
    for (const ws of [ana.ws, bob.ws, bobChat]) ws.close();
  });

  test('declining stops the ring on every device', async () => {
    const ana = await room('ana');
    const coraChat = await chatSocket('cora');
    await ringInto('ana', [people.cora.id]);
    await coraChat.next('call.ring');
    assert.equal((await clients.cora.post(`${API()}/meetings/${meeting.id}/ring`, { json: { answer: 'decline' } })).status, 200);
    await coraChat.next('call.stop', 3000, (m) => m.data.meeting_id === meeting.id);
    for (const ws of [ana.ws, coraChat]) ws.close();
  });

  test('someone not rung cannot use the answer endpoint of a meeting', async () => {
    const other = (await clients.ana.post(`${API()}/meetings`, { json: { title: 'Private', notify_members: false } })).data.meeting;
    assert.equal((await clients.dan.post(`${API()}/meetings/${other.id}/ring`, { json: { answer: 'decline' } })).status, 404);
  });
});
