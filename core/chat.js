import { MESSAGE_JSON } from './events.js';
import { can, isAdminRole } from './orgs.js';
import { appError, newId, nowIso, parseJson } from './util.js';

const MAX_BODY = 10_000;
const MAX_ATTACHMENTS = 10;
const PAGE = 50;
// Up to this many members a Space behaves like a small team: calls ring
// everyone and every message notifies (each person can change it).
export const SMALL_SPACE = 20;
// Mentions are stored in the body as <@userId>; the client renders names.
const MENTION_RE = /<@([A-Za-z0-9_-]{10,40})>/g;
const EMOJI_RE = /^[^\s<>"'`]{1,16}$/;

const period = () => nowIso().slice(0, 7);
// Usage counter increment, only when `guard` holds (e.g. the message was
// really inserted — a concurrent retry must not count twice).
const usage = (orgId, metric, n = 1, guard = '1', guardArgs = []) => [
  `INSERT INTO usage_counters (org_id, period, metric, value) SELECT ?, ?, ?, ? WHERE ${guard}
   ON CONFLICT(org_id, period, metric) DO UPDATE SET value = value + excluded.value`,
  [orgId, period(), metric, n, ...guardArgs],
];

// createChat: conversations (DM, groups, Spaces), memberships and messages
// (spec §7). Every read and write is scoped by organization and checked
// against the caller's conversation membership here, server-side.
export function createChat({ db, events, audit, policies }) {
  const parseMessage = (row) => (row ? JSON.parse(row.json) : null);

  // --------------------------------------------------------- conversations

  // A person's notifications for a conversation: their choice, or by size —
  // everything in a DM or a Space of up to SMALL_SPACE people, only mentions
  // in a bigger one.
  const notifyLevel = (conv, member) => member.notify || (member.muted ? 'none' : conv.type === 'dm' || conv.member_count <= SMALL_SPACE ? 'all' : 'mentions');


  async function requireConversation(org, user, conversationId) {
    const row = await db.get(
      `SELECT c.*, cm.role AS my_role, cm.last_read_seq FROM conversations c
       JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = ?
       WHERE c.id = ? AND c.org_id = ?`,
      [user.id, conversationId, org.id]
    );
    if (!row) throw appError('not_found', 'Conversation not found');
    return row;
  }

  // Moderation rights: Space moderators, org owners/admins (spaces only);
  // DMs and groups have no moderators.
  const canModerate = (conv, orgRole) => conv.type === 'space' && (conv.my_role === 'moderator' || orgRole === 'owner' || orgRole === 'admin');

  const conversationJson = `json_object(
    'id', c.id, 'type', c.type, 'name', c.name, 'description', c.description, 'visibility', c.visibility,
    'last_seq', c.last_seq, 'last_message_at', c.last_message_at, 'created_at', c.created_at, 'created_by', c.created_by,
    'member_count', (SELECT COUNT(*) FROM conversation_members x WHERE x.conversation_id = c.id),
    'external_count', (SELECT COUNT(*) FROM conversation_members x JOIN memberships xm ON xm.user_id = x.user_id AND xm.org_id = c.org_id
                       WHERE x.conversation_id = c.id AND xm.role = 'external'),
    'member_ids', CASE WHEN c.type = 'space' THEN json('[]') ELSE json((SELECT json_group_array(x.user_id) FROM conversation_members x WHERE x.conversation_id = c.id)) END
  )`;

  async function list(org, user) {
    const rows = await db.all(
      `SELECT ${conversationJson} AS json, cm.last_read_seq, cm.role, cm.muted, cm.notify,
         (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.seq > cm.last_read_seq AND m.author_id IS NOT ? AND m.deleted_at IS NULL) AS unread,
         (SELECT COUNT(*) FROM message_mentions mm WHERE mm.user_id = ? AND mm.conversation_id = c.id AND mm.seq > cm.last_read_seq) AS mentions,
         (SELECT json_object('author_id', m.author_id, 'body', CASE WHEN m.deleted_at IS NULL THEN substr(m.body, 1, 140) ELSE '' END, 'kind', m.kind, 'created_at', m.created_at)
            FROM messages m WHERE m.conversation_id = c.id AND m.seq = c.last_seq) AS last_message
       FROM conversation_members cm JOIN conversations c ON c.id = cm.conversation_id
       WHERE cm.user_id = ? AND c.org_id = ? AND c.archived_at IS NULL
       ORDER BY COALESCE(c.last_message_at, c.created_at) DESC`,
      [user.id, user.id, user.id, org.id]
    );
    return rows.map((r) => ({ ...JSON.parse(r.json), last_read_seq: r.last_read_seq, my_role: r.role, muted: !!r.muted, notify: notifyLevel(JSON.parse(r.json), r), unread: r.unread, mentions: r.mentions, last_message: parseJson(r.last_message, null) }));
  }

  // One conversation of `org` the user belongs to (null otherwise).
  async function one(org, conversationId, user) {
    const row = await db.get(
      `SELECT ${conversationJson} AS json, cm.last_read_seq, cm.role, cm.muted, cm.notify,
         (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.seq > cm.last_read_seq AND m.author_id IS NOT ? AND m.deleted_at IS NULL) AS unread,
         (SELECT COUNT(*) FROM message_mentions mm WHERE mm.user_id = ? AND mm.conversation_id = c.id AND mm.seq > cm.last_read_seq) AS mentions
       FROM conversations c JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = ? WHERE c.id = ? AND c.org_id = ?`,
      [user.id, user.id, user.id, conversationId, org.id]
    );
    return row ? { ...JSON.parse(row.json), last_read_seq: row.last_read_seq, my_role: row.role, muted: !!row.muted, notify: notifyLevel(JSON.parse(row.json), row), unread: row.unread, mentions: row.mentions } : null;
  }

  // Users the caller may address: everyone active in the org, except for
  // external collaborators, who only see people they already share a
  // conversation with.
  // (Only current access: a collaborator whose access expired is gone at
  // once, before the maintenance sweep revokes the membership.)
  async function directory(org, user, role) {
    const current = "m.status = 'active' AND (m.access_expires_at IS NULL OR m.access_expires_at > ?) AND u.status = 'active'";
    if (can(role, 'directory')) {
      return db.all(
        `SELECT u.id, u.name, u.email, m.role, m.title, m.department FROM memberships m JOIN users u ON u.id = m.user_id
         WHERE m.org_id = ? AND ${current} ORDER BY u.name COLLATE NOCASE`,
        [org.id, nowIso()]
      );
    }
    return db.all(
      `SELECT DISTINCT u.id, u.name, u.email, m.role, m.title, m.department FROM conversation_members a
       JOIN conversations c ON c.id = a.conversation_id AND c.org_id = ?
       JOIN conversation_members b ON b.conversation_id = a.conversation_id
       JOIN users u ON u.id = b.user_id JOIN memberships m ON m.user_id = u.id AND m.org_id = c.org_id
       WHERE a.user_id = ? AND ${current} ORDER BY u.name COLLATE NOCASE`,
      [org.id, user.id, nowIso()]
    );
  }

  // All ids must be active members of the org (and visible to the caller).
  async function assertMembers(org, user, role, ids) {
    const allowed = new Set((await directory(org, user, role)).map((u) => u.id));
    for (const id of ids) if (!allowed.has(id)) throw appError('forbidden', 'User is not reachable in this organization');
  }

  // External collaborators join a Space only as the collaborator policy
  // allows (enabled, who may add them, their domain), whichever path adds
  // them: an invitation, the member picker, Space creation.
  async function assertCollaboratorsAllowed(org, role, spaceRole, ids) {
    if (!ids.length) return;
    const externals = await db.all(
      `SELECT u.email FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? AND m.role = 'external' AND m.user_id IN (${ids.map(() => '?').join(',')})`,
      [org.id, ...ids]
    );
    if (!externals.length) return;
    const policy = await policies.get(org.id);
    for (const { email } of externals) policies.assertCanInviteCollaborator({ policy, orgRole: role, spaceRole, email });
  }

  function memberRows(conversationId, ids, at, roleFor = () => 'member') {
    return ids.map((id) => [
      'INSERT OR IGNORE INTO conversation_members (conversation_id, user_id, role, last_read_seq, joined_at) VALUES (?, ?, ?, (SELECT last_seq FROM conversations WHERE id = ?), ?)',
      [conversationId, id, roleFor(id), conversationId, at],
    ]);
  }

  async function openDm(org, user, role, otherId) {
    await assertMembers(org, user, role, [otherId]);
    const key = [user.id, otherId].sort().join(':');
    const existing = await db.get('SELECT id FROM conversations WHERE org_id = ? AND dm_key = ?', [org.id, key]);
    if (existing) {
      // A DM survives membership changes; make sure the caller is (back) in it.
      await db.batch(memberRows(existing.id, [user.id], nowIso()));
      return one(org, existing.id, user);
    }
    const id = newId();
    const at = nowIso();
    await db.batch([
      ['INSERT OR IGNORE INTO conversations (id, org_id, type, dm_key, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)', [id, org.id, 'dm', key, user.id, at]],
      ...memberRows(id, [...new Set([user.id, otherId])], at),
      events.statement({ orgId: org.id, conversationId: id, type: 'conversation.created', data: { id } }),
    ]);
    events.notify();
    const created = await db.get('SELECT id FROM conversations WHERE org_id = ? AND dm_key = ?', [org.id, key]);
    return one(org, created.id, user);
  }

  async function createSpace(org, user, role, { name, description = '', visibility = 'public', memberIds = [] }, ip) {
    if (!can(role, 'spaces.browse')) throw appError('forbidden', 'External collaborators cannot create Spaces');
    const cleanName = String(name || '').trim().slice(0, 80);
    if (!cleanName) throw appError('invalid', 'Name required', { field: 'name' });
    const ids = [...new Set(memberIds)].filter((id) => id !== user.id).slice(0, 500);
    await assertMembers(org, user, role, ids);
    await assertCollaboratorsAllowed(org, role, 'moderator', ids);
    const id = newId();
    const at = nowIso();
    await db.batch([
      [
        'INSERT INTO conversations (id, org_id, type, name, description, visibility, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [id, org.id, 'space', cleanName, String(description).trim().slice(0, 500), visibility === 'private' ? 'private' : 'public', user.id, at],
      ],
      ...memberRows(id, [user.id, ...ids], at, (uid) => (uid === user.id ? 'moderator' : 'member')),
      events.statement({ orgId: org.id, conversationId: id, type: 'conversation.created', data: { id } }),
      audit.statement({ orgId: org.id, actor: user, action: 'space.create', resourceType: 'space', resourceId: id, ip, data: { name: cleanName, visibility } }),
    ]);
    events.notify();
    return one(org, id, user);
  }

  const browseSpaces = (org, user) =>
    db.all(
      `SELECT c.id, c.name, c.description, c.created_at,
         (SELECT COUNT(*) FROM conversation_members x WHERE x.conversation_id = c.id) AS member_count,
         EXISTS (SELECT 1 FROM conversation_members x WHERE x.conversation_id = c.id AND x.user_id = ?) AS joined
       FROM conversations c WHERE c.org_id = ? AND c.type = 'space' AND c.visibility = 'public' AND c.archived_at IS NULL
       ORDER BY c.name COLLATE NOCASE`,
      [user.id, org.id]
    );

  async function joinSpace(org, user, role, spaceId) {
    if (!can(role, 'spaces.browse')) throw appError('forbidden', 'Not allowed');
    const space = await db.get("SELECT * FROM conversations WHERE id = ? AND org_id = ? AND type = 'space' AND archived_at IS NULL", [spaceId, org.id]);
    if (!space || space.visibility !== 'public') throw appError('not_found', 'Space not found');
    await db.batch([...memberRows(space.id, [user.id], nowIso()), events.statement({ orgId: org.id, conversationId: space.id, type: 'conversation.members', data: { id: space.id, added: [user.id] } })]);
    events.notify();
    return one(org, space.id, user);
  }

  async function members(org, user, conversationId) {
    await requireConversation(org, user, conversationId);
    return db.all(
      `SELECT u.id, u.name, u.email, cm.role, cm.last_read_seq FROM conversation_members cm JOIN users u ON u.id = cm.user_id
       WHERE cm.conversation_id = ? ORDER BY u.name COLLATE NOCASE`,
      [conversationId]
    );
  }

  async function addMembers(org, user, role, conversationId, ids, ip) {
    const conv = await requireConversation(org, user, conversationId);
    if (conv.type === 'dm') throw appError('invalid', 'Direct messages have exactly two people');
    if (conv.type === 'space' && conv.visibility === 'private' && !canModerate(conv, role)) throw appError('forbidden', 'Only moderators can add people');
    const clean = [...new Set(ids)].slice(0, 500);
    await assertMembers(org, user, role, clean);
    if (conv.type === 'space') await assertCollaboratorsAllowed(org, role, conv.my_role, clean);
    await db.batch([
      ...memberRows(conv.id, clean, nowIso()),
      events.statement({ orgId: org.id, conversationId: conv.id, type: 'conversation.members', data: { id: conv.id, added: clean } }),
      audit.statement({ orgId: org.id, actor: user, action: 'conversation.add_members', resourceType: conv.type, resourceId: conv.id, ip, data: { users: clean } }),
    ]);
    events.notify();
  }

  // Leave (self) or remove (moderator/admin). The removed user is told on a
  // user-scoped event; the remaining members get conversation.members.
  async function removeMember(org, user, role, conversationId, targetId, ip) {
    const conv = await requireConversation(org, user, conversationId);
    if (conv.type === 'dm') throw appError('invalid', 'Cannot leave a direct message');
    if (targetId !== user.id && !canModerate(conv, role)) throw appError('forbidden', 'Only moderators can remove people');
    await db.batch([
      ['DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?', [conv.id, targetId]],
      events.statement({ orgId: org.id, userId: targetId, type: 'conversation.removed', data: { id: conv.id } }),
      events.statement({ orgId: org.id, conversationId: conv.id, type: 'conversation.members', data: { id: conv.id, removed: [targetId] } }),
      audit.statement({ orgId: org.id, actor: user, action: targetId === user.id ? 'conversation.leave' : 'conversation.remove_member', resourceType: conv.type, resourceId: conv.id, ip, data: { user: targetId } }),
    ]);
    events.notify();
  }

  async function setMemberRole(org, user, role, conversationId, targetId, memberRole, ip) {
    const conv = await requireConversation(org, user, conversationId);
    if (!canModerate(conv, role)) throw appError('forbidden', 'Only moderators can change roles');
    const next = memberRole === 'moderator' ? 'moderator' : 'member';
    await db.batch([
      ['UPDATE conversation_members SET role = ? WHERE conversation_id = ? AND user_id = ?', [next, conv.id, targetId]],
      events.statement({ orgId: org.id, conversationId: conv.id, type: 'conversation.members', data: { id: conv.id, role: { [targetId]: next } } }),
      audit.statement({ orgId: org.id, actor: user, action: 'space.member_role', resourceType: 'space', resourceId: conv.id, ip, data: { user: targetId, role: next } }),
    ]);
    events.notify();
  }

  // Space settings (moderators, org owners/admins): name, description,
  // visibility. Going public opens the whole history to anyone in the org
  // who joins — the client warns before that.
  async function update(org, user, role, conversationId, { name, description, visibility }, ip) {
    const conv = await requireConversation(org, user, conversationId);
    if (conv.type === 'dm') throw appError('invalid', 'Direct messages have no name');
    if (conv.type === 'space' && !canModerate(conv, role)) throw appError('forbidden', 'Only moderators can edit a Space');
    const nextName = name === undefined ? conv.name : String(name).trim().slice(0, 80) || (conv.type === 'space' ? conv.name : null);
    const nextDescription = description === undefined ? conv.description : String(description).trim().slice(0, 500);
    const nextVisibility = conv.type === 'space' && ['public', 'private'].includes(visibility) ? visibility : conv.visibility;
    const changes = {};
    if (nextName !== conv.name) changes.name = { from: conv.name, to: nextName };
    if (nextDescription !== conv.description) changes.description = true;
    if (nextVisibility !== conv.visibility) changes.visibility = { from: conv.visibility, to: nextVisibility };
    await db.batch([
      ['UPDATE conversations SET name = ?, description = ?, visibility = ? WHERE id = ?', [nextName, nextDescription, nextVisibility, conv.id]],
      events.statement({ orgId: org.id, conversationId: conv.id, type: 'conversation.updated', data: { id: conv.id, name: nextName, description: nextDescription, visibility: nextVisibility } }),
      audit.statement({ orgId: org.id, actor: user, action: 'conversation.update', resourceType: conv.type, resourceId: conv.id, ip, data: changes }),
    ]);
    events.notify();
  }

  // Archiving from the Space itself (moderators, owners/admins): read-only
  // and out of everyone's list; un-archiving stays in the admin console.
  async function archiveOwn(org, user, role, conversationId, ip) {
    const conv = await requireConversation(org, user, conversationId);
    if (conv.type !== 'space' || !canModerate(conv, role)) throw appError('forbidden', 'Only moderators can archive a Space');
    await archiveSpace(org, user, conv.id, true, ip);
  }

  async function archiveSpace(org, actor, spaceId, archived, ip) {
    await db.batch([
      ["UPDATE conversations SET archived_at = ? WHERE id = ? AND org_id = ? AND type = 'space'", [archived ? nowIso() : null, spaceId, org.id]],
      events.statement({ orgId: org.id, conversationId: spaceId, type: 'conversation.updated', data: { id: spaceId, archived: !!archived } }),
      audit.statement({ orgId: org.id, actor, action: archived ? 'space.archive' : 'space.unarchive', resourceType: 'space', resourceId: spaceId, ip }),
    ]);
    events.notify();
  }

  const allSpaces = (org) =>
    db.all(
      `SELECT c.id, c.name, c.visibility, c.archived_at, c.created_at, c.last_message_at, u.name AS creator,
         (SELECT COUNT(*) FROM conversation_members x WHERE x.conversation_id = c.id) AS member_count
       FROM conversations c LEFT JOIN users u ON u.id = c.created_by WHERE c.org_id = ? AND c.type = 'space' ORDER BY c.name COLLATE NOCASE`,
      [org.id]
    );

  // Recipients of a conversation event (read at delivery time): members
  // whose organization access is still valid — an expired collaborator
  // receives nothing even before the maintenance sweep removes them.
  const memberIds = async (conversationId) =>
    (
      await db.all(
        `SELECT cm.user_id FROM conversation_members cm JOIN conversations c ON c.id = cm.conversation_id
         JOIN memberships m ON m.org_id = c.org_id AND m.user_id = cm.user_id
         WHERE cm.conversation_id = ? AND m.status = 'active' AND (m.access_expires_at IS NULL OR m.access_expires_at > ?)`,
        [conversationId || '', nowIso()]
      )
    ).map((r) => r.user_id);

  // ---------------------------------------------------------------- messages

  async function history(org, user, conversationId, { before, after, parentId, limit }) {
    await requireConversation(org, user, conversationId);
    const n = Math.min(Math.max(Number(limit) || PAGE, 1), 200);
    const thread = parentId ? 'm.parent_id = ?' : 'm.parent_id IS NULL';
    const args = parentId ? [conversationId, parentId] : [conversationId];
    let rows;
    if (after !== undefined && after !== '') {
      rows = await db.all(`SELECT ${MESSAGE_JSON} AS json FROM messages m WHERE m.conversation_id = ? AND ${thread} AND m.seq > ? ORDER BY m.seq LIMIT ?`, [...args, Number(after), n]);
    } else {
      const top = before !== undefined && before !== '' ? Number(before) : Number.MAX_SAFE_INTEGER;
      rows = (await db.all(`SELECT ${MESSAGE_JSON} AS json FROM messages m WHERE m.conversation_id = ? AND ${thread} AND m.seq < ? ORDER BY m.seq DESC LIMIT ?`, [...args, top, n])).reverse();
    }
    const messages = rows.map(parseMessage);
    const parent = parentId ? parseMessage(await db.get(`SELECT ${MESSAGE_JSON} AS json FROM messages m WHERE m.id = ? AND m.conversation_id = ?`, [parentId, conversationId])) : null;
    return { messages, parent, has_more: messages.length === n };
  }

  async function mentionIds(conversationId, body) {
    const ids = [...new Set([...String(body).matchAll(MENTION_RE)].map((m) => m[1]))].slice(0, 50);
    if (!ids.length) return [];
    const rows = await db.all(`SELECT user_id FROM conversation_members WHERE conversation_id = ? AND user_id IN (${ids.map(() => '?').join(',')})`, [conversationId, ...ids]);
    return rows.map((r) => r.user_id);
  }

  // send: persist-once. A retry with the same client_message_id returns the
  // already stored message (duplicate: true) and creates no new event.
  // The ACK "persisted" is sent by the caller only after this resolves, i.e.
  // after the batch committed (SQLite transaction / rqlite quorum).
  async function send(org, user, { conversationId, clientMessageId, body = '', parentId = null, attachmentIds = [], kind = 'text', meta = null }) {
    const conv = await requireConversation(org, user, conversationId);
    if (conv.archived_at) throw appError('forbidden', 'Space archived');
    const cid = String(clientMessageId || '').slice(0, 64);
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(cid)) throw appError('invalid', 'client_message_id required');
    const text = String(body || '').replace(/\r\n/g, '\n').trim();
    if (text.length > MAX_BODY) throw appError('invalid', 'Message too long', { max: MAX_BODY });
    const files = [...new Set(Array.isArray(attachmentIds) ? attachmentIds : [])].slice(0, MAX_ATTACHMENTS + 1);
    if (files.length > MAX_ATTACHMENTS) throw appError('invalid', 'Too many attachments');
    if (!text && !files.length && kind === 'text') throw appError('invalid', 'Empty message');

    const existing = await db.get(`SELECT ${MESSAGE_JSON} AS json FROM messages m WHERE m.conversation_id = ? AND m.author_id = ? AND m.client_message_id = ?`, [conv.id, user.id, cid]);
    if (existing) return { message: parseMessage(existing), duplicate: true };

    if (parentId) {
      const parent = await db.get('SELECT id, parent_id FROM messages WHERE id = ? AND conversation_id = ? AND deleted_at IS NULL', [parentId, conv.id]);
      if (!parent || parent.parent_id) throw appError('invalid', 'Replies attach to a top-level message');
    }
    if (files.length) {
      const owned = await db.get(
        `SELECT COUNT(*) AS n FROM attachments WHERE org_id = ? AND uploader_id = ? AND message_id IS NULL AND id IN (${files.map(() => '?').join(',')})`,
        [org.id, user.id, ...files]
      );
      if (owned.n !== files.length) throw appError('invalid', 'Unknown attachment');
    }
    const mentioned = await mentionIds(conv.id, text);
    const id = newId();
    const at = nowIso();
    // Every effect of the send depends on two guards evaluated inside the
    // same atomic batch: not a duplicate of an already stored message, and
    // (with files) every attachment still unattached — a concurrent send
    // that grabbed a file first makes this one fail cleanly instead of
    // saving an empty message.
    const fileList = files.map(() => '?').join(',');
    const go = `NOT EXISTS (SELECT 1 FROM messages WHERE conversation_id = ? AND author_id = ? AND client_message_id = ?)${
      files.length ? ` AND (SELECT COUNT(*) FROM attachments WHERE id IN (${fileList}) AND uploader_id = ? AND message_id IS NULL) = ${files.length}` : ''
    }`;
    const goArgs = [conv.id, user.id, cid, ...(files.length ? [...files, user.id] : [])];
    const inserted = 'EXISTS (SELECT 1 FROM messages WHERE id = ?)';

    const statements = [
      [`UPDATE conversations SET last_seq = last_seq + 1, last_message_at = ? WHERE id = ? AND ${go}`, [at, conv.id, ...goArgs]],
      [
        `INSERT OR IGNORE INTO messages (id, org_id, conversation_id, seq, author_id, client_message_id, kind, body, meta, parent_id, created_at)
         SELECT ?, ?, ?, c.last_seq, ?, ?, ?, ?, ?, ?, ? FROM conversations c WHERE c.id = ? AND ${go}`,
        [id, org.id, conv.id, user.id, cid, kind, text, meta ? JSON.stringify(meta) : null, parentId, at, conv.id, ...goArgs],
      ],
      [`UPDATE conversation_members SET last_read_seq = (SELECT seq FROM messages WHERE id = ?) WHERE conversation_id = ? AND user_id = ? AND ${inserted}`, [id, conv.id, user.id, id]],
      usage(org.id, 'messages', 1, inserted, [id]),
    ];
    if (parentId) {
      statements.push([`UPDATE messages SET reply_count = reply_count + 1 WHERE id = ? AND ${inserted}`, [parentId, id]], events.messageEvent('message.updated', parentId, inserted, [id]));
    }
    if (files.length) {
      statements.push([`UPDATE attachments SET message_id = ?, conversation_id = ? WHERE id IN (${fileList}) AND uploader_id = ? AND message_id IS NULL AND ${inserted}`, [id, conv.id, ...files, user.id, id]]);
    }
    // Last, so the event snapshot includes the linked attachments.
    statements.push(events.messageEvent('message.created', id));
    for (const uid of mentioned) {
      statements.push(['INSERT OR IGNORE INTO message_mentions (message_id, user_id, conversation_id, seq) SELECT id, ?, conversation_id, seq FROM messages WHERE id = ?', [uid, id]]);
    }
    await db.batch(statements);
    events.notify();
    const stored = await db.get(`SELECT ${MESSAGE_JSON} AS json FROM messages m WHERE m.conversation_id = ? AND m.author_id = ? AND m.client_message_id = ?`, [conv.id, user.id, cid]);
    if (!stored) throw appError('conflict', 'Attachment already used by another message', { reason: 'attachmentUsed' });
    const message = parseMessage(stored);
    return { message, duplicate: message.id !== id, mentioned };
  }

  async function requireMessage(conv, messageId) {
    const row = await db.get('SELECT * FROM messages WHERE id = ? AND conversation_id = ?', [messageId, conv.id]);
    if (!row) throw appError('not_found', 'Message not found');
    return row;
  }

  async function edit(org, user, { conversationId, messageId, body, version }) {
    const conv = await requireConversation(org, user, conversationId);
    const msg = await requireMessage(conv, messageId);
    if (msg.author_id !== user.id || msg.kind !== 'text') throw appError('forbidden', 'Only the author can edit');
    if (msg.deleted_at) throw appError('invalid', 'Message deleted');
    const text = String(body || '').replace(/\r\n/g, '\n').trim();
    if (!text || text.length > MAX_BODY) throw appError('invalid', 'Invalid message');
    if (Number(version) !== msg.version) throw appError('stale_version', 'Message changed meanwhile');
    const mentioned = await mentionIds(conv.id, text);
    const at = nowIso();
    // Mentions, the event and the scrub of older event copies only apply if
    // this edit is the one that won (version bumped by us, our text in place).
    const won = 'EXISTS (SELECT 1 FROM messages WHERE id = ? AND version = ? AND body = ? AND edited_at = ?)';
    const wonArgs = [msg.id, msg.version + 1, text, at];
    const results = await db.batch([
      ['UPDATE messages SET body = ?, edited_at = ?, version = version + 1 WHERE id = ? AND version = ?', [text, at, msg.id, msg.version]],
      [`DELETE FROM message_mentions WHERE message_id = ? AND ${won}`, [msg.id, ...wonArgs]],
      ...mentioned.map((uid) => [`INSERT OR IGNORE INTO message_mentions (message_id, user_id, conversation_id, seq) SELECT ?, ?, ?, ? WHERE ${won}`, [msg.id, uid, conv.id, msg.seq, ...wonArgs]]),
      // Earlier event copies must not keep serving the old text.
      [`UPDATE events SET data = json_set(data, '$.body', ?) WHERE conversation_id = ? AND type IN ('message.created', 'message.updated') AND json_extract(data, '$.id') = ? AND ${won}`, [text, conv.id, msg.id, ...wonArgs]],
      events.messageEvent('message.updated', msg.id, won, wonArgs),
    ]);
    if (!results[0].changes) throw appError('stale_version', 'Message changed meanwhile');
    events.notify();
  }

  async function remove(org, user, role, { conversationId, messageId }, ip) {
    const conv = await requireConversation(org, user, conversationId);
    const msg = await requireMessage(conv, messageId);
    const moderated = msg.author_id !== user.id;
    if (moderated && !canModerate(conv, role)) throw appError('forbidden', 'Only the author or a moderator can delete');
    if (msg.deleted_at) return;
    await db.batch([
      ["UPDATE messages SET body = '', deleted_at = ?, pinned_at = NULL, version = version + 1 WHERE id = ?", [nowIso(), msg.id]],
      ['DELETE FROM message_mentions WHERE message_id = ?', [msg.id]],
      ['DELETE FROM reactions WHERE message_id = ?', [msg.id]],
      // Files go with the message (the trigger queues the stored bytes for
      // deletion), and earlier event copies lose the text and file list.
      ['DELETE FROM attachments WHERE message_id = ?', [msg.id]],
      [
        `UPDATE events SET data = json_set(data, '$.body', '', '$.attachments', json('[]')) WHERE conversation_id = ? AND type IN ('message.created', 'message.updated') AND json_extract(data, '$.id') = ?`,
        [conv.id, msg.id],
      ],
      events.messageEvent('message.updated', msg.id),
      ...(moderated ? [audit.statement({ orgId: org.id, actor: user, action: 'message.moderate_delete', resourceType: 'message', resourceId: msg.id, ip, data: { conversation: conv.id, author: msg.author_id } })] : []),
    ]);
    events.notify();
  }

  async function react(org, user, { conversationId, messageId, emoji }) {
    const conv = await requireConversation(org, user, conversationId);
    const msg = await requireMessage(conv, messageId);
    if (msg.deleted_at) throw appError('invalid', 'Message deleted');
    const value = String(emoji || '').trim();
    if (!EMOJI_RE.test(value)) throw appError('invalid', 'Invalid reaction');
    const has = await db.get('SELECT 1 AS x FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?', [msg.id, user.id, value]);
    await db.batch([
      has
        ? ['DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?', [msg.id, user.id, value]]
        : ['INSERT OR IGNORE INTO reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)', [msg.id, user.id, value, nowIso()]],
      ['UPDATE messages SET version = version + 1 WHERE id = ?', [msg.id]],
      events.messageEvent('message.updated', msg.id),
    ]);
    events.notify();
  }

  async function pin(org, user, role, { conversationId, messageId, pinned }, ip) {
    const conv = await requireConversation(org, user, conversationId);
    if (conv.type === 'space' && !canModerate(conv, role)) throw appError('forbidden', 'Only moderators can pin in a Space');
    const msg = await requireMessage(conv, messageId);
    if (msg.deleted_at) throw appError('invalid', 'Message deleted');
    await db.batch([
      ['UPDATE messages SET pinned_at = ?, pinned_by = ?, version = version + 1 WHERE id = ?', [pinned ? nowIso() : null, pinned ? user.id : null, msg.id]],
      events.messageEvent('message.updated', msg.id),
    ]);
    events.notify();
  }

  async function pinned(org, user, conversationId) {
    await requireConversation(org, user, conversationId);
    const rows = await db.all(`SELECT ${MESSAGE_JSON} AS json FROM messages m WHERE m.conversation_id = ? AND m.pinned_at IS NOT NULL ORDER BY m.pinned_at DESC LIMIT 50`, [conversationId]);
    return rows.map(parseMessage);
  }

  // Read state (separate from "persisted"): the highest seq the user has
  // seen. Members are told so DMs can show "seen".
  async function markRead(org, user, conversationId, seq) {
    const conv = await requireConversation(org, user, conversationId);
    const target = Math.min(Number(seq) || 0, conv.last_seq);
    if (target <= conv.last_read_seq) return;
    const [res] = await db.batch([
      ['UPDATE conversation_members SET last_read_seq = ? WHERE conversation_id = ? AND user_id = ? AND last_read_seq < ?', [target, conv.id, user.id, target]],
      events.statement({ orgId: org.id, conversationId: conv.id, type: 'conversation.read', data: { id: conv.id, user_id: user.id, seq: target } }),
    ]);
    if (res.changes) events.notify();
  }

  async function setNotify(org, user, conversationId, level) {
    await requireConversation(org, user, conversationId);
    const value = ['all', 'mentions', 'none'].includes(level) ? level : null;
    await db.run('UPDATE conversation_members SET notify = ?, muted = ? WHERE conversation_id = ? AND user_id = ?', [value, value === 'none' ? 1 : 0, conversationId, user.id]);
  }
  const setMuted = (org, user, conversationId, muted) => setNotify(org, user, conversationId, muted ? 'none' : null);

  // Who is notified of a message in a conversation, by their level: the
  // ids with 'all', and those who want at least their mentions.
  async function notifyTargets(conversationId) {
    const rows = await db.all(
      `SELECT cm.user_id, cm.notify, cm.muted, c.type, (SELECT COUNT(*) FROM conversation_members x WHERE x.conversation_id = c.id) AS member_count
       FROM conversation_members cm JOIN conversations c ON c.id = cm.conversation_id WHERE cm.conversation_id = ?`,
      [conversationId]
    );
    const levels = new Map(rows.map((r) => [r.user_id, notifyLevel(r, r)]));
    return { all: [...levels].filter(([, l]) => l === 'all').map(([id]) => id), quiet: [...levels].filter(([, l]) => l === 'none').map(([id]) => id) };
  }

  // Full-text search (FTS5) limited to conversations the caller belongs to,
  // with Space/author/date filters (spec §7.5). Words are quoted, so FTS
  // syntax in user input is treated as text.
  async function search(org, user, { q = '', conversationId = '', authorId = '', from = '', to = '', limit = 30 }) {
    const terms = String(q).normalize('NFC').match(/[\p{L}\p{N}_]+/gu)?.slice(0, 8) || [];
    const fileTerm = String(q).trim().slice(0, 100);
    if (!terms.length) return { messages: [], files: [] };
    const match = terms.map((w) => `"${w}"*`).join(' ');
    const scope = `m.org_id = ? AND m.deleted_at IS NULL
      AND m.conversation_id IN (SELECT conversation_id FROM conversation_members WHERE user_id = ?)
      AND (? = '' OR m.conversation_id = ?) AND (? = '' OR m.author_id = ?)
      AND (? = '' OR m.created_at >= ?) AND (? = '' OR m.created_at < ?)`;
    const scopeArgs = [org.id, user.id, conversationId, conversationId, authorId, authorId, from, from, to, to];
    const rows = await db.all(
      `SELECT ${MESSAGE_JSON} AS json, snippet(messages_fts, 0, '[[', ']]', '…', 16) AS snippet
       FROM messages_fts JOIN messages m ON m.rowid = messages_fts.rowid
       WHERE messages_fts MATCH ? AND ${scope} ORDER BY m.created_at DESC LIMIT ?`,
      [match, ...scopeArgs, Math.min(Number(limit) || 30, 100)]
    );
    const files = await db.all(
      `SELECT a.id, a.name, a.mime, a.size, a.created_at, a.conversation_id, a.message_id, a.uploader_id FROM attachments a JOIN messages m ON m.id = a.message_id
       WHERE a.name LIKE '%' || ? || '%' AND ${scope} ORDER BY a.created_at DESC LIMIT 20`,
      [fileTerm, ...scopeArgs]
    );
    return { messages: rows.map((r) => ({ ...parseMessage(r), snippet: r.snippet })), files };
  }

  return {
    requireConversation,
    canModerate,
    memberIds,
    list,
    one,
    directory,
    openDm,
    createSpace,
    browseSpaces,
    joinSpace,
    members,
    addMembers,
    removeMember,
    setMemberRole,
    update,
    archiveSpace,
    archiveOwn,
    allSpaces,
    history,
    send,
    edit,
    remove,
    react,
    pin,
    pinned,
    markRead,
    setMuted,
    setNotify,
    notifyTargets,
    search,
    isAdminRole,
  };
}
