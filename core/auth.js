import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { appError, isoIn, newToken, nowIso, sha256 } from './util.js';
import { verifyTotp } from './totp.js';

const scryptAsync = promisify(scrypt);
// scrypt N=2^15, r=8, p=1 (OWASP minimum); maxmem raised to fit N·r·128.
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const THROTTLE_WINDOW_MS = 15 * 60_000;
const TOUCH_EVERY_MS = 5 * 60_000;

// createAuth: password hashing, server-side sessions (only the sha256 of the
// cookie value is stored), sign-in throttling and request guards. Org-level
// guards (membership, role) are in core/orgs.js.
export function createAuth({ db, users, config, secretBox }) {
  // Live connections (chat and meeting sockets) subscribe here and close the
  // sockets of revoked sessions immediately.
  const revokeListeners = [];
  const revoked = (hashes) => {
    if (hashes.length) for (const fn of revokeListeners) fn(hashes);
  };
  const cookieName = (secure) => (secure ? '__Host-sid' : 'sid');

  async function hashPassword(password) {
    const salt = randomBytes(16);
    const hash = await scryptAsync(String(password), salt, 64, SCRYPT);
    return `scrypt$${SCRYPT.N}$${salt.toString('base64')}$${hash.toString('base64')}`;
  }

  async function verifyPassword(password, stored) {
    const [scheme, n, salt, hash] = String(stored || '').split('$');
    if (scheme !== 'scrypt' || !salt || !hash) return false;
    const expected = Buffer.from(hash, 'base64');
    const candidate = await scryptAsync(String(password), Buffer.from(salt, 'base64'), expected.length, { ...SCRYPT, N: Number(n) });
    return timingSafeEqual(candidate, expected);
  }

  function validatePassword(password) {
    const value = String(password || '');
    if (value.length < 10 || value.length > 200) throw appError('invalid', 'Password must be 10-200 characters', { field: 'password' });
    return value;
  }

  // ---------------------------------------------------------------- throttle

  async function recordFailure(...keys) {
    const at = nowIso();
    await db.batch(keys.map((key) => ['INSERT INTO auth_failures (key, created_at) VALUES (?, ?)', [key, at]]));
  }

  async function tooManyFailures(key, max) {
    const since = new Date(Date.now() - THROTTLE_WINDOW_MS).toISOString();
    return (await db.get('SELECT COUNT(*) AS n FROM auth_failures WHERE key = ? AND created_at >= ?', [key, since])).n >= max;
  }

  const clearFailures = (key) => db.run('DELETE FROM auth_failures WHERE key = ?', [key]);

  // ---------------------------------------------------------------- sessions

  async function createSession(res, req, userId, { mfaOk = false } = {}) {
    const token = newToken();
    const at = nowIso();
    await db.run(
      'INSERT INTO sessions (id_hash, user_id, mfa_ok, ip, user_agent, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [sha256(token), userId, mfaOk ? 1 : 0, req.ip, String(req.headers['user-agent'] || '').slice(0, 200), at, at, isoIn(config.sessionTtlHours * 3600_000)]
    );
    res.cookie(cookieName(req.secure), token, { secure: req.secure, maxAgeSeconds: config.sessionTtlHours * 3600, sameSite: 'Lax' });
  }

  function readToken(req) {
    return req.cookies['__Host-sid'] || req.cookies.sid || '';
  }

  // Resolves the session cookie to { session, user }; null if missing,
  // expired, the user is disabled (revocation is immediate), or the user has
  // MFA and has not passed it in this session (unless allowPendingMfa).
  async function sessionFromToken(token, { allowPendingMfa = false } = {}) {
    if (!token) return null;
    const session = await db.get('SELECT * FROM sessions WHERE id_hash = ?', [sha256(token)]);
    if (!session) return null;
    if (session.expires_at < nowIso()) {
      await db.run('DELETE FROM sessions WHERE id_hash = ?', [session.id_hash]);
      revoked([session.id_hash]);
      return null;
    }
    const user = await users.byId(session.user_id);
    if (!user || user.status !== 'active') return null;
    if (user.mfa_enabled && !session.mfa_ok && !allowPendingMfa) return null;
    if (Date.now() - Date.parse(session.last_seen_at) > TOUCH_EVERY_MS) {
      db.run('UPDATE sessions SET last_seen_at = ? WHERE id_hash = ?', [nowIso(), session.id_hash]).catch(() => {});
    }
    return { session, user };
  }

  async function destroySession(req, res) {
    const token = readToken(req);
    if (token) {
      await db.run('DELETE FROM sessions WHERE id_hash = ?', [sha256(token)]);
      revoked([sha256(token)]);
    }
    res.cookie(cookieName(req.secure), '', { secure: req.secure, maxAgeSeconds: 0 });
  }

  async function destroyUserSessions(userId, exceptHash = '') {
    const rows = await db.all('SELECT id_hash FROM sessions WHERE user_id = ? AND id_hash != ?', [userId, exceptHash]);
    await db.run('DELETE FROM sessions WHERE user_id = ? AND id_hash != ?', [userId, exceptHash]);
    revoked(rows.map((r) => r.id_hash));
  }

  // Re-validation of a live connection by its stored session hash: the
  // session still exists, has not expired, the user is active and has passed
  // MFA. Returns the current user or null.
  async function userForSessionHash(hash) {
    const session = await db.get('SELECT * FROM sessions WHERE id_hash = ?', [hash]);
    if (!session || session.expires_at < nowIso()) return null;
    const user = await users.byId(session.user_id);
    if (!user || user.status !== 'active' || (user.mfa_enabled && !session.mfa_ok)) return null;
    return user;
  }

  async function markMfa(req) {
    await db.run('UPDATE sessions SET mfa_ok = 1 WHERE id_hash = ?', [sha256(readToken(req))]);
  }

  async function checkTotp(userId, code) {
    const row = await users.credentials(userId);
    return !!row?.totp_secret && verifyTotp(secretBox.decrypt(row.totp_secret), code);
  }

  // ------------------------------------------------------------------ guards

  // loadUser runs before every route: req.user / req.session, or null.
  // A password-verified session still waiting for its TOTP code only gets
  // req.pendingMfa (the /login/mfa page).
  async function loadUser(req) {
    const found = await sessionFromToken(readToken(req), { allowPendingMfa: true });
    const complete = found && (!found.user.mfa_enabled || found.session.mfa_ok);
    req.user = complete ? found.user : null;
    req.session = found?.session || null;
    req.pendingMfa = found && !complete ? found.user : null;
  }

  function requireUser(req, res, next) {
    if (req.user) return next();
    if (req.path.startsWith('/api/')) throw appError('unauthorized', 'Sign in required');
    res.redirect(`/login?next=${encodeURIComponent(req.url)}`);
  }

  // Administrators must use MFA (spec §15): enrolled and verified this session.
  function requireMfa(req, res, next) {
    if (req.user.mfa_enabled && req.session.mfa_ok) return next();
    if (req.path.startsWith('/api/')) throw appError('forbidden', 'MFA required', { reason: 'mfa' });
    res.redirect(`/account/mfa?next=${encodeURIComponent(req.url)}`);
  }

  function requireOperator(req, res, next) {
    if (req.user?.platform_role === 'operator') return next();
    throw appError('forbidden', 'Platform operators only');
  }

  return {
    hashPassword,
    verifyPassword,
    validatePassword,
    recordFailure,
    tooManyFailures,
    clearFailures,
    createSession,
    sessionFromToken,
    readToken,
    destroySession,
    destroyUserSessions,
    userForSessionHash,
    onRevoke: (fn) => revokeListeners.push(fn),
    markMfa,
    checkTotp,
    loadUser,
    requireUser,
    requireMfa,
    requireOperator,
    pruneExpired: async () => {
      const expired = await db.all('SELECT id_hash FROM sessions WHERE expires_at < ?', [nowIso()]);
      revoked(expired.map((r) => r.id_hash));
      return db.batch([
      ['DELETE FROM sessions WHERE expires_at < ?', [nowIso()]],
      ['DELETE FROM auth_failures WHERE created_at < ?', [new Date(Date.now() - THROTTLE_WINDOW_MS).toISOString()]],
      ['DELETE FROM email_tokens WHERE expires_at < ?', [nowIso()]],
      ]);
    },
  };
}
