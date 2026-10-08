import { translateError } from '../core/i18n.js';
import { readForm } from '../core/router.js';
import { nowIso } from '../core/util.js';
import { orgInviteEmail } from '../views/emails.js';
import { auditView, membersView, overviewView, policiesView, spacesView } from '../views/admin.js';

// Organization console under /o/:org/admin. Requires an admin-level role and
// MFA (spec §15); each page also checks its own permission.
export function registerAdminRoutes(router, { auth, orgs, chat, policies, audit, realtime, mailer, config, db, files }) {
  const gate = (permission) => [auth.requireUser, orgs.requireOrg, orgs.requirePermission(permission), auth.requireMfa];
  const base = (req) => `/o/${req.org.slug}/admin`;
  const flash = (req) => ({
    notice: req.query.notice && req.t.has(`notices.${req.query.notice}`) ? req.t(`notices.${req.query.notice}`) : '',
    error: req.query.error && req.t.has(`errors.${req.query.error}`) ? req.t(`errors.${req.query.error}`) : '',
  });
  // Service errors → a translated message key on the redirect.
  const errorKey = (err) => (err.details?.reason && `reason_${err.details.reason}`) || err.code || 'invalid';

  // Any admin-level permission opens the overview.
  router.get('/o/:org/admin', auth.requireUser, orgs.requireOrg, (req, res, next) => (orgs.isAdmin(req.membership.role) ? next() : res.redirect(`/o/${req.org.slug}`)), auth.requireMfa, async (req, res) => {
    const period = nowIso().slice(0, 7);
    const usage = Object.fromEntries((await db.all('SELECT metric, value FROM usage_counters WHERE org_id = ? AND period = ?', [req.org.id, period])).map((r) => [r.metric, r.value]));
    const admins = await db.all(
      "SELECT (u.totp_secret IS NOT NULL) AS mfa FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? AND m.status = 'active' AND m.role IN ('owner', 'admin', 'compliance')",
      [req.org.id]
    );
    const stats = {
      members: await orgs.countActiveMembers(req.org.id),
      spaces: (await db.get("SELECT COUNT(*) AS n FROM conversations WHERE org_id = ? AND type = 'space' AND archived_at IS NULL", [req.org.id])).n,
      messages: usage.messages || 0,
      meetingMinutes: usage.meeting_minutes || 0,
      storage: await files.storageUsed(req.org.id),
      guestInvites: (await db.get('SELECT COUNT(*) AS n FROM meeting_invitations WHERE org_id = ? AND email IS NOT NULL AND created_at >= ?', [req.org.id, `${period}-01`])).n,
      admins: admins.length,
      adminsWithMfa: admins.filter((a) => a.mfa).length,
    };
    res.send(overviewView({ t: req.t, req, stats, ...flash(req) }));
  });

  router.post('/o/:org/admin/settings', ...gate('org.manage'), async (req, res) => {
    const form = await readForm(req);
    const name = String(form.get('name') || '').trim().slice(0, 80);
    const color = /^#[0-9a-f]{6}$/i.test(form.get('brand_color') || '') ? form.get('brand_color') : null;
    if (name) {
      await db.batch([
        ['UPDATE organizations SET name = ?, brand_color = ?, updated_at = ? WHERE id = ?', [name, color, nowIso(), req.org.id]],
        audit.statement({ orgId: req.org.id, actor: req.user, action: 'org.settings', resourceType: 'organization', resourceId: req.org.id, ip: req.ip, data: { name, brand_color: color } }),
      ]);
    }
    res.redirect(`${base(req)}?notice=saved`);
  });

  // ---------------------------------------------------------------- members
  router.get('/o/:org/admin/members', ...gate('members.manage'), async (req, res) => {
    const members = await orgs.members(req.org.id, { search: String(req.query.q || '').slice(0, 80), includeRevoked: !!req.query.all });
    res.send(membersView({ t: req.t, req, members, invites: await orgs.pendingInvites(req.org.id), companyDomains: (await policies.get(req.org.id)).company_domains, ...flash(req) }));
  });

  router.post('/o/:org/admin/invites', ...gate('members.manage'), async (req, res) => {
    const form = await readForm(req);
    try {
      const inv = await orgs.invite(req.org, { email: form.get('email'), role: form.get('role') || 'member' }, req.actor, req.ip);
      mailer.queue({ to: inv.email, ...orgInviteEmail({ t: req.t, org: req.org.name, inviter: req.user.name, role: form.get('role') || 'member', url: `${config.appUrl}/invite/${inv.token}` }) });
      res.redirect(`${base(req)}/members?notice=inviteSent`);
    } catch (err) {
      res.redirect(`${base(req)}/members?error=${errorKey(err)}`);
    }
  });

  router.post('/o/:org/admin/invites/:id/revoke', ...gate('members.manage'), async (req, res) => {
    await orgs.revokeInvite(req.org, req.params.id, req.user, req.ip);
    res.redirect(`${base(req)}/members?notice=inviteRevoked`);
  });

  router.post('/o/:org/admin/members/:uid/role', ...gate('members.manage'), async (req, res) => {
    const target = await orgs.membership(req.org.id, req.params.uid);
    const role = (await readForm(req)).get('role');
    // Only owners touch owners; nobody changes their own role.
    if (!target || req.params.uid === req.user.id || ((target.role === 'owner' || role === 'owner') && req.membership.role !== 'owner')) return res.redirect(`${base(req)}/members?error=forbidden`);
    try {
      await orgs.setRole(req.org, req.params.uid, role, req.user, req.ip);
      res.redirect(`${base(req)}/members?notice=saved`);
    } catch (err) {
      res.redirect(`${base(req)}/members?error=${errorKey(err)}`);
    }
  });

  // Revocation (criterion 20): membership gone, sockets closed now.
  router.post('/o/:org/admin/members/:uid/revoke', ...gate('members.manage'), async (req, res) => {
    const target = await orgs.membership(req.org.id, req.params.uid);
    if (!target || req.params.uid === req.user.id || (target.role === 'owner' && req.membership.role !== 'owner')) return res.redirect(`${base(req)}/members?error=forbidden`);
    try {
      await orgs.revoke(req.org, req.params.uid, req.user, req.ip);
      realtime.disconnectUser(req.params.uid, req.org.id);
      res.redirect(`${base(req)}/members?notice=memberRevoked`);
    } catch (err) {
      res.redirect(`${base(req)}/members?error=${errorKey(err)}`);
    }
  });

  // Collaborator access: extend by the policy's duration from today.
  router.post('/o/:org/admin/members/:uid/extend', ...gate('members.manage'), async (req, res) => {
    // (Read directly: an expired, not yet revoked membership can be extended.)
    const target = await db.get("SELECT role FROM memberships WHERE org_id = ? AND user_id = ? AND status = 'active'", [req.org.id, req.params.uid]);
    if (target?.role !== 'external') return res.redirect(`${base(req)}/members?error=forbidden`);
    await orgs.setAccessExpiry(req.org, req.params.uid, (await policies.get(req.org.id)).collaborator_access_days, req.user, req.ip);
    res.redirect(`${base(req)}/members?notice=saved`);
  });

  // ----------------------------------------------------------------- spaces
  router.get('/o/:org/admin/spaces', ...gate('spaces.manage'), async (req, res) => {
    res.send(spacesView({ t: req.t, req, spaces: await chat.allSpaces(req.org), ...flash(req) }));
  });

  for (const action of ['archive', 'unarchive']) {
    router.post(`/o/:org/admin/spaces/:id/${action}`, ...gate('spaces.manage'), async (req, res) => {
      await chat.archiveSpace(req.org, req.user, req.params.id, action === 'archive', req.ip);
      res.redirect(`${base(req)}/spaces?notice=saved`);
    });
  }

  // --------------------------------------------------------------- policies
  router.get('/o/:org/admin/policies', ...gate('policies.manage'), async (req, res) => {
    res.send(policiesView({ t: req.t, req, policy: await policies.get(req.org.id), ...flash(req) }));
  });

  router.post('/o/:org/admin/policies', ...gate('policies.manage'), async (req, res) => {
    const form = await readForm(req);
    const input = Object.fromEntries(form);
    // Unchecked switches are absent from the form: listed booleans default off.
    for (const key of String(form.get('_bools') || '').split(',')) if (key && !(key in input)) input[key] = false;
    try {
      await policies.update(req.org.id, input, req.user, req.ip);
      res.redirect(`${base(req)}/policies?notice=saved`);
    } catch (err) {
      res.status(400).send(policiesView({ t: req.t, req, policy: await policies.get(req.org.id), error: translateError(req.t, err) }));
    }
  });

  // ------------------------------------------------------------------ audit
  router.get('/o/:org/admin/audit', ...gate('audit.read'), async (req, res) => {
    const action = String(req.query.action || '').slice(0, 60);
    const rows = await audit.list({ orgId: req.org.id, action, before: String(req.query.before || ''), limit: 100 });
    res.send(auditView({ t: req.t, req, rows, action, next: rows.length === 100 ? rows.at(-1).created_at : '' }));
  });
}
