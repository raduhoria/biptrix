import { readFileSync } from 'node:fs';
import path from 'node:path';

// Versioned changes after the first release. schema.sql only creates what is
// missing; anything that alters an existing table goes here with the next
// version number and is applied exactly once (recorded in schema_migrations).
const MIGRATIONS = [
  // Who accepted an invitation: lets the acceptance batch tell whether its
  // own conditional update won.
  [2, ['ALTER TABLE org_invites ADD COLUMN accepted_by TEXT']],
  // External collaborators: an invitation can target a Space (joined on
  // acceptance) and carry an access duration; their membership can expire.
  [
    3,
    [
      'ALTER TABLE org_invites ADD COLUMN conversation_id TEXT',
      'ALTER TABLE org_invites ADD COLUMN access_days INTEGER',
      'ALTER TABLE memberships ADD COLUMN access_expires_at TEXT',
    ],
  ],
  // Calls: a meeting started from a DM or group rings the other members
  // (audio or video call); ring_state: ringing | answered | declined | missed.
  [
    4,
    [
      'ALTER TABLE meetings ADD COLUMN call_kind TEXT',
      'ALTER TABLE meetings ADD COLUMN ring_state TEXT',
      'ALTER TABLE meetings ADD COLUMN ring_until TEXT',
    ],
  ],
  // Call cards of meetings that ended before cards were updated on close
  // (or simply ran past their end time) stop offering "Join".
  [
    5,
    [
      `UPDATE meetings SET state = 'ended', ended_at = expires_at WHERE state IN ('scheduled', 'open', 'live') AND expires_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
      `UPDATE messages SET version = version + 1, meta = json_set(COALESCE(messages.meta, '{}'),
         '$.state', mt.state, '$.ended_at', mt.ended_at, '$.outcome', mt.ring_state,
         '$.duration_s', CASE WHEN mt.started_at IS NOT NULL AND mt.ended_at IS NOT NULL THEN CAST(ROUND((julianday(mt.ended_at) - julianday(mt.started_at)) * 86400) AS INTEGER) END)
       FROM meetings mt
       WHERE messages.kind = 'meeting' AND mt.id = json_extract(messages.meta, '$.meeting_id') AND mt.state IN ('ended', 'canceled')`,
    ],
  ],
];

export async function runMigrations(db) {
  await db.exec(readFileSync(path.join(import.meta.dirname, 'schema.sql'), 'utf8'));
  const done = new Set((await db.all('SELECT version FROM schema_migrations')).map((r) => r.version));
  if (!done.has(1)) await db.run('INSERT INTO schema_migrations (version, applied_at) VALUES (1, ?)', [new Date().toISOString()]);
  for (const [version, statements] of MIGRATIONS) {
    if (done.has(version)) continue;
    await db.batch([...statements.map((sql) => [sql, []]), ['INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)', [version, new Date().toISOString()]]]);
  }
}
