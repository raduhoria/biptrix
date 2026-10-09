import { mentionEmail } from '../views/emails.js';
import { createTranslator } from './i18n.js';
import { orgSender } from './mailer.js';
import { nowIso } from './util.js';

const THROTTLE_MS = 10 * 60_000;

// Notifications about a new message (spec §7.4).
// - Push (core/push.js), to the recipient's devices unless they are looking
//   at the app in that organization right now: direct messages, groups,
//   and mentions in Spaces. The text is shown unless the person turned
//   previews off.
// - E-mail, for people not connected at all: mentions and direct messages,
//   at most one per person and conversation every 10 minutes, if the org
//   policy allows.
// Both respect the conversation mute.
export function createNotifier({ db, mailer, policies, config, isOnline, isWatching = () => false, push = null }) {
  const last = new Map();

  async function afterSend(org, author, conversation, message, mentioned = []) {
    if (message.kind !== 'text') return;
    const policy = await policies.get(org.id);
    const mentions = new Set(mentioned);
    const members = conversation.type === 'space' ? [] : conversation.member_ids || [];
    const targets = new Set([...mentions, ...members]);
    targets.delete(author.id);
    for (const userId of targets) {
      // Only people whose access to the organization is still valid: an
      // expired collaborator gets no previews before maintenance removes them.
      const row = await db.get(
        `SELECT u.email, u.locale, u.push_preview, cm.muted FROM users u JOIN conversation_members cm ON cm.user_id = u.id AND cm.conversation_id = ?
         JOIN memberships m ON m.user_id = u.id AND m.org_id = ? AND m.status = 'active' AND (m.access_expires_at IS NULL OR m.access_expires_at > ?)
         WHERE u.id = ? AND u.status = 'active'`,
        [conversation.id, org.id, nowIso(), userId]
      );
      if (!row || row.muted) continue;
      const t = createTranslator(row.locale || 'en');
      const preview = String(message.body).replace(/<@[A-Za-z0-9_-]+>/g, '@…').slice(0, 200);
      const name = conversation.type === 'dm' ? t('email.directMessage') : conversation.name || t('email.group');
      const url = `${config.appUrl}/o/${org.slug}/c/${conversation.id}`;

      if (push && !isWatching(org.id, userId)) {
        push
          .toUser(userId, {
            type: 'message',
            tag: `c-${conversation.id}`,
            title: conversation.type === 'dm' ? author.name : `${author.name} · ${name}`,
            body: row.push_preview ? preview : t(mentions.has(userId) ? 'push.mention' : 'push.newMessage', { name: author.name }),
            url,
          })
          .catch(() => {});
      }

      const emailWanted = mentions.has(userId) || conversation.type === 'dm';
      if (!emailWanted || !policy.email_notifications || isOnline(org.id, userId)) continue;
      const key = `${userId}:${conversation.id}`;
      if (Date.now() - (last.get(key) || 0) < THROTTLE_MS) continue;
      last.set(key, Date.now());
      mailer.queue({
        to: row.email,
        sender: orgSender(org),
        ...mentionEmail({ t, org: org.name, author: author.name, conversation: name, preview, url }),
      });
    }
    if (last.size > 10_000) last.clear();
  }

  return { afterSend };
}
