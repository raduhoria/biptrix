import { readForm } from '../core/router.js';
import { appError, canonicalEmail, clampInt, isEmail, nowIso } from '../core/util.js';
import { orgInviteEmail } from '../views/emails.js';
import { healthView, orgsView, platformAuditView, usersView } from '../views/platform.js';

// Platform operator console (/platform): tenants, limits, accounts, health.
// Operators manage tenants, never read tenant content.
export function registerPlatformRoutes(router, { auth, orgs, users, audit, realtime, rooms, mailer, config, db, health }) {
  const gate = [auth.requireUser, auth.requireOperator, auth.requireMfa];
  const flash = (req) => ({
    notice: req.query.notice && req.t.has(`notices.${req.query.notice}`) ? req.t(`notices.${req.query.notice}`) : '',
    error: req.query.error && req.t.has(`errors.${req.query.error}`) ? req.t(`errors.${req.query.error}`) : '',
  });

  router.get('/platform', ...gate, async (req, res) => {
    const period = nowIso().slice(0, 7);
    const usage = {};
    for (const r of await db.all('SELECT org_id, metric, value FROM usage_counters WHERE period = ?', [period])) (usage[r.org_id] ||= {})[r.metric] = r.value;
    res.send(orgsView({ t: req.t, req, orgs: await orgs.listAll(), usage, ...flash(req) }));
  });

  // New tenant: an existing account becomes owner directly; otherwise the
  // owner gets an invitation e-mail.
  router.post('/platform/orgs', ...gate, async (req, res) => {
    const form = await readForm(req);
    const email = canonicalEmail(form.get('owner_email'));
    if (!isEmail(email)) return res.redirect('/platform?error=invalid');
    const owner = await users.byEmail(email);
    const org = await orgs.create({ name: form.get('name'), ownerId: owner?.id || null, actor: req.user, ip: req.ip });
    if (!owner) {
      const inv = await orgs.invite(org, { email, role: 'owner' }, { ...req.user, orgRole: 'owner' }, req.ip);
      mailer.queue({ to: email, ...orgInviteEmail({ t: req.t, org: org.name, inviter: req.user.name, url: `${config.appUrl}/invite/${inv.token}` }) });
    }
    res.redirect('/platform?notice=orgCreated');
  });

  router.post('/platform/orgs/:id/limits', ...gate, async (req, res) => {
    const form = await readForm(req);
    const org = await orgs.byId(req.params.id);
    if (!org) throw appError('not_found', 'Organization not found');
    await orgs.updateLimits(
      org.id,
      {
        plan: String(form.get('plan') || org.plan).trim().slice(0, 30) || org.plan,
        maxMembers: clampInt(form.get('max_members'), 1, 1_000_000, org.max_members),
        storageQuotaMb: clampInt(form.get('storage_quota_mb'), 10, 100_000_000, org.storage_quota_mb),
      },
      req.user,
      req.ip
    );
    res.redirect('/platform?notice=saved');
  });

  // Suspension blocks every request and closes live sockets of the tenant.
  for (const action of ['suspend', 'activate']) {
    router.post(`/platform/orgs/:id/${action}`, ...gate, async (req, res) => {
      const org = await orgs.byId(req.params.id);
      if (!org) throw appError('not_found', 'Organization not found');
      await orgs.setStatus(org.id, action === 'suspend' ? 'suspended' : 'active', req.user, req.ip);
      if (action === 'suspend') {
        for (const m of await orgs.members(org.id)) realtime.disconnectUser(m.id, org.id);
      }
      res.redirect('/platform?notice=saved');
    });
  }

  router.get('/platform/users', ...gate, async (req, res) => {
    res.send(usersView({ t: req.t, req, users: await users.listAll({ search: String(req.query.q || '').slice(0, 80) }), ...flash(req) }));
  });

  // Disabling an account ends its sessions and live connections everywhere.
  for (const action of ['disable', 'enable']) {
    router.post(`/platform/users/:id/${action}`, ...gate, async (req, res) => {
      if (req.params.id === req.user.id) return res.redirect('/platform/users?error=forbidden');
      await users.setStatus(req.params.id, action === 'disable' ? 'disabled' : 'active');
      if (action === 'disable') {
        await auth.destroyUserSessions(req.params.id);
        realtime.disconnectUser(req.params.id);
      }
      await audit.log({ actor: req.user, action: `user.${action}`, resourceType: 'user', resourceId: req.params.id, ip: req.ip });
      res.redirect('/platform/users?notice=saved');
    });
  }

  router.get('/platform/health', ...gate, async (req, res) => {
    res.send(healthView({ t: req.t, req, health: { ...(await health()), realtime: realtime.stats(), meetings: rooms.stats() } }));
  });

  // Platform-level actions only; tenant audit stays with the tenant.
  router.get('/platform/audit', ...gate, async (req, res) => {
    res.send(platformAuditView({ t: req.t, req, rows: await db.all("SELECT * FROM audit_events WHERE org_id IS NULL OR action LIKE 'org.%' OR action LIKE 'user.%' ORDER BY created_at DESC LIMIT 200") }));
  });
}
