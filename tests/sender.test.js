import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { client, startApp } from './helpers.js';

// Per-organization e-mail sender: only from the organization's own domains;
// mail about the organization uses it, account mail keeps the platform's.
describe('organization e-mail sender', () => {
  let app;
  let org;
  let admin;
  const ADMIN = () => `/o/${org.slug}/admin`;

  before(async () => {
    app = await startApp({ SMTP_FROM_EMAIL: 'tech@platform.test', SMTP_FROM_NAME: 'BipTrix' });
    org = await app.org('Unicorn Dev');
    const owner = await app.user(org, { email: 'horia@unicorndev.eu', role: 'owner' });
    admin = client(app.base);
    await admin.login('horia@unicorndev.eu');
    // The console requires MFA: the session counts as verified.
    await app.db.run('UPDATE users SET totp_secret = ? WHERE id = ?', [app.services.secretBox.encrypt('JBSWY3DPEHPK3PXP'), owner.id]);
    await app.db.run('UPDATE sessions SET mfa_ok = 1 WHERE user_id = ?', [owner.id]);
  });
  after(() => app.stop());

  const settings = (fields) => admin.post(`${ADMIN()}/settings`, { form: { name: 'Unicorn Dev', brand_color: '#4f46e5', ...fields } });

  test('the sender must be in a company domain', async () => {
    assert.match((await settings({ email_from: 'no-reply@unicorndev.eu' })).location, /error=reason_senderDomain/);
    await app.services.policies.update(org.id, { company_domains: 'unicorndev.eu' }, { id: null }, '');
    assert.match((await settings({ email_from: 'no-reply@altcineva.ro' })).location, /error=reason_senderDomain/);
    assert.match((await settings({ email_from: 'no-reply@unicorndev.eu', email_from_name: 'Unicorn Dev' })).location, /notice=saved/);
    const row = await app.db.get('SELECT email_from, email_from_name FROM organizations WHERE id = ?', [org.id]);
    assert.deepEqual({ ...row }, { email_from: 'no-reply@unicorndev.eu', email_from_name: 'Unicorn Dev' });
  });

  test('organization mail leaves from it; account mail from the platform', async () => {
    await admin.post(`${ADMIN()}/invites`, { form: { email: 'coleg@unicorndev.eu', role: 'member' } });
    const invite = app.mailer.sent.filter((m) => m.to === 'coleg@unicorndev.eu').at(-1);
    assert.equal(invite.from, 'no-reply@unicorndev.eu');
    assert.equal(invite.fromName, 'Unicorn Dev');

    assert.match((await admin.post(`${ADMIN()}/settings/test-email`, { form: {} })).location, /notice=testEmailSent/);
    assert.equal(app.mailer.sent.at(-1).from, 'no-reply@unicorndev.eu');

    await client(app.base).post('/forgot', { form: { email: 'horia@unicorndev.eu' } });
    assert.equal(app.mailer.sent.filter((m) => m.to === 'horia@unicorndev.eu').at(-1).from, 'tech@platform.test');

    // Emptied: back to the platform sender.
    await settings({ email_from: '' });
    await admin.post(`${ADMIN()}/invites`, { form: { email: 'altul@unicorndev.eu', role: 'member' } });
    assert.equal(app.mailer.sent.filter((m) => m.to === 'altul@unicorndev.eu').at(-1).from, 'tech@platform.test');
  });
});
