import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { totpNow } from '../core/totp.js';
import { nowIso } from '../core/util.js';
import { client, sleep, socket, startApp } from './helpers.js';

// Regression tests for the security review of 2026-10-08: each test is one
// reported scenario.
describe('review fixes', () => {
  let app;
  let org;
  let ownerA;
  let ana;
  let bob;
  const API = () => `/api/o/${org.slug}`;
  const login = async (email) => {
    const c = client(app.base);
    await c.login(email);
    return c;
  };

  before(async () => {
    app = await startApp();
    org = await app.org('Review SRL');
    ownerA = await app.user(org, { email: 'owner@rev.ro', role: 'owner' });
    ana = await app.user(org, { email: 'ana@rev.ro' });
    bob = await app.user(org, { email: 'bob@rev.ro' });
  });
  after(() => app.stop());

  test('logout and "sign out other sessions" close open chat sockets', async () => {
    const a1 = await login('ana@rev.ro');
    const a2 = await login('ana@rev.ro');
    const space = (await a1.post(`${API()}/spaces`, { json: { name: 'Sesiuni' } })).data.conversation;
    const w1 = socket(app.base, `/ws?org=${org.slug}`, a1);
    const w2 = socket(app.base, `/ws?org=${org.slug}`, a2);
    await Promise.all([w1.opened, w2.opened]);

    await a2.post('/account/sessions/revoke', { form: {} });
    assert.equal((await w1.closed).code, 4001, 'other session socket closed');

    await a2.post('/logout', { form: {} });
    assert.equal((await w2.closed).code, 4001, 'own socket closed at logout');
    const count = (await app.db.get('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?', [space.id])).n;
    assert.equal(count, 0);
  });

  test('a socket whose session row disappears cannot send', async () => {
    const a = await login('ana@rev.ro');
    const space = (await a.post(`${API()}/spaces`, { json: { name: 'Expirat' } })).data.conversation;
    const ws = socket(app.base, `/ws?org=${org.slug}`, a);
    await ws.opened;
    // Simulates expiry / removal done elsewhere (no revocation hook fired).
    await app.db.run("DELETE FROM sessions WHERE user_id = ?", [ana.id]);
    ws.send('message.send', { conversation_id: space.id, client_message_id: 'expired-000001', body: 'x' });
    assert.equal((await ws.closed).code, 4001);
    assert.equal((await app.db.get('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?', [space.id])).n, 0);
  });

  test('meetings: a demoted admin cannot end; a suspended org gets no new joins', async () => {
    const admin = await app.user(org, { email: 'admin@rev.ro', role: 'admin' });
    const host = await login('owner@rev.ro');
    const { meeting } = (await host.post(`${API()}/meetings`, { json: { title: 'Rol', user_ids: [admin.id] } })).data;
    const ad = await login('admin@rev.ro');
    const ws = socket(app.base, `/ws/meeting?id=${meeting.id}`, ad);
    await ws.opened;
    ws.send('join', {});
    assert.equal((await ws.next('joined')).data.can_manage, true);

    await app.services.orgs.setRole(org, admin.id, 'member', ownerA, '127.0.0.1');
    ws.send('end');
    assert.equal((await ws.next('error')).data.code, 'forbidden');
    assert.equal((await app.services.meetings.byId(meeting.id)).state !== 'ended', true);
    ws.close();

    const org2 = await app.org('Suspendat');
    await app.user(org2, { email: 'owner@rev.ro', role: 'owner' });
    const { meeting: m2 } = (await host.post(`/api/o/${org2.slug}/meetings`, { json: { title: 'S' } })).data;
    await app.services.orgs.setStatus(org2.id, 'suspended', ownerA, '127.0.0.1');
    await assert.rejects(socket(app.base, `/ws/meeting?id=${m2.id}`, host).opened, /401/);
  });

  test('MFA: needs the password, cannot replace an active factor, ignores plain cookies', async () => {
    const u = await app.user(org, { email: 'mfa@rev.ro' });
    const c = await login('mfa@rev.ro');
    const page = await c.get('/account/mfa');
    const secret = page.text.match(/user-select-all[^>]*>([A-Z2-7 ]+)</)[1].replace(/ /g, '');
    assert.equal((await c.post('/account/mfa/enable', { form: { code: totpNow(secret), password: 'gresita' } })).status, 400);
    // A crafted, unencrypted cookie with an attacker-chosen secret is refused.
    c.jar.set('mfa_setup', encodeURIComponent(`${u.id}:JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP`));
    assert.equal((await c.post('/account/mfa/enable', { form: { code: totpNow('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'), password: 'Parola12345' } })).status, 400);
    await c.get('/account/mfa');
    const page2 = await c.get('/account/mfa');
    const secret2 = page2.text.match(/user-select-all[^>]*>([A-Z2-7 ]+)</)[1].replace(/ /g, '');
    assert.equal((await c.post('/account/mfa/enable', { form: { code: totpNow(secret2), password: 'Parola12345' } })).status, 303);
    // With MFA on, enabling again (a new secret) is refused.
    const again = await c.post('/account/mfa/enable', { form: { code: totpNow(secret2), password: 'Parola12345' } });
    assert.equal(again.status, 409);
  });

  test('edit: a rejected concurrent edit leaves no mentions behind', async () => {
    const a = await login('ana@rev.ro');
    const space = (await a.post(`${API()}/spaces`, { json: { name: 'Mentiuni', user_ids: [bob.id, ownerA.id] } })).data.conversation;
    const m = (await a.post(`${API()}/conversations/${space.id}/messages`, { json: { client_message_id: 'edit-race-001', body: 'salut' } })).data.message;
    const edit = (who) => a.post(`${API()}/conversations/${space.id}/messages/${m.id}/edit`, { json: { body: `pentru <@${who}>`, version: m.version } });
    const results = await Promise.all([edit(bob.id), edit(ownerA.id)]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    const stored = await app.db.get('SELECT body FROM messages WHERE id = ?', [m.id]);
    const mentions = (await app.db.all('SELECT user_id FROM message_mentions WHERE message_id = ?', [m.id])).map((r) => r.user_id);
    assert.equal(mentions.length, 1);
    assert.ok(stored.body.includes(`<@${mentions[0]}>`), 'mention matches the stored text');
  });

  test('storage quota holds without Content-Length and for concurrent uploads', async () => {
    await app.db.run('UPDATE organizations SET storage_quota_mb = 1 WHERE id = ?', [org.id]);
    const fresh = (await app.services.orgs.byId(org.id));
    const used = await app.services.files.storageUsed(org.id);
    const a = await login('ana@rev.ro');
    const chunk = Buffer.alloc(256 * 1024, 120);
    const streamed = () =>
      fetch(`${app.base}${API()}/files`, {
        method: 'POST',
        headers: { Origin: app.base, Cookie: a.cookieHeader(), 'X-File-Name': 'mare.txt' },
        duplex: 'half',
        body: new ReadableStream({
          start(ctrl) {
            for (let i = 0; i < 3; i++) ctrl.enqueue(chunk);
            ctrl.close();
          },
        }),
      }).then((r) => r.status);
    const statuses = await Promise.all([streamed(), streamed(), streamed()]);
    const total = await app.services.files.storageUsed(org.id);
    assert.ok(total <= fresh.storage_quota_mb * 1048576, `stored ${total} bytes over a 1 MB quota (statuses ${statuses})`);
    assert.ok(statuses.includes(403));
    assert.ok(used <= total);
    await app.db.run('UPDATE organizations SET storage_quota_mb = 10240 WHERE id = ?', [org.id]);
    await app.db.run('DELETE FROM attachments WHERE org_id = ? AND message_id IS NULL', [org.id]);
    await app.maintenance();
  });

  test('deleting and retention remove the stored files and event copies', async () => {
    const a = await login('ana@rev.ro');
    const space = (await a.post(`${API()}/spaces`, { json: { name: 'Retentie' } })).data.conversation;
    const up = async (name) => (await a.post(`${API()}/files`, { body: 'date', headers: { 'X-File-Name': name } })).data.file;
    const f1 = await up('sters.txt');
    const f2 = await up('vechi.txt');
    const m1 = (await a.post(`${API()}/conversations/${space.id}/messages`, { json: { client_message_id: 'ret-del-0001', body: 'secret șters', attachment_ids: [f1.id] } })).data.message;
    const m2 = (await a.post(`${API()}/conversations/${space.id}/messages`, { json: { client_message_id: 'ret-old-0001', body: 'secret vechi', attachment_ids: [f2.id] } })).data.message;
    const fileOf = async (id) => path.join(app.config.filesDir, (await app.db.get('SELECT storage_key FROM attachments WHERE id = ?', [id])).storage_key);
    const p1 = await fileOf(f1.id);
    const p2 = await fileOf(f2.id);

    await a.post(`${API()}/conversations/${space.id}/messages/${m1.id}/delete`, { json: {} });
    const copies = await app.db.all("SELECT data FROM events WHERE json_extract(data, '$.id') = ?", [m1.id]);
    assert.ok(copies.every((e) => !e.data.includes('secret șters')), 'event copies scrubbed');

    await app.services.policies.update(org.id, { message_retention_days: 1 }, ownerA, '127.0.0.1');
    await app.db.run('UPDATE messages SET created_at = ? WHERE id = ?', [new Date(Date.now() - 3 * 86400_000).toISOString(), m2.id]);
    await app.maintenance();
    assert.equal(existsSync(p1), false, 'deleted message file removed');
    assert.equal(existsSync(p2), false, 'retention file removed');
    assert.equal((await app.db.get('SELECT COUNT(*) AS n FROM file_deletions')).n, 0);
    assert.equal((await app.db.get("SELECT COUNT(*) AS n FROM events WHERE json_extract(data, '$.id') = ?", [m2.id])).n, 0, 'no event copy outlives retention');
    await app.services.policies.update(org.id, { message_retention_days: 0 }, ownerA, '127.0.0.1');
  });

  test('a failed event delivery is retried before the cursor moves on', async () => {
    const a = await login('ana@rev.ro');
    const b = await login('bob@rev.ro');
    const space = (await a.post(`${API()}/spaces`, { json: { name: 'Livrare', user_ids: [bob.id] } })).data.conversation;
    const wb = socket(app.base, `/ws?org=${org.slug}`, b);
    await wb.opened;
    const chat = app.services.chat;
    const original = chat.memberIds;
    let failures = 2;
    chat.memberIds = async (...args) => {
      if (failures-- > 0) throw new Error('db hiccup');
      return original(...args);
    };
    await a.post(`${API()}/conversations/${space.id}/messages`, { json: { client_message_id: 'deliver-0001', body: 'unu' } });
    await a.post(`${API()}/conversations/${space.id}/messages`, { json: { client_message_id: 'deliver-0002', body: 'doi' } });
    const first = await wb.next('message.created', 5000);
    const second = await wb.next('message.created', 5000);
    chat.memberIds = original;
    assert.deepEqual([first.data.body, second.data.body], ['unu', 'doi'], 'in order, none lost');
    wb.close();
  });

  test('owner and member-limit rules hold under concurrency', async () => {
    const o2 = await app.org('Doi Proprietari');
    const p1 = await app.user(o2, { email: 'p1@rev.ro', role: 'owner' });
    const p2 = await app.user(o2, { email: 'p2@rev.ro', role: 'owner' });
    await Promise.allSettled([app.services.orgs.setRole(o2, p1.id, 'member', p2, ''), app.services.orgs.setRole(o2, p2.id, 'member', p1, '')]);
    const owners = (await app.db.get("SELECT COUNT(*) AS n FROM memberships WHERE org_id = ? AND role = 'owner' AND status = 'active'", [o2.id])).n;
    assert.equal(owners, 1);

    await app.db.run('UPDATE organizations SET max_members = 2 WHERE id = ?', [o2.id]);
    await app.db.run("UPDATE memberships SET status = 'revoked' WHERE org_id = ? AND role = 'member'", [o2.id]);
    const owner = (await app.db.get("SELECT user_id FROM memberships WHERE org_id = ? AND role = 'owner'", [o2.id])).user_id;
    const inviter = { id: owner, email: 'x', orgRole: 'owner' };
    const fresh = await app.services.orgs.byId(o2.id);
    const invites = [];
    for (const n of [1, 2, 3]) invites.push(await app.services.orgs.invite(fresh, { email: `nou${n}@rev.ro` }, inviter, ''));
    await Promise.allSettled(invites.map((inv, i) => app.services.orgs.acceptInvite(inv.token, { name: `N${i}`, passwordHash: 'x' })));
    const members = (await app.db.get("SELECT COUNT(*) AS n FROM memberships WHERE org_id = ? AND status = 'active'", [o2.id])).n;
    assert.equal(members, 2, 'limit of two respected');
  });

  test('conversation metadata is scoped to the organization in the URL', async () => {
    const other = await app.org('Alta');
    await app.user(other, { email: 'ana@rev.ro' });
    const a = await login('ana@rev.ro');
    const space = (await a.post(`${API()}/spaces`, { json: { name: 'Doar in Review' } })).data.conversation;
    assert.equal((await a.get(`${API()}/conversations/${space.id}`)).status, 200);
    assert.equal((await a.get(`/api/o/${other.slug}/conversations/${space.id}`)).status, 404);
  });

  test('concurrent sends: one attachment, one message; one retry, one usage count', async () => {
    const a = await login('ana@rev.ro');
    const space = (await a.post(`${API()}/spaces`, { json: { name: 'Concurent' } })).data.conversation;
    const file = (await a.post(`${API()}/files`, { body: 'x', headers: { 'X-File-Name': 'unic.txt' } })).data.file;
    const send = (cid, body, ids) => a.post(`${API()}/conversations/${space.id}/messages`, { json: { client_message_id: cid, body, attachment_ids: ids } });
    const [r1, r2] = await Promise.all([send('att-race-0001', '', [file.id]), send('att-race-0002', '', [file.id])]);
    // The loser is refused either by the pre-check (400) or, when both passed
    // it, by the guard inside the atomic batch (409) — never saved empty.
    const statuses = [r1.status, r2.status].sort();
    assert.equal(statuses[0], 200);
    assert.ok([400, 409].includes(statuses[1]));
    const msgs = await app.db.all('SELECT body, (SELECT COUNT(*) FROM attachments WHERE message_id = messages.id) AS files FROM messages WHERE conversation_id = ?', [space.id]);
    assert.deepEqual(msgs.map((m) => m.files), [1], 'no empty message saved');

    const period = nowIso().slice(0, 7);
    const before = (await app.db.get("SELECT value FROM usage_counters WHERE org_id = ? AND period = ? AND metric = 'messages'", [org.id, period])).value;
    await Promise.all([send('retry-race-01', 'o dată', []), send('retry-race-01', 'o dată', []), send('retry-race-01', 'o dată', [])]);
    const afterCount = (await app.db.get("SELECT value FROM usage_counters WHERE org_id = ? AND period = ? AND metric = 'messages'", [org.id, period])).value;
    assert.equal(afterCount - before, 1);
    await sleep(10);
  });
});

describe('first-run setup', () => {
  let app;
  before(async () => {
    app = await startApp();
  });
  after(() => app.stop());

  test('concurrent setup requests create exactly one operator and one organization', async () => {
    const post = (n) => client(app.base).post('/setup', { form: { org_name: `Org ${n}`, name: `Op ${n}`, email: `op${n}@x.ro`, password: 'Parola12345' } });
    await Promise.all([post(1), post(2), post(3), post(4)]);
    assert.equal((await app.db.get('SELECT COUNT(*) AS n FROM users')).n, 1);
    assert.equal((await app.db.get('SELECT COUNT(*) AS n FROM organizations')).n, 1);
    assert.equal((await app.db.get('SELECT COUNT(*) AS n FROM memberships')).n, 1);
  });

  test('with SETUP_TOKEN, /setup needs the token', async () => {
    const guarded = await startApp({ SETUP_TOKEN: 'tok-123456' });
    try {
      const c = client(guarded.base);
      assert.equal((await c.get('/setup')).status, 404);
      assert.equal((await c.post('/setup', { form: { org_name: 'X', name: 'Y', email: 'y@x.ro', password: 'Parola12345' } })).status, 404);
      assert.equal((await c.get('/setup?token=tok-123456')).status, 200);
      const ok = await c.post('/setup', { form: { token: 'tok-123456', org_name: 'X', name: 'Y', email: 'y@x.ro', password: 'Parola12345' } });
      assert.equal(ok.status, 303);
    } finally {
      await guarded.stop();
    }
  });

  test('the server listens on loopback unless HOST is set', async () => {
    const { loadConfig } = await import('../config/env.js');
    assert.equal(loadConfig({}).host, '127.0.0.1');
    assert.equal(loadConfig({ HOST: '0.0.0.0' }).host, '0.0.0.0');
  });
});
