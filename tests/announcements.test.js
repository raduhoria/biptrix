import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { client, socket, startApp } from './helpers.js';

// Company announcements: administrators publish them for a period; members
// see the ones active today (live), external collaborators see none.
describe('company announcements', () => {
  let app;
  let org;
  let admin;
  let member;
  let external;
  const ADMIN = () => `/o/${org.slug}/admin/announcements`;
  const API = () => `/api/o/${org.slug}`;
  const day = (offset) => new Date(Date.now() + offset * 86400_000).toISOString().slice(0, 10);

  before(async () => {
    app = await startApp();
    org = await app.org('Altbet');
    const owner = await app.user(org, { email: 'sef@altbet.ro', role: 'owner' });
    await app.user(org, { email: 'ana@altbet.ro' });
    await app.user(org, { email: 'ext@partener.com', role: 'external' });
    admin = client(app.base);
    await admin.login('sef@altbet.ro');
    // The console requires MFA: the session counts as verified.
    await app.db.run('UPDATE users SET totp_secret = ? WHERE id = ?', [app.services.secretBox.encrypt('JBSWY3DPEHPK3PXP'), owner.id]);
    await app.db.run('UPDATE sessions SET mfa_ok = 1 WHERE user_id = ?', [owner.id]);
    member = client(app.base);
    await member.login('ana@altbet.ro');
    external = client(app.base);
    await external.login('ext@partener.com');
  });
  after(() => app.stop());

  const publish = (fields) => admin.post(ADMIN(), { form: { title: 'Anunț', body: '', level: 'info', starts_on: day(0), ends_on: day(3), ...fields } });

  test('only administrators manage announcements', async () => {
    assert.notEqual((await member.get(ADMIN())).status, 200);
    assert.notEqual((await member.post(ADMIN(), { form: { title: 'X', starts_on: day(0), ends_on: day(1) } })).status, 303);
    assert.equal((await app.db.get('SELECT COUNT(*) AS n FROM announcements')).n, 0);
    assert.equal((await admin.get(ADMIN())).status, 200);
  });

  test('a title and a valid period are required', async () => {
    assert.equal((await publish({ title: ' ' })).status, 400);
    const res = await publish({ title: 'Inversat', starts_on: day(3), ends_on: day(1) });
    assert.equal(res.status, 400);
    assert.match(res.text, /Inversat/, 'the form comes back as typed');
    assert.equal((await publish({ starts_on: '2026-02-30' })).status, 400);
    assert.equal((await app.db.get('SELECT COUNT(*) AS n FROM announcements')).n, 0);
  });

  test('members see the active ones, live; external collaborators none', async () => {
    const ws = socket(app.base, `/ws?org=${org.slug}`, member);
    await ws.opened;
    assert.match((await publish({ title: 'Mentenanță sâmbătă', body: 'Serverele **nu** merg 2 ore.', level: 'warning' })).location, /notice=saved/);
    await ws.next('announcements.changed');
    ws.close();
    await publish({ title: 'Viitor', starts_on: day(5), ends_on: day(6) });
    await publish({ title: 'Trecut', starts_on: day(-6), ends_on: day(-5) });

    const titles = (r) => r.data.announcements.map((a) => a.title);
    assert.deepEqual(titles(await member.get(`${API()}/announcements`)), ['Mentenanță sâmbătă']);
    assert.deepEqual(titles(await member.get(`${API()}/bootstrap`)), ['Mentenanță sâmbătă']);
    assert.deepEqual(titles(await external.get(`${API()}/announcements`)), []);
    assert.deepEqual(titles(await external.get(`${API()}/bootstrap`)), []);
  });

  test('edit and delete, with an audit trail', async () => {
    const { id } = await app.db.get("SELECT id FROM announcements WHERE title = 'Viitor'");
    assert.match((await admin.get(`${ADMIN()}?edit=${id}`)).text, /value="Viitor"/);
    await admin.post(ADMIN(), { form: { id, title: 'Acum', level: 'success', starts_on: day(0), ends_on: day(0) } });
    assert.ok((await member.get(`${API()}/announcements`)).data.announcements.some((a) => a.title === 'Acum' && a.level === 'success'));

    assert.match((await admin.post(`${ADMIN()}/${id}/delete`, { form: {} })).location, /notice=announcementDeleted/);
    assert.ok(!(await member.get(`${API()}/announcements`)).data.announcements.some((a) => a.id === id));
    const actions = (await app.db.all("SELECT action FROM audit_events WHERE resource_type = 'announcement'")).map((r) => r.action);
    assert.ok(actions.includes('announcement.create') && actions.includes('announcement.update') && actions.includes('announcement.delete'));
  });
});
