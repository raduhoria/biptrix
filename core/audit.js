import { newId, nowIso } from './util.js';

// Append-only audit trail (spec §6, §10, §15): administrative actions,
// policy changes, invitations, privileged access. Rows are never updated.
export function createAudit(db) {
  function entry({ orgId = null, actor = null, action, resourceType = null, resourceId = null, data = null, ip = null }) {
    return [
      `INSERT INTO audit_events (id, org_id, actor_id, actor_label, action, resource_type, resource_id, data, ip, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [newId(), orgId, actor?.id || null, actor?.email || actor?.label || null, action, resourceType, resourceId, data ? JSON.stringify(data) : null, ip, nowIso()],
    ];
  }

  // statement(): to include the audit row in the same atomic batch as the
  // change it describes; log(): standalone.
  return {
    statement: entry,
    log: (fields) => db.run(...entry(fields)),
    list: ({ orgId, action = '', limit = 100, before = '' }) =>
      db.all(
        `SELECT * FROM audit_events WHERE org_id IS ? AND (? = '' OR action LIKE ? || '%') AND (? = '' OR created_at < ?)
         ORDER BY created_at DESC LIMIT ?`,
        [orgId, action, action, before, before, limit]
      ),
  };
}
