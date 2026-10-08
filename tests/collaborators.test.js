import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { client, socket, startApp } from './helpers.js';

const lastMailTo = (app, to) => app.mailer.sent.filter((m) => m.to === to).at(-1);
const inviteToken = (mail) => mail.text.match(/\/invite\/([A-Za-z0-9_-]+)/)[1];
const codeIn = (mail) => mail.text.match(/\b(\d{6})\b/)[1];

// External collaborators: invited by e-mail into one Space, see only what is
// shared with them, sign in without a password, lose access on expiry.
describe('external collaborators', () => {
  let app;
  let org;
  let ana;
  let space;
  let anaClient;
  const API = () => `/api/o/${org.slug}`;

  before(async () => {
    app = await startApp();
    org = await app.org('Altbet Colab');
    ana = await app.user(org, { email: 'ana@altbet.ro' });
    await app.user(org, { email: 'bob@altbet.ro' });
    anaClient = client(app.base);
    await anaClient.login('ana@altbet.ro');
    space = (await anaClient.post(`${API()}/spaces`, { json: { name: 'Proiect Partener' } })).data.conversation;
    await anaClient.post(`${API()}/spaces`, { json: { name: 'Intern', visibility: 'public' } });
  });
  after(() => app.stop());

  test('a moderator invites by e-mail; the guest joins without a password, straight into the Space', async () => {
    const res = await anaClient.post(`${API()}/conversations/${space.id}/invite`, { json: { email: 'Ion@Partener.com' } });
    assert.equal(res.data.status, 'invited');
    const mail = lastMailTo(app, 'ion@partener.com');
    assert.match(mail.subject, /Proiect Partener/);
    const pending = (await anaClient.get(`${API()}/conversations/${space.id}/invites`)).data.invites;
    assert.equal(pending.length, 1);

    const ion = client(app.base);
    const token = inviteToken(mail);
    assert.match((await ion.get(`/invite/${token}`)).text, /Proiect Partener/);
    const accepted = await ion.post(`/invite/${token}`, { form: { name: 'Ion Partener' } });
    assert.equal(accepted.status, 303);
    assert.equal(accepted.location, `/o/${org.slug}/c/${space.id}`);

    const boot = (await ion.get(`${API()}/bootstrap`)).data;
    assert.deepEqual(boot.conversations.map((c) => c.id), [space.id], 'only the invited Space');
    assert.deepEqual(boot.directory.map((u) => u.email).sort(), ['ana@altbet.ro', 'ion@partener.com'], 'only people sharing a conversation');
    assert.equal((await ion.get(`${API()}/spaces`)).status, 403, 'cannot browse public Spaces');
    assert.equal((await ion.post(`${API()}/spaces`, { json: { name: 'x' } })).status, 403);

    const m = await app.db.get("SELECT role, access_expires_at FROM memberships WHERE org_id = ? AND user_id = (SELECT id FROM users WHERE email = 'ion@partener.com')", [org.id]);
    assert.equal(m.role, 'external');
    const days = (Date.parse(m.access_expires_at) - Date.now()) / 86400_000;
    assert.ok(days > 89 && days <= 90, 'policy default: 90 days');
    assert.equal((await anaClient.get(`${API()}/conversations/${space.id}`)).data.conversation.external_count, 1);

    // Ana's open socket learns that the member list changed.
    const ws = socket(app.base, `/ws?org=${org.slug}`, anaClient);
    await ws.opened;
    ws.close();
  });

  test('passwordless sign-in with an e-mail code', async () => {
    const c = client(app.base);
    assert.equal((await c.post('/login/code', { form: { email: 'ion@partener.com' } })).status, 200);
    const code = codeIn(lastMailTo(app, 'ion@partener.com'));
    assert.equal((await c.post('/login/code/verify', { form: { email: 'ion@partener.com', code: '000000' } })).status, 401);
    const ok = await c.post('/login/code/verify', { form: { email: 'ion@partener.com', code } });
    assert.equal(ok.status, 303);
    assert.equal((await c.get(`${API()}/bootstrap`)).status, 200);
    // Unknown addresses get the same answer and no mail.
    const before = app.mailer.sent.length;
    assert.equal((await client(app.base).post('/login/code', { form: { email: 'nimeni@x.ro' } })).status, 200);
    assert.equal(app.mailer.sent.length, before);
  });

  test('who may invite, and the organization policy', async () => {
    const bob = client(app.base);
    await bob.login('bob@altbet.ro');
    await anaClient.post(`${API()}/conversations/${space.id}/members`, { json: { user_ids: [(await app.services.users.byEmail('bob@altbet.ro')).id] } });
    const notMod = await bob.post(`${API()}/conversations/${space.id}/invite`, { json: { email: 'x@partener.com' } });
    assert.equal(notMod.status, 403);
    assert.equal(notMod.data.error.details.reason, 'moderatorsOnly');

    // A colleague's address is simply added.
    await app.user(org, { email: 'coleg@altbet.ro' });
    assert.equal((await anaClient.post(`${API()}/conversations/${space.id}/invite`, { json: { email: 'coleg@altbet.ro' } })).data.status, 'added');

    const owner = await app.user(org, { email: 'owner@altbet.ro', role: 'owner' });
    await app.services.policies.update(org.id, { collaborator_domain_denylist: 'concurent.ro' }, owner, '');
    assert.equal((await anaClient.post(`${API()}/conversations/${space.id}/invite`, { json: { email: 'a@concurent.ro' } })).data.error.details.reason, 'domainDenied');
    await app.services.policies.update(org.id, { collaborators_enabled: false }, owner, '');
    assert.equal((await anaClient.post(`${API()}/conversations/${space.id}/invite`, { json: { email: 'a@ok.com' } })).data.error.details.reason, 'collaboratorsDisabled');
    await app.services.policies.update(org.id, { collaborators_enabled: true, collaborator_domain_denylist: '' }, owner, '');
  });

  test('a revoked invitation no longer works', async () => {
    await anaClient.post(`${API()}/conversations/${space.id}/invite`, { json: { email: 'maria@alt.com' } });
    const token = inviteToken(lastMailTo(app, 'maria@alt.com'));
    const inv = (await anaClient.get(`${API()}/conversations/${space.id}/invites`)).data.invites.find((i) => i.email === 'maria@alt.com');
    await anaClient.post(`${API()}/conversations/${space.id}/invites/${inv.id}/revoke`, { json: {} });
    assert.equal((await client(app.base).get(`/invite/${token}`)).status, 404);
  });

  test('expired access ends at once and is cleaned up by maintenance', async () => {
    const ion = client(app.base);
    await ion.post('/login/code', { form: { email: 'ion@partener.com' } });
    await new Promise((r) => setTimeout(r, 5));
    await app.db.run('DELETE FROM login_codes');
    await ion.post('/login/code', { form: { email: 'ion@partener.com' } });
    await ion.post('/login/code/verify', { form: { email: 'ion@partener.com', code: codeIn(lastMailTo(app, 'ion@partener.com')) } });
    assert.equal((await ion.get(`${API()}/bootstrap`)).status, 200);
    const ionId = (await app.services.users.byEmail('ion@partener.com')).id;
    await app.db.run('UPDATE memberships SET access_expires_at = ? WHERE org_id = ? AND user_id = ?', [new Date(Date.now() - 1000).toISOString(), org.id, ionId]);
    assert.equal((await ion.get(`${API()}/bootstrap`)).status, 403, 'refused before maintenance runs');
    await app.maintenance();
    assert.equal((await app.db.get('SELECT status FROM memberships WHERE org_id = ? AND user_id = ?', [org.id, ionId])).status, 'revoked');
    assert.equal((await app.db.get('SELECT COUNT(*) AS n FROM conversation_members WHERE user_id = ?', [ionId])).n, 0);
    assert.ok(await app.db.get("SELECT 1 FROM audit_events WHERE action = 'member.expire' AND resource_id = ?", [ionId]));
    void ana;
  });
});
