import { createHmac, randomInt } from 'node:crypto';
import { canonicalEmail, isEmail, isoIn, newId, newToken, nowIso, appError, parseJson, safeEqualHex, sha256 } from './util.js';

const OTP_TTL_MS = 10 * 60_000;
const OTP_MAX_ATTEMPTS = 5;
const OTP_RESEND_MS = 60_000;
const OTP_MAX_PER_HOUR = 5;
const ACTIVE = ['scheduled', 'open', 'live'];

// createMeetings: meeting lifecycle, internal and external invitations, the
// guest e-mail OTP flow, guest sessions and the lobby (spec §8–9). Media
// signaling lives in core/meeting-rooms.js; it calls back here for every
// authorization decision.
export function createMeetings({ db, policies, audit, appSecret, events }) {
  const otpHash = (invitationId, code) => createHmac('sha256', appSecret).update(`otp:${invitationId}:${code}`).digest('hex');

  // A meeting that is past its expiry is treated as ended everywhere.
  const isOpen = (m) => ACTIVE.includes(m.state) && m.expires_at > nowIso();

  const byId = (id) => db.get('SELECT * FROM meetings WHERE id = ?', [id]);

  async function requireMeeting(org, id) {
    const m = await db.get('SELECT * FROM meetings WHERE id = ? AND org_id = ?', [id, org.id]);
    if (!m) throw appError('not_found', 'Meeting not found');
    return m;
  }

  async function create(org, user, role, { title, scheduledAt = '', durationMin, conversationId = null, userIds = [], guests = [] }, ip) {
    const policy = await policies.get(org.id);
    const cleanTitle = String(title || '').trim().slice(0, 120);
    if (!cleanTitle) throw appError('invalid', 'Title required', { field: 'title' });
    const duration = Math.min(Math.max(Number(durationMin) || 60, 5), policy.max_meeting_minutes);
    const start = scheduledAt ? new Date(scheduledAt) : new Date();
    if (Number.isNaN(start.getTime())) throw appError('invalid', 'Invalid start time', { field: 'scheduled_at' });
    const scheduled = start.getTime() > Date.now() + 5 * 60_000;
    // Joinable from creation until the planned end plus the max duration.
    const expiresAt = new Date(Math.max(start.getTime(), Date.now()) + (duration + policy.max_meeting_minutes) * 60_000).toISOString();
    const cleanGuests = guests.map((g) => ({ email: canonicalEmail(g.email), name: String(g.name || '').trim().slice(0, 80) })).filter((g) => g.email);
    for (const g of cleanGuests) {
      if (!isEmail(g.email)) throw appError('invalid', 'Invalid e-mail', { field: 'guests', email: g.email });
      await policies.assertCanInviteExternal({ orgId: org.id, policy, membershipRole: role, email: g.email });
    }
    const internal = [...new Set(userIds)].filter((id) => id !== user.id);
    if (internal.length) {
      const ok = await db.get(
        `SELECT COUNT(*) AS n FROM memberships WHERE org_id = ? AND status = 'active' AND user_id IN (${internal.map(() => '?').join(',')})`,
        [org.id, ...internal]
      );
      if (ok.n !== internal.length) throw appError('invalid', 'Unknown invitee');
    }
    const id = newId();
    const at = nowIso();
    const snapshot = {
      guest_otp_required: policy.guest_otp_required,
      guest_lobby_required: policy.guest_lobby_required,
      guest_screen_share: policy.guest_screen_share,
      media_sfu_allowed: policy.media_sfu_allowed,
      max_participants: policy.max_participants,
    };
    const tokens = [];
    const statements = [
      [
        `INSERT INTO meetings (id, org_id, conversation_id, host_id, title, state, scheduled_at, duration_min, expires_at, policy_version, policy_snapshot, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, org.id, conversationId, user.id, cleanTitle, scheduled ? 'scheduled' : 'open', start.toISOString(), duration, expiresAt, policy.version, JSON.stringify(snapshot), at],
      ],
      ...internal.map((uid) => ['INSERT INTO meeting_invitations (id, meeting_id, org_id, user_id, invited_by, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [newId(), id, org.id, uid, user.id, expiresAt, at]]),
      audit.statement({ orgId: org.id, actor: user, action: 'meeting.create', resourceType: 'meeting', resourceId: id, ip, data: { title: cleanTitle, scheduled: start.toISOString(), internal: internal.length, guests: cleanGuests.length } }),
    ];
    for (const g of cleanGuests) {
      const inv = guestInvitation({ orgId: org.id, meetingId: id, guest: g, inviter: user, expiresAt: isoIn(Math.min(policy.invite_ttl_hours * 3600_000, Date.parse(expiresAt) - Date.now())) });
      tokens.push(inv.result);
      statements.push(...inv.statements, audit.statement({ orgId: org.id, actor: user, action: 'meeting.invite_external', resourceType: 'meeting', resourceId: id, ip, data: { email: g.email } }));
    }
    await db.batch(statements);
    return { meeting: await byId(id), guestTokens: tokens };
  }

  // One external invitation: unique per recipient and meeting; only the
  // token hash is stored (spec §9 step 11).
  function guestInvitation({ orgId, meetingId, guest, inviter, expiresAt }) {
    const token = newToken();
    const invitationId = newId();
    return {
      result: { invitationId, email: guest.email, name: guest.name, token },
      statements: [
        ['UPDATE meeting_invitations SET revoked_at = ? WHERE meeting_id = ? AND email = ? AND revoked_at IS NULL', [nowIso(), meetingId, guest.email]],
        [
          'INSERT INTO meeting_invitations (id, meeting_id, org_id, email, name, token_hash, invited_by, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [invitationId, meetingId, orgId, guest.email, guest.name || null, sha256(token), inviter.id, expiresAt, nowIso()],
        ],
      ],
    };
  }

  async function inviteGuest(org, meeting, user, role, { email, name }, ip) {
    if (!isOpen(meeting)) throw appError('expired', 'Meeting ended');
    if (!(await canManage(meeting, user, role))) throw appError('forbidden', 'Only the host can invite');
    const policy = await policies.get(org.id);
    const clean = canonicalEmail(email);
    if (!isEmail(clean)) throw appError('invalid', 'Invalid e-mail', { field: 'email' });
    await policies.assertCanInviteExternal({ orgId: org.id, policy, membershipRole: role, email: clean });
    const inv = guestInvitation({ orgId: org.id, meetingId: meeting.id, guest: { email: clean, name }, inviter: user, expiresAt: isoIn(Math.min(policy.invite_ttl_hours * 3600_000, Date.parse(meeting.expires_at) - Date.now())) });
    await db.batch([...inv.statements, audit.statement({ orgId: org.id, actor: user, action: 'meeting.invite_external', resourceType: 'meeting', resourceId: meeting.id, ip, data: { email: clean } })]);
    return inv.result;
  }

  async function inviteMembers(org, meeting, user, role, userIds, ip) {
    if (!(await canManage(meeting, user, role))) throw appError('forbidden', 'Only the host can invite');
    const ids = [...new Set(userIds)].slice(0, 200);
    const valid = ids.length
      ? await db.all(`SELECT user_id FROM memberships WHERE org_id = ? AND status = 'active' AND user_id IN (${ids.map(() => '?').join(',')})`, [org.id, ...ids])
      : [];
    await db.batch([
      ...valid.map((r) => [
        'INSERT INTO meeting_invitations (id, meeting_id, org_id, user_id, invited_by, expires_at, created_at) SELECT ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM meeting_invitations WHERE meeting_id = ? AND user_id = ? AND revoked_at IS NULL)',
        [newId(), meeting.id, org.id, r.user_id, user.id, meeting.expires_at, nowIso(), meeting.id, r.user_id],
      ]),
      audit.statement({ orgId: org.id, actor: user, action: 'meeting.invite_members', resourceType: 'meeting', resourceId: meeting.id, ip, data: { users: valid.map((r) => r.user_id) } }),
    ]);
    return valid.map((r) => r.user_id);
  }

  // Host, co-host, or an org owner/admin may manage a meeting.
  async function canManage(meeting, user, role) {
    if (meeting.host_id === user.id || role === 'owner' || role === 'admin') return true;
    const p = await db.get("SELECT role FROM meeting_participants WHERE meeting_id = ? AND user_id = ? AND state = 'admitted'", [meeting.id, user.id]);
    return p?.role === 'cohost';
  }

  // Members of the host organization: the host, invitees and members of the
  // linked conversation enter directly; anyone else in the org waits in the
  // lobby. Revoked/removed participants stay out.
  async function memberAccess(meeting, user) {
    if (meeting.host_id === user.id) return 'host';
    const invited = await db.get('SELECT 1 AS x FROM meeting_invitations WHERE meeting_id = ? AND user_id = ? AND revoked_at IS NULL', [meeting.id, user.id]);
    if (invited) return 'direct';
    if (meeting.conversation_id) {
      const inConv = await db.get('SELECT 1 AS x FROM conversation_members WHERE conversation_id = ? AND user_id = ?', [meeting.conversation_id, user.id]);
      if (inConv) return 'direct';
    }
    return 'lobby';
  }

  // Creates or refreshes the participant row for a member. Returns it with
  // `state` admitted or lobby.
  async function joinAsMember(meeting, user) {
    if (!isOpen(meeting)) throw appError('expired', 'Meeting ended');
    const existing = await db.get('SELECT * FROM meeting_participants WHERE meeting_id = ? AND user_id = ?', [meeting.id, user.id]);
    if (existing && (existing.state === 'removed' || existing.state === 'rejected')) throw appError('forbidden', 'Removed from this meeting', { reason: existing.state });
    const access = await memberAccess(meeting, user);
    const state = existing?.state === 'admitted' || access !== 'lobby' ? 'admitted' : 'lobby';
    const role = access === 'host' ? 'host' : existing?.role || 'participant';
    const at = nowIso();
    if (existing) {
      await db.run('UPDATE meeting_participants SET state = ?, role = ?, display_name = ?, left_at = NULL WHERE id = ?', [state, role, user.name, existing.id]);
      return { ...existing, state, role, display_name: user.name };
    }
    const id = newId();
    await db.run(
      'INSERT INTO meeting_participants (id, meeting_id, user_id, display_name, role, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, meeting.id, user.id, user.name, role, state, at]
    );
    return { id, meeting_id: meeting.id, user_id: user.id, invitation_id: null, display_name: user.name, role, state };
  }

  // ------------------------------------------------------------ guest flow

  async function invitationByToken(token) {
    const inv = await db.get('SELECT * FROM meeting_invitations WHERE token_hash = ?', [sha256(String(token || ''))]);
    if (!inv) throw appError('not_found', 'Invitation not found');
    const meeting = await byId(inv.meeting_id);
    const org = await db.get('SELECT id, name, slug, status FROM organizations WHERE id = ?', [inv.org_id]);
    if (inv.revoked_at) throw appError('expired', 'Invitation revoked', { reason: 'revoked' });
    if (inv.expires_at < nowIso()) throw appError('expired', 'Invitation expired', { reason: 'expired' });
    if (!meeting || !isOpen(meeting)) throw appError('expired', 'Meeting ended', { reason: meeting?.state === 'canceled' ? 'canceled' : 'ended' });
    if (org.status !== 'active') throw appError('expired', 'Organization suspended', { reason: 'suspended' });
    return { inv, meeting, org, policy: parseJson(meeting.policy_snapshot, {}) };
  }

  // The OTP goes to the invited address only (proves control of it). Rate
  // limited per invitation; the code is stored as an HMAC.
  async function issueOtp(inv) {
    const recent = await db.all('SELECT created_at FROM email_otps WHERE invitation_id = ? AND created_at >= ? ORDER BY created_at DESC', [inv.id, new Date(Date.now() - 3600_000).toISOString()]);
    if (recent.length >= OTP_MAX_PER_HOUR) throw appError('rate_limited', 'Too many codes', { reason: 'hour' });
    const wait = recent[0] ? Math.ceil((Date.parse(recent[0].created_at) + OTP_RESEND_MS - Date.now()) / 1000) : 0;
    if (wait > 0) throw appError('rate_limited', 'Wait before a new code', { reason: 'wait', seconds: wait });
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await db.batch([
      ['UPDATE email_otps SET used_at = ? WHERE invitation_id = ? AND used_at IS NULL', [nowIso(), inv.id]],
      ['INSERT INTO email_otps (id, invitation_id, code_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)', [newId(), inv.id, otpHash(inv.id, code), isoIn(OTP_TTL_MS), nowIso()]],
    ]);
    return code;
  }

  // Returns a new guest session token, or throws. Attempts are counted per
  // code; brute force kills the code (spec §9 edge cases).
  async function verifyOtp(inv, code, ip) {
    const row = await db.get('SELECT * FROM email_otps WHERE invitation_id = ? AND used_at IS NULL ORDER BY created_at DESC LIMIT 1', [inv.id]);
    if (!row || row.expires_at < nowIso()) throw appError('expired', 'Code expired', { reason: 'otpExpired' });
    if (row.attempts >= OTP_MAX_ATTEMPTS) throw appError('rate_limited', 'Too many attempts', { reason: 'otpLocked' });
    const given = String(code || '').replace(/\D/g, '');
    if (!safeEqualHex(otpHash(inv.id, given), row.code_hash)) {
      await db.run('UPDATE email_otps SET attempts = attempts + 1 WHERE id = ?', [row.id]);
      await audit.log({ orgId: inv.org_id, actor: { label: `guest:${inv.email}` }, action: 'meeting.otp_failed', resourceType: 'invitation', resourceId: inv.id, ip });
      throw appError('invalid', 'Wrong code', { reason: row.attempts + 1 >= OTP_MAX_ATTEMPTS ? 'otpLocked' : 'otpWrong' });
    }
    await db.run('UPDATE email_otps SET used_at = ? WHERE id = ?', [nowIso(), row.id]);
    return startGuestSession(inv, ip, 'otp');
  }

  async function startGuestSession(inv, ip, method) {
    const meeting = await byId(inv.meeting_id);
    const token = newToken();
    await db.batch([
      ['UPDATE meeting_invitations SET verified_at = COALESCE(verified_at, ?) WHERE id = ?', [nowIso(), inv.id]],
      ['INSERT INTO guest_sessions (id_hash, invitation_id, meeting_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?)', [sha256(token), inv.id, inv.meeting_id, meeting.expires_at, nowIso()]],
      audit.statement({ orgId: inv.org_id, actor: { label: `guest:${inv.email}` }, action: 'meeting.guest_verified', resourceType: 'invitation', resourceId: inv.id, ip, data: { method } }),
    ]);
    return token;
  }

  // Guest session → { session, inv, meeting } if still valid (not revoked,
  // invitation not revoked, meeting open).
  async function guestFromToken(token) {
    if (!token) return null;
    const session = await db.get('SELECT * FROM guest_sessions WHERE id_hash = ?', [sha256(token)]);
    if (!session || session.revoked_at || session.expires_at < nowIso()) return null;
    const inv = await db.get('SELECT * FROM meeting_invitations WHERE id = ?', [session.invitation_id]);
    const meeting = await byId(session.meeting_id);
    if (!inv || inv.revoked_at || !meeting || !isOpen(meeting)) return null;
    const org = await db.get('SELECT id, slug, name, status FROM organizations WHERE id = ?', [meeting.org_id]);
    if (org.status !== 'active') return null;
    return { session, inv, meeting, org, policy: parseJson(meeting.policy_snapshot, {}) };
  }

  async function joinAsGuest({ inv, meeting, policy }, displayName) {
    const name = String(displayName || inv.name || inv.email.split('@')[0]).trim().slice(0, 60) || 'Guest';
    const existing = await db.get('SELECT * FROM meeting_participants WHERE meeting_id = ? AND invitation_id = ?', [meeting.id, inv.id]);
    if (existing && (existing.state === 'removed' || existing.state === 'rejected')) throw appError('forbidden', 'Removed from this meeting', { reason: existing.state });
    const state = existing?.state === 'admitted' || policy.guest_lobby_required === false ? 'admitted' : 'lobby';
    if (existing) {
      await db.run('UPDATE meeting_participants SET state = ?, display_name = ?, left_at = NULL WHERE id = ?', [state, name, existing.id]);
      return { ...existing, state, display_name: name };
    }
    const id = newId();
    await db.run(
      "INSERT INTO meeting_participants (id, meeting_id, invitation_id, display_name, role, state, created_at) VALUES (?, ?, ?, ?, 'guest', ?, ?)",
      [id, meeting.id, inv.id, name, state, nowIso()]
    );
    return { id, meeting_id: meeting.id, user_id: null, invitation_id: inv.id, display_name: name, role: 'guest', state };
  }

  // ------------------------------------------------------- host decisions

  const participant = (meetingId, participantId) => db.get('SELECT * FROM meeting_participants WHERE id = ? AND meeting_id = ?', [participantId, meetingId]);

  async function admit(meeting, actor, participantId, accept, ip) {
    const p = await participant(meeting.id, participantId);
    if (!p || p.state !== 'lobby') throw appError('not_found', 'Nobody waiting');
    const state = accept ? 'admitted' : 'rejected';
    await db.batch([
      ['UPDATE meeting_participants SET state = ? WHERE id = ?', [state, p.id]],
      audit.statement({ orgId: meeting.org_id, actor, action: accept ? 'meeting.admit' : 'meeting.reject', resourceType: 'meeting', resourceId: meeting.id, ip, data: { participant: p.id, name: p.display_name } }),
    ]);
    return { ...p, state };
  }

  async function setCohost(meeting, actor, participantId, on, ip) {
    const p = await participant(meeting.id, participantId);
    if (!p || !p.user_id || p.role === 'host') throw appError('invalid', 'Only members can be co-hosts');
    await db.batch([
      ['UPDATE meeting_participants SET role = ? WHERE id = ?', [on ? 'cohost' : 'participant', p.id]],
      audit.statement({ orgId: meeting.org_id, actor, action: on ? 'meeting.cohost_add' : 'meeting.cohost_remove', resourceType: 'meeting', resourceId: meeting.id, ip, data: { participant: p.id } }),
    ]);
  }

  // Removal invalidates the participant and, for guests, their sessions.
  async function removeParticipant(meeting, actor, participantId, ip) {
    const p = await participant(meeting.id, participantId);
    if (!p || p.role === 'host') throw appError('invalid', 'Cannot remove the host');
    await db.batch([
      ["UPDATE meeting_participants SET state = 'removed', left_at = ? WHERE id = ?", [nowIso(), p.id]],
      ...(p.invitation_id ? [['UPDATE guest_sessions SET revoked_at = ? WHERE invitation_id = ? AND revoked_at IS NULL', [nowIso(), p.invitation_id]]] : []),
      audit.statement({ orgId: meeting.org_id, actor, action: 'meeting.remove_participant', resourceType: 'meeting', resourceId: meeting.id, ip, data: { participant: p.id, name: p.display_name } }),
    ]);
    return p;
  }

  async function revokeInvitation(meeting, actor, invitationId, ip) {
    const inv = await db.get('SELECT * FROM meeting_invitations WHERE id = ? AND meeting_id = ?', [invitationId, meeting.id]);
    if (!inv) throw appError('not_found', 'Invitation not found');
    const at = nowIso();
    await db.batch([
      ['UPDATE meeting_invitations SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?', [at, inv.id]],
      ['UPDATE guest_sessions SET revoked_at = ? WHERE invitation_id = ? AND revoked_at IS NULL', [at, inv.id]],
      ["UPDATE meeting_participants SET state = 'removed', left_at = ? WHERE meeting_id = ? AND (invitation_id = ? OR (user_id IS NOT NULL AND user_id = ?)) AND state IN ('lobby', 'admitted')", [at, meeting.id, inv.id, inv.user_id]],
      audit.statement({ orgId: meeting.org_id, actor, action: 'meeting.invite_revoke', resourceType: 'invitation', resourceId: inv.id, ip, data: { email: inv.email, user: inv.user_id } }),
    ]);
    return inv;
  }

  // End or cancel: every join session and media path is invalidated, and
  // the meeting's card in its conversation stops offering "Join" — it shows
  // how the call ended (ended with its duration, missed, canceled), on every
  // client at once (message.updated).
  async function close(meeting, actor, state, ip) {
    if (!isOpen(meeting)) return;
    await finish(meeting, state, nowIso(), audit.statement({ orgId: meeting.org_id, actor, action: state === 'canceled' ? 'meeting.cancel' : 'meeting.end', resourceType: 'meeting', resourceId: meeting.id, ip }));
  }

  async function finish(meeting, state, at, auditRow) {
    const cards = meeting.conversation_id
      ? await db.all("SELECT id FROM messages WHERE conversation_id = ? AND kind = 'meeting' AND json_extract(meta, '$.meeting_id') = ?", [meeting.conversation_id, meeting.id])
      : [];
    // Only the batch that really closes the meeting updates the cards.
    const closedNow = 'EXISTS (SELECT 1 FROM meetings WHERE id = ? AND ended_at = ? AND state = ?)';
    const closedArgs = [meeting.id, at, state];
    await db.batch([
      ["UPDATE meetings SET state = ?, ended_at = ? WHERE id = ? AND state IN ('scheduled', 'open', 'live')", [state, at, meeting.id]],
      ['UPDATE guest_sessions SET revoked_at = ? WHERE meeting_id = ? AND revoked_at IS NULL', [at, meeting.id]],
      ["UPDATE meeting_participants SET state = 'left', left_at = COALESCE(left_at, ?) WHERE meeting_id = ? AND state IN ('lobby', 'admitted')", [at, meeting.id]],
      ...(auditRow ? [auditRow] : []),
      ...cards.flatMap(({ id }) => [
        [
          `UPDATE messages SET version = version + 1, meta = json_set(COALESCE(meta, '{}'),
             '$.state', ?, '$.ended_at', ?, '$.outcome', (SELECT ring_state FROM meetings WHERE id = ?),
             '$.duration_s', (SELECT CAST(ROUND((julianday(ended_at) - julianday(started_at)) * 86400) AS INTEGER) FROM meetings WHERE id = ? AND started_at IS NOT NULL))
           WHERE id = ? AND ${closedNow}`,
          [state, at, meeting.id, meeting.id, id, ...closedArgs],
        ],
        events.messageEvent('message.updated', id, closedNow, closedArgs),
      ]),
    ]);
    if (cards.length) events.notify();
  }

  // Meetings past their end time that nobody closed (maintenance).
  async function closeExpired() {
    const rows = await db.all("SELECT * FROM meetings WHERE state IN ('scheduled', 'open', 'live') AND expires_at < ? LIMIT 200", [nowIso()]);
    for (const m of rows) await finish(m, 'ended', m.expires_at, null);
    return rows.length;
  }

  async function markLive(meeting) {
    await db.run("UPDATE meetings SET state = 'live', started_at = COALESCE(started_at, ?) WHERE id = ? AND state IN ('scheduled', 'open')", [nowIso(), meeting.id]);
  }

  async function markIdle(meetingId) {
    await db.run("UPDATE meetings SET state = 'open' WHERE id = ? AND state = 'live'", [meetingId]);
  }

  async function recordLeave(participantId, minutes, orgId) {
    await db.batch([
      ['UPDATE meeting_participants SET left_at = ? WHERE id = ?', [nowIso(), participantId]],
      [
        'INSERT INTO usage_counters (org_id, period, metric, value) VALUES (?, ?, ?, ?) ON CONFLICT(org_id, period, metric) DO UPDATE SET value = value + excluded.value',
        [orgId, nowIso().slice(0, 7), 'meeting_minutes', Math.max(1, Math.round(minutes))],
      ],
    ]);
  }

  // Meetings the user hosts, is invited to, or can reach via a conversation;
  // upcoming and live first, then the recent past.
  const listForUser = (org, user) =>
    db.all(
      `SELECT m.*, u.name AS host_name FROM meetings m LEFT JOIN users u ON u.id = m.host_id
       WHERE m.org_id = ? AND (m.host_id = ?
         OR EXISTS (SELECT 1 FROM meeting_invitations i WHERE i.meeting_id = m.id AND i.user_id = ? AND i.revoked_at IS NULL)
         OR EXISTS (SELECT 1 FROM conversation_members cm WHERE cm.conversation_id = m.conversation_id AND cm.user_id = ?))
         AND m.created_at > ?
       ORDER BY CASE WHEN m.state IN ('live', 'open', 'scheduled') AND m.expires_at > ? THEN 0 ELSE 1 END, m.scheduled_at DESC LIMIT 100`,
      [org.id, user.id, user.id, user.id, new Date(Date.now() - 30 * 86400_000).toISOString(), nowIso()]
    );

  const invitations = (meetingId) =>
    db.all(
      `SELECT i.id, i.user_id, i.email, i.name, i.verified_at, i.revoked_at, i.expires_at, i.created_at, u.name AS user_name
       FROM meeting_invitations i LEFT JOIN users u ON u.id = i.user_id WHERE i.meeting_id = ? ORDER BY i.created_at`,
      [meetingId]
    );

  const participants = (meetingId) => db.all('SELECT * FROM meeting_participants WHERE meeting_id = ? ORDER BY created_at', [meetingId]);

  // ------------------------------------------------------------ room chat
  // Meetings without a conversation keep their in-call chat here. Sending
  // is idempotent per participant and client id (a resend after a
  // reconnect stores nothing new).
  const CHAT_MAX = 2000;
  const chatRow = (r) => ({ id: r.id, author_id: r.user_id, participant_id: r.participant_id, name: r.display_name, body: r.body, client_id: r.client_id, created_at: r.created_at });

  async function addChatMessage(meeting, participant, clientId, body) {
    const text = String(body || '').replace(/\r\n/g, '\n').trim();
    if (!text) throw appError('invalid', 'Empty message');
    if (text.length > CHAT_MAX) throw appError('invalid', 'Message too long', { max: CHAT_MAX });
    const cid = String(clientId || '');
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(cid)) throw appError('invalid', 'client_id required');
    await db.run(
      `INSERT OR IGNORE INTO meeting_messages (id, meeting_id, org_id, participant_id, user_id, display_name, client_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [newId(), meeting.id, meeting.org_id, participant.id, participant.user_id || null, participant.display_name, cid, text, nowIso()]
    );
    return chatRow(await db.get('SELECT * FROM meeting_messages WHERE meeting_id = ? AND participant_id = ? AND client_id = ?', [meeting.id, participant.id, cid]));
  }

  const chatMessages = async (meetingId) =>
    (await db.all('SELECT * FROM (SELECT * FROM meeting_messages WHERE meeting_id = ? ORDER BY created_at DESC LIMIT 200) ORDER BY created_at', [meetingId])).map(chatRow);

  return {
    isOpen,
    byId,
    requireMeeting,
    create,
    inviteGuest,
    inviteMembers,
    canManage,
    joinAsMember,
    invitationByToken,
    issueOtp,
    verifyOtp,
    startGuestSession,
    guestFromToken,
    joinAsGuest,
    participant,
    admit,
    setCohost,
    removeParticipant,
    revokeInvitation,
    close,
    closeExpired,
    markLive,
    markIdle,
    recordLeave,
    listForUser,
    invitations,
    participants,
    addChatMessage,
    chatMessages,
  };
}
