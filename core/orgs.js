import { appError, canonicalEmail, isEmail, isoIn, newId, newToken, nowIso, sha256, slugify } from './util.js';

// Organization roles (spec §6) and what each may do. Checked server-side on
// every request; the UI only hides what the server would refuse anyway.
export const ORG_ROLES = ['owner', 'admin', 'compliance', 'member', 'external'];
const PERMISSIONS = {
  owner: ['chat', 'directory', 'spaces.browse', 'meetings.create', 'org.manage', 'members.manage', 'spaces.manage', 'policies.manage', 'audit.read'],
  admin: ['chat', 'directory', 'spaces.browse', 'meetings.create', 'members.manage', 'spaces.manage', 'policies.manage', 'audit.read'],
  compliance: ['chat', 'directory', 'spaces.browse', 'meetings.create', 'audit.read'],
  member: ['chat', 'directory', 'spaces.browse', 'meetings.create'],
  // External collaborators only see what was shared with them explicitly.
  external: ['chat'],
};
export const can = (role, permission) => !!PERMISSIONS[role]?.includes(permission);
export const isAdminRole = (role) => role === 'owner' || role === 'admin' || role === 'compliance';

const INVITE_TTL_MS = 7 * 24 * 3600_000;

export function createOrgs({ db, users, audit, events }) {
  const bySlug = (slug) => db.get('SELECT * FROM organizations WHERE slug = ?', [slug]);
  const byId = (id) => db.get('SELECT * FROM organizations WHERE id = ?', [id]);

  // Active membership; an external collaborator whose access has expired
  // has none (the maintenance job also marks it revoked).
  const ACTIVE = "m.status = 'active' AND (m.access_expires_at IS NULL OR m.access_expires_at > ?)";
  const membership = (orgId, userId) => db.get(`SELECT m.* FROM memberships m WHERE m.org_id = ? AND m.user_id = ? AND ${ACTIVE}`, [orgId, userId, nowIso()]);

  // Organizations the user can open, for the org switcher.
  const forUser = (userId) =>
    db.all(
      `SELECT o.id, o.slug, o.name, o.status, o.brand_color, m.role FROM memberships m JOIN organizations o ON o.id = m.org_id
       WHERE m.user_id = ? AND ${ACTIVE} ORDER BY o.name`,
      [userId, nowIso()]
    );

  async function uniqueSlug(name) {
    const base = slugify(name) || 'org';
    for (let i = 0; i < 50; i++) {
      const slug = i ? `${base}-${i + 1}` : base;
      if (!(await bySlug(slug))) return slug;
    }
    return `${base}-${newId().slice(0, 6).toLowerCase()}`;
  }

  // The statements that create an organization (policies row, audit, and
  // optionally the owner's membership), for callers that need them inside a
  // larger atomic batch (first-run setup). `when` is an SQL guard added to
  // every statement (with its parameters).
  async function createStatements({ name, ownerId = null, actor, ip, when = '1', whenArgs = [] }) {
    const cleanName = String(name || '').trim().slice(0, 80);
    if (!cleanName) throw appError('invalid', 'Name required', { field: 'name' });
    const id = newId();
    const at = nowIso();

    const statements = [
      [`INSERT INTO organizations (id, slug, name, status, created_at, updated_at) SELECT ?, ?, ?, 'active', ?, ? WHERE ${when}`, [id, await uniqueSlug(cleanName), cleanName, at, at, ...whenArgs]],
      [`INSERT INTO policies (org_id, version, data, updated_at) SELECT ?, 1, '{}', ? WHERE ${when}`, [id, at, ...whenArgs]],
      audit.statement({ orgId: id, actor, action: 'org.create', resourceType: 'organization', resourceId: id, ip, data: { name: cleanName } }, when, whenArgs),
    ];
    if (ownerId) {
      statements.push([`INSERT INTO memberships (org_id, user_id, role, status, created_at, updated_at) SELECT ?, ?, 'owner', 'active', ?, ? WHERE ${when}`, [id, ownerId, at, at, ...whenArgs]]);
    }
    return { id, statements };
  }

  // Creates an organization; the owner is an existing user (operator console
  // or first-run setup). Owners without an account get an org invite instead.
  async function create(fields) {
    const { id, statements } = await createStatements(fields);
    await db.batch(statements);
    return byId(id);
  }

  async function setStatus(orgId, status, actor, ip) {
    await db.batch([
      ['UPDATE organizations SET status = ?, updated_at = ? WHERE id = ?', [status, nowIso(), orgId]],
      audit.statement({ orgId, actor, action: `org.${status === 'active' ? 'activate' : 'suspend'}`, resourceType: 'organization', resourceId: orgId, ip }),
    ]);
  }

  async function updateLimits(orgId, { plan, maxMembers, storageQuotaMb }, actor, ip) {
    await db.batch([
      ['UPDATE organizations SET plan = ?, max_members = ?, storage_quota_mb = ?, updated_at = ? WHERE id = ?', [plan, maxMembers, storageQuotaMb, nowIso(), orgId]],
      audit.statement({ orgId, actor, action: 'org.limits', resourceType: 'organization', resourceId: orgId, ip, data: { plan, maxMembers, storageQuotaMb } }),
    ]);
  }

  const members = (orgId, { search = '', includeRevoked = false } = {}) =>
    db.all(
      `SELECT u.id, u.email, u.name, u.status AS user_status, (u.totp_secret IS NOT NULL) AS mfa_enabled,
              m.role, m.status, m.title, m.department, m.created_at, m.access_expires_at
       FROM memberships m JOIN users u ON u.id = m.user_id
       WHERE m.org_id = ? AND (? = 1 OR m.status = 'active')
         AND (? = '' OR u.email LIKE '%' || ? || '%' OR u.name LIKE '%' || ? || '%')
       ORDER BY u.name COLLATE NOCASE LIMIT 2000`,
      [orgId, includeRevoked ? 1 : 0, search, search, search]
    );

  async function countActiveMembers(orgId) {
    return (await db.get("SELECT COUNT(*) AS n FROM memberships WHERE org_id = ? AND status = 'active'", [orgId])).n;
  }

  // "At least one active owner" is enforced inside the UPDATE itself, so two
  // concurrent demotions cannot both pass a check made beforehand.
  const keepsAnOwner = `(role != 'owner' OR (SELECT COUNT(*) FROM memberships WHERE org_id = ? AND role = 'owner' AND status = 'active') > 1)`;

  // Only external collaborators have time-limited access: any other role
  // drops the expiry, so a promoted collaborator is not revoked later.
  async function setRole(org, userId, role, actor, ip) {
    if (!ORG_ROLES.includes(role)) throw appError('invalid', 'Unknown role');
    const current = await membership(org.id, userId);
    if (!current) throw appError('not_found', 'Member not found');
    const [res] = await db.batch([
      [
        `UPDATE memberships SET role = ?, access_expires_at = CASE WHEN ? = 'external' THEN access_expires_at END, updated_at = ?
         WHERE org_id = ? AND user_id = ? AND status = 'active' AND (? = 'owner' OR ${keepsAnOwner})`,
        [role, role, nowIso(), org.id, userId, role, org.id],
      ],
    ]);
    if (!res.changes) throw appError('conflict', 'An organization needs at least one owner', { reason: 'lastOwner' });
    await audit.log({ orgId: org.id, actor, action: 'member.role', resourceType: 'user', resourceId: userId, ip, data: { from: current.role, to: role } });
  }

  // Revocation (spec §5, criterion 20): the membership ends, the user leaves
  // every conversation and meeting of this org. One atomic batch, every
  // statement guarded by `cond` (evaluated before the membership row
  // changes, which is the last statement): manual removal and expiry share
  // it, and a concurrent extension or the last-owner rule stop all of it.
  // Live sockets are closed by the caller (realtime.disconnectUser).
  function revocationStatements(orgId, userId, { cond, condArgs, action, actor, ip }) {
    const at = nowIso();
    const guard = `EXISTS (SELECT 1 FROM memberships WHERE org_id = ? AND user_id = ? AND ${cond})`;
    const guardArgs = [orgId, userId, ...condArgs];
    const ev = events.statement({ orgId, userId, type: 'conversation.removed', data: { all: true } });
    return [
      [`DELETE FROM conversation_members WHERE user_id = ? AND conversation_id IN (SELECT id FROM conversations WHERE org_id = ?) AND ${guard}`, [userId, orgId, ...guardArgs]],
      [
        `UPDATE meeting_participants SET state = 'removed', left_at = ? WHERE user_id = ? AND state IN ('lobby', 'admitted') AND meeting_id IN (SELECT id FROM meetings WHERE org_id = ?) AND ${guard}`,
        [at, userId, orgId, ...guardArgs],
      ],
      [ev[0].replace(/VALUES \(([^)]*)\)$/s, `SELECT $1 WHERE ${guard}`), [...ev[1], ...guardArgs]],
      audit.statement({ orgId, actor, action, resourceType: 'user', resourceId: userId, ip }, guard, guardArgs),
      [`UPDATE memberships SET status = 'revoked', updated_at = ? WHERE org_id = ? AND user_id = ? AND ${cond}`, [at, orgId, userId, ...condArgs]],
    ];
  }

  async function revoke(org, userId, actor, ip) {
    if (!(await membership(org.id, userId))) throw appError('not_found', 'Member not found');
    const statements = revocationStatements(org.id, userId, { cond: `status = 'active' AND ${keepsAnOwner}`, condArgs: [org.id], action: 'member.revoke', actor, ip });
    const results = await db.batch(statements);
    if (!results.at(-1).changes) throw appError('conflict', 'An organization needs at least one owner', { reason: 'lastOwner' });
    events.notify();
  }

  // ------------------------------------------------------------------ invites

  // Organization invitation. With `conversationId` (a Space) the person
  // joins that Space on acceptance; `accessDays` sets an expiry on the
  // membership (external collaborators).
  async function invite(org, { email, role = 'member', conversationId = null, accessDays = null }, actor, ip) {
    const clean = canonicalEmail(email);
    if (!isEmail(clean)) throw appError('invalid', 'Invalid e-mail', { field: 'email' });
    if (!ORG_ROLES.includes(role) || (role === 'owner' && actor.orgRole !== 'owner')) throw appError('forbidden', 'Role not allowed');
    if ((await countActiveMembers(org.id)) >= org.max_members) throw appError('quota_exceeded', 'Member limit reached', { reason: 'members' });
    const existing = await users.byEmail(clean);
    if (existing && (await membership(org.id, existing.id))) throw appError('conflict', 'Already a member', { reason: 'alreadyMember' });
    const token = newToken();
    const id = newId();
    await db.batch([
      // A newer invitation replaces a pending one for the same person and target.
      ['UPDATE org_invites SET revoked_at = ? WHERE org_id = ? AND email = ? AND conversation_id IS ? AND accepted_at IS NULL AND revoked_at IS NULL', [nowIso(), org.id, clean, conversationId]],
      [
        'INSERT INTO org_invites (id, org_id, email, role, token_hash, invited_by, expires_at, created_at, conversation_id, access_days) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [id, org.id, clean, role, sha256(token), actor.id, isoIn(INVITE_TTL_MS), nowIso(), conversationId, accessDays || null],
      ],
      audit.statement({ orgId: org.id, actor, action: 'member.invite', resourceType: 'invite', resourceId: id, ip, data: { email: clean, role, space: conversationId, access_days: accessDays || null } }),
    ]);
    return { id, token, email: clean, existingUser: !!existing };
  }

  async function inviteByToken(token) {
    const row = await db.get(
      `SELECT i.*, o.name AS org_name, o.slug AS org_slug, o.status AS org_status, c.name AS space_name
       FROM org_invites i JOIN organizations o ON o.id = i.org_id LEFT JOIN conversations c ON c.id = i.conversation_id WHERE i.token_hash = ?`,
      [sha256(token)]
    );
    if (!row || row.revoked_at || row.accepted_at) throw appError('not_found', 'Invitation not found');
    if (row.expires_at < nowIso() || row.org_status !== 'active') throw appError('expired', 'Invitation expired');
    return row;
  }

  // Accept: an existing account just gains the membership; a new person
  // creates their account in the same atomic batch. The first statement
  // claims the invitation and checks the member limit at once; everything
  // else only happens if that claim is ours (accepted_by), so concurrent
  // acceptances cannot exceed the limit or use one invitation twice.
  async function acceptInvite(token, { userId = null, name, passwordHash }) {
    const inv = await inviteByToken(token);
    const at = nowIso();
    let accountId = userId;
    let userInsert = null;
    if (!accountId) {
      if (await users.byEmail(inv.email)) throw appError('conflict', 'Account exists; sign in first', { reason: 'signInFirst' });
      const created = users.insertStatement({ email: inv.email, name, passwordHash });
      accountId = created.id;
      userInsert = created.statement;
    }
    const claimed = 'EXISTS (SELECT 1 FROM org_invites WHERE id = ? AND accepted_by = ?)';
    const claimArgs = [inv.id, accountId];
    const statements = [
      [
        `UPDATE org_invites SET accepted_at = ?, accepted_by = ? WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL
           AND (SELECT COUNT(*) FROM memberships WHERE org_id = ? AND status = 'active' AND user_id != ?) < (SELECT max_members FROM organizations WHERE id = ?)`,
        [at, accountId, inv.id, inv.org_id, accountId, inv.org_id],
      ],
    ];
    if (userInsert) statements.push([userInsert[0].replace(/VALUES \(([^)]*)\)$/s, `SELECT $1 WHERE ${claimed}`), [...userInsert[1], ...claimArgs]]);
    // A collaborator whose access expired but was not swept yet starts over:
    // nothing from the old access (Spaces, meeting admissions) carries over.
    const lapsed = `${claimed} AND EXISTS (SELECT 1 FROM memberships WHERE org_id = ? AND user_id = ? AND status = 'active' AND access_expires_at <= ?)`;
    const lapsedArgs = [...claimArgs, inv.org_id, accountId, at];
    statements.push(
      [`DELETE FROM conversation_members WHERE user_id = ? AND conversation_id IN (SELECT id FROM conversations WHERE org_id = ?) AND ${lapsed}`, [accountId, inv.org_id, ...lapsedArgs]],
      [
        `UPDATE meeting_participants SET state = 'removed', left_at = ? WHERE user_id = ? AND state IN ('lobby', 'admitted') AND meeting_id IN (SELECT id FROM meetings WHERE org_id = ?) AND ${lapsed}`,
        [at, accountId, inv.org_id, ...lapsedArgs],
      ]
    );
    const accessExpires = inv.access_days && inv.role === 'external' ? isoIn(inv.access_days * 86400_000) : null;
    // A current membership keeps its role (a Space invitation grants access
    // to the Space, not a role: an owner accepting an older one stays owner);
    // only an external collaborator is upgraded by an invitation to a fuller
    // role. A kept collaborator's access lasts until the later expiry.
    const current = "memberships.status = 'active' AND (memberships.access_expires_at IS NULL OR memberships.access_expires_at > excluded.updated_at)";
    const keep = `${current} AND NOT (memberships.role = 'external' AND excluded.role != 'external')`;
    statements.push(
      [
        `INSERT INTO memberships (org_id, user_id, role, status, created_at, updated_at, access_expires_at) SELECT ?, ?, ?, 'active', ?, ?, ? WHERE ${claimed}
         ON CONFLICT(org_id, user_id) DO UPDATE SET
           role = CASE WHEN ${keep} THEN memberships.role ELSE excluded.role END,
           access_expires_at = CASE WHEN NOT (${keep}) THEN excluded.access_expires_at
             WHEN memberships.access_expires_at IS NULL OR excluded.access_expires_at IS NULL THEN NULL
             ELSE MAX(memberships.access_expires_at, excluded.access_expires_at) END,
           status = 'active', updated_at = excluded.updated_at`,
        [inv.org_id, accountId, inv.role, at, at, accessExpires, ...claimArgs],
      ],
      audit.statement({ orgId: inv.org_id, actor: { id: accountId, email: inv.email }, action: 'member.join', resourceType: 'invite', resourceId: inv.id, data: inv.conversation_id ? { space: inv.conversation_id } : null }, claimed, claimArgs)
    );
    // Invited into a Space: joins it in the same batch (if it still exists
    // and is not archived), and its members are told.
    if (inv.conversation_id) {
      const spaceOk = `${claimed} AND EXISTS (SELECT 1 FROM conversations WHERE id = ? AND org_id = ? AND archived_at IS NULL)`;
      const spaceArgs = [...claimArgs, inv.conversation_id, inv.org_id];
      const ev = events.statement({ orgId: inv.org_id, conversationId: inv.conversation_id, type: 'conversation.members', data: { id: inv.conversation_id, added: [accountId] } });
      statements.push(
        [
          `INSERT OR IGNORE INTO conversation_members (conversation_id, user_id, role, last_read_seq, joined_at) SELECT ?, ?, 'member', 0, ? WHERE ${spaceOk}`,
          [inv.conversation_id, accountId, at, ...spaceArgs],
        ],
        [ev[0].replace(/VALUES \(([^)]*)\)$/s, `SELECT $1 WHERE ${spaceOk}`), [...ev[1], ...spaceArgs]]
      );
    }
    const [claim] = await db.batch(statements);
    if (!claim.changes) {
      const now = await db.get('SELECT accepted_at, revoked_at FROM org_invites WHERE id = ?', [inv.id]);
      if (now?.accepted_at || now?.revoked_at) throw appError('not_found', 'Invitation not found');
      throw appError('quota_exceeded', 'Member limit reached', { reason: 'members' });
    }
    if (inv.conversation_id) events.notify();
    return { orgSlug: inv.org_slug, userId: accountId, conversationId: inv.conversation_id };
  }

  // Collaborator access: extend from now, or end it (days = 0 → no expiry).
  async function setAccessExpiry(org, userId, days, actor, ip) {
    const expires = days > 0 ? isoIn(days * 86400_000) : null;
    await db.batch([
      ["UPDATE memberships SET access_expires_at = ?, updated_at = ? WHERE org_id = ? AND user_id = ? AND status = 'active' AND role = 'external'", [expires, nowIso(), org.id, userId]],
      audit.statement({ orgId: org.id, actor, action: 'member.access_extend', resourceType: 'user', resourceId: userId, ip, data: { expires } }),
    ]);
  }

  // Expired collaborators: the same revocation as a manual removal. The
  // expiry is re-checked inside the batch, so an extension made after the
  // list was read wins.
  async function expireCollaborators() {
    const now = nowIso();
    const rows = await db.all("SELECT org_id, user_id FROM memberships WHERE status = 'active' AND access_expires_at IS NOT NULL AND access_expires_at <= ? LIMIT 500", [now]);
    const expired = [];
    for (const r of rows) {
      const cond = `status = 'active' AND access_expires_at IS NOT NULL AND access_expires_at <= ? AND ${keepsAnOwner}`;
      const results = await db.batch(revocationStatements(r.org_id, r.user_id, { cond, condArgs: [now, r.org_id], action: 'member.expire', actor: { label: 'system' } }));
      if (results.at(-1).changes) expired.push(r);
    }
    if (expired.length) events.notify();
    return expired;
  }

  // Pending Space invitations (shown to the Space's moderators).
  const spaceInvites = (orgId, conversationId) =>
    db.all(
      'SELECT id, email, expires_at, created_at FROM org_invites WHERE org_id = ? AND conversation_id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC',
      [orgId, conversationId, nowIso()]
    );

  const pendingInvites = (orgId) =>
    db.all('SELECT id, email, role, expires_at, created_at FROM org_invites WHERE org_id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC', [orgId, nowIso()]);

  async function revokeInvite(org, inviteId, actor, ip) {
    await db.batch([
      ['UPDATE org_invites SET revoked_at = ? WHERE id = ? AND org_id = ?', [nowIso(), inviteId, org.id]],
      audit.statement({ orgId: org.id, actor, action: 'member.invite_revoke', resourceType: 'invite', resourceId: inviteId, ip }),
    ]);
  }

  // ------------------------------------------------------------------- guards

  // requireOrg: resolves /o/:org (slug) to an active organization in which
  // the signed-in user has an active membership. Operators get no implicit
  // access to tenant content (spec §6, §10.1).
  async function requireOrg(req, res, next) {
    const org = await bySlug(req.params.org);
    if (!org) throw appError('not_found', 'Organization not found');
    const member = await membership(org.id, req.user.id);
    if (!member) throw appError('forbidden', 'Not a member of this organization');
    if (org.status !== 'active') throw appError('forbidden', 'Organization suspended', { reason: 'suspended' });
    req.org = org;
    req.membership = member;
    req.actor = { id: req.user.id, email: req.user.email, orgRole: member.role };
    next();
  }

  const requirePermission = (permission) => (req, res, next) => {
    if (!can(req.membership?.role, permission)) throw appError('forbidden', `Missing permission ${permission}`);
    next();
  };

  return {
    bySlug,
    byId,
    forUser,
    membership,
    create,
    createStatements,
    setStatus,
    updateLimits,
    members,
    countActiveMembers,
    setRole,
    revoke,
    invite,
    inviteByToken,
    acceptInvite,
    setAccessExpiry,
    expireCollaborators,
    spaceInvites,
    pendingInvites,
    revokeInvite,
    requireOrg,
    requirePermission,
    isAdmin: isAdminRole,
    listAll: () =>
      db.all(
        `SELECT o.*, (SELECT COUNT(*) FROM memberships m WHERE m.org_id = o.id AND m.status = 'active') AS member_count
         FROM organizations o ORDER BY o.created_at DESC`
      ),
  };
}
