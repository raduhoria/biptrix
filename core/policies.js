import { appError, emailDomain, nowIso, parseJson } from './util.js';

// Per-organization policies (spec §9, §10.2). Stored as one JSON document
// per org with a version that increments on every change; meetings keep the
// version and a snapshot of the meeting-related keys at creation.
export const DEFAULT_POLICY = {
  external_meetings_enabled: true,
  external_invite_roles: 'members', // members | admins
  domain_allowlist: [], // empty = any domain not denied
  domain_denylist: [],
  guest_otp_required: true,
  guest_lobby_required: true,
  guest_screen_share: false,
  // Calls above the peer-to-peer limit may go through Cloudflare's SFU
  // (which can see the media). Off: calls stay end-to-end encrypted between
  // participants, and are limited to the peer-to-peer size.
  media_sfu_allowed: true,
  max_invites_per_day: 100,
  max_meeting_minutes: 240,
  max_participants: 25,
  invite_ttl_hours: 72,
  max_file_mb: 25,
  message_retention_days: 0, // 0 = keep
  email_notifications: true,
  // External collaborators (people from other companies) in Spaces.
  collaborators_enabled: true,
  collaborator_invite_roles: 'moderators', // moderators (of the Space) | admins
  collaborator_domain_allowlist: [],
  collaborator_domain_denylist: [],
  // The organization's own e-mail domains: someone invited into a Space
  // with such an address joins as a member, not as an external collaborator.
  company_domains: [],
  collaborator_access_days: 90, // 0 = no expiry
};

const NUMERIC = {
  max_invites_per_day: [0, 10_000],
  max_meeting_minutes: [5, 24 * 60],
  max_participants: [2, 1000],
  invite_ttl_hours: [1, 24 * 30],
  max_file_mb: [1, 2048],
  message_retention_days: [0, 36_500],
  collaborator_access_days: [0, 3650],
};

const domainList = (value) =>
  [...new Set((Array.isArray(value) ? value : String(value || '').split(/[\s,;]+/)).map((d) => d.trim().toLowerCase().replace(/^@/, '')).filter((d) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)))];

// normalize: accepts a form/JSON payload, returns a complete, valid policy.
export function normalizePolicy(input, base = DEFAULT_POLICY) {
  const out = { ...DEFAULT_POLICY, ...base };
  for (const key of Object.keys(DEFAULT_POLICY)) {
    if (!(key in input)) continue;
    const value = input[key];
    if (typeof DEFAULT_POLICY[key] === 'boolean') out[key] = value === true || value === 'on' || value === '1' || value === 1;
    else if (NUMERIC[key]) {
      const n = Number(value);
      if (!Number.isFinite(n)) continue;
      out[key] = Math.min(NUMERIC[key][1], Math.max(NUMERIC[key][0], Math.round(n)));
    } else if (key.endsWith('_allowlist') || key.endsWith('_denylist') || key === 'company_domains') out[key] = domainList(value);
    else if (key === 'external_invite_roles') out[key] = value === 'admins' ? 'admins' : 'members';
    else if (key === 'collaborator_invite_roles') out[key] = value === 'admins' ? 'admins' : 'moderators';
  }
  return out;
}

export function createPolicies({ db, audit }) {
  async function get(orgId) {
    const row = await db.get('SELECT version, data FROM policies WHERE org_id = ?', [orgId]);
    return { version: row?.version || 1, ...normalizePolicy(parseJson(row?.data, {})) };
  }

  async function update(orgId, input, actor, ip) {
    const current = await get(orgId);
    const next = normalizePolicy(input, current);
    const changed = Object.keys(DEFAULT_POLICY).filter((k) => JSON.stringify(next[k]) !== JSON.stringify(current[k]));
    if (!changed.length) return current;
    await db.batch([
      [
        `INSERT INTO policies (org_id, version, data, updated_by, updated_at) VALUES (?, 2, ?, ?, ?)
         ON CONFLICT(org_id) DO UPDATE SET version = version + 1, data = excluded.data, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
        [orgId, JSON.stringify(next), actor.id, nowIso()],
      ],
      audit.statement({ orgId, actor, action: 'policy.update', resourceType: 'policy', resourceId: orgId, ip, data: Object.fromEntries(changed.map((k) => [k, { from: current[k], to: next[k] }])) }),
    ]);
    return get(orgId);
  }

  // External meeting invitation check (spec §9 step 10). Throws policy_denied
  // with a reason code the UI translates.
  async function assertCanInviteExternal({ orgId, policy, membershipRole, email }) {
    if (!policy.external_meetings_enabled) throw appError('policy_denied', 'External meetings disabled', { reason: 'externalDisabled' });
    if (policy.external_invite_roles === 'admins' && !['owner', 'admin'].includes(membershipRole)) {
      throw appError('policy_denied', 'Only administrators may invite external guests', { reason: 'adminsOnly' });
    }
    const domain = emailDomain(email);
    if (policy.domain_denylist.some((d) => domain === d || domain.endsWith(`.${d}`))) throw appError('policy_denied', 'Domain denied', { reason: 'domainDenied' });
    if (policy.domain_allowlist.length && !policy.domain_allowlist.some((d) => domain === d || domain.endsWith(`.${d}`))) {
      throw appError('policy_denied', 'Domain not allowed', { reason: 'domainNotAllowed' });
    }
    const since = new Date(Date.now() - 24 * 3600_000).toISOString();
    const sent = await db.get('SELECT COUNT(*) AS n FROM meeting_invitations WHERE org_id = ? AND email IS NOT NULL AND created_at >= ?', [orgId, since]);
    if (sent.n >= policy.max_invites_per_day) throw appError('policy_denied', 'Daily invitation limit reached', { reason: 'dailyLimit' });
  }

  // Inviting a collaborator into a Space (by e-mail): allowed by the policy,
  // by the caller's role (Space moderator or org admin, per policy) and by
  // the domain lists.
  function assertCanInviteCollaborator({ policy, orgRole, spaceRole, email }) {
    if (!policy.collaborators_enabled) throw appError('policy_denied', 'External collaborators disabled', { reason: 'collaboratorsDisabled' });
    const admin = orgRole === 'owner' || orgRole === 'admin';
    if (!admin && (policy.collaborator_invite_roles === 'admins' || spaceRole !== 'moderator')) {
      throw appError('policy_denied', 'Not allowed to invite collaborators', { reason: policy.collaborator_invite_roles === 'admins' ? 'adminsOnly' : 'moderatorsOnly' });
    }
    const domain = emailDomain(email);
    const listed = (list) => list.some((d) => domain === d || domain.endsWith(`.${d}`));
    if (listed(policy.collaborator_domain_denylist)) throw appError('policy_denied', 'Domain denied', { reason: 'domainDenied' });
    if (policy.collaborator_domain_allowlist.length && !listed(policy.collaborator_domain_allowlist)) throw appError('policy_denied', 'Domain not allowed', { reason: 'domainNotAllowed' });
  }

  // A colleague (company domain) invited into a Space by e-mail: the same
  // "who may invite" rule as for collaborators; the collaborator switch and
  // domain lists do not apply to the organization's own people.
  function assertCanInviteColleague({ policy, orgRole, spaceRole }) {
    const admin = orgRole === 'owner' || orgRole === 'admin';
    if (!admin && (policy.collaborator_invite_roles === 'admins' || spaceRole !== 'moderator')) {
      throw appError('policy_denied', 'Not allowed to invite', { reason: policy.collaborator_invite_roles === 'admins' ? 'adminsOnly' : 'moderatorsOnly' });
    }
  }

  const isCompanyEmail = (policy, email) => {
    const domain = emailDomain(email);
    return policy.company_domains.some((d) => domain === d || domain.endsWith(`.${d}`));
  };

  return { get, update, assertCanInviteExternal, assertCanInviteCollaborator, assertCanInviteColleague, isCompanyEmail };
}
