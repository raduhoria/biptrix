import { readForm } from '../core/router.js';
import { LOCALE_COOKIE, normalizeLocale, translateError } from '../core/i18n.js';
import { newTotpSecret, totpUri, verifyTotp } from '../core/totp.js';
import { canonicalEmail, isoIn, newId, newToken, nowIso, sha256 } from '../core/util.js';
import { accountView, forgotView, inviteView, loginView, mfaLoginView, orgPickerView, resetView, setupView } from '../views/auth.js';
import { messagePage } from '../views/layout.js';
import { resetEmail } from '../views/emails.js';

// Only same-site paths are accepted as redirect targets.
export const safeNext = (value, fallback = '/') => (typeof value === 'string' && /^\/(?!\/)[^\\\s]*$/.test(value) ? value : fallback);

const RESET_TTL_MS = 3600_000;
const MFA_COOKIE = 'mfa_setup';

export function registerAuthRoutes(router, { auth, users, orgs, mailer, config, audit, db, secretBox, realtime }) {
  const { requireUser } = auth;

  router.get('/', async (req, res) => {
    if (!req.user) return res.redirect((await users.count()) ? '/login' : '/setup');
    const list = await orgs.forUser(req.user.id);
    const isOperator = req.user.platform_role === 'operator';
    if (list.length === 1 && !isOperator) return res.redirect(`/o/${list[0].slug}`);
    res.send(orgPickerView({ t: req.t, user: req.user, orgs: list, isOperator }));
  });

  // ------------------------------------------------------------------ setup
  // First run only: creates the platform operator and the first organization.
  router.get('/setup', async (req, res) => {
    if (await users.count()) return res.redirect('/login');
    res.send(setupView({ t: req.t }));
  });

  router.post('/setup', async (req, res) => {
    if (await users.count()) return res.redirect('/login');
    const form = Object.fromEntries(await readForm(req));
    try {
      const password = auth.validatePassword(form.password);
      const created = users.insertStatement({ email: form.email, name: form.name, passwordHash: await auth.hashPassword(password), platformRole: 'operator', locale: req.t.locale });
      await db.batch([created.statement]);
      const user = await users.byId(created.id);
      const org = await orgs.create({ name: form.org_name, ownerId: user.id, actor: user, ip: req.ip });
      await auth.createSession(res, req, user.id);
      res.redirect(`/o/${org.slug}`);
    } catch (err) {
      res.status(400).send(setupView({ t: req.t, values: form, error: translateError(req.t, err) }));
    }
  });

  // ---------------------------------------------------------------- sign in
  router.get('/login', (req, res) => {
    if (req.user) return res.redirect(safeNext(req.query.next));
    const notice = req.query.notice && req.t.has(`notices.${req.query.notice}`) ? req.t(`notices.${req.query.notice}`) : '';
    res.send(loginView({ t: req.t, email: req.query.email || '', next: safeNext(req.query.next, ''), notice }));
  });

  router.post('/login', async (req, res) => {
    const form = await readForm(req);
    const email = canonicalEmail(form.get('email'));
    const next = safeNext(form.get('next'), '/');
    const fail = (key, status = 401) => res.status(status).send(loginView({ t: req.t, email, next, error: req.t(key) }));
    if ((await auth.tooManyFailures(`acct:${email}`, 8)) || (await auth.tooManyFailures(`ip:${req.ip}`, 40))) return fail('auth.tooMany', 429);
    const user = await users.byEmail(email);
    const creds = user && (await users.credentials(user.id));
    const ok = creds?.password_hash && user.status === 'active' && (await auth.verifyPassword(form.get('password') || '', creds.password_hash));
    if (!ok) {
      await auth.recordFailure(`acct:${email}`, `ip:${req.ip}`);
      if (user) await audit.log({ actor: user, action: 'auth.login_failed', resourceType: 'user', resourceId: user.id, ip: req.ip });
      return fail('auth.invalid');
    }
    await auth.clearFailures(`acct:${email}`);
    await auth.createSession(res, req, user.id);
    if (user.mfa_enabled) return res.redirect(`/login/mfa?next=${encodeURIComponent(next)}`);
    res.redirect(next);
  });

  router.get('/login/mfa', (req, res) => {
    if (req.user) return res.redirect(safeNext(req.query.next));
    if (!req.pendingMfa) return res.redirect('/login');
    res.send(mfaLoginView({ t: req.t, next: safeNext(req.query.next, '/') }));
  });

  router.post('/login/mfa', async (req, res) => {
    const user = req.pendingMfa;
    if (!user) return res.redirect('/login');
    const form = await readForm(req);
    const next = safeNext(form.get('next'), '/');
    const key = `mfa:${user.id}`;
    if (await auth.tooManyFailures(key, 5)) {
      await auth.destroySession(req, res);
      return res.redirect('/login?notice=mfaLocked');
    }
    if (!(await auth.checkTotp(user.id, form.get('code')))) {
      await auth.recordFailure(key);
      return res.status(401).send(mfaLoginView({ t: req.t, next, error: req.t('auth.badCode') }));
    }
    await auth.clearFailures(key);
    await auth.markMfa(req);
    res.redirect(next);
  });

  router.post('/logout', async (req, res) => {
    const form = await readForm(req);
    await auth.destroySession(req, res);
    res.redirect(safeNext(form.get('next'), '/login'));
  });

  // ----------------------------------------------------------- password reset
  router.get('/forgot', (req, res) => res.send(forgotView({ t: req.t })));

  router.post('/forgot', async (req, res) => {
    const email = canonicalEmail((await readForm(req)).get('email'));
    if (await auth.tooManyFailures(`forgot:${req.ip}`, 10)) return res.status(429).send(forgotView({ t: req.t, error: req.t('auth.tooMany') }));
    await auth.recordFailure(`forgot:${req.ip}`);
    const user = await users.byEmail(email);
    // Same answer whether or not the address has an account.
    if (user?.status === 'active') {
      const token = newToken();
      await db.batch([
        ["UPDATE email_tokens SET used_at = ? WHERE user_id = ? AND purpose = 'reset' AND used_at IS NULL", [nowIso(), user.id]],
        ['INSERT INTO email_tokens (id, user_id, purpose, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)', [newId(), user.id, 'reset', sha256(token), isoIn(RESET_TTL_MS), nowIso()]],
      ]);
      mailer.queue({ to: user.email, ...resetEmail({ t: req.t, url: `${config.appUrl}/reset/${token}` }) });
    }
    res.send(forgotView({ t: req.t, sent: true }));
  });

  const resetToken = (token) => db.get("SELECT * FROM email_tokens WHERE token_hash = ? AND purpose = 'reset' AND used_at IS NULL AND expires_at > ?", [sha256(token), nowIso()]);

  router.get('/reset/:token', async (req, res) => {
    if (!(await resetToken(req.params.token))) return res.status(410).send(messagePage({ t: req.t, title: req.t('auth.resetTitle'), message: req.t('errors.expired'), back: '/forgot' }));
    res.send(resetView({ t: req.t, token: req.params.token }));
  });

  router.post('/reset/:token', async (req, res) => {
    const row = await resetToken(req.params.token);
    if (!row) return res.status(410).send(messagePage({ t: req.t, title: req.t('auth.resetTitle'), message: req.t('errors.expired'), back: '/forgot' }));
    try {
      const hash = await auth.hashPassword(auth.validatePassword((await readForm(req)).get('password')));
      await db.batch([
        ['UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', [hash, nowIso(), row.user_id]],
        ['UPDATE email_tokens SET used_at = ? WHERE id = ?', [nowIso(), row.id]],
        ['DELETE FROM sessions WHERE user_id = ?', [row.user_id]],
        audit.statement({ actor: { id: row.user_id }, action: 'auth.password_reset', resourceType: 'user', resourceId: row.user_id, ip: req.ip }),
      ]);
      realtime.disconnectUser(row.user_id);
      res.redirect('/login?notice=passwordReset');
    } catch (err) {
      res.status(400).send(resetView({ t: req.t, token: req.params.token, error: translateError(req.t, err) }));
    }
  });

  // ------------------------------------------------------ org invitations
  async function loadInvite(req, res) {
    try {
      const invite = await orgs.inviteByToken(req.params.token);
      invite.has_account = !!(await users.byEmail(invite.email));
      return invite;
    } catch (err) {
      res.status(err.status || 400).send(messagePage({ t: req.t, title: req.t('invite.invalidTitle'), message: translateError(req.t, err), back: '/' }));
      return null;
    }
  }

  router.get('/invite/:token', async (req, res) => {
    const invite = await loadInvite(req, res);
    if (invite) res.send(inviteView({ t: req.t, invite, token: req.params.token, user: req.user }));
  });

  router.post('/invite/:token', async (req, res) => {
    const invite = await loadInvite(req, res);
    if (!invite) return;
    try {
      if (req.user) {
        if (req.user.email !== invite.email) return res.redirect(`/invite/${encodeURIComponent(req.params.token)}`);
        const { orgSlug } = await orgs.acceptInvite(req.params.token, { userId: req.user.id });
        return res.redirect(`/o/${orgSlug}`);
      }
      if (invite.has_account) return res.redirect(`/login?next=${encodeURIComponent(`/invite/${req.params.token}`)}&email=${encodeURIComponent(invite.email)}`);
      const form = await readForm(req);
      const passwordHash = await auth.hashPassword(auth.validatePassword(form.get('password')));
      const { orgSlug, userId } = await orgs.acceptInvite(req.params.token, { name: form.get('name'), passwordHash });
      await users.setLocale(userId, req.t.locale);
      await auth.createSession(res, req, userId);
      res.redirect(`/o/${orgSlug}`);
    } catch (err) {
      res.status(err.status || 400).send(inviteView({ t: req.t, invite, token: req.params.token, user: req.user, error: translateError(req.t, err) }));
    }
  });

  // ---------------------------------------------------------------- account
  async function renderAccount(req, res, { notice = '', error = '', mfaSetup = null, status = 200 } = {}) {
    const sessions = await db.all('SELECT id_hash, ip, user_agent, last_seen_at FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY last_seen_at DESC LIMIT 20', [req.user.id, nowIso()]);
    const list = await orgs.forUser(req.user.id);
    res.status(status).send(accountView({ t: req.t, user: req.user, orgs: list, sessions, currentHash: req.session.id_hash, notice, error, mfaSetup, next: safeNext(req.query.next, '') }));
  }

  router.get('/account', requireUser, (req, res) => {
    const notice = req.query.notice && req.t.has(`notices.${req.query.notice}`) ? req.t(`notices.${req.query.notice}`) : '';
    return renderAccount(req, res, { notice });
  });

  router.post('/account/profile', requireUser, async (req, res) => {
    const name = String((await readForm(req)).get('name') || '').trim();
    if (name) await users.setName(req.user.id, name);
    res.redirect('/account?notice=saved');
  });

  router.post('/account/password', requireUser, async (req, res) => {
    const form = await readForm(req);
    try {
      const creds = await users.credentials(req.user.id);
      if (!(await auth.verifyPassword(form.get('current') || '', creds.password_hash))) return renderAccount(req, res, { error: req.t('account.wrongPassword'), status: 400 });
      await users.setPasswordHash(req.user.id, await auth.hashPassword(auth.validatePassword(form.get('password'))));
      await auth.destroyUserSessions(req.user.id, req.session.id_hash);
      await audit.log({ actor: req.user, action: 'auth.password_change', resourceType: 'user', resourceId: req.user.id, ip: req.ip });
      res.redirect('/account?notice=passwordChanged');
    } catch (err) {
      renderAccount(req, res, { error: translateError(req.t, err), status: 400 });
    }
  });

  // MFA enrollment: the pending secret lives in a short-lived encrypted
  // cookie until the first code proves the authenticator app has it.
  router.get('/account/mfa', requireUser, async (req, res) => {
    if (req.user.mfa_enabled) return res.redirect('/account#mfa');
    const secret = newTotpSecret();
    res.cookie(MFA_COOKIE, secretBox.encrypt(secret), { secure: req.secure, maxAgeSeconds: 600, path: '/account' });
    await renderAccount(req, res, { mfaSetup: { secret, uri: totpUri({ secret, account: req.user.email, issuer: req.t('app.name') }) }, notice: req.query.next ? req.t('account.mfaRequired') : '' });
  });

  router.post('/account/mfa/enable', requireUser, async (req, res) => {
    const form = await readForm(req);
    let secret = '';
    try {
      secret = secretBox.decrypt(req.cookies[MFA_COOKIE]);
    } catch {
      secret = '';
    }
    if (!secret || !verifyTotp(secret, form.get('code'))) {
      return renderAccount(req, res, { error: req.t('auth.badCode'), mfaSetup: secret ? { secret, uri: totpUri({ secret, account: req.user.email, issuer: req.t('app.name') }) } : null, status: 400 });
    }
    await users.setTotpSecret(req.user.id, secretBox.encrypt(secret));
    await auth.markMfa(req);
    await audit.log({ actor: req.user, action: 'auth.mfa_enable', resourceType: 'user', resourceId: req.user.id, ip: req.ip });
    res.cookie(MFA_COOKIE, '', { maxAgeSeconds: 0, path: '/account' });
    res.redirect(safeNext(form.get('next'), '/account?notice=mfaEnabled'));
  });

  router.post('/account/mfa/disable', requireUser, async (req, res) => {
    if (!(await auth.checkTotp(req.user.id, (await readForm(req)).get('code')))) return renderAccount(req, res, { error: req.t('auth.badCode'), status: 400 });
    await users.setTotpSecret(req.user.id, null);
    await audit.log({ actor: req.user, action: 'auth.mfa_disable', resourceType: 'user', resourceId: req.user.id, ip: req.ip });
    res.redirect('/account?notice=mfaDisabled');
  });

  router.post('/account/sessions/revoke', requireUser, async (req, res) => {
    await auth.destroyUserSessions(req.user.id, req.session.id_hash);
    res.redirect('/account?notice=sessionsRevoked');
  });

  router.post('/locale', async (req, res) => {
    const form = await readForm(req);
    const locale = normalizeLocale(form.get('locale'));
    if (locale) {
      res.cookie(LOCALE_COOKIE, locale, { maxAgeSeconds: 365 * 86400, secure: req.secure });
      if (req.user) await users.setLocale(req.user.id, locale);
    }
    res.redirect(safeNext(form.get('next'), '/'));
  });
}
