import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { client, socket, startApp } from './helpers.js';

// SFU topology with the Cloudflare API stubbed: the server proxies push/pull,
// names tracks itself, only lets admitted participants of the same room pull,
// and closes a participant's tracks when they leave.
describe('sfu', () => {
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
    app = await startApp({ CF_SFU_APP_ID: 'app', CF_SFU_APP_TOKEN: 'secret' });
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
