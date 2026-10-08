import { timingSafeEqual } from 'node:crypto';
import { readForm } from '../core/router.js';
import { LOCALE_COOKIE, normalizeLocale, translateError } from '../core/i18n.js';
import { newTotpSecret, totpUri, verifyTotp } from '../core/totp.js';
import { canonicalEmail, isEmail, isoIn, newId, newToken, nowIso, sha256 } from '../core/util.js';
import { accountView, codeLoginView, forgotView, inviteView, loginView, mfaLoginView, orgPickerView, resetView, setupView } from '../views/auth.js';
import { messagePage } from '../views/layout.js';
import { loginCodeEmail, resetEmail } from '../views/emails.js';

// Only same-site paths are accepted as redirect targets.
export const safeNext = (value, fallback = '/') => (typeof value === 'string' && /^\/(?!\/)[^\\\s]*$/.test(value) ? value : fallback);

const RESET_TTL_MS = 3600_000;
const MFA_COOKIE = 'mfa_setup';

export function registerAuthRoutes(router, { auth, users, orgs, mailer, config, audit, db, secretBox, realtime, loginCodes }) {
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
  // With SETUP_TOKEN set (production), the first-run page only opens with
  // ?token=<SETUP_TOKEN>: a fresh public deployment cannot be claimed by
  // whoever finds it first.
  const setupAllowed = (token) => !config.setupToken || (typeof token === 'string' && token.length === config.setupToken.length && timingSafeEqual(Buffer.from(token), Buffer.from(config.setupToken)));

  router.get('/setup', async (req, res) => {
    if (await users.count()) return res.redirect('/login');
    if (!setupAllowed(req.query.token)) return res.status(404).send(messagePage({ t: req.t, title: req.t('setup.title'), message: req.t('setup.needsToken'), back: '/' }));
    res.send(setupView({ t: req.t, token: req.query.token || '' }));
  });

  // The operator, the first organization and its owner membership are one
  // atomic batch guarded by "no other user exists": concurrent setup
  // requests cannot create two operators.
  router.post('/setup', async (req, res) => {
    if (await users.count()) return res.redirect('/login');
    const form = Object.fromEntries(await readForm(req));
    if (!setupAllowed(form.token)) return res.status(404).send(messagePage({ t: req.t, title: req.t('setup.title'), message: req.t('setup.needsToken'), back: '/' }));
    try {
      const password = auth.validatePassword(form.password);
      const created = users.insertStatement({ email: form.email, name: form.name, passwordHash: await auth.hashPassword(password), platformRole: 'operator', locale: req.t.locale });
      const onlyUser = '(SELECT COUNT(*) FROM users) = 1 AND EXISTS (SELECT 1 FROM users WHERE id = ?)';
      const [sql, args] = created.statement;
      const userInsert = [sql.replace(/VALUES \(([^)]*)\)$/s, 'SELECT $1 WHERE NOT EXISTS (SELECT 1 FROM users)'), args];
      const org = await orgs.createStatements({ name: form.org_name, ownerId: created.id, actor: { id: created.id, email: form.email }, ip: req.ip, when: onlyUser, whenArgs: [created.id] });
      const [first] = await db.batch([userInsert, ...org.statements]);
      if (!first.changes) return res.redirect('/login');
      await auth.createSession(res, req, created.id);
      res.redirect(`/o/${(await orgs.byId(org.id)).slug}`);
    } catch (err) {
      res.status(400).send(setupView({ t: req.t, values: form, token: form.token || '', error: translateError(req.t, err) }));
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
    const fail = (key, status = 401) => res.status(status).send(loginView({ t: req.t, email: email.slice(0, 254), next, error: req.t(key) }));
    if (await auth.tooManyFailures(`ip:${req.ip}`, 40)) return fail('auth.tooMany', 429);
    // Not an address: refused before any per-account key is stored.
    if (!isEmail(email)) {
      await auth.recordFailure(`ip:${req.ip}`);
      return fail('auth.invalid');
    }
    if (await auth.tooManyFailures(`acct:${email}`, 8)) return fail('auth.tooMany', 429);
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

  // ------------------------------------------------- passwordless sign-in
  // E-mail → 6-digit code → session. The answer is the same whether or not
  // the address has an account, and whether or not a code was really sent
  // (per-account limits are silent). MFA, when enabled, still follows.
  router.get('/login/code', (req, res) => {
    if (req.user) return res.redirect(safeNext(req.query.next));
    res.send(codeLoginView({ t: req.t, email: req.query.email || '', next: safeNext(req.query.next, '') }));
  });

  router.post('/login/code', async (req, res) => {
    const form = await readForm(req);
    const email = canonicalEmail(form.get('email'));
    const next = safeNext(form.get('next'), '/');
    if (!isEmail(email)) return res.status(400).send(codeLoginView({ t: req.t, next, error: req.t('errors.invalidEmail') }));
    if (await auth.tooManyFailures(`code-ip:${req.ip}`, 30)) return res.status(429).send(codeLoginView({ t: req.t, email, next, error: req.t('auth.tooMany') }));
    await auth.recordFailure(`code-ip:${req.ip}`);
    const user = await users.byEmail(email);
    if (user?.status === 'active') {
      try {
        const code = await loginCodes.issue(user.id);
        mailer.queue({ to: user.email, ...loginCodeEmail({ t: req.t, code }) });
      } catch (err) {
        if (err.code !== 'rate_limited') throw err;
      }
    }
    res.send(codeLoginView({ t: req.t, email, next, step: 'code', notice: req.t('auth.codeSent', { email }) }));
  });

  router.post('/login/code/verify', async (req, res) => {
    const form = await readForm(req);
    const email = canonicalEmail(form.get('email'));
    const next = safeNext(form.get('next'), '/');
    const fail = (key, status = 401) => res.status(status).send(codeLoginView({ t: req.t, email: email.slice(0, 254), next, step: 'code', error: req.t(key) }));
    // Per address and per IP, both checked before anything is written; a
    // malformed address stores nothing.
    if (await auth.tooManyFailures(`code-verify-ip:${req.ip}`, 30)) return fail('auth.tooMany', 429);
    if (!isEmail(email)) {
      await auth.recordFailure(`code-verify-ip:${req.ip}`);
      return fail('auth.badCode');
    }
    if (await auth.tooManyFailures(`acct:${email}`, 8)) return fail('auth.tooMany', 429);
    const user = await users.byEmail(email);
    const result = user?.status === 'active' ? await loginCodes.verify(user.id, form.get('code')) : 'invalid';
    if (result !== 'ok') {
      await auth.recordFailure(`acct:${email}`, `code-verify-ip:${req.ip}`);
      return fail(result === 'expired' ? 'guest.otpExpired' : result === 'locked' ? 'guest.otpLocked' : 'auth.badCode');
    }
    await auth.clearFailures(`acct:${email}`);
    await auth.createSession(res, req, user.id);
    await audit.log({ actor: user, action: 'auth.login_code', resourceType: 'user', resourceId: user.id, ip: req.ip });
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

  // The token is consumed in the same batch that changes the password, and
  // every statement requires it to be still unused: of two concurrent
  // requests with one token, only one changes anything.
  router.post('/reset/:token', async (req, res) => {
    const gone = () => res.status(410).send(messagePage({ t: req.t, title: req.t('auth.resetTitle'), message: req.t('errors.expired'), back: '/forgot' }));
    const row = await resetToken(req.params.token);
    if (!row) return gone();
    try {
      const hash = await auth.hashPassword(auth.validatePassword((await readForm(req)).get('password')));
      const at = nowIso();
      const valid = 'EXISTS (SELECT 1 FROM email_tokens WHERE id = ? AND used_at IS NULL AND expires_at > ?)';
      const validArgs = [row.id, at];
      const [changed] = await db.batch([
        [`UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ? AND ${valid}`, [hash, at, row.user_id, ...validArgs]],
        [`DELETE FROM sessions WHERE user_id = ? AND ${valid}`, [row.user_id, ...validArgs]],
        audit.statement({ actor: { id: row.user_id }, action: 'auth.password_reset', resourceType: 'user', resourceId: row.user_id, ip: req.ip }, valid, validArgs),
        ['UPDATE email_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL', [at, row.id]],
      ]);
      if (!changed.changes) return gone();
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
        const { orgSlug, conversationId } = await orgs.acceptInvite(req.params.token, { userId: req.user.id });
        return res.redirect(`/o/${orgSlug}${conversationId ? `/c/${conversationId}` : ''}`);
      }
      if (invite.has_account) return res.redirect(`/login?next=${encodeURIComponent(`/invite/${req.params.token}`)}&email=${encodeURIComponent(invite.email)}`);
      // The link itself proves control of the address; a password is
      // optional (without one, sign-in is by e-mail code).
      const form = await readForm(req);
      const password = form.get('password') || '';
      const passwordHash = password ? await auth.hashPassword(auth.validatePassword(password)) : null;
      const { orgSlug, userId, conversationId } = await orgs.acceptInvite(req.params.token, { name: form.get('name'), passwordHash });
      await users.setLocale(userId, req.t.locale);
      await auth.createSession(res, req, userId);
      res.redirect(`/o/${orgSlug}${conversationId ? `/c/${conversationId}` : ''}`);
    } catch (err) {
      res.status(err.status || 400).send(inviteView({ t: req.t, invite, token: req.params.token, user: req.user, error: translateError(req.t, err) }));
    }
  });

  // ---------------------------------------------------------------- account
  async function renderAccount(req, res, { notice = '', error = '', mfaSetup = null, codeSent = false, status = 200 } = {}) {
    const sessions = await db.all('SELECT id_hash, ip, user_agent, last_seen_at FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY last_seen_at DESC LIMIT 20', [req.user.id, nowIso()]);
    const list = await orgs.forUser(req.user.id);
    const hasPassword = !!(await users.credentials(req.user.id))?.password_hash;
    res.status(status).send(accountView({ t: req.t, user: req.user, orgs: list, sessions, currentHash: req.session.id_hash, notice, error, mfaSetup, hasPassword, codeSent, next: safeNext(req.query.next, '') }));
  }

  router.get('/account', requireUser, (req, res) => {
    const notice = req.query.notice && req.t.has(`notices.${req.query.notice}`) ? req.t(`notices.${req.query.notice}`) : '';
    return renderAccount(req, res, { notice });
  });

  // Profile: name and language. The language is saved on the account (used
  // on every device and for the e-mails this person receives) and in the
  // selector cookie, so it applies at once.
  router.post('/account/profile', requireUser, async (req, res) => {
    const form = await readForm(req);
    const name = String(form.get('name') || '').trim();
    if (name) await users.setName(req.user.id, name);
    const locale = normalizeLocale(form.get('locale'));
    if (locale) {
      await users.setLocale(req.user.id, locale);
      res.cookie(LOCALE_COOKIE, locale, { maxAgeSeconds: 365 * 86400, secure: req.secure });
    }
    res.redirect('/account?notice=saved');
  });

  // Accounts created without a password (e-mail code sign-in) set their
  // first one with a fresh code sent to their address instead of a current
  // password: the session alone is not enough (otherwise a stolen session
  // could set a password, then enroll the attacker's MFA factor).
  router.post('/account/password/code', requireUser, async (req, res) => {
    if ((await users.credentials(req.user.id))?.password_hash) return res.redirect('/account');
    try {
      const code = await loginCodes.issue(req.user.id);
      mailer.queue({ to: req.user.email, ...loginCodeEmail({ t: req.t, code }) });
    } catch (err) {
      if (err.code !== 'rate_limited') throw err;
      return renderAccount(req, res, { error: req.t('account.codeWait'), codeSent: true, status: 429 });
    }
    renderAccount(req, res, { notice: req.t('account.codeSent', { email: req.user.email }), codeSent: true });
  });

  router.post('/account/password', requireUser, async (req, res) => {
    const form = await readForm(req);
    try {
      const creds = await users.credentials(req.user.id);
      const password = auth.validatePassword(form.get('password'));
      if (creds.password_hash) {
        if (!(await auth.verifyPassword(form.get('current') || '', creds.password_hash))) return renderAccount(req, res, { error: req.t('account.wrongPassword'), status: 400 });
        await users.setPasswordHash(req.user.id, await auth.hashPassword(password));
      } else {
        const result = await loginCodes.verify(req.user.id, form.get('code'));
        if (result !== 'ok') return renderAccount(req, res, { error: req.t(result === 'expired' ? 'guest.otpExpired' : result === 'locked' ? 'guest.otpLocked' : 'auth.badCode'), codeSent: result === 'invalid', status: 400 });
        // Conditional: never overwrites a password set meanwhile.
        const [set] = await db.batch([['UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ? AND password_hash IS NULL', [await auth.hashPassword(password), nowIso(), req.user.id]]]);
        if (!set.changes) return renderAccount(req, res, { error: req.t('account.wrongPassword'), status: 409 });
      }
      await auth.destroyUserSessions(req.user.id, req.session.id_hash);
      await audit.log({ actor: req.user, action: 'auth.password_change', resourceType: 'user', resourceId: req.user.id, ip: req.ip });
      res.redirect('/account?notice=passwordChanged');
    } catch (err) {
      renderAccount(req, res, { error: translateError(req.t, err), codeSent: true, status: 400 });
    }
  });

  // MFA enrollment: the pending secret lives in a short-lived encrypted
  // cookie bound to this account until the first code proves the
  // authenticator app has it. Enabling needs the current password (a stolen
  // session alone cannot install an attacker's factor; a passwordless account
  // first sets one with a code from its e-mail) and is refused while a
  // factor is already active — that one must be removed first, with its code.
  const pendingSecret = (req) => {
    try {
      const [userId, secret] = secretBox.decrypt(req.cookies[MFA_COOKIE]).split(':');
      return userId === req.user.id ? secret : '';
    } catch {
      return '';
    }
  };
  const setupFor = (req, secret) => (secret ? { secret, uri: totpUri({ secret, account: req.user.email, issuer: req.t('app.name') }) } : null);

  async function passwordOk(req, password) {
    const creds = await users.credentials(req.user.id);
    return !!creds?.password_hash && (await auth.verifyPassword(password || '', creds.password_hash));
  }

  router.get('/account/mfa', requireUser, async (req, res) => {
    if (req.user.mfa_enabled) return res.redirect('/account#mfa');
    const secret = newTotpSecret();
    res.cookie(MFA_COOKIE, secretBox.encrypt(`${req.user.id}:${secret}`), { secure: req.secure, maxAgeSeconds: 600, path: '/account' });
    await renderAccount(req, res, { mfaSetup: setupFor(req, secret), notice: req.query.next ? req.t('account.mfaRequired') : '' });
  });

  router.post('/account/mfa/enable', requireUser, async (req, res) => {
    if (req.user.mfa_enabled) return renderAccount(req, res, { error: req.t('account.mfaAlreadyOn'), status: 409 });
    if (!(await users.credentials(req.user.id))?.password_hash) return renderAccount(req, res, { error: req.t('account.mfaNeedsPassword'), status: 400 });
    const form = await readForm(req);
    const secret = pendingSecret(req);
    const key = `mfa-enroll:${req.user.id}`;
    if (await auth.tooManyFailures(key, 5)) return renderAccount(req, res, { error: req.t('auth.tooMany'), status: 429 });
    if (!(await passwordOk(req, form.get('password')))) {
      await auth.recordFailure(key);
      return renderAccount(req, res, { error: req.t('account.wrongPassword'), mfaSetup: setupFor(req, secret), status: 400 });
    }
    if (!secret || !verifyTotp(secret, form.get('code'))) {
      return renderAccount(req, res, { error: req.t('auth.badCode'), mfaSetup: setupFor(req, secret), status: 400 });
    }
    // Conditional write: two concurrent enrollments cannot both win.
    const [res1] = await db.batch([['UPDATE users SET totp_secret = ?, updated_at = ? WHERE id = ? AND totp_secret IS NULL', [secretBox.encrypt(secret), nowIso(), req.user.id]]]);
    if (!res1.changes) return renderAccount(req, res, { error: req.t('account.mfaAlreadyOn'), status: 409 });
    await auth.markMfa(req);
    await auth.destroyUserSessions(req.user.id, req.session.id_hash);
    await audit.log({ actor: req.user, action: 'auth.mfa_enable', resourceType: 'user', resourceId: req.user.id, ip: req.ip });
    res.cookie(MFA_COOKIE, '', { maxAgeSeconds: 0, path: '/account' });
    res.redirect(safeNext(form.get('next'), '/account?notice=mfaEnabled'));
  });

  router.post('/account/mfa/disable', requireUser, async (req, res) => {
    const form = await readForm(req);
    const key = `mfa-disable:${req.user.id}`;
    if (await auth.tooManyFailures(key, 5)) return renderAccount(req, res, { error: req.t('auth.tooMany'), status: 429 });
    if (!(await passwordOk(req, form.get('password'))) || !(await auth.checkTotp(req.user.id, form.get('code')))) {
      await auth.recordFailure(key);
      return renderAccount(req, res, { error: req.t('account.mfaDisableFailed'), status: 400 });
    }
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
