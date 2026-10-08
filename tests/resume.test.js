import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { client, socket, startApp } from './helpers.js';

// A dropped meeting socket keeps its place for a grace period: the others are
// not told it left, it can resume in place (same page id), newcomers do not
// see it meanwhile, and an explicit leave still ends it at once.
describe('meeting resume', () => {
  let app;
  let org;
  const API = () => `/api/o/${org.slug}`;

  before(async () => {
    app = await startApp();
    org = await app.org('Resume SRL');
    for (const u of ['a', 'b', 'c']) await app.user(org, { email: `${u}@resume.ro` });
  });
  after(() => app.stop());

  const login = async (u) => {
    const c = client(app.base);
    await c.login(`${u}@resume.ro`);
    return c;
  };
  const enter = async (c, meetingId, data = {}) => {
    const ws = socket(app.base, `/ws/meeting?id=${meetingId}`, c);
    await ws.opened;
    ws.send('join', data);
    return { ws, joined: await ws.next('joined') };
  };

  test('a dropped socket resumes without the others noticing', async () => {
    const [a, b, c] = [await login('a'), await login('b'), await login('c')];
    const ids = await Promise.all(['b', 'c'].map(async (u) => (await app.services.users.byEmail(`${u}@resume.ro`)).id));
    const { meeting } = (await a.post(`${API()}/meetings`, { json: { title: 'Resume', user_ids: ids } })).data;
    const pa = await enter(a, meeting.id, { page: 'page-a' });
    const pb = await enter(b, meeting.id, { page: 'page-b' });
    assert.equal((await pa.ws.next('peer.joined')).data.page, 'page-b');

    // A's connection dies without a leave (network drop).
    pa.ws.ws.terminate();
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(!pb.ws.frames.some((f) => f.type === 'peer.left'), 'no peer.left during the grace period');

    // Someone joining meanwhile does not see A.
    const pc = await enter(c, meeting.id, { page: 'page-c' });
    assert.deepEqual(pc.joined.data.peers.map((p) => p.page), ['page-b']);

    // A comes back with the same page: resumed, and B is told it is a resume.
    const back = await enter(a, meeting.id, { page: 'page-a', resume: true });
    assert.equal(back.joined.data.resumed, true);
    const again = await pb.ws.next('peer.joined', 3000, (m) => m.data.page === 'page-a');
    assert.equal(again.data.resume, true);
    assert.ok(!pb.ws.frames.some((f) => f.type === 'peer.left'));

    // An explicit leave is announced at once.
    back.ws.send('leave');
    assert.equal((await pb.ws.next('peer.left', 3000)).data.id, back.joined.data.self.id);
    pb.ws.close();
    pc.ws.close();
  });
});
