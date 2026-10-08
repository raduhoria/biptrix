import { can, ORG_ROLES } from '../core/orgs.js';
import { alerts, consolePage, escapeHtml, fmtDate, table } from './layout.js';

// Organization console (spec §10.2): members, invitations, Spaces, policies,
// audit. Every page is gated server-side by permission and MFA.
function adminNav(t, org, role) {
  const base = `/o/${org.slug}/admin`;
  return [
    { href: base, key: 'overview', label: t('admin.overview'), ic: 'grid' },
    can(role, 'members.manage') && { href: `${base}/members`, key: 'members', label: t('admin.members'), ic: 'users' },
    can(role, 'spaces.manage') && { href: `${base}/spaces`, key: 'spaces', label: t('admin.spaces'), ic: 'hash' },
    can(role, 'policies.manage') && { href: `${base}/policies`, key: 'policies', label: t('admin.policies'), ic: 'shield' },
    can(role, 'audit.read') && { href: `${base}/audit`, key: 'audit', label: t('admin.audit'), ic: 'activity' },
  ].filter(Boolean);
}

const shell = (t, req, key, title, body) =>
  consolePage({ t, title, user: req.user, org: req.org, nav: adminNav(t, req.org, req.membership.role), active: key, body, path: req.path });

const stat = (label, value) => `<div class="col-6 col-lg-3"><div class="card h-100"><div class="card-body"><div class="small text-body-secondary">${escapeHtml(label)}</div><div class="fs-3 fw-semibold">${escapeHtml(value)}</div></div></div></div>`;

const fmtBytes = (n) => (n > 1073741824 ? `${(n / 1073741824).toFixed(1)} GB` : n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);

export function overviewView({ t, req, stats, notice, error }) {
  const org = req.org;
  const settings =
    req.membership.role === 'owner'
      ? `<section class="card mt-4"><div class="card-body">
          <h2 class="h6 text-uppercase text-body-secondary mb-3">${escapeHtml(t('admin.orgSettings'))}</h2>
          <form method="post" action="/o/${escapeHtml(org.slug)}/admin/settings" class="row g-3 align-items-end">
            <div class="col-md-6"><label class="form-label" for="o-name">${escapeHtml(t('admin.orgName'))}</label><input class="form-control" id="o-name" name="name" value="${escapeHtml(org.name)}" maxlength="80" required></div>
            <div class="col-md-3"><label class="form-label" for="o-color">${escapeHtml(t('admin.brandColor'))}</label><input class="form-control form-control-color w-100" type="color" id="o-color" name="brand_color" value="${escapeHtml(org.brand_color || '#4f46e5')}"></div>
            <div class="col-md-3"><button class="btn btn-primary w-100">${escapeHtml(t('common.save'))}</button></div>
          </form>
        </div></section>`
      : '';
  return shell(
    t,
    req,
    'overview',
    t('admin.overview'),
    `${alerts({ notice, error })}
    <div class="row g-3">
      ${stat(t('admin.statMembers'), `${stats.members} / ${org.max_members}`)}
      ${stat(t('admin.statSpaces'), stats.spaces)}
      ${stat(t('admin.statMessages'), stats.messages)}
      ${stat(t('admin.statMeetingMinutes'), stats.meetingMinutes)}
      ${stat(t('admin.statStorage'), `${fmtBytes(stats.storage)} / ${org.storage_quota_mb >= 1024 ? `${org.storage_quota_mb / 1024} GB` : `${org.storage_quota_mb} MB`}`)}
      ${stat(t('admin.statInvites'), stats.guestInvites)}
      ${stat(t('admin.statPlan'), org.plan)}
      ${stat(t('admin.statMfa'), `${stats.adminsWithMfa} / ${stats.admins}`)}
    </div>
    ${settings}`
  );
}

export function membersView({ t, req, members, invites, notice, error, companyDomains = [] }) {
  const ownDomain = (email) => {
    const d = String(email).split('@')[1] || '';
    return companyDomains.some((c) => d === c || d.endsWith(`.${c}`));
  };
  const org = req.org;
  const myRole = req.membership.role;
  const roleOptions = (current) =>
    ORG_ROLES.filter((r) => r !== 'owner' || myRole === 'owner')
      .map((r) => `<option value="${r}"${r === current ? ' selected' : ''}>${escapeHtml(t(`roles.${r}`))}</option>`)
      .join('');
  const rows = members.map((m) => [
    `<div class="fw-semibold">${escapeHtml(m.name)}</div><div class="small text-body-secondary">${escapeHtml(m.email)}</div>${
      m.status === 'active' && m.role === 'external' && ownDomain(m.email) ? `<div class="small text-warning-emphasis">${escapeHtml(t('admin.externalOwnDomain'))}</div>` : ''
    }`,
    m.status === 'active' && m.id !== req.user.id && (m.role !== 'owner' || myRole === 'owner')
      ? `<form method="post" action="/o/${escapeHtml(org.slug)}/admin/members/${escapeHtml(m.id)}/role" class="d-flex gap-1">
           <select class="form-select form-select-sm" name="role" aria-label="${escapeHtml(t('admin.role'))}">${roleOptions(m.role)}</select>
           <button class="btn btn-sm btn-outline-primary">${escapeHtml(t('common.save'))}</button></form>`
      : `<span class="badge text-bg-light border">${escapeHtml(t(`roles.${m.role}`))}</span>`,
    m.mfa_enabled ? `<span class="badge text-bg-success">MFA</span>` : '<span class="text-body-tertiary">—</span>',
    m.status === 'active' ? `<span class="badge text-bg-success-subtle text-success-emphasis">${escapeHtml(t('admin.active'))}</span>` : `<span class="badge text-bg-secondary">${escapeHtml(t('admin.revoked'))}</span>`,
    `${fmtDate(m.created_at)}${m.access_expires_at ? `<div class="small ${m.access_expires_at < new Date().toISOString() ? 'text-danger' : 'text-body-secondary'}">${escapeHtml(t('admin.accessUntil'))} ${fmtDate(m.access_expires_at)}</div>` : ''}`,
    m.status === 'active' && m.id !== req.user.id && m.role === 'external'
      ? `<div class="d-flex gap-1"><form method="post" action="/o/${escapeHtml(org.slug)}/admin/members/${escapeHtml(m.id)}/extend"><button class="btn btn-sm btn-outline-secondary">${escapeHtml(t('admin.extend'))}</button></form>
         <form method="post" action="/o/${escapeHtml(org.slug)}/admin/members/${escapeHtml(m.id)}/revoke" data-confirm="${escapeHtml(t('admin.revokeConfirm', { name: m.name }))}"><button class="btn btn-sm btn-outline-danger">${escapeHtml(t('admin.revoke'))}</button></form></div>`
      : m.status === 'active' && m.id !== req.user.id
      ? `<form method="post" action="/o/${escapeHtml(org.slug)}/admin/members/${escapeHtml(m.id)}/revoke" data-confirm="${escapeHtml(t('admin.revokeConfirm', { name: m.name }))}"><button class="btn btn-sm btn-outline-danger">${escapeHtml(t('admin.revoke'))}</button></form>`
      : '',
  ]);
  const inviteRows = invites.map((i) => [
    escapeHtml(i.email),
    escapeHtml(t(`roles.${i.role}`)),
    fmtDate(i.expires_at),
    `<form method="post" action="/o/${escapeHtml(org.slug)}/admin/invites/${escapeHtml(i.id)}/revoke"><button class="btn btn-sm btn-outline-secondary">${escapeHtml(t('admin.cancelInvite'))}</button></form>`,
  ]);
  return shell(
    t,
    req,
    'members',
    t('admin.members'),
    `${alerts({ notice, error })}
    <section class="card mb-4"><div class="card-body">
      <h2 class="h6 text-uppercase text-body-secondary mb-3">${escapeHtml(t('admin.inviteTitle'))}</h2>
      <form method="post" action="/o/${escapeHtml(org.slug)}/admin/invites" class="row g-2 align-items-end">
        <div class="col-md-6"><label class="form-label" for="i-email">${escapeHtml(t('auth.email'))}</label><input class="form-control" type="email" id="i-email" name="email" required></div>
        <div class="col-md-3"><label class="form-label" for="i-role">${escapeHtml(t('admin.role'))}</label><select class="form-select" id="i-role" name="role">${roleOptions('member')}</select></div>
        <div class="col-md-3"><button class="btn btn-primary w-100">${escapeHtml(t('admin.sendInvite'))}</button></div>
      </form>
      ${invites.length ? `<h3 class="h6 mt-4">${escapeHtml(t('admin.pendingInvites'))}</h3>${table([t('auth.email'), t('admin.role'), t('admin.expires'), ''], inviteRows, '')}` : ''}
    </div></section>
    <section class="card"><div class="card-body">
      <form class="d-flex gap-2 mb-3" method="get"><input class="form-control" name="q" value="${escapeHtml(req.query.q || '')}" placeholder="${escapeHtml(t('admin.searchMembers'))}">
        <div class="form-check form-switch d-flex align-items-center gap-2 text-nowrap"><input class="form-check-input" type="checkbox" role="switch" id="all" name="all" value="1"${req.query.all ? ' checked' : ''}><label class="form-check-label" for="all">${escapeHtml(t('admin.showRevoked'))}</label></div>
        <button class="btn btn-outline-secondary">${escapeHtml(t('common.search'))}</button></form>
      ${table([t('admin.person'), t('admin.role'), 'MFA', t('admin.status'), t('admin.since'), ''], rows, t('admin.noMembers'))}
    </div></section>`
  );
}

export function spacesView({ t, req, spaces, notice, error }) {
  const org = req.org;
  const rows = spaces.map((s) => [
    `<div class="fw-semibold">${escapeHtml(s.name)}</div><div class="small text-body-secondary">${escapeHtml(t('admin.createdBy', { name: s.creator || '—' }))}</div>`,
    escapeHtml(t(`client.visibility.${s.visibility}`)),
    escapeHtml(s.member_count),
    fmtDate(s.last_message_at),
    s.archived_at ? `<span class="badge text-bg-secondary">${escapeHtml(t('admin.archived'))}</span>` : `<span class="badge text-bg-success-subtle text-success-emphasis">${escapeHtml(t('admin.active'))}</span>`,
    `<form method="post" action="/o/${escapeHtml(org.slug)}/admin/spaces/${escapeHtml(s.id)}/${s.archived_at ? 'unarchive' : 'archive'}"><button class="btn btn-sm btn-outline-secondary">${escapeHtml(t(s.archived_at ? 'admin.unarchive' : 'admin.archive'))}</button></form>`,
  ]);
  return shell(t, req, 'spaces', t('admin.spaces'), `${alerts({ notice, error })}<section class="card"><div class="card-body">${table([t('admin.space'), t('admin.visibility'), t('admin.statMembers'), t('admin.lastActivity'), t('admin.status'), ''], rows, t('admin.noSpaces'))}</div></section>`);
}

export function policiesView({ t, req, policy, notice, error }) {
  const org = req.org;
  const check = (name) => `<div class="form-check form-switch mb-2">
      <input class="form-check-input" type="checkbox" role="switch" id="p-${name}" name="${name}" value="1"${policy[name] ? ' checked' : ''}>
      <label class="form-check-label" for="p-${name}">${escapeHtml(t(`policy.${name}`))}</label></div>`;
  const num = (name, min, max) => `<div class="col-sm-6 col-lg-4"><label class="form-label small" for="p-${name}">${escapeHtml(t(`policy.${name}`))}</label>
      <input class="form-control" type="number" id="p-${name}" name="${name}" min="${min}" max="${max}" value="${escapeHtml(policy[name])}"></div>`;
  return shell(
    t,
    req,
    'policies',
    t('admin.policies'),
    `${alerts({ notice, error })}
    <form method="post" action="/o/${escapeHtml(org.slug)}/admin/policies">
      <input type="hidden" name="_bools" value="external_meetings_enabled,guest_otp_required,guest_lobby_required,guest_screen_share,email_notifications,collaborators_enabled,media_sfu_allowed">
      <section class="card mb-4"><div class="card-body">
        <h2 class="h6 text-uppercase text-body-secondary mb-3">${escapeHtml(t('policy.externalTitle'))}</h2>
        ${check('external_meetings_enabled')}
        <div class="row g-3 my-1">
          <div class="col-sm-6 col-lg-4"><label class="form-label small" for="p-roles">${escapeHtml(t('policy.external_invite_roles'))}</label>
            <select class="form-select" id="p-roles" name="external_invite_roles">
              <option value="members"${policy.external_invite_roles === 'members' ? ' selected' : ''}>${escapeHtml(t('policy.rolesMembers'))}</option>
              <option value="admins"${policy.external_invite_roles === 'admins' ? ' selected' : ''}>${escapeHtml(t('policy.rolesAdmins'))}</option>
            </select></div>
          ${num('max_invites_per_day', 0, 10000)}
          ${num('invite_ttl_hours', 1, 720)}
        </div>
        ${check('guest_otp_required')}
        ${check('guest_lobby_required')}
        ${check('guest_screen_share')}
        <div class="row g-3 mt-1">
          <div class="col-md-6"><label class="form-label small" for="p-allow">${escapeHtml(t('policy.domain_allowlist'))}</label>
            <textarea class="form-control" id="p-allow" name="domain_allowlist" rows="2" placeholder="partener.ro, client.com">${escapeHtml(policy.domain_allowlist.join(', '))}</textarea></div>
          <div class="col-md-6"><label class="form-label small" for="p-deny">${escapeHtml(t('policy.domain_denylist'))}</label>
            <textarea class="form-control" id="p-deny" name="domain_denylist" rows="2">${escapeHtml(policy.domain_denylist.join(', '))}</textarea></div>
        </div>
      </div></section>
      <section class="card mb-4"><div class="card-body">
        <h2 class="h6 text-uppercase text-body-secondary mb-3">${escapeHtml(t('policy.collaboratorsTitle'))}</h2>
        <p class="small text-body-secondary">${escapeHtml(t('policy.collaboratorsHelp'))}</p>
        <div class="mb-3"><label class="form-label small" for="p-company">${escapeHtml(t('policy.company_domains'))}</label>
          <textarea class="form-control" id="p-company" name="company_domains" rows="1" placeholder="firma.ro">${escapeHtml(policy.company_domains.join(', '))}</textarea>
          <div class="form-text">${escapeHtml(t('policy.company_domains_help'))}</div></div>
        ${check('collaborators_enabled')}
        <div class="row g-3 my-1">
          <div class="col-sm-6 col-lg-4"><label class="form-label small" for="p-croles">${escapeHtml(t('policy.collaborator_invite_roles'))}</label>
            <select class="form-select" id="p-croles" name="collaborator_invite_roles">
              <option value="moderators"${policy.collaborator_invite_roles === 'moderators' ? ' selected' : ''}>${escapeHtml(t('policy.rolesModerators'))}</option>
              <option value="admins"${policy.collaborator_invite_roles === 'admins' ? ' selected' : ''}>${escapeHtml(t('policy.rolesAdmins'))}</option>
            </select></div>
          ${num('collaborator_access_days', 0, 3650)}
        </div>
        <div class="row g-3 mt-1">
          <div class="col-md-6"><label class="form-label small" for="p-callow">${escapeHtml(t('policy.domain_allowlist'))}</label>
            <textarea class="form-control" id="p-callow" name="collaborator_domain_allowlist" rows="2" placeholder="partener.ro, client.com">${escapeHtml(policy.collaborator_domain_allowlist.join(', '))}</textarea></div>
          <div class="col-md-6"><label class="form-label small" for="p-cdeny">${escapeHtml(t('policy.domain_denylist'))}</label>
            <textarea class="form-control" id="p-cdeny" name="collaborator_domain_denylist" rows="2">${escapeHtml(policy.collaborator_domain_denylist.join(', '))}</textarea></div>
        </div>
      </div></section>
      <section class="card mb-4"><div class="card-body">
        <h2 class="h6 text-uppercase text-body-secondary mb-3">${escapeHtml(t('policy.meetingsTitle'))}</h2>
        <div class="row g-3">${num('max_meeting_minutes', 5, 1440)}${num('max_participants', 2, 1000)}</div>
        <div class="mt-3">${check('media_sfu_allowed')}<div class="form-text mt-n1">${escapeHtml(t('policy.media_sfu_help'))}</div></div>
      </div></section>
      <section class="card mb-4"><div class="card-body">
        <h2 class="h6 text-uppercase text-body-secondary mb-3">${escapeHtml(t('policy.dataTitle'))}</h2>
        <div class="row g-3 mb-2">${num('max_file_mb', 1, 2048)}${num('message_retention_days', 0, 36500)}</div>
        ${check('email_notifications')}
      </div></section>
      <div class="d-flex align-items-center gap-3"><button class="btn btn-primary">${escapeHtml(t('common.save'))}</button><span class="small text-body-secondary">${escapeHtml(t('policy.version', { v: policy.version }))}</span></div>
    </form>`
  );
}

export function auditView({ t, req, rows, action, next }) {
  const tableRows = rows.map((r) => [
    fmtDate(r.created_at),
    `<code>${escapeHtml(r.action)}</code>`,
    escapeHtml(r.actor_label || r.actor_id || '—'),
    `${escapeHtml(r.resource_type || '')} <span class="small text-body-secondary">${escapeHtml(r.resource_id || '')}</span>`,
    r.data ? `<details><summary class="small">${escapeHtml(t('admin.details'))}</summary><pre class="small mb-0 audit-json">${escapeHtml(JSON.stringify(JSON.parse(r.data), null, 2))}</pre></details>` : '',
    escapeHtml(r.ip || ''),
  ]);
  return shell(
    t,
    req,
    'audit',
    t('admin.audit'),
    `<form class="d-flex gap-2 mb-3" method="get"><input class="form-control" name="action" value="${escapeHtml(action)}" placeholder="${escapeHtml(t('admin.auditFilter'))}"><button class="btn btn-outline-secondary">${escapeHtml(t('common.search'))}</button></form>
    <section class="card"><div class="card-body">${table([t('admin.when'), t('admin.action'), t('admin.actor'), t('admin.resource'), '', 'IP'], tableRows, t('admin.noAudit'))}</div></section>
    ${next ? `<a class="btn btn-outline-secondary mt-3" href="?action=${encodeURIComponent(action)}&before=${encodeURIComponent(next)}">${escapeHtml(t('admin.older'))}</a>` : ''}`
  );
}
