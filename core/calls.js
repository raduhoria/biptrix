import { createTranslator } from './i18n.js';
import { missedCallEmail } from '../views/emails.js';

export const RING_MS = 45_000;
const HANG_UP_GRACE_MS = 15_000;
const MAX_RING = 20; // larger conversations get the meeting card, no ringing

// createCalls: a call started from a DM or a group rings the other members.
// The meeting carries the call (call_kind audio|video, ring_state, ring_until);
// each callee gets a user-scoped durable event `call.ring` (every open tab
// and device rings until ring_until) and `call.stop` when it is over for
// them. Outcomes, decided by conditional updates so that only one wins:
//   answered — the first callee joins the room (the others stop ringing at
//              the deadline, or when they answer or decline themselves);
//   declined — the only callee of a DM declines;
//   missed   — nobody answered by the deadline, or the caller hung up first:
//              a "missed call" line in the conversation, an e-mail to
//              callees who were not connected, the meeting closed.
// The deadline is a timer on this node, with the maintenance sweep as the
// fallback after a restart.
export function createCalls({ db, events, chat, meetings, orgs, users, mailer, config, rooms, isOnline }) {
  const timers = new Map();

  const callees = async (meeting) => (await chat.memberIds(meeting.conversation_id)).filter((id) => id !== meeting.host_id);

  async function ring(org, caller, conversation, meeting, kind) {
    if (!['dm', 'group'].includes(conversation.type)) return [];
    const targets = (await chat.memberIds(conversation.id)).filter((id) => id !== caller.id);
    if (!targets.length || targets.length > MAX_RING) return [];
    const until = new Date(Date.now() + RING_MS).toISOString();
    const data = { meeting_id: meeting.id, conversation_id: conversation.id, from: caller.id, from_name: caller.name, kind, ring_until: until };
    await db.batch([
      ["UPDATE meetings SET call_kind = ?, ring_state = 'ringing', ring_until = ? WHERE id = ?", [kind, until, meeting.id]],
      ...targets.map((userId) => events.statement({ orgId: org.id, userId, type: 'call.ring', data })),
    ]);
    events.notify();
    clearTimeout(timers.get(meeting.id));
    const timer = setTimeout(() => deadline(meeting.id).catch((err) => console.error('Call deadline failed:', err.message)), RING_MS + 500);
    timer.unref?.();
    timers.set(meeting.id, timer);
    return targets;
  }

  async function stopFor(orgId, meetingId, userIds) {
    if (!userIds.length) return;
    await db.batch(userIds.map((userId) => events.statement({ orgId, userId, type: 'call.stop', data: { meeting_id: meetingId } })));
    events.notify();
  }

  // A callee answered (joined the room) or declined, on any device.
  async function respond(meeting, user, answer) {
    if (!meeting.call_kind || user.id === meeting.host_id) return;
    await stopFor(meeting.org_id, meeting.id, [user.id]);
    if (answer === 'accept') {
      await db.run("UPDATE meetings SET ring_state = 'answered' WHERE id = ? AND ring_state = 'ringing'", [meeting.id]);
      return;
    }
    rooms.notifyRoom(meeting.id, 'call.declined', { name: user.name });
    // A DM has one callee: declining ends the ringing for good.
    const conv = await db.get('SELECT type FROM conversations WHERE id = ?', [meeting.conversation_id]);
    if (conv?.type === 'dm') {
      const [res] = await db.batch([["UPDATE meetings SET ring_state = 'declined' WHERE id = ? AND ring_state = 'ringing'", [meeting.id]]]);
      if (res.changes) clearTimeout(timers.get(meeting.id));
    }
  }

  // The deadline passed: callees still ringing stop; nobody answered → missed.
  async function deadline(meetingId) {
    timers.delete(meetingId);
    const meeting = await meetings.byId(meetingId);
    if (!meeting?.call_kind) return;
    const joined = new Set((await db.all("SELECT user_id FROM meeting_participants WHERE meeting_id = ? AND user_id IS NOT NULL AND state IN ('admitted', 'left')", [meetingId])).map((r) => r.user_id));
    await stopFor(meeting.org_id, meetingId, (await callees(meeting)).filter((id) => !joined.has(id)));
    if (meeting.ring_state === 'ringing') await missed(meeting);
  }

  async function missed(meeting) {
    const [res] = await db.batch([["UPDATE meetings SET ring_state = 'missed' WHERE id = ? AND ring_state = 'ringing'", [meeting.id]]]);
    if (!res.changes) return;
    clearTimeout(timers.get(meeting.id));
    timers.delete(meeting.id);
    const org = await orgs.byId(meeting.org_id);
    const caller = meeting.host_id && (await users.byId(meeting.host_id));
    const targets = await callees(meeting);
    await stopFor(meeting.org_id, meeting.id, targets);
    rooms.notifyRoom(meeting.id, 'call.missed', {});
    if (caller) {
      await chat
        .send(org, caller, { conversationId: meeting.conversation_id, clientMessageId: `missed_${meeting.id}`.slice(0, 64), kind: 'call_missed', meta: { meeting_id: meeting.id, kind: meeting.call_kind } })
        .catch((err) => console.error('Missed-call message failed:', err.message));
      for (const userId of targets) {
        if (isOnline(org.id, userId)) continue;
        const u = await users.byId(userId);
        if (!u || u.status !== 'active') continue;
        const t = createTranslator(u.locale || 'en');
        mailer.queue({ to: u.email, ...missedCallEmail({ t, org: org.name, caller: caller.name, kind: meeting.call_kind, url: `${config.appUrl}/o/${org.slug}/c/${meeting.conversation_id}` }) });
      }
    }
    // Nobody is left in a call that was never answered: close it.
    if (!rooms.live(meeting.id)) await meetings.close(meeting, { label: 'system' }, 'ended', null);
  }

  rooms.setHooks({
    // Entering the room is answering.
    joined: async (meeting, ws) => {
      if (meeting.call_kind && ws.ctx.user && ws.ctx.user.id !== meeting.host_id) await respond(meeting, ws.ctx.user, 'accept');
    },
    // The caller hung up while it was still ringing: a missed call.
    // Otherwise a call ends like a phone call when everyone has left (after
    // a short grace, so a dropped connection can come back).
    empty: async (meeting) => {
      const current = await meetings.byId(meeting.id);
      if (!current?.call_kind) return;
      if (current.ring_state === 'ringing') return missed(current);
      const timer = setTimeout(async () => {
        try {
          const now = await meetings.byId(meeting.id);
          if (now && !rooms.live(meeting.id)) await meetings.close(now, { label: 'system' }, 'ended', null);
        } catch (err) {
          console.error('Call close failed:', err.message);
        }
      }, HANG_UP_GRACE_MS);
      timer.unref?.();
    },
  });

  // Fallback after a restart (maintenance): calls past their deadline.
  async function sweep() {
    const late = await db.all("SELECT id FROM meetings WHERE ring_state = 'ringing' AND ring_until < ? LIMIT 100", [new Date(Date.now() - 5000).toISOString()]);
    for (const { id } of late) await deadline(id);
  }

  return { ring, respond, sweep, close: () => timers.forEach((t) => clearTimeout(t)) };
}
