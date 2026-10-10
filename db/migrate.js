import { readFileSync } from 'node:fs';
import path from 'node:path';

// Versioned changes after the first release. schema.sql only creates what is
// missing; anything that alters an existing table goes here with the next
// version number and is applied exactly once (recorded in schema_migrations).
export const MIGRATIONS = [
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
  // Per-organization e-mail sender (e.g. no-reply@company.com): mail about
  // an organization leaves from its own address; account mail (sign-in
  // codes, password reset) keeps the platform sender.
  [6, ['ALTER TABLE organizations ADD COLUMN email_from TEXT', 'ALTER TABLE organizations ADD COLUMN email_from_name TEXT']],
  // Push notifications: whether they show the message text (off: only
  // "new message from X").
  [7, ['ALTER TABLE users ADD COLUMN push_preview INTEGER NOT NULL DEFAULT 1']],
  // Groups are gone (a Space does all a group did): existing groups become
  // private Spaces whose members are all moderators (they had equal rights),
  // named after their members when they had no name. Notifications per
  // person and conversation: all | mentions | none (NULL = by size);
  // "muted" becomes "none".
  [
    8,
    [
      'ALTER TABLE conversation_members ADD COLUMN notify TEXT',
      "UPDATE conversation_members SET notify = 'none' WHERE muted = 1",
      "UPDATE conversation_members SET role = 'moderator' WHERE conversation_id IN (SELECT id FROM conversations WHERE type = 'group')",
      `UPDATE conversations SET type = 'space', visibility = 'private', name = COALESCE(NULLIF(TRIM(name), ''),
         (SELECT group_concat(n, ', ') FROM (SELECT u.name AS n FROM conversation_members cm JOIN users u ON u.id = cm.user_id WHERE cm.conversation_id = conversations.id ORDER BY u.name LIMIT 4)), 'Space')
       WHERE type = 'group'`,
    ],
  ],
  // "Ring into" a meeting under way, kept on the invitation (not in one
  // node's memory): until when the person rings, who rang, audio|video.
  [
    9,
    [
      'ALTER TABLE meeting_invitations ADD COLUMN ring_until TEXT',
      'ALTER TABLE meeting_invitations ADD COLUMN ring_by TEXT',
      'ALTER TABLE meeting_invitations ADD COLUMN ring_kind TEXT',
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
