import { appError, newId, nowIso } from './util.js';

// Company announcements: banners an administrator pins for the whole
// organization between two dates (inclusive). Members see them in the
// sidebar; external collaborators do not. Dates are calendar days: the
// server sends what may be active anywhere today (a day of margin each
// side) and the client keeps what is active on its own local date.
export const ANNOUNCEMENT_LEVELS = ['info', 'warning', 'success'];
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const validDay = (d) => DAY.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().startsWith(d);
const dayOffset = (days) => new Date(Date.now() + days * 86400_000).toISOString().slice(0, 10);

export function createAnnouncements({ db, audit, events }) {
  const COLUMNS = 'id, title, body, level, starts_on, ends_on, updated_at';

  // Every announcement, newest period first (console).
  const all = (orgId) => db.all(`SELECT ${COLUMNS}, created_at FROM announcements WHERE org_id = ? ORDER BY ends_on DESC, starts_on DESC, created_at DESC`, [orgId]);
  const one = (orgId, id) => db.get(`SELECT ${COLUMNS} FROM announcements WHERE org_id = ? AND id = ?`, [orgId, id]);
  // What a member may see today, whatever their time zone.
  const current = (orgId) => db.all(`SELECT ${COLUMNS} FROM announcements WHERE org_id = ? AND starts_on <= ? AND ends_on >= ? ORDER BY starts_on DESC, created_at DESC`, [orgId, dayOffset(1), dayOffset(-1)]);

  function normalize(input) {
    const a = {
      title: String(input.title || '').trim().slice(0, 120),
      body: String(input.body || '').replace(/\r\n/g, '\n').trim().slice(0, 2000),
      level: ANNOUNCEMENT_LEVELS.includes(input.level) ? input.level : 'info',
      starts_on: String(input.starts_on || ''),
      ends_on: String(input.ends_on || ''),
    };
    if (!a.title) throw appError('invalid', 'Title required', { reason: 'announcementTitle' });
    if (!validDay(a.starts_on) || !validDay(a.ends_on) || a.ends_on < a.starts_on) throw appError('invalid', 'Invalid period', { reason: 'announcementDates' });
    return a;
  }

  // Members' clients reload the list; the event carries no content, so
  // external collaborators (who get org-wide events too) learn nothing.
  const changed = (orgId) => events.statement({ orgId, type: 'announcements.changed', data: {} });

  async function save(org, actor, id, input, ip) {
    const a = normalize(input);
    const now = nowIso();
    if (id && !(await one(org.id, id))) throw appError('not_found', 'Announcement not found');
    const annId = id || newId();
    await db.batch([
      id
        ? ['UPDATE announcements SET title = ?, body = ?, level = ?, starts_on = ?, ends_on = ?, updated_at = ? WHERE id = ? AND org_id = ?', [a.title, a.body, a.level, a.starts_on, a.ends_on, now, id, org.id]]
        : ['INSERT INTO announcements (id, org_id, title, body, level, starts_on, ends_on, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [annId, org.id, a.title, a.body, a.level, a.starts_on, a.ends_on, actor.id, now, now]],
      audit.statement({ orgId: org.id, actor, action: id ? 'announcement.update' : 'announcement.create', resourceType: 'announcement', resourceId: annId, ip, data: a }),
      changed(org.id),
    ]);
    events.notify();
    return annId;
  }

  async function remove(org, actor, id, ip) {
    const a = await one(org.id, id);
    if (!a) return;
    await db.batch([
      ['DELETE FROM announcements WHERE id = ? AND org_id = ?', [id, org.id]],
      audit.statement({ orgId: org.id, actor, action: 'announcement.delete', resourceType: 'announcement', resourceId: id, ip, data: { title: a.title } }),
      changed(org.id),
    ]);
    events.notify();
  }

  return { all, one, current, save, remove };
}
