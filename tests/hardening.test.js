import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { newId, nowIso } from '../core/util.js';
import { client, socket, startApp } from './helpers.js';

const lastMailTo = (app, to) => app.mailer.sent.filter((m) => m.to === to).at(-1);
const inviteToken = (mail) => mail.text.match(/\/invite\/([A-Za-z0-9_-]+)/)[1];
const codeIn = (mail) => mail.text.match(/\b(\d{6})\b/)[1];
const past = () => new Date(Date.now() - 1000).toISOString();

// Second review: collaborator policies on every path, roles kept on
// invitation acceptance, complete revocation on expiry, sign-in limits,
// atomic token use, upload bookkeeping, backups of the right things.
describe('collaborators: roles, policies, expiry', () => {
  let app;
  let org;
  let ana; // member, moderator of `shared`
  let anaClient;
  let bobClient; // plain member
  let shared;
  let open; // public Space Bob is in, not a moderator
  let owner;
  const API = () => `/api/o/${org.slug}`;
  const membershipOf = (email) =>
    app.db.get('SELECT m.* FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? AND u.email = ?', [org.id, email]);

  // An external collaborator of `shared`, signed in.
  async function collaborator(email) {
    await anaClient.post(`${API()}/conversations/${shared.id}/invite`, { json: { email } });
    const c = client(app.base);
    assert.equal((await c.post(`/invite/${inviteToken(lastMailTo(app, email))}`, { form: { name: email } })).status, 303);
    return { c, user: await app.services.users.byEmail(email) };
  }

  before(async () => {
    app = await startApp();
    org = await app.org('Hardening');
    owner = await app.user(org, { email: 'owner@h.ro', role: 'owner' });
    ana = await app.user(org, { email: 'ana@h.ro' });
    await app.user(org, { email: 'bob@h.ro' });
    anaClient = client(app.base);
    await anaClient.login('ana@h.ro');
    bobClient = client(app.base);
    await bobClient.login('bob@h.ro');
    shared = (await anaClient.post(`${API()}/spaces`, { json: { name: 'Shared' } })).data.conversation;
    open = (await anaClient.post(`${API()}/spaces`, { json: { name: 'Open', visibility: 'public' } })).data.conversation;
    await bobClient.post(`${API()}/spaces/${open.id}/join`, { json: {} });
  });
  after(() => app.stop());

  test('an existing collaborator is subject to the policy on every path that adds them', async () => {
    const { user: ion } = await collaborator('ion@partner.com');
    await app.services.policies.update(org.id, { collaborators_enabled: false }, owner, '');
    const viaInvite = await bobClient.post(`${API()}/conversations/${open.id}/invite`, { json: { email: 'ion@partner.com' } });
    assert.equal(viaInvite.status, 403);
    assert.equal(viaInvite.data.error.details.reason, 'collaboratorsDisabled');
    const viaMembers = await bobClient.post(`${API()}/conversations/${open.id}/members`, { json: { user_ids: [ion.id] } });
    assert.equal(viaMembers.status, 403);
    const viaCreate = await bobClient.post(`${API()}/spaces`, { json: { name: 'Side door', user_ids: [ion.id] } });
    assert.equal(viaCreate.status, 403);

    await app.services.policies.update(org.id, { collaborators_enabled: true, collaborator_invite_roles: 'admins' }, owner, '');
    assert.equal((await bobClient.post(`${API()}/conversations/${open.id}/invite`, { json: { email: 'ion@partner.com' } })).data.error.details.reason, 'adminsOnly');
    await app.services.policies.update(org.id, { collaborator_invite_roles: 'moderators', collaborator_domain_denylist: 'partner.com' }, owner, '');
    assert.equal((await anaClient.post(`${API()}/conversations/${open.id}/members`, { json: { user_ids: [ion.id] } })).data.error.details.reason, 'domainDenied');
    assert.equal((await app.db.get('SELECT COUNT(*) AS n FROM conversation_members WHERE conversation_id = ? AND user_id = ?', [open.id, ion.id])).n, 0);

    // Colleagues are not collaborators: still simply added.
    await app.services.policies.update(org.id, { collaborators_enabled: false, collaborator_domain_denylist: '' }, owner, '');
    await app.user(org, { email: 'coleg@h.ro' });
    assert.equal((await bobClient.post(`${API()}/conversations/${open.id}/invite`, { json: { email: 'coleg@h.ro' } })).data.status, 'added');
    await app.services.policies.update(org.id, { collaborators_enabled: true }, owner, '');
  });

  test('accepting an older Space invitation keeps the owner role', async () => {
    await anaClient.post(`${API()}/conversations/${shared.id}/invite`, { json: { email: 'nou@x.com' } });
    const spaceToken = inviteToken(lastMailTo(app, 'nou@x.com'));
    const ownerInvite = await app.services.orgs.invite(org, { email: 'nou@x.com', role: 'owner' }, { id: owner.id, email: owner.email, orgRole: 'owner' }, '');
    const nou = client(app.base);
    assert.equal((await nou.post(`/invite/${ownerInvite.token}`, { form: { name: 'Nou', password: 'Parola12345' } })).status, 303);
    // The new owner becomes the only one.
    await app.db.run("UPDATE memberships SET role = 'admin' WHERE org_id = ? AND user_id = ?", [org.id, owner.id]);
    assert.equal((await nou.post(`/invite/${spaceToken}`, { form: {} })).status, 303);
    const m = await membershipOf('nou@x.com');
    assert.equal(m.role, 'owner');
    assert.equal(m.access_expires_at, null);
    assert.ok(await app.db.get('SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?', [shared.id, m.user_id]), 'joined the Space');
    await app.db.run("UPDATE memberships SET role = 'owner' WHERE org_id = ? AND user_id = ?", [org.id, owner.id]);
  });

  test('a collaborator promoted to owner loses the expiry and is never revoked by it', async () => {
    const { user } = await collaborator('promo@partner.com');
    assert.ok((await membershipOf('promo@partner.com')).access_expires_at);
    await app.services.orgs.setRole(org, user.id, 'owner', owner, '');
    assert.equal((await membershipOf('promo@partner.com')).access_expires_at, null);
    await app.maintenance();
    assert.equal((await membershipOf('promo@partner.com')).status, 'active');
  });

  test('expiry: the open socket gets nothing more, meeting admissions end, a re-invitation starts clean', async () => {
    const { c, user } = await collaborator('exp@partner.com');
    const ws = socket(app.base, `/ws?org=${org.slug}`, c);
    await ws.opened;
    await ws.next('hello');
    await app.db.run('UPDATE memberships SET access_expires_at = ? WHERE org_id = ? AND user_id = ?', [past(), org.id, user.id]);
    const anaWs = socket(app.base, `/ws?org=${org.slug}`, anaClient);
    await anaWs.opened;
    await anaClient.post(`${API()}/conversations/${shared.id}/messages`, { json: { client_message_id: newId(), body: 'după expirare' } });
    await anaWs.next('message.created');
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(!ws.frames.some((f) => f.type === 'message.created'), 'no message delivered after expiry');
    // Any frame from it is refused and closes the socket.
    ws.send('presence.set', { status: 'away' });
    assert.equal((await ws.closed).code, 4001);
    anaWs.ws.close();

    // An admission from before the expiry, then a new invitation to another
    // Space before maintenance ran: the old admission does not survive.
    const meetingRes = await anaClient.post(`${API()}/meetings`, { json: { title: 'Call', user_ids: [] } });
    const meetingId = meetingRes.data.meeting.id;
    await app.db.run("INSERT INTO meeting_participants (id, meeting_id, user_id, display_name, role, state, created_at) VALUES (?, ?, ?, 'Exp', 'participant', 'admitted', ?)", [newId(), meetingId, user.id, nowIso()]);
    const other = (await anaClient.post(`${API()}/spaces`, { json: { name: 'Other' } })).data.conversation;
    await anaClient.post(`${API()}/conversations/${other.id}/invite`, { json: { email: 'exp@partner.com' } });
    assert.equal((await c.post(`/invite/${inviteToken(lastMailTo(app, 'exp@partner.com'))}`, { form: {} })).status, 303);
    assert.equal((await app.db.get('SELECT state FROM meeting_participants WHERE meeting_id = ? AND user_id = ?', [meetingId, user.id])).state, 'removed');
    const spaces = (await app.db.all('SELECT conversation_id FROM conversation_members WHERE user_id = ?', [user.id])).map((r) => r.conversation_id);
    assert.deepEqual(spaces, [other.id], 'only the new Space');
    assert.equal((await membershipOf('exp@partner.com')).role, 'external');
  });

  test('maintenance revokes like a manual removal, and an extension made meanwhile wins', async () => {
    const { user } = await collaborator('race@partner.com');
    const meetingId = (await anaClient.post(`${API()}/meetings`, { json: { title: 'Call 2', user_ids: [] } })).data.meeting.id;
    await app.db.run("INSERT INTO meeting_participants (id, meeting_id, user_id, display_name, role, state, created_at) VALUES (?, ?, ?, 'R', 'participant', 'admitted', ?)", [newId(), meetingId, user.id, nowIso()]);
    await app.db.run('UPDATE memberships SET access_expires_at = ? WHERE org_id = ? AND user_id = ?', [past(), org.id, user.id]);

    // The sweep reads its list, then the admin extends before it writes.
    const realAll = app.db.all;
    app.db.all = async (sql, params) => {
      const rows = await realAll(sql, params);
      if (/access_expires_at <= \?/.test(sql)) {
        app.db.all = realAll;
        await app.services.orgs.setAccessExpiry(org, user.id, 90, owner, '');
      }
      return rows;
    };
    try {
      assert.deepEqual(await app.services.orgs.expireCollaborators(), []);
    } finally {
      app.db.all = realAll;
    }
    const m = await membershipOf('race@partner.com');
    assert.equal(m.status, 'active');
    assert.ok(m.access_expires_at > nowIso());
    assert.equal((await app.db.get('SELECT COUNT(*) AS n FROM conversation_members WHERE user_id = ?', [user.id])).n, 1, 'still in the Space');

    // A real expiry: everything a manual removal does.
    await app.db.run('UPDATE memberships SET access_expires_at = ? WHERE org_id = ? AND user_id = ?', [past(), org.id, user.id]);
    await app.maintenance();
    assert.equal((await membershipOf('race@partner.com')).status, 'revoked');
    assert.equal((await app.db.get('SELECT COUNT(*) AS n FROM conversation_members WHERE user_id = ?', [user.id])).n, 0);
    assert.equal((await app.db.get('SELECT state FROM meeting_participants WHERE meeting_id = ? AND user_id = ?', [meetingId, user.id])).state, 'removed');
    void ana;
  });
  test('an expired collaborator gets no mention e-mails before maintenance', async () => {
    const { user } = await collaborator('mail@partner.com');
    await app.db.run('UPDATE memberships SET access_expires_at = ? WHERE org_id = ? AND user_id = ?', [past(), org.id, user.id]);
    const before = app.mailer.sent.filter((m) => m.to === 'mail@partner.com').length;
    await anaClient.post(`${API()}/conversations/${shared.id}/messages`, { json: { client_message_id: newId(), body: `<@${user.id}> secret plan` } });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(app.mailer.sent.filter((m) => m.to === 'mail@partner.com').length, before);
  });
});

describe('sign-in hardening', () => {
  let app;
  let org;

  before(async () => {
    app = await startApp();
    org = await app.org('Auth');
    await app.user(org, { email: 'ana@a.ro' });
    // Passwordless account (as created by an invitation without a password).
    await app.services.users.create({ email: 'fara@a.ro', name: 'Fara', passwordHash: null });
  });
  after(() => app.stop());

  test('code verification: limited per IP, malformed addresses store nothing', async () => {
    const c = client(app.base);
    const huge = `${'a'.repeat(100_000)}@x.ro`;
    assert.equal((await c.post('/login/code/verify', { form: { email: huge, code: '123456' } })).status, 401);
    assert.equal((await app.db.get('SELECT MAX(LENGTH(key)) AS n FROM auth_failures')).n < 300, true);
    let limited = 0;
    for (let i = 0; i < 35; i++) if ((await c.post('/login/code/verify', { form: { email: `x${i}@y.ro`, code: '123456' } })).status === 429) limited++;
    assert.ok(limited >= 5, `per-IP limit applies (${limited} refused)`);
  });

  test('requesting codes says the same for existing and unknown addresses, even when repeated', async () => {
    const text = async (email) => (await client(app.base).post('/login/code', { form: { email } })).text.replaceAll(email, 'E');
    await text('ana@a.ro');
    await text('nimeni@a.ro');
    assert.equal(await text('ana@a.ro'), await text('nimeni@a.ro'));
  });

  test('codes: issuing and attempts are limited under concurrency', async () => {
    const { loginCodes } = app.services;
    const user = await app.services.users.byEmail('ana@a.ro');
    await app.db.run('DELETE FROM login_codes');
    const issued = await Promise.allSettled(Array.from({ length: 10 }, () => loginCodes.issue(user.id)));
    assert.equal(issued.filter((r) => r.status === 'fulfilled').length, 1);
    const results = await Promise.all(Array.from({ length: 12 }, () => loginCodes.verify(user.id, 'x')));
    assert.ok(results.filter((r) => r === 'invalid').length <= 5, 'at most 5 guesses are checked');
    assert.ok(results.filter((r) => r === 'locked').length >= 7);
    assert.equal((await app.db.get('SELECT attempts FROM login_codes WHERE user_id = ?', [user.id])).attempts, 5);
    // Maintenance drops old codes.
    await app.db.run('UPDATE login_codes SET created_at = ?', [new Date(Date.now() - 3 * 3600_000).toISOString()]);
    await app.maintenance();
    assert.equal((await app.db.get('SELECT COUNT(*) AS n FROM login_codes')).n, 0);
  });

  test('a reset token changes the password once, even with concurrent requests', async () => {
    await client(app.base).post('/forgot', { form: { email: 'ana@a.ro' } });
    const token = lastMailTo(app, 'ana@a.ro').text.match(/\/reset\/([A-Za-z0-9_-]+)/)[1];
    const [a, b] = await Promise.all(['Prima-parola-1', 'A-doua-parola-2'].map((password) => client(app.base).post(`/reset/${token}`, { form: { password } })));
    assert.deepEqual([a.status, b.status].sort(), [303, 410]);
    const winner = a.status === 303 ? 'Prima-parola-1' : 'A-doua-parola-2';
    await client(app.base).login('ana@a.ro', winner);
  });

  test('a passwordless account sets its first password only with a code from its e-mail', async () => {
    await app.db.run('DELETE FROM auth_failures');
    const c = client(app.base);
    await c.post('/login/code', { form: { email: 'fara@a.ro' } });
    assert.equal((await c.post('/login/code/verify', { form: { email: 'fara@a.ro', code: codeIn(lastMailTo(app, 'fara@a.ro')) } })).status, 303);
    assert.equal((await c.post('/account/password', { form: { password: 'Parola-atacator' } })).status, 400, 'the session alone is not enough');
    assert.equal((await app.services.users.credentials((await app.services.users.byEmail('fara@a.ro')).id)).password_hash, null);
    // MFA cannot be enabled without a password either.
    assert.equal((await c.post('/account/mfa/enable', { form: { password: '', code: '000000' } })).status, 400);

    await app.db.run('DELETE FROM login_codes');
    const sent = await c.post('/account/password/code', { form: {} });
    assert.equal(sent.status, 200);
    const res = await c.post('/account/password', { form: { code: codeIn(lastMailTo(app, 'fara@a.ro')), password: 'Parola-proprie-1' } });
    assert.equal(res.status, 303);
    await client(app.base).login('fara@a.ro', 'Parola-proprie-1');
  });

  test('origin check compares the scheme too', async () => {
    const c = client(app.base);
    const res = await c.post('/login', { form: { email: 'ana@a.ro', password: 'x' }, headers: { Origin: app.base.replace('http:', 'https:') } });
    assert.equal(res.status, 403);
  });
  test('password guesses: the limit holds under concurrency and on the change form', async () => {
    await app.db.run('DELETE FROM auth_failures');
    await app.user(org, { email: 'brute@a.ro' });
    const statuses = await Promise.all(Array.from({ length: 12 }, () => client(app.base).post('/login', { form: { email: 'brute@a.ro', password: 'gresita-123' } })));
    assert.equal(statuses.filter((r) => r.status === 401).length, 8, 'exactly 8 checked');
    assert.equal(statuses.filter((r) => r.status === 429).length, 4);

    await app.db.run('DELETE FROM auth_failures');
    const c = client(app.base);
    await c.login('brute@a.ro');
    const codes = [];
    for (let i = 0; i < 7; i++) codes.push((await c.post('/account/password', { form: { current: `gresita-${i}`, password: 'Parola-noua-123' } })).status);
    assert.deepEqual(codes, [400, 400, 400, 400, 400, 429, 429]);
  });

  test('a password change authorized before a reset cannot overwrite it', async () => {
    await app.db.run('DELETE FROM auth_failures');
    await app.user(org, { email: 'race@a.ro' });
    const c = client(app.base);
    await c.login('race@a.ro');
    const { auth } = app.services;
    const realHash = auth.hashPassword;
    let resume;
    const paused = new Promise((r) => (resume = r));
    let started;
    const hashing = new Promise((r) => (started = r));
    auth.hashPassword = async (pw) => {
      if (pw === 'Parola-veche-schimbata') {
        started();
        await paused;
      }
      return realHash(pw);
    };
    try {
      const change = c.post('/account/password', { form: { current: 'Parola12345', password: 'Parola-veche-schimbata' } });
      await hashing;
      // Meanwhile the owner resets the password by e-mail.
      await client(app.base).post('/forgot', { form: { email: 'race@a.ro' } });
      const token = lastMailTo(app, 'race@a.ro').text.match(/\/reset\/([A-Za-z0-9_-]+)/)[1];
      assert.equal((await client(app.base).post(`/reset/${token}`, { form: { password: 'Parola-din-reset' } })).status, 303);
      resume();
      assert.equal((await change).status, 409);
    } finally {
      auth.hashPassword = realHash;
    }
    await client(app.base).login('race@a.ro', 'Parola-din-reset');
  });

  test('code verification answers the same for an account without a code and an unknown address', async () => {
    await app.db.run('DELETE FROM auth_failures');
    await app.db.run('DELETE FROM login_codes');
    const text = async (email) => {
      const res = await client(app.base).post('/login/code/verify', { form: { email, code: '123456' } });
      return `${res.status} ${res.text.replaceAll(email, 'E')}`;
    };
    assert.equal(await text('ana@a.ro'), await text('nimeni@a.ro'));
  });
});

describe('uploads', () => {
  let app;
  let org;
  let c;

  before(async () => {
    app = await startApp();
    org = await app.org('Files');
    await app.user(org, { email: 'ana@f.ro' });
    c = client(app.base);
    await c.login('ana@f.ro');
  });
  after(() => app.stop());

  test('a database error while registering an upload leaves no unaccounted bytes', async () => {
    const realBatch = app.db.batch;
    app.db.batch = async (statements) => {
      if (/INSERT INTO attachments/.test(statements[0][0])) throw new Error('simulated DB failure');
      return realBatch(statements);
    };
    try {
      const res = await c.post(`/api/o/${org.slug}/files`, { body: 'hello', headers: { 'X-File-Name': 'a.txt', 'Content-Type': 'application/octet-stream' } });
      assert.equal(res.status, 500);
    } finally {
      app.db.batch = realBatch;
    }
    const dir = path.join(app.config.filesDir, org.id);
    const stored = readdirSync(dir).filter((f) => !f.startsWith('.'));
    assert.deepEqual(stored, []);
    assert.deepEqual(readdirSync(path.join(app.config.filesDir, '.tmp')), []);

    // A normal upload still works.
    const ok = await c.post(`/api/o/${org.slug}/files`, { body: 'hello', headers: { 'X-File-Name': 'a.txt', 'Content-Type': 'application/octet-stream' } });
    assert.equal(ok.status, 200);
    assert.deepEqual(readdirSync(dir), [ok.data.file.id]);
  });
});
