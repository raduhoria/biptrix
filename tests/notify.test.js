import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { client, startApp } from './helpers.js';

// Notification e-mails say who wrote and where, never the message itself
// (it would travel through the mail provider and stay in the inbox).
describe('notification e-mails', () => {
  let app;
  let org;

  before(async () => {
    app = await startApp();
    org = await app.org('Altbet');
    await app.user(org, { email: 'ana@altbet.ro', name: 'Ana' });
    await app.user(org, { email: 'bob@altbet.ro', name: 'Bob' });
  });
  after(() => app.stop());

  test('a direct message to someone offline: an e-mail without the text', async () => {
    const ana = client(app.base);
    await ana.login('ana@altbet.ro');
    const API = `/api/o/${org.slug}`;
    const bob = await app.services.users.byEmail('bob@altbet.ro');
    const dm = (await ana.post(`${API}/dms`, { json: { user_id: bob.id } })).data.conversation;
    await ana.post(`${API}/conversations/${dm.id}/messages`, { json: { client_message_id: 'secret-msg-1', body: 'Parola serverului e Zebra42' } });
    let mail;
    for (let i = 0; i < 40 && !mail; i++, await new Promise((r) => setTimeout(r, 25))) mail = app.mailer.sent.find((m) => m.to === 'bob@altbet.ro');
    assert.ok(mail, 'an e-mail was sent');
    assert.match(JSON.stringify(mail), /Ana/);
    assert.doesNotMatch(JSON.stringify(mail), /Zebra42|Parola serverului/);
  });
});
