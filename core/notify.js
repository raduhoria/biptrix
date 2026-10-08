import { mentionEmail } from '../views/emails.js';
import { createTranslator } from './i18n.js';
import { nowIso } from './util.js';

const THROTTLE_MS = 10 * 60_000;

// E-mail notifications for people who are not connected (spec §7.4): a
// mention, or a direct message. At most one mail per person and conversation
// every 10 minutes; respects the org policy and the conversation mute.
export function createNotifier({ db, mailer, policies, config, isOnline }) {
  const last = new Map();

  async function afterSend(org, author, conversation, message, mentioned = []) {
    if (message.kind !== 'text') return;
    const policy = await policies.get(org.id);
    if (!policy.email_notifications) return;
    const targets = new Set(mentioned);
    if (conversation.type === 'dm') for (const id of conversation.member_ids || []) targets.add(id);
    targets.delete(author.id);
    for (const userId of targets) {
      if (isOnline(org.id, userId)) continue;
      const key = `${userId}:${conversation.id}`;
      if (Date.now() - (last.get(key) || 0) < THROTTLE_MS) continue;
      // Only people whose access to the organization is still valid: an
      // expired collaborator gets no previews before maintenance removes them.
      const row = await db.get(
        `SELECT u.email, u.locale, cm.muted FROM users u JOIN conversation_members cm ON cm.user_id = u.id AND cm.conversation_id = ?
         JOIN memberships m ON m.user_id = u.id AND m.org_id = ? AND m.status = 'active' AND (m.access_expires_at IS NULL OR m.access_expires_at > ?)
         WHERE u.id = ? AND u.status = 'active'`,
        [conversation.id, org.id, nowIso(), userId]
      );
      if (!row || row.muted) continue;
      last.set(key, Date.now());
      const t = createTranslator(row.locale || 'en');
      const preview = String(message.body).replace(/<@[A-Za-z0-9_-]+>/g, '@…').slice(0, 200);
      const name = conversation.type === 'dm' ? t('email.directMessage') : conversation.name || t('email.group');
      mailer.queue({
        to: row.email,
        ...mentionEmail({ t, org: org.name, author: author.name, conversation: name, preview, url: `${config.appUrl}/o/${org.slug}/c/${conversation.id}` }),
      });
    }
    if (last.size > 10_000) last.clear();
  }

  return { afterSend };
}
