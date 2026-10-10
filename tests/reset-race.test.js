import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { totpNow } from '../core/totp.js';
import { client, startApp } from './helpers.js';

// A password reset that finishes while a sign-in or an MFA change is
// between its checks and its write: the reset wins. The race is forced by
// running the reset from inside the password check.
describe('password reset racing other operations', () => {
  let app;
  let user;
  const realVerify = { fn: null };

  before(async () => {
    app = await startApp();
    const org = await app.org('Race');
    user = await app.user(org, { email: 'ana@race.ro', name: 'Ana' });
    realVerify.fn = app.services.auth.verifyPassword;
  });
  after(() => app.stop());

  // The next password check passes, then a reset lands (new password,
  // every session revoked), as if it finished in between.
  function resetDuringNextCheck() {
    app.services.auth.verifyPassword = async (...a) => {
      app.services.auth.verifyPassword = realVerify.fn;
      const ok = await realVerify.fn(...a);
      await app.db.batch([
        ['UPDATE users SET password_hash = ? WHERE id = ?', [await app.services.auth.hashPassword('ParolaNoua123'), user.id]],
        ['DELETE FROM sessions WHERE user_id = ?', [user.id]],
      ]);
      return ok;
    };
  }
  const sessions = async () => (await app.db.get('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?', [user.id])).n;

  test('a sign-in with the old password does not get a session after the reset', async () => {
    resetDuringNextCheck();
    const res = await client(app.base).post('/login', { form: { email: 'ana@race.ro', password: 'Parola12345', next: '/' } });
    assert.equal(res.status, 401);
    assert.equal(await sessions(), 0);
    await app.db.run('UPDATE users SET password_hash = ? WHERE id = ?', [await app.services.auth.hashPassword('Parola12345'), user.id]);
  });

  test('an MFA enrollment authorized before the reset installs nothing after it', async () => {
    const c = client(app.base);
    await c.login('ana@race.ro');
    await c.get('/account/mfa');
    const secret = app.services.secretBox.decrypt(decodeURIComponent(c.jar.get('mfa_setup'))).split(':')[1];
    resetDuringNextCheck();
    const res = await c.post('/account/mfa/enable', { form: { password: 'Parola12345', code: totpNow(secret) } });
    assert.equal(res.location, '/login');
    assert.equal((await app.db.get('SELECT totp_secret FROM users WHERE id = ?', [user.id])).totp_secret, null);
    await app.db.run('UPDATE users SET password_hash = ? WHERE id = ?', [await app.services.auth.hashPassword('Parola12345'), user.id]);
  });

  test('without a race, both still work', async () => {
    const c = client(app.base);
    await c.login('ana@race.ro');
    await c.get('/account/mfa');
    const secret = app.services.secretBox.decrypt(decodeURIComponent(c.jar.get('mfa_setup'))).split(':')[1];
    assert.match((await c.post('/account/mfa/enable', { form: { password: 'Parola12345', code: totpNow(secret) } })).location, /mfaEnabled/);
    assert.notEqual((await app.db.get('SELECT totp_secret FROM users WHERE id = ?', [user.id])).totp_secret, null);
  });
});
