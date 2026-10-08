import { nowIso } from './util.js';

// Durable event log (spec §11–12). Writers add events inside the same atomic
// batch as the change (events.statement / messageEvent), so an event exists
// if and only if its change was committed. Delivery has a single path:
// pump() reads the log after the last dispatched id and hands each event to
// the realtime hub — after a local write (notify()) and, in a multi-node
// deployment, on a short timer, so events written by other Node instances
// reach this node's sockets too. Lost wake-ups only add latency: the log is
// the source of truth and clients resume from their own cursor (system.sync).

// Serialized message snapshot, built by SQLite itself so the same JSON is used
// for events, history pages and sync. Deleted messages lose body and files.
export const MESSAGE_JSON = `json_object(
  'id', m.id, 'conversation_id', m.conversation_id, 'seq', m.seq, 'author_id', m.author_id,
  'client_message_id', m.client_message_id, 'kind', m.kind,
  'body', CASE WHEN m.deleted_at IS NULL THEN m.body ELSE '' END,
  'meta', json(COALESCE(m.meta, 'null')), 'parent_id', m.parent_id, 'reply_count', m.reply_count,
  'version', m.version, 'pinned_at', m.pinned_at, 'edited_at', m.edited_at, 'deleted_at', m.deleted_at,
  'created_at', m.created_at,
  'reactions', json((SELECT json_group_array(json_object('emoji', r.emoji, 'user_id', r.user_id)) FROM reactions r WHERE r.message_id = m.id)),
  'attachments', CASE WHEN m.deleted_at IS NULL THEN json((SELECT json_group_array(json_object('id', a.id, 'name', a.name, 'mime', a.mime, 'size', a.size)) FROM attachments a WHERE a.message_id = m.id)) ELSE json('[]') END
)`;

const SYNC_LIMIT = 500;

export function createEvents({ db, nodeId, cluster, pollMs = 400 }) {
  let cursor = 0;
  let pumping = false;
  let again = false;
  let timer = null;
  let deliver = () => {};

  // An event row as a batch statement. Scope: conversationId (its members),
  // userId (that user), or neither (the whole organization).
  function statement({ orgId, conversationId = null, userId = null, type, data }) {
    return [
      'INSERT INTO events (org_id, conversation_id, user_id, type, data, node_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [orgId, conversationId, userId, type, JSON.stringify(data), nodeId, nowIso()],
    ];
  }

  // A message.created / message.updated event whose payload is the message
  // row as committed (only inserted if that message exists).
  function messageEvent(type, messageId) {
    return [
      `INSERT INTO events (org_id, conversation_id, user_id, type, data, node_id, created_at)
       SELECT m.org_id, m.conversation_id, NULL, ?, ${MESSAGE_JSON}, ?, ? FROM messages m WHERE m.id = ?`,
      [type, nodeId, nowIso(), messageId],
    ];
  }

  async function pump() {
    if (pumping) {
      again = true;
      return;
    }
    pumping = true;
    try {
      do {
        again = false;
        const rows = await db.all('SELECT * FROM events WHERE id > ? ORDER BY id LIMIT 1000', [cursor]);
        for (const row of rows) {
          cursor = row.id;
          try {
            await deliver({ ...row, data: JSON.parse(row.data) });
          } catch (err) {
            console.error('Event delivery failed:', err.message);
          }
        }
        if (rows.length === 1000) again = true;
      } while (again);
    } catch (err) {
      console.error('Event pump failed:', err.message);
    } finally {
      pumping = false;
    }
  }

  async function start(onEvent) {
    deliver = onEvent;
    cursor = (await db.get('SELECT COALESCE(MAX(id), 0) AS id FROM events')).id;
    if (cluster) {
      timer = setInterval(pump, pollMs);
      timer.unref();
    }
  }

  // Events visible to one user in one org after `since`. More than SYNC_LIMIT
  // (or a cursor older than the retained log) → { reset: true }: the client
  // reloads its state instead of replaying.
  async function since(orgId, userId, sinceId) {
    const oldest = await db.get('SELECT MIN(id) AS id FROM events WHERE org_id = ?', [orgId]);
    if (sinceId && oldest?.id && sinceId < oldest.id - 1) return { reset: true, events: [], cursor };
    const rows = await db.all(
      `SELECT * FROM events WHERE org_id = ? AND id > ? AND (
         user_id = ?
         OR (user_id IS NULL AND conversation_id IN (SELECT conversation_id FROM conversation_members WHERE user_id = ?))
         OR (user_id IS NULL AND conversation_id IS NULL))
       ORDER BY id LIMIT ?`,
      [orgId, sinceId, userId, userId, SYNC_LIMIT + 1]
    );
    if (rows.length > SYNC_LIMIT) return { reset: true, events: [], cursor };
    return { reset: false, events: rows.map((r) => ({ ...r, data: JSON.parse(r.data) })), cursor: rows.at(-1)?.id || sinceId };
  }

  return {
    statement,
    messageEvent,
    notify: () => {
      pump();
    },
    pump,
    start,
    since,
    cursor: () => cursor,
    stop: () => clearInterval(timer),
    // Retention of the replay log; clients older than this do a full reload.
    prune: (days = 7) => db.run('DELETE FROM events WHERE created_at < ?', [new Date(Date.now() - days * 86400_000).toISOString()]),
  };
}
