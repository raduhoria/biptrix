import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { client, startApp } from './helpers.js';

// Sliding sessions: a session in use is extended (and its cookie with it);
// one left unused expires; one still waiting for MFA is not extended.
describe('sliding sessions', () => {
  let app;
  let org;
  let ana;
  const hourAgo = () => new Date(Date.now() - 3600_000).toISOString();
  const soon = () => new Date(Date.now() + 60_000).toISOString();
  const session = (userId) => app.db.get('SELECT expires_at FROM sessions WHERE user_id = ?', [userId]);

  before(async () => {
    app = await startApp({ SESSION_TTL_HOURS: '720' });
    org = await app.org('Altbet');
    ana = await app.user(org, { email: 'ana@altbet.ro' });
  });
  after(() => app.stop());

  test('a session in use lives on, cookie included', async () => {
    const c = client(app.base);
    await c.login('ana@altbet.ro');
    // About to expire, last used an hour ago.
    await app.db.run('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE user_id = ?', [hourAgo(), soon(), ana.id]);
    const res = await fetch(`${app.base}/api/o/${org.slug}/announcements`, { headers: { Cookie: c.cookieHeader() } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('set-cookie') || '', /sid=.*Max-Age=2592000/);
    const left = Date.parse((await session(ana.id)).expires_at) - Date.now();
    assert.ok(left > 29 * 86400_000, `extended to ~30 days, got ${left}`);
  });

  test('used again within minutes: no rewrite, no new cookie', async () => {
    const c = client(app.base);
    await c.login('ana@altbet.ro');
    const res = await fetch(`${app.base}/api/o/${org.slug}/announcements`, { headers: { Cookie: c.cookieHeader() } });
    assert.equal(res.headers.get('set-cookie'), null);
  });

  test('an unused session still expires', async () => {
    await app.db.run('DELETE FROM sessions');
    const c = client(app.base);
    await c.login('ana@altbet.ro');
    await app.db.run('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE user_id = ?', [hourAgo(), hourAgo(), ana.id]);
    assert.equal((await c.get(`/api/o/${org.slug}/announcements`)).status, 401);
  });

  test('a session waiting for MFA is not extended', async () => {
    await app.db.run('DELETE FROM sessions');
    const c = client(app.base);
    await c.login('ana@altbet.ro');
    await app.db.run('UPDATE users SET totp_secret = ? WHERE id = ?', [app.services.secretBox.encrypt('JBSWY3DPEHPK3PXP'), ana.id]);
    const expires = soon();
    await app.db.run('UPDATE sessions SET last_seen_at = ?, expires_at = ?, mfa_ok = 0 WHERE user_id = ?', [hourAgo(), expires, ana.id]);
    await c.get('/login/mfa');
    assert.equal((await session(ana.id)).expires_at, expires);
    await app.db.run('UPDATE users SET totp_secret = NULL WHERE id = ?', [ana.id]);
  });
});
