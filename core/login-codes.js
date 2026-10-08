import { createHmac, randomInt } from 'node:crypto';
import { appError, isoIn, newId, nowIso, safeEqualHex } from './util.js';

export const CODE_TTL_MINUTES = 10;
const MAX_ATTEMPTS = 5;
const RESEND_MS = 60_000;
const MAX_PER_HOUR = 5;

// Passwordless sign-in: a 6-digit code sent by e-mail. Only an HMAC is
// stored; a code expires after 10 minutes, is single-use, dies after 5 wrong
// attempts; issuing is limited per user (1/minute, 5/hour). Mainly for
// external collaborators who sign in rarely and have no password.
export function createLoginCodes({ db, secret }) {
  const hash = (userId, code) => createHmac('sha256', secret).update(`login:${userId}:${code}`).digest('hex');

  // The limits are checked inside the INSERT itself, so concurrent requests
  // (or several nodes) cannot issue more codes than allowed.
  async function issue(userId) {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const now = Date.now();
    const at = nowIso();
    const hourAgo = new Date(now - 3600_000).toISOString();
    const minuteAgo = new Date(now - RESEND_MS).toISOString();
    const allowed = `(SELECT COUNT(*) FROM login_codes WHERE user_id = ? AND created_at >= ?) < ? AND NOT EXISTS (SELECT 1 FROM login_codes WHERE user_id = ? AND created_at > ?)`;
    const allowedArgs = [userId, hourAgo, MAX_PER_HOUR, userId, minuteAgo];
    const id = newId();
    const [res] = await db.batch([
      [`INSERT INTO login_codes (id, user_id, code_hash, expires_at, created_at) SELECT ?, ?, ?, ?, ? WHERE ${allowed}`, [id, userId, hash(userId, code), isoIn(CODE_TTL_MINUTES * 60_000), at, ...allowedArgs]],
      // Only the newest code is valid (and only a code really issued here
      // retires the previous one).
      ['UPDATE login_codes SET used_at = ? WHERE user_id = ? AND used_at IS NULL AND id != ? AND EXISTS (SELECT 1 FROM login_codes WHERE id = ?)', [at, userId, id, id]],
    ]);
    if (!res.changes) throw appError('rate_limited', 'Too many codes', { reason: 'wait' });
    return code;
  }

  // 'ok' | 'invalid' | 'expired' | 'locked'. Each check first takes one of
  // the 5 attempts with a conditional UPDATE, so concurrent guesses cannot
  // exceed the limit; consumption is conditional too (single use).
  async function verify(userId, code) {
    const row = await db.get('SELECT * FROM login_codes WHERE user_id = ? AND used_at IS NULL ORDER BY created_at DESC LIMIT 1', [userId]);
    if (!row || row.expires_at < nowIso()) return 'expired';
    const [attempt] = await db.batch([['UPDATE login_codes SET attempts = attempts + 1 WHERE id = ? AND used_at IS NULL AND attempts < ?', [row.id, MAX_ATTEMPTS]]]);
    if (!attempt.changes) return 'locked';
    if (!safeEqualHex(hash(userId, String(code || '').replace(/\D/g, '')), row.code_hash)) return row.attempts + 1 >= MAX_ATTEMPTS ? 'locked' : 'invalid';
    const [res] = await db.batch([['UPDATE login_codes SET used_at = ? WHERE id = ? AND used_at IS NULL', [nowIso(), row.id]]]);
    return res.changes ? 'ok' : 'expired';
  }

  // Housekeeping: codes are only needed for the hourly issuing limit.
  const prune = () => db.run('DELETE FROM login_codes WHERE created_at < ?', [new Date(Date.now() - 2 * 3600_000).toISOString()]);

  return { issue, verify, prune };
}
