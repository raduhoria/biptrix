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

export function createOrgs({ db, users, audit }) {
  const bySlug = (slug) => db.get('SELECT * FROM organizations WHERE slug = ?', [slug]);
  const byId = (id) => db.get('SELECT * FROM organizations WHERE id = ?', [id]);

  const membership = (orgId, userId) => db.get("SELECT * FROM memberships WHERE org_id = ? AND user_id = ? AND status = 'active'", [orgId, userId]);

  // Organizations the user can open, for the org switcher.
  const forUser = (userId) =>
    db.all(
      `SELECT o.id, o.slug, o.name, o.status, o.brand_color, m.role FROM memberships m JOIN organizations o ON o.id = m.org_id
       WHERE m.user_id = ? AND m.status = 'active' ORDER BY o.name`,
      [userId]
    );

  async function uniqueSlug(name) {
    const base = slugify(name) || 'org';
    for (let i = 0; i < 50; i++) {
      const slug = i ? `${base}-${i + 1}` : base;
      if (!(await bySlug(slug))) return slug;
    }
    return `${base}-${newId().slice(0, 6).toLowerCase()}`;
  }

  // Creates an organization; the owner is an existing user (operator console
  // or first-run setup). Owners without an account get an org invite instead.
  async function create({ name, ownerId = null, actor, ip }) {
    const cleanName = String(name || '').trim().slice(0, 80);
    if (!cleanName) throw appError('invalid', 'Name required', { field: 'name' });
    const id = newId();
    const at = nowIso();
    const statements = [
      ['INSERT INTO organizations (id, slug, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [id, await uniqueSlug(cleanName), cleanName, 'active', at, at]],
      ['INSERT INTO policies (org_id, version, data, updated_at) VALUES (?, 1, ?, ?)', [id, '{}', at]],
      audit.statement({ orgId: id, actor, action: 'org.create', resourceType: 'organization', resourceId: id, ip, data: { name: cleanName } }),
    ];
    if (ownerId) statements.push(['INSERT INTO memberships (org_id, user_id, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [id, ownerId, 'owner', 'active', at, at]]);
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
              m.role, m.status, m.title, m.department, m.created_at
       FROM memberships m JOIN users u ON u.id = m.user_id
       WHERE m.org_id = ? AND (? = 1 OR m.status = 'active')
         AND (? = '' OR u.email LIKE '%' || ? || '%' OR u.name LIKE '%' || ? || '%')
       ORDER BY u.name COLLATE NOCASE LIMIT 2000`,
      [orgId, includeRevoked ? 1 : 0, search, search, search]
    );

  async function countActiveMembers(orgId) {
    return (await db.get("SELECT COUNT(*) AS n FROM memberships WHERE org_id = ? AND status = 'active'", [orgId])).n;
  }

  async function setRole(org, userId, role, actor, ip) {
    if (!ORG_ROLES.includes(role)) throw appError('invalid', 'Unknown role');
    const current = await membership(org.id, userId);
    if (!current) throw appError('not_found', 'Member not found');
    if (current.role === 'owner' && role !== 'owner') {
      const owners = await db.get("SELECT COUNT(*) AS n FROM memberships WHERE org_id = ? AND role = 'owner' AND status = 'active'", [org.id]);
      if (owners.n <= 1) throw appError('conflict', 'An organization needs at least one owner', { reason: 'lastOwner' });
    }
    await db.batch([
      ['UPDATE memberships SET role = ?, updated_at = ? WHERE org_id = ? AND user_id = ?', [role, nowIso(), org.id, userId]],
      audit.statement({ orgId: org.id, actor, action: 'member.role', resourceType: 'user', resourceId: userId, ip, data: { from: current.role, to: role } }),
    ]);
  }

  // Revocation (spec §5, criterion 20): the membership ends, the user leaves
  // every conversation of this org. Live sockets are closed by the caller
  // (realtime.disconnectUser) right after.
  async function revoke(org, userId, actor, ip) {
    const current = await membership(org.id, userId);
    if (!current) throw appError('not_found', 'Member not found');
    if (current.role === 'owner') {
      const owners = await db.get("SELECT COUNT(*) AS n FROM memberships WHERE org_id = ? AND role = 'owner' AND status = 'active'", [org.id]);
      if (owners.n <= 1) throw appError('conflict', 'An organization needs at least one owner', { reason: 'lastOwner' });
    }
    await db.batch([
      ["UPDATE memberships SET status = 'revoked', updated_at = ? WHERE org_id = ? AND user_id = ?", [nowIso(), org.id, userId]],
      ['DELETE FROM conversation_members WHERE user_id = ? AND conversation_id IN (SELECT id FROM conversations WHERE org_id = ?)', [userId, org.id]],
      ["UPDATE meeting_participants SET state = 'removed', left_at = ? WHERE user_id = ? AND state IN ('lobby', 'admitted') AND meeting_id IN (SELECT id FROM meetings WHERE org_id = ?)", [nowIso(), userId, org.id]],
      audit.statement({ orgId: org.id, actor, action: 'member.revoke', resourceType: 'user', resourceId: userId, ip }),
    ]);
  }

  // ------------------------------------------------------------------ invites

  async function invite(org, { email, role = 'member' }, actor, ip) {
    const clean = canonicalEmail(email);
    if (!isEmail(clean)) throw appError('invalid', 'Invalid e-mail', { field: 'email' });
    if (!ORG_ROLES.includes(role) || (role === 'owner' && actor.orgRole !== 'owner')) throw appError('forbidden', 'Role not allowed');
    if ((await countActiveMembers(org.id)) >= org.max_members) throw appError('quota_exceeded', 'Member limit reached', { reason: 'members' });
    const existing = await users.byEmail(clean);
    if (existing && (await membership(org.id, existing.id))) throw appError('conflict', 'Already a member', { reason: 'alreadyMember' });
    const token = newToken();
    const id = newId();
    await db.batch([
      ['UPDATE org_invites SET revoked_at = ? WHERE org_id = ? AND email = ? AND accepted_at IS NULL AND revoked_at IS NULL', [nowIso(), org.id, clean]],
      ['INSERT INTO org_invites (id, org_id, email, role, token_hash, invited_by, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [id, org.id, clean, role, sha256(token), actor.id, isoIn(INVITE_TTL_MS), nowIso()]],
      audit.statement({ orgId: org.id, actor, action: 'member.invite', resourceType: 'invite', resourceId: id, ip, data: { email: clean, role } }),
    ]);
    return { id, token, email: clean, existingUser: !!existing };
  }

  async function inviteByToken(token) {
    const row = await db.get(
      `SELECT i.*, o.name AS org_name, o.slug AS org_slug, o.status AS org_status FROM org_invites i JOIN organizations o ON o.id = i.org_id WHERE i.token_hash = ?`,
      [sha256(token)]
    );
    if (!row || row.revoked_at || row.accepted_at) throw appError('not_found', 'Invitation not found');
    if (row.expires_at < nowIso() || row.org_status !== 'active') throw appError('expired', 'Invitation expired');
    return row;
  }

  // Accept: an existing account just gains the membership; a new person
  // creates their account in the same atomic batch.
  async function acceptInvite(token, { userId = null, name, passwordHash }) {
    const inv = await inviteByToken(token);
    const at = nowIso();
    let accountId = userId;
    const statements = [];
    if (!accountId) {
      if (await users.byEmail(inv.email)) throw appError('conflict', 'Account exists; sign in first', { reason: 'signInFirst' });
      const created = users.insertStatement({ email: inv.email, name, passwordHash });
      accountId = created.id;
      statements.push(created.statement);
    }
    statements.push(
      [
        `INSERT INTO memberships (org_id, user_id, role, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)
         ON CONFLICT(org_id, user_id) DO UPDATE SET role = excluded.role, status = 'active', updated_at = excluded.updated_at`,
        [inv.org_id, accountId, inv.role, at, at],
      ],
      ['UPDATE org_invites SET accepted_at = ? WHERE id = ?', [at, inv.id]],
      audit.statement({ orgId: inv.org_id, actor: { id: accountId, email: inv.email }, action: 'member.join', resourceType: 'invite', resourceId: inv.id })
    );
    await db.batch(statements);
    return { orgSlug: inv.org_slug, userId: accountId };
  }

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
    setStatus,
    updateLimits,
    members,
    countActiveMembers,
    setRole,
    revoke,
    invite,
    inviteByToken,
    acceptInvite,
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
