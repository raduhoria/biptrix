import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

// Small shared helpers. Ids are 16 random bytes in base64url — opaque, not
// guessable, and never derived from content or order.
export const newId = () => randomBytes(16).toString('base64url');
export const newToken = () => randomBytes(32).toString('base64url');
export const nowIso = () => new Date().toISOString();
export const isoIn = (ms) => new Date(Date.now() + ms).toISOString();
export const sha256 = (value) => createHash('sha256').update(String(value)).digest('hex');

export function safeEqualHex(a, b) {
  const x = Buffer.from(String(a), 'hex');
  const y = Buffer.from(String(b), 'hex');
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

// Unique e-mail canonicalization (spec §13): trimmed and lower-cased. Plus
// tags and dots are kept — they are real, distinct mailboxes at many providers.
export function canonicalEmail(value) {
  return String(value || '').trim().toLowerCase();
}

export function isEmail(value) {
  return /^[^\s@<>()[\],;:"]+@[^\s@<>()[\],;:"]+\.[^\s@<>()[\],;:"]+$/.test(String(value || '')) && String(value).length <= 254;
}

export const emailDomain = (email) => canonicalEmail(email).split('@')[1] || '';

// Standard error codes (spec §14): unauthorized, forbidden, not_found,
// expired, rate_limited, stale_version, invalid, conflict, quota_exceeded.
const STATUS = { unauthorized: 401, forbidden: 403, not_found: 404, expired: 410, rate_limited: 429, stale_version: 409, conflict: 409, invalid: 400, quota_exceeded: 403, policy_denied: 403, db_unavailable: 503 };

export function appError(code, message = code, details) {
  return Object.assign(new Error(message), { code, status: STATUS[code] || 400, details, expose: true });
}

export function slugify(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

export function parseJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

export const clampInt = (value, min, max, fallback) => {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
