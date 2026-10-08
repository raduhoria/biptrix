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
