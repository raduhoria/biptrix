import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { client, socket, startApp } from './helpers.js';

// SFU topology with the Cloudflare API stubbed: the server proxies push/pull,
// names tracks itself, only lets admitted participants of the same room pull,
// and closes a participant's tracks when they leave.
describe('sfu (MEDIA_TOPOLOGY=sfu)', () => {
  let app;
  let org;
  const calls = [];
  const realFetch = globalThis.fetch;

  before(async () => {
    globalThis.fetch = async (url, opts = {}) => {
      if (!String(url).startsWith('https://rtc.live.cloudflare.com/')) return realFetch(url, opts);
      const path = new URL(url).pathname;
      const body = opts.body ? JSON.parse(opts.body) : {};
      calls.push({ path, body });
      let out = {};
      if (path.endsWith('/sessions/new')) out = { sessionId: `s${calls.length}` };
      else if (path.endsWith('/tracks/new')) {
        const remote = body.tracks[0]?.location === 'remote';
        out = { requiresImmediateRenegotiation: remote, sessionDescription: { type: remote ? 'offer' : 'answer', sdp: 'v=0' }, tracks: body.tracks.map((t, i) => ({ ...t, mid: t.mid || String(10 + i) })) };
      } else out = { tracks: body.tracks || [] };
      return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    app = await startApp({ CF_SFU_APP_ID: 'app', CF_SFU_APP_TOKEN: 'secret', MEDIA_TOPOLOGY: 'sfu' });
    org = await app.org('Sfu SRL');
    await app.user(org, { email: 'a@sfu.ro' });
    await app.user(org, { email: 'b@sfu.ro' });
  });
  after(async () => {
    await app.stop();
    globalThis.fetch = realFetch;
  });

  test('push, publish, pull and cleanup go through the server', async () => {
    const a = client(app.base);
    await a.login('a@sfu.ro');
    const b = client(app.base);
    await b.login('b@sfu.ro');
    const { meeting } = (await a.post(`/api/o/${org.slug}/meetings`, { json: { title: 'SFU', user_ids: [(await app.services.users.byEmail('b@sfu.ro')).id] } })).data;

    const wa = socket(app.base, `/ws/meeting?id=${meeting.id}`, a);
    const wb = socket(app.base, `/ws/meeting?id=${meeting.id}`, b);
    await Promise.all([wa.opened, wb.opened]);
    wa.send('join', {});
    const ja = await wa.next('joined');
    assert.equal(ja.data.topology, 'sfu');
    wb.send('join', {});
    const jb = await wb.next('joined');

    // Client-chosen names are ignored; the server names the tracks.
    const pushed = await wa.request('sfu.push', { sdp: { type: 'offer', sdp: 'v=0' }, tracks: [{ mid: '0', slot: 'audio', trackName: 'spoof' }, { mid: '1', slot: 'camera' }] });
    assert.equal(pushed.type, 'sfu.answer');
    const push = calls.find((c) => c.path.endsWith('/tracks/new') && c.body.tracks[0].location === 'local');
    assert.deepEqual(push.body.tracks.map((t) => t.trackName), [`${ja.data.self.id}-audio`, `${ja.data.self.id}-camera`]);

    // Nothing to pull before the publisher announces its tracks.
    const early = await wb.request('sfu.pull', { tracks: [{ participant_id: ja.data.self.id, slot: 'audio' }] });
    assert.equal(early.data.tracks.length, 0);

    wa.send('sfu.publish', { slots: ['audio', 'camera'] });
    const announced = await wb.next('peer.tracks');
    assert.equal(announced.data.tracks.camera, `${ja.data.self.id}-camera`);
    const pulled = await wb.request('sfu.pull', { tracks: [{ participant_id: ja.data.self.id, slot: 'audio' }, { participant_id: ja.data.self.id, slot: 'camera' }, { participant_id: 'someone-else', slot: 'audio' }] });
    assert.equal(pulled.data.tracks.length, 2, 'unknown participants are skipped');
    assert.equal(pulled.data.renegotiate, true);
    assert.ok(jb.data.self.id);

    wa.close();
    await wb.next('peer.left');
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(calls.some((c) => c.path.endsWith('/tracks/close') && c.body.force === true), 'publisher tracks closed on leave');
    wb.close();
  });
});

// MEDIA_TOPOLOGY=auto (the default): peer-to-peer while the call fits the
// mesh limit, moved to the SFU when one more joins, back once it is small
// again; the org policy can forbid the SFU.
describe('auto topology', () => {
  let app;
  let org;
  const realFetch = globalThis.fetch;
  const users = ['a', 'b', 'c'];

  before(async () => {
    globalThis.fetch = async (url, opts = {}) => {
      if (!String(url).startsWith('https://rtc.live.cloudflare.com/')) return realFetch(url, opts);
      const body = opts.body ? JSON.parse(opts.body) : {};
      const out = new URL(url).pathname.endsWith('/sessions/new') ? { sessionId: 's1' } : { tracks: body.tracks || [] };
      return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    app = await startApp({ CF_SFU_APP_ID: 'app', CF_SFU_APP_TOKEN: 'secret', MESH_MAX_PARTICIPANTS: '2', MEDIA_SFU_RETURN_MS: '200' });
    org = await app.org('Auto SRL');
    for (const u of users) await app.user(org, { email: `${u}@auto.ro` });
  });
  after(async () => {
    await app.stop();
    globalThis.fetch = realFetch;
  });

  async function people() {
    const out = [];
    for (const u of users) {
      const c = client(app.base);
      await c.login(`${u}@auto.ro`);
      out.push(c);
    }
    return out;
  }
  async function enter(c, meetingId) {
    const ws = socket(app.base, `/ws/meeting?id=${meetingId}`, c);
    await ws.opened;
    ws.send('join', {});
    return { ws, joined: await ws.next('joined') };
  }

  test('peer-to-peer up to the limit, the SFU above it, and back', async () => {
    const [a, b, c] = await people();
    const ids = await Promise.all(['b', 'c'].map(async (u) => (await app.services.users.byEmail(`${u}@auto.ro`)).id));
    const { meeting } = (await a.post(`/api/o/${org.slug}/meetings`, { json: { title: 'Auto', user_ids: ids } })).data;
    const pa = await enter(a, meeting.id);
    const pb = await enter(b, meeting.id);
    assert.equal(pa.joined.data.topology, 'mesh');
    assert.equal(pb.joined.data.topology, 'mesh');

    // The third person: everyone already inside is told to move first, the
    // newcomer starts on the SFU, and nobody is disconnected.
    const pc = await enter(c, meeting.id);
    assert.equal(pc.joined.data.topology, 'sfu');
    assert.equal((await pa.ws.next('topology')).data.topology, 'sfu');
    assert.equal((await pb.ws.next('topology')).data.topology, 'sfu');
    const pushed = await pa.ws.request('sfu.push', { sdp: { type: 'offer', sdp: 'v=0' }, tracks: [{ mid: '0', slot: 'audio' }] });
    assert.equal(pushed.type, 'sfu.answer');

    // Small again: back to peer-to-peer after the delay; SFU sessions end.
    pc.ws.close();
    assert.equal((await pa.ws.next('topology', 2000)).data.topology, 'mesh');
    await pb.ws.next('topology', 2000);
    assert.equal((await pa.ws.request('sfu.leave', {})).type, 'sfu.ok');
    // Peer-to-peer signaling still works on the same sockets.
    pa.ws.send('signal', { to: pb.joined.data.self.id, data: { sdp: { type: 'offer', sdp: 'v=0' } } });
    await pb.ws.next('signal');
    pa.ws.close();
    pb.ws.close();
  });

  test('with the SFU forbidden by policy, calls stay peer-to-peer and are capped', async () => {
    const [a, b, c] = await people();
    const owner = await app.user(org, { email: 'owner@auto.ro', role: 'owner' });
    await app.services.policies.update(org.id, { media_sfu_allowed: false }, owner, '');
    const ids = await Promise.all(['b', 'c'].map(async (u) => (await app.services.users.byEmail(`${u}@auto.ro`)).id));
    const { meeting } = (await a.post(`/api/o/${org.slug}/meetings`, { json: { title: 'Private', user_ids: ids } })).data;
    const pa = await enter(a, meeting.id);
    await enter(b, meeting.id);
    assert.equal(pa.joined.data.topology, 'mesh');
    const ws = socket(app.base, `/ws/meeting?id=${meeting.id}`, c);
    await ws.opened;
    ws.send('join', {});
    const full = await ws.next('error');
    assert.equal(full.data.code, 'room_full');
    assert.ok(!pa.ws.frames.some((f) => f.type === 'topology'), 'never moved to the SFU');
    const refused = await Promise.race([pa.ws.request('sfu.push', { sdp: { type: 'offer', sdp: 'v=0' }, tracks: [] }).then(() => 'answered'), new Promise((r) => setTimeout(() => r('ignored'), 300))]);
    assert.equal(refused, 'ignored');
  });
});
