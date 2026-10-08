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

  async function issue(userId) {
    const recent = await db.all('SELECT created_at FROM login_codes WHERE user_id = ? AND created_at >= ? ORDER BY created_at DESC', [userId, new Date(Date.now() - 3600_000).toISOString()]);
    if (recent.length >= MAX_PER_HOUR) throw appError('rate_limited', 'Too many codes', { reason: 'hour' });
    const wait = recent[0] ? Math.ceil((Date.parse(recent[0].created_at) + RESEND_MS - Date.now()) / 1000) : 0;
    if (wait > 0) throw appError('rate_limited', 'Wait before a new code', { reason: 'wait', seconds: wait });
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await db.batch([
      ['UPDATE login_codes SET used_at = ? WHERE user_id = ? AND used_at IS NULL', [nowIso(), userId]],
      ['INSERT INTO login_codes (id, user_id, code_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)', [newId(), userId, hash(userId, code), isoIn(CODE_TTL_MINUTES * 60_000), nowIso()]],
    ]);
    return code;
  }

  // 'ok' | 'invalid' | 'expired' | 'locked'. Consumption is conditional, so a
  // code cannot be used twice by concurrent requests.
  async function verify(userId, code) {
    const row = await db.get('SELECT * FROM login_codes WHERE user_id = ? AND used_at IS NULL ORDER BY created_at DESC LIMIT 1', [userId]);
    if (!row || row.expires_at < nowIso()) return 'expired';
    if (row.attempts >= MAX_ATTEMPTS) return 'locked';
    if (!safeEqualHex(hash(userId, String(code || '').replace(/\D/g, '')), row.code_hash)) {
      await db.run('UPDATE login_codes SET attempts = attempts + 1 WHERE id = ?', [row.id]);
      return row.attempts + 1 >= MAX_ATTEMPTS ? 'locked' : 'invalid';
    }
    const [res] = await db.batch([['UPDATE login_codes SET used_at = ? WHERE id = ? AND used_at IS NULL', [nowIso(), row.id]]]);
    return res.changes ? 'ok' : 'expired';
  }

  return { issue, verify };
}
