import { alerts, consolePage, escapeHtml, fmtDate, table } from './layout.js';

// Platform operator console (spec §10.1): tenant lifecycle, plans and limits,
// aggregate usage, health. No access to tenant content — there is no route
// here that reads messages, files or meetings.
const nav = (t) => [
  { href: '/platform', key: 'orgs', label: t('platform.orgs'), ic: 'building' },
  { href: '/platform/users', key: 'users', label: t('platform.users'), ic: 'users' },
  { href: '/platform/health', key: 'health', label: t('platform.health'), ic: 'activity' },
  { href: '/platform/audit', key: 'audit', label: t('admin.audit'), ic: 'list' },
];

const shell = (t, req, key, title, body) => consolePage({ t, title, user: req.user, nav: nav(t), active: key, body, path: req.path });

export function orgsView({ t, req, orgs, usage, notice, error }) {
  const rows = orgs.map((o) => {
    const u = usage[o.id] || {};
    return [
      `<div class="fw-semibold">${escapeHtml(o.name)}</div><div class="small text-body-secondary">/${escapeHtml(o.slug)}</div>`,
      o.status === 'active' ? `<span class="badge text-bg-success-subtle text-success-emphasis">${escapeHtml(t('admin.active'))}</span>` : `<span class="badge text-bg-danger">${escapeHtml(t('org.suspended'))}</span>`,
      `${escapeHtml(o.member_count)} / ${escapeHtml(o.max_members)}`,
      `${escapeHtml(u.messages || 0)} · ${escapeHtml(u.meeting_minutes || 0)} min · ${escapeHtml(Math.round((u.upload_bytes || 0) / 1048576))} MB`,
      `<form method="post" action="/platform/orgs/${escapeHtml(o.id)}/limits" class="d-flex gap-1">
        <input class="form-control form-control-sm" name="plan" value="${escapeHtml(o.plan)}" aria-label="${escapeHtml(t('platform.plan'))}" style="width:6rem">
        <input class="form-control form-control-sm" type="number" name="max_members" value="${escapeHtml(o.max_members)}" min="1" aria-label="${escapeHtml(t('platform.maxMembers'))}" style="width:6rem">
        <input class="form-control form-control-sm" type="number" name="storage_quota_mb" value="${escapeHtml(o.storage_quota_mb)}" min="10" aria-label="${escapeHtml(t('platform.storageMb'))}" style="width:7rem">
        <button class="btn btn-sm btn-outline-primary">${escapeHtml(t('common.save'))}</button></form>`,
      `<form method="post" action="/platform/orgs/${escapeHtml(o.id)}/${o.status === 'active' ? 'suspend' : 'activate'}" ${o.status === 'active' ? `data-confirm="${escapeHtml(t('platform.suspendConfirm', { name: o.name }))}"` : ''}>
        <button class="btn btn-sm ${o.status === 'active' ? 'btn-outline-danger' : 'btn-outline-success'}">${escapeHtml(t(o.status === 'active' ? 'platform.suspend' : 'platform.activate'))}</button></form>`,
    ];
  });
  return shell(
    t,
    req,
    'orgs',
    t('platform.orgs'),
    `${alerts({ notice, error })}
    <section class="card mb-4"><div class="card-body">
      <h2 class="h6 text-uppercase text-body-secondary mb-3">${escapeHtml(t('platform.newOrg'))}</h2>
      <form method="post" action="/platform/orgs" class="row g-2 align-items-end">
        <div class="col-md-5"><label class="form-label" for="n-name">${escapeHtml(t('admin.orgName'))}</label><input class="form-control" id="n-name" name="name" required maxlength="80"></div>
        <div class="col-md-5"><label class="form-label" for="n-owner">${escapeHtml(t('platform.ownerEmail'))}</label><input class="form-control" type="email" id="n-owner" name="owner_email" required></div>
        <div class="col-md-2"><button class="btn btn-primary w-100">${escapeHtml(t('common.create'))}</button></div>
      </form>
    </div></section>
    <section class="card"><div class="card-body">${table([t('platform.org'), t('admin.status'), t('admin.statMembers'), t('platform.usageMonth'), t('platform.limits'), ''], rows, t('platform.noOrgs'))}</div></section>`
  );
}

export function usersView({ t, req, users, notice, error }) {
  const rows = users.map((u) => [
    `<div class="fw-semibold">${escapeHtml(u.name)}</div><div class="small text-body-secondary">${escapeHtml(u.email)}</div>`,
    u.platform_role ? `<span class="badge text-bg-warning">${escapeHtml(t('platform.operator'))}</span>` : '',
    u.mfa_enabled ? '<span class="badge text-bg-success">MFA</span>' : '—',
    u.status === 'active' ? `<span class="badge text-bg-success-subtle text-success-emphasis">${escapeHtml(t('admin.active'))}</span>` : `<span class="badge text-bg-danger">${escapeHtml(t('platform.disabled'))}</span>`,
    fmtDate(u.created_at),
    u.id === req.user.id
      ? ''
      : `<form method="post" action="/platform/users/${escapeHtml(u.id)}/${u.status === 'active' ? 'disable' : 'enable'}" ${u.status === 'active' ? `data-confirm="${escapeHtml(t('platform.disableConfirm', { name: u.name }))}"` : ''}>
          <button class="btn btn-sm ${u.status === 'active' ? 'btn-outline-danger' : 'btn-outline-success'}">${escapeHtml(t(u.status === 'active' ? 'platform.disable' : 'platform.enable'))}</button></form>`,
  ]);
  return shell(
    t,
    req,
    'users',
    t('platform.users'),
    `${alerts({ notice, error })}
    <form class="d-flex gap-2 mb-3" method="get"><input class="form-control" name="q" value="${escapeHtml(req.query.q || '')}" placeholder="${escapeHtml(t('admin.searchMembers'))}"><button class="btn btn-outline-secondary">${escapeHtml(t('common.search'))}</button></form>
    <section class="card"><div class="card-body">${table([t('admin.person'), '', 'MFA', t('admin.status'), t('admin.since'), ''], rows, t('admin.noMembers'))}</div></section>`
  );
}

export function healthView({ t, req, health }) {
  const rows = Object.entries(health).map(([k, v]) => [`<code>${escapeHtml(k)}</code>`, `<span class="font-monospace">${escapeHtml(typeof v === 'object' ? JSON.stringify(v) : v)}</span>`]);
  return shell(t, req, 'health', t('platform.health'), `<section class="card"><div class="card-body">${table([t('platform.metric'), t('platform.value')], rows, '')}</div></section>`);
}

export function platformAuditView({ t, req, rows }) {
  const tableRows = rows.map((r) => [fmtDate(r.created_at), `<code>${escapeHtml(r.action)}</code>`, escapeHtml(r.actor_label || '—'), escapeHtml(r.org_id || '—'), escapeHtml(r.resource_id || '')]);
  return shell(t, req, 'audit', t('admin.audit'), `<section class="card"><div class="card-body">${table([t('admin.when'), t('admin.action'), t('admin.actor'), t('platform.org'), t('admin.resource')], tableRows, t('admin.noAudit'))}</div></section>`);
}
