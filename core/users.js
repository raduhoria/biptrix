import { appError, canonicalEmail, isEmail, newId, nowIso } from './util.js';

// Global identities (spec §5). A user can belong to several organizations;
// org-specific rights live in memberships (core/orgs.js).
export function createUsers(db) {
  const PUBLIC = 'id, email, name, status, platform_role, locale, push_preview, (totp_secret IS NOT NULL) AS mfa_enabled, created_at';

  const byId = (id) => db.get(`SELECT ${PUBLIC} FROM users WHERE id = ?`, [id]);
  const byEmail = (email) => db.get(`SELECT ${PUBLIC} FROM users WHERE email = ?`, [canonicalEmail(email)]);
  const credentials = (id) => db.get('SELECT id, password_hash, totp_secret FROM users WHERE id = ?', [id]);

  // insertStatement: for batches that create the user together with a
  // membership (invite acceptance, organization setup).
  function insertStatement({ id = newId(), email, name, passwordHash = null, platformRole = null, locale = null }) {
    const clean = canonicalEmail(email);
    if (!isEmail(clean)) throw appError('invalid', 'Invalid e-mail', { field: 'email' });
    const displayName = String(name || '').trim().slice(0, 80) || clean.split('@')[0];
    const at = nowIso();
    return {
      id,
      statement: [
        'INSERT INTO users (id, email, name, password_hash, platform_role, locale, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [id, clean, displayName, passwordHash, platformRole, locale, 'active', at, at],
      ],
    };
  }

  async function create(fields) {
    if (await byEmail(fields.email)) throw appError('conflict', 'E-mail already registered', { field: 'email' });
    const { id, statement } = insertStatement(fields);
    await db.run(...statement);
    return byId(id);
  }

  return {
    byId,
    byEmail,
    credentials,
    insertStatement,
    create,
    count: async () => (await db.get('SELECT COUNT(*) AS n FROM users')).n,
    setName: (id, name) => db.run('UPDATE users SET name = ?, updated_at = ? WHERE id = ?', [String(name).trim().slice(0, 80), nowIso(), id]),
    setLocale: (id, locale) => db.run('UPDATE users SET locale = ?, updated_at = ? WHERE id = ?', [locale, nowIso(), id]),
    setPasswordHash: (id, hash) => db.run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', [hash, nowIso(), id]),
    setTotpSecret: (id, encrypted) => db.run('UPDATE users SET totp_secret = ?, updated_at = ? WHERE id = ?', [encrypted, nowIso(), id]),
    setStatus: (id, status) => db.run('UPDATE users SET status = ?, updated_at = ? WHERE id = ?', [status, nowIso(), id]),
    listAll: ({ search = '', limit = 100 } = {}) =>
      db.all(`SELECT ${PUBLIC} FROM users WHERE (? = '' OR email LIKE '%' || ? || '%' OR name LIKE '%' || ? || '%') ORDER BY created_at DESC LIMIT ?`, [search, search, search, limit]),
  };
}
