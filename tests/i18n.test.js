import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { client, startApp } from './helpers.js';

// English is the default; the selector (cookie) and the user's saved
// language win; the browser's Accept-Language is not used.
describe('languages', () => {
  let app;
  let org;
  before(async () => {
    app = await startApp();
    org = await app.org('Idiomas');
    await app.user(org, { email: 'lang@x.ro' });
  });
  after(() => app.stop());

  test('English by default, even for a Romanian browser', async () => {
    const res = await client(app.base).get('/login', { headers: { 'Accept-Language': 'ro-RO,ro;q=0.9' } });
    assert.match(res.text, /<html lang="en">/);
    assert.match(res.text, /Sign in/);
  });

  test('Spanish from the selector, and saved on the account', async () => {
    const c = client(app.base);
    await c.post('/locale', { form: { locale: 'es', next: '/login' } });
    assert.match((await c.get('/login')).text, /Iniciar sesión/);
    await c.login('lang@x.ro');
    await c.post('/locale', { form: { locale: 'es', next: '/' } });
    // A fresh browser (no cookie) gets the account's language after sign-in.
    const fresh = client(app.base);
    await fresh.login('lang@x.ro');
    assert.match((await fresh.get('/account')).text, /<html lang="es">/);
    const user = await app.services.users.byEmail('lang@x.ro');
    assert.equal(user.locale, 'es');
  });

  test('the account page sets the language per user', async () => {
    const c = client(app.base);
    await c.login('lang@x.ro');
    const page = await c.get('/account');
    assert.match(page.text, /name="locale"/);
    assert.match(page.text, /English/);
    await c.post('/account/profile', { form: { name: 'Lang User', locale: 'ro' } });
    assert.equal((await app.services.users.byEmail('lang@x.ro')).locale, 'ro');
    assert.match((await c.get('/account')).text, /<html lang="ro">/);
  });
});
