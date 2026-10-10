import { createTranslator } from './i18n.js';
import { nowIso } from './util.js';
import { missedCallEmail } from '../views/emails.js';
import { orgSender } from './mailer.js';
import { SMALL_SPACE } from './chat.js';

export const RING_MS = 45_000;
// A push notification sounds once; while a call rings it is sent again at
// this interval (same tag, renotify), so a closed app keeps ringing.
export const RE_RING_MS = 6_000;
const HANG_UP_GRACE_MS = 15_000;
const MAX_RING = SMALL_SPACE; // larger Spaces get the meeting card, no ringing

// createCalls: a call started from a DM or a small Space rings the other
// members (not those who turned the conversation's notifications off).
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
export function createCalls({ db, events, chat, meetings, orgs, users, mailer, config, rooms, isOnline, isWatching = () => false, push = null, reRingMs = RE_RING_MS }) {
  const timers = new Map();
  // key → { meetingId, users: callees whose devices still ring, timer }
  // (key: the meeting id for its own ring, another for each "ring into").
  const reRings = new Map();
  // "Ring into" state lives on the meeting invitation (ring_until), so any
  // node sees it and a restart does not lose it.
  let ringIntoSeq = 0;

  function endReRing(key) {
    clearInterval(reRings.get(key)?.timer);
    reRings.delete(key);
  }

  // Rings again the devices of those who neither answered nor declined, as
  // long as `active()` says the ring is on — true, or the set of people
  // still ringing (checked in the database: another node may have taken
  // the answer) — and not in the last moments before the deadline. When it
  // stops for another reason than the deadline, `onStop(remaining)`.
  function startReRing(key, org, meeting, targets, extra, active, onStop = () => {}) {
    endReRing(key);
    if (!push?.enabled) return;
    const entry = { meetingId: meeting.id, users: new Set(targets) };
    entry.timer = setInterval(async () => {
      try {
        if (Date.now() > Date.parse(extra.until) - reRingMs / 2) return endReRing(key);
        const on = await active();
        if (!on) {
          endReRing(key);
          return onStop([...entry.users]);
        }
        const joined = new Set((await db.all('SELECT user_id FROM meeting_participants WHERE meeting_id = ? AND user_id IS NOT NULL', [meeting.id])).map((r) => r.user_id));
        const users = [...entry.users].filter((id) => !joined.has(id) && (on === true || on.has(id)));
        if (!users.length) return endReRing(key);
        await pushCall(org, meeting, users, 'ring', extra);
      } catch (err) {
        console.error('Call re-ring failed:', err.message);
      }
    }, reRingMs);
    entry.timer.unref?.();
    reRings.set(key, entry);
  }

  // Push to the callees' devices (the app may be closed): the ring, with
  // answer/decline, until the deadline; then "over" or "missed", which
  // replaces it (same tag and topic, so an undelivered ring is replaced too).
  async function pushCall(org, meeting, userIds, kind, extra = {}) {
    if (!push?.enabled) return;
    const caller = extra.caller || (meeting.host_id && (await users.byId(meeting.host_id)));
    for (const userId of userIds) {
      if (kind === 'ring' && isWatching(org.id, userId)) continue;
      const u = await users.byId(userId);
      if (!u) continue;
      const t = createTranslator(u.locale || 'en');
      const base = { tag: `call-${meeting.id}`, meeting_id: meeting.id, url: `${config.appUrl}/o/${org.slug}/${meeting.conversation_id ? `c/${meeting.conversation_id}` : `meet/${meeting.id}`}` };
      const payload =
        kind === 'ring'
          ? {
              ...base,
              type: 'call',
              title: t('client.callIncoming', { name: caller?.name || '' }),
              body: t(extra.callKind === 'audio' ? 'client.incomingAudio' : 'client.incomingVideo'),
              accept_url: `${config.appUrl}/o/${org.slug}/meet/${meeting.id}?call=${extra.callKind}`,
              decline_url: `${config.appUrl}/api/o/${org.slug}/meetings/${meeting.id}/ring`,
              until: extra.until,
              actions: { accept: t('client.callAccept'), decline: t('client.callDecline') },
            }
          : kind === 'missed'
            ? { ...base, type: 'missed', title: t('client.callMissedFrom', { name: caller?.name || '' }), body: '' }
            : { ...base, type: 'call-stop' };
      push.toUser(userId, payload, { urgency: 'high', ttl: kind === 'ring' ? Math.ceil(RING_MS / 1000) : 3600, topic: `call-${meeting.id}` }).catch(() => {});
    }
  }

  const callees = async (meeting) => (await chat.memberIds(meeting.conversation_id)).filter((id) => id !== meeting.host_id);

  async function ring(org, caller, conversation, meeting, kind) {
    if (!['dm', 'space'].includes(conversation.type)) return [];
    const { quiet } = await chat.notifyTargets(conversation.id);
    const targets = (await chat.memberIds(conversation.id)).filter((id) => id !== caller.id && !quiet.includes(id));
    if (!targets.length || targets.length > MAX_RING) return [];
    const until = new Date(Date.now() + RING_MS).toISOString();
    const data = { meeting_id: meeting.id, conversation_id: conversation.id, from: caller.id, from_name: caller.name, kind, ring_until: until };
    await db.batch([
      ["UPDATE meetings SET call_kind = ?, ring_state = 'ringing', ring_until = ? WHERE id = ?", [kind, until, meeting.id]],
      ...targets.map((userId) => events.statement({ orgId: org.id, userId, type: 'call.ring', data })),
    ]);
    events.notify();
    pushCall(org, meeting, targets, 'ring', { caller, callKind: kind, until }).catch(() => {});
    startReRing(meeting.id, org, meeting, targets, { caller, callKind: kind, until }, async () => (await meetings.byId(meeting.id))?.ring_state === 'ringing');
    clearTimeout(timers.get(meeting.id));
    const timer = setTimeout(() => deadline(meeting.id).catch((err) => console.error('Call deadline failed:', err.message)), RING_MS + 500);
    timer.unref?.();
    timers.set(meeting.id, timer);
    return targets;
  }

  async function stopFor(orgId, meetingId, userIds, { pushed = true } = {}) {
    if (!userIds.length) return;
    for (const [key, reRing] of reRings) {
      if (reRing.meetingId !== meetingId) continue;
      for (const id of userIds) reRing.users.delete(id);
      if (!reRing.users.size) endReRing(key);
    }
    await db.batch(userIds.map((userId) => events.statement({ orgId, userId, type: 'call.stop', data: { meeting_id: meetingId } })));
    events.notify();
    if (pushed && push?.enabled) {
      const meeting = await meetings.byId(meetingId);
      const org = meeting && (await orgs.byId(orgId));
      if (org) await pushCall(org, meeting, userIds, 'stop');
    }
  }

  // Someone in a meeting rings colleagues into it ("ring into"): the same
  // incoming-call screen and push as a call, for RING_MS; whoever has not
  // joined or declined by then gets a missed call. Those already in the
  // room are not rung.
  // The invitation rows ringing with this deadline (this "ring into").
  const ringingSince = async (meetingId, until) => new Set((await db.all('SELECT user_id FROM meeting_invitations WHERE meeting_id = ? AND ring_until = ? AND revoked_at IS NULL', [meetingId, until])).map((r) => r.user_id));

  async function ringInto(org, caller, meeting, userIds, kind) {
    const present = new Set((await db.all("SELECT user_id FROM meeting_participants WHERE meeting_id = ? AND user_id IS NOT NULL AND state = 'admitted' AND left_at IS NULL", [meeting.id])).map((r) => r.user_id));
    const targets = userIds.filter((id) => id !== caller.id && !present.has(id));
    if (!targets.length) return [];
    const until = new Date(Date.now() + RING_MS).toISOString();
    const data = { meeting_id: meeting.id, conversation_id: meeting.conversation_id, from: caller.id, from_name: caller.name, kind, ring_until: until, title: meeting.title };
    // Only while the meeting is open: a meeting ended meanwhile rings no one.
    const open = "EXISTS (SELECT 1 FROM meetings WHERE id = ? AND state IN ('scheduled', 'open', 'live'))";
    await db.batch([
      [`UPDATE meeting_invitations SET ring_until = ?, ring_by = ?, ring_kind = ? WHERE meeting_id = ? AND revoked_at IS NULL AND user_id IN (${targets.map(() => '?').join(',')}) AND ${open}`, [until, caller.id, kind, meeting.id, ...targets, meeting.id]],
      ...targets.map((userId) => events.statement({ orgId: org.id, userId, type: 'call.ring', data })),
    ]);
    const rung = [...(await ringingSince(meeting.id, until))];
    if (!rung.length) return [];
    events.notify();
    const extra = { caller, callKind: kind, until };
    pushCall(org, meeting, rung, 'ring', extra).catch(() => {});
    // Re-rung while ringing; when the meeting ends meanwhile, their phones
    // are told to stop.
    startReRing(
      `${meeting.id}#${++ringIntoSeq}`,
      org,
      meeting,
      rung,
      extra,
      async () => {
        const set = await ringingSince(meeting.id, until);
        return set.size ? set : false;
      },
      (remaining) => remaining.length && pushCall(org, meeting, remaining, 'stop').catch(() => {})
    );
    const timer = setTimeout(() => ringIntoDeadline(org, meeting, until, caller).catch((err) => console.error('Ring-into deadline failed:', err.message)), RING_MS + 500);
    timer.unref?.();
    return rung;
  }

  // Who still rings with that deadline stops, and gets a missed call. Also
  // run by the maintenance sweep (another node, a restart).
  async function ringIntoDeadline(org, meeting, until, caller) {
    const left = [...(await ringingSince(meeting.id, until))];
    if (!left.length) return;
    await db.run(`UPDATE meeting_invitations SET ring_until = NULL WHERE meeting_id = ? AND ring_until = ? AND user_id IN (${left.map(() => '?').join(',')})`, [meeting.id, until, ...left]);
    await stopFor(org.id, meeting.id, left, { pushed: false });
    await pushCall(org, meeting, left, 'missed', { caller });
  }

  // A callee answered (joined the room) or declined, on any device. Whoever
  // was rung into the meeting stops ringing — the meeting's own host too.
  async function respond(meeting, user, answer) {
    const [cleared] = await db.batch([['UPDATE meeting_invitations SET ring_until = NULL WHERE meeting_id = ? AND user_id = ? AND ring_until IS NOT NULL', [meeting.id, user.id]]]);
    if (user.id === meeting.host_id || !meeting.call_kind) {
      if (cleared.changes) await stopFor(meeting.org_id, meeting.id, [user.id]);
      return;
    }
    await stopFor(meeting.org_id, meeting.id, [user.id]);
    if (answer === 'accept') {
      // A call's duration runs from the answer, not from the first ring.
      await db.run("UPDATE meetings SET ring_state = 'answered', started_at = ? WHERE id = ? AND ring_state = 'ringing'", [nowIso(), meeting.id]);
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
    // (The devices get "missed" instead of a plain stop.)
    await stopFor(meeting.org_id, meeting.id, targets, { pushed: false });
    await pushCall(org, meeting, targets, 'missed', { caller });
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
        mailer.queue({ to: u.email, sender: orgSender(org), ...missedCallEmail({ t, org: org.name, caller: caller.name, kind: meeting.call_kind, url: `${config.appUrl}/o/${org.slug}/c/${meeting.conversation_id}` }) });
      }
    }
    // Nobody is left in a call that was never answered: close it.
    if (!rooms.live(meeting.id)) await meetings.close(meeting, { label: 'system' }, 'ended', null);
  }

  rooms.setHooks({
    // Entering the room is answering.
    joined: async (meeting, ws) => {
      if (ws.ctx.user) await respond(meeting, ws.ctx.user, 'accept');
    },
    // The caller hung up while it was still ringing: a missed call.
    // Otherwise a call ends like a phone call when everyone has left (after
    // a short grace, so a dropped connection can come back).
    empty: async (meeting) => {
      const current = await meetings.byId(meeting.id);
      if (!current?.call_kind) return;
      if (current.ring_state === 'ringing') return missed(current);
      const emptiedAt = nowIso();
      const timer = setTimeout(async () => {
        try {
          const now = await meetings.byId(meeting.id);
          if (now && !rooms.live(meeting.id)) await meetings.close(now, { label: 'system' }, 'ended', null, emptiedAt);
        } catch (err) {
          console.error('Call close failed:', err.message);
        }
      }, HANG_UP_GRACE_MS);
      timer.unref?.();
    },
  });

  // Fallback after a restart (maintenance): calls past their deadline.
  async function sweep() {
    const cutoff = new Date(Date.now() - 5000).toISOString();
    const late = await db.all("SELECT id FROM meetings WHERE ring_state = 'ringing' AND ring_until < ? LIMIT 100", [cutoff]);
    for (const { id } of late) await deadline(id);
    // "Ring into" deadlines this node did not see (another node, a restart).
    const lateInto = await db.all('SELECT DISTINCT meeting_id, ring_until, ring_by FROM meeting_invitations WHERE ring_until IS NOT NULL AND ring_until < ? LIMIT 100', [cutoff]);
    for (const r of lateInto) {
      const meeting = await meetings.byId(r.meeting_id);
      const org = meeting && (await orgs.byId(meeting.org_id));
      if (org) await ringIntoDeadline(org, meeting, r.ring_until, r.ring_by && (await users.byId(r.ring_by)));
    }
  }

  return {
    ring,
    ringInto,
    respond,
    sweep,
    close: () => {
      timers.forEach((t) => clearTimeout(t));
      for (const id of [...reRings.keys()]) endReRing(id);
    },
  };
}
