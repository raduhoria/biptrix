import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { totpNow } from '../core/totp.js';
import { client, socket, startApp } from './helpers.js';

const tokenFrom = (mail) => mail.text.match(/\/join\/([A-Za-z0-9_-]+)/)[1];
const codeFrom = (mail) => mail.text.match(/\b(\d{6})\b/)[1];

// Spec §8–9 and acceptance criteria 18, 19, 20, 25.
describe('meetings and external guests', () => {
  let app;
  let org;
  let host;
  let owner;
  let hostClient;
  const API = () => `/api/o/${org.slug}`;

  before(async () => {
    app = await startApp();
    org = await app.org('Gama Group');
    host = await app.user(org, { email: 'host@gama.ro', name: 'Gazda' });
    owner = await app.user(org, { email: 'owner@gama.ro', name: 'Owner', role: 'owner' });
    hostClient = client(app.base);
    await hostClient.login('host@gama.ro');
  });
  after(() => app.stop());

  async function createMeeting(guests = [{ email: 'client@extern.com', name: 'Client Extern' }]) {
    const res = await hostClient.post(`${API()}/meetings`, { json: { title: 'Ofertă', guests } });
    assert.equal(res.status, 200, res.text);
    return res.data.meeting;
  }

  async function verifiedGuest(email = 'client@extern.com') {
    const invite = app.mailer.sent.filter((m) => m.to === email).at(-1);
    const token = tokenFrom(invite);
    const g = client(app.base);
    assert.equal((await g.get(`/join/${token}`)).status, 200);
    assert.equal((await g.post(`/join/${token}/code`)).status, 200);
    const otp = codeFrom(app.mailer.sent.filter((m) => m.to === email).at(-1));
    const verified = await g.post(`/join/${token}/verify`, { form: { code: otp } });
    assert.equal(verified.status, 303);
    return { g, token };
  }

  test('guest joins after OTP and lobby admission (criterion 18)', async () => {
    const meeting = await createMeeting();
    const { g } = await verifiedGuest();
    assert.equal((await g.get(`/meet/${meeting.id}`)).status, 200);

    const hostWs = socket(app.base, `/ws/meeting?id=${meeting.id}`, hostClient);
    await hostWs.opened;
    hostWs.send('join', {});
    const joined = await hostWs.next('joined');
    assert.equal(joined.data.can_manage, true);
    assert.ok(joined.data.ice_servers.length);

    const guestWs = socket(app.base, `/ws/meeting?id=${meeting.id}`, g);
    await guestWs.opened;
    guestWs.send('join', { name: 'Client Extern' });
    await guestWs.next('lobby');
    const lobby = await hostWs.next('lobby.update', 3000, (m) => m.data.waiting.length === 1);
    const waiting = lobby.data.waiting[0];
    assert.equal(waiting.email, 'client@extern.com');

    hostWs.send('admit', { participant_id: waiting.id, accept: true });
    await guestWs.next('admitted');
    guestWs.send('join', { name: 'Client Extern' });
    const guestJoined = await guestWs.next('joined');
    assert.equal(guestJoined.data.peers.length, 1);
    assert.equal(guestJoined.data.can_manage, false);
    assert.equal(guestJoined.data.screen_share, false, 'policy: guests cannot share screen by default');
    await hostWs.next('peer.joined');

    // Signaling is relayed only between admitted participants.
    hostWs.send('signal', { to: guestJoined.data.self.id, data: { sdp: { type: 'offer', sdp: 'v=0' } } });
    const sig = await guestWs.next('signal');
    assert.equal(sig.data.from, joined.data.self.id);

    // A guest cannot act as host.
    guestWs.send('end');
    assert.equal((await guestWs.next('error')).data.code, 'forbidden');

    // Ending the meeting closes everyone and invalidates the guest session.
    hostWs.send('end');
    await guestWs.next('ended');
    assert.equal((await g.get(`/meet/${meeting.id}`)).status, 403);
  });

  test('a forwarded link without verification does not grant access (criterion 19)', async () => {
    const meeting = await createMeeting([{ email: 'partener@extern.com' }]);
    const token = tokenFrom(app.mailer.sent.filter((m) => m.to === 'partener@extern.com').at(-1));
    const stranger = client(app.base);
    assert.equal((await stranger.get(`/join/${token}`)).status, 200, 'the page asks for the code');
    assert.equal((await stranger.get(`/meet/${meeting.id}`)).status, 403);
    assert.equal((await stranger.post(`/join/${token}/continue`)).status, 303, 'continue without OTP is refused…');
    assert.equal((await stranger.get(`/meet/${meeting.id}`)).status, 403, '…and creates no session');
    await assert.rejects(socket(app.base, `/ws/meeting?id=${meeting.id}`, stranger).opened, /401/);

    // Brute force: five wrong codes lock the current code.
    await stranger.post(`/join/${token}/code`);
    for (let i = 0; i < 5; i++) await stranger.post(`/join/${token}/verify`, { form: { code: '000000' } });
    const real = codeFrom(app.mailer.sent.filter((m) => m.to === 'partener@extern.com').at(-1));
    const late = await stranger.post(`/join/${token}/verify`, { form: { code: real } });
    assert.equal(late.status, 429, 'locked even with the right code');
  });

  test('revoking an invitation kicks the guest and blocks the link (criterion 20)', async () => {
    const meeting = await createMeeting([{ email: 'revocat@extern.com' }]);
    const { g, token } = await verifiedGuest('revocat@extern.com');
    const guestWs = socket(app.base, `/ws/meeting?id=${meeting.id}`, g);
    await guestWs.opened;
    guestWs.send('join', {});
    await guestWs.next('lobby');
    const { invitations } = (await hostClient.get(`${API()}/meetings/${meeting.id}`)).data;
    const inv = invitations.find((i) => i.email === 'revocat@extern.com');
    await hostClient.post(`${API()}/meetings/${meeting.id}/invitations/${inv.id}/revoke`, { json: {} });
    await guestWs.next('removed');
    assert.equal((await g.get(`/meet/${meeting.id}`)).status, 403);
    assert.equal((await g.get(`/join/${token}`)).status, 410);
  });

  test('organization policy is enforced on external invitations', async () => {
    const policies = app.services.policies;
    await policies.update(org.id, { domain_denylist: 'concurent.ro' }, owner, '127.0.0.1');
    const denied = await hostClient.post(`${API()}/meetings`, { json: { title: 'X', guests: [{ email: 'spion@concurent.ro' }] } });
    assert.equal(denied.status, 403);
    assert.equal(denied.data.error.code, 'policy_denied');
    await policies.update(org.id, { external_meetings_enabled: false }, owner, '127.0.0.1');
    const off = await hostClient.post(`${API()}/meetings`, { json: { title: 'X', guests: [{ email: 'a@ok.com' }] } });
    assert.equal(off.status, 403);
    await policies.update(org.id, { external_meetings_enabled: true, domain_denylist: '' }, owner, '127.0.0.1');
    // Policy changes are audited (criterion 25).
    const audit = await app.db.all("SELECT * FROM audit_events WHERE org_id = ? AND action = 'policy.update'", [org.id]);
    assert.equal(audit.length, 3);
  });

  test('members outside the meeting wait in the lobby; invitees enter directly', async () => {
    const invited = await app.user(org, { email: 'invitat@gama.ro' });
    await app.user(org, { email: 'curios@gama.ro' });
    const res = await hostClient.post(`${API()}/meetings`, { json: { title: 'Intern', user_ids: [invited.id] } });
    const meeting = res.data.meeting;
    const i = client(app.base);
    await i.login('invitat@gama.ro');
    const iws = socket(app.base, `/ws/meeting?id=${meeting.id}`, i);
    await iws.opened;
    iws.send('join', {});
    await iws.next('joined');
    const c = client(app.base);
    await c.login('curios@gama.ro');
    const cws = socket(app.base, `/ws/meeting?id=${meeting.id}`, c);
    await cws.opened;
    cws.send('join', {});
    await cws.next('lobby');
    iws.close();
    cws.close();
  });

  test('call from a conversation posts a meeting card', async () => {
    const other = await app.user(org, { email: 'coleg@gama.ro' });
    const dm = (await hostClient.post(`${API()}/dms`, { json: { user_id: other.id } })).data.conversation;
    const { meeting } = (await hostClient.post(`${API()}/meetings`, { json: { conversation_id: dm.id } })).data;
    const msgs = (await hostClient.get(`${API()}/conversations/${dm.id}/messages`)).data.messages;
    assert.equal(msgs.at(-1).kind, 'meeting');
    assert.equal(msgs.at(-1).meta.meeting_id, meeting.id);
    // The other DM member enters directly (conversation membership).
    const c = client(app.base);
    await c.login('coleg@gama.ro');
    const ws = socket(app.base, `/ws/meeting?id=${meeting.id}`, c);
    await ws.opened;
    ws.send('join', {});
    await ws.next('joined');
    ws.close();
  });
});

describe('administration', () => {
  let app;
  let org;

  before(async () => {
    app = await startApp();
    org = await app.org('Delta');
    await app.user(org, { email: 'admin@delta.ro', role: 'admin' });
    await app.user(org, { email: 'membru@delta.ro' });
  });
  after(() => app.stop());

  test('admin console requires MFA; members are refused', async () => {
    const m = client(app.base);
    await m.login('membru@delta.ro');
    assert.equal((await m.get(`/o/${org.slug}/admin/members`)).status, 403);

    const a = client(app.base);
    await a.login('admin@delta.ro');
    const gate = await a.get(`/o/${org.slug}/admin/members`);
    assert.equal(gate.status, 303);
    assert.match(gate.location, /^\/account\/mfa/);

    // Enroll TOTP, then the console opens.
    const page = await a.get('/account/mfa');
    const secret = page.text.match(/user-select-all[^>]*>([A-Z2-7 ]+)</)[1].replace(/ /g, '');
    const enabled = await a.post('/account/mfa/enable', { form: { code: totpNow(secret), password: 'Parola12345' } });
    assert.equal(enabled.status, 303);
    assert.equal((await a.get(`/o/${org.slug}/admin/members`)).status, 200);

    // Next sign-in asks for the code before anything else.
    const again = client(app.base);
    const login = await again.post('/login', { form: { email: 'admin@delta.ro', password: 'Parola12345', next: '/' } });
    assert.match(login.location, /^\/login\/mfa/);
    assert.equal((await again.get(`/api/o/${org.slug}/bootstrap`)).status, 401);
    await again.post('/login/mfa', { form: { code: totpNow(secret), next: '/' } });
    assert.equal((await again.get(`/api/o/${org.slug}/bootstrap`)).status, 200);
  });

  test('org invitation creates an account and membership', async () => {
    const admin = await app.services.users.byEmail('admin@delta.ro');
    const inv = await app.services.orgs.invite(org, { email: 'nou@delta.ro', role: 'member' }, { ...admin, orgRole: 'admin' }, '127.0.0.1');
    const c = client(app.base);
    assert.equal((await c.get(`/invite/${inv.token}`)).status, 200);
    const res = await c.post(`/invite/${inv.token}`, { form: { name: 'Nou Venit', password: 'ParolaNoua123' } });
    assert.equal(res.status, 303);
    assert.equal(res.location, `/o/${org.slug}`);
    assert.equal((await c.get(`/api/o/${org.slug}/bootstrap`)).status, 200);
    assert.equal((await c.get(`/invite/${inv.token}`)).status, 404, 'single use');
  });

  test('sign-in throttling', async () => {
    const c = client(app.base);
    for (let i = 0; i < 8; i++) await c.post('/login', { form: { email: 'membru@delta.ro', password: 'gresit' } });
    const res = await c.post('/login', { form: { email: 'membru@delta.ro', password: 'Parola12345' } });
    assert.equal(res.status, 429);
  });
});
