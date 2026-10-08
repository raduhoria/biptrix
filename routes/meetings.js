import { INTL_LOCALE, createTranslator, translateError } from '../core/i18n.js';
import { readForm, readJson } from '../core/router.js';
import { can } from '../core/orgs.js';
import { appError, newId } from '../core/util.js';
import { meetingInviteEmail, memberMeetingEmail, otpEmail } from '../views/emails.js';
import { messagePage } from '../views/layout.js';
import { guestJoinView, meetingRoomView } from '../views/meeting.js';

const GUEST_COOKIE = 'gsid';

// Meetings (spec §8–9): member pages and API under /o/:org, the external
// guest flow under /join/:token (invitation link → e-mail OTP → guest
// session) and the guest room at /meet/:id.
export function registerMeetingRoutes(router, { auth, orgs, chat, meetings, rooms, calls, mailer, config, db, users }) {
  const member = [auth.requireUser, orgs.requireOrg];
  const whenText = (t, m) => new Date(m.scheduled_at).toLocaleString(INTL_LOCALE[t.locale] || 'en-GB', { dateStyle: 'full', timeStyle: 'short', timeZone: 'Europe/Bucharest' }) + ' (Europe/Bucharest)';

  function sendGuestInvites(t, org, meeting, inviter, tokens) {
    for (const g of tokens) {
      mailer.queue({
        to: g.email,
        ...meetingInviteEmail({ t, org: org.name, inviter: inviter.name, title: meeting.title, when: whenText(t, meeting), url: `${config.appUrl}/join/${g.token}`, otp: JSON.parse(meeting.policy_snapshot).guest_otp_required }),
      });
    }
  }

  async function sendMemberInvites(org, meeting, inviter, userIds) {
    for (const id of userIds) {
      const u = await users.byId(id);
      if (!u) continue;
      const t = createTranslator(u.locale || 'en');
      mailer.queue({ to: u.email, ...memberMeetingEmail({ t, org: org.name, inviter: inviter.name, title: meeting.title, when: whenText(t, meeting), url: `${config.appUrl}/o/${org.slug}/meet/${meeting.id}` }) });
    }
  }

  const meetingJson = async (m, req) => ({
    ...m,
    policy_snapshot: JSON.parse(m.policy_snapshot),
    open: meetings.isOpen(m),
    live_count: rooms.live(m.id),
    can_manage: await meetings.canManage(m, req.user, req.membership.role),
    url: `${config.appUrl}/o/${req.org.slug}/meet/${m.id}`,
  });

  router.get('/api/o/:org/meetings', ...member, async (req, res) => {
    const list = await meetings.listForUser(req.org, req.user);
    res.json({ meetings: await Promise.all(list.map((m) => meetingJson(m, req))) });
  });

  // Create: scheduled or instant; from a conversation the meeting is linked
  // to it and announced there as a meeting card. `call: audio|video` (the
  // call buttons) also rings the other members of a DM or group.
  router.post('/api/o/:org/meetings', ...member, async (req, res) => {
    const body = await readJson(req);
    // A call (call: audio|video) inside one of the caller's conversations
    // needs only `calls` (external collaborators too); anything else — a
    // scheduled or free-standing meeting, invitees, guests — `meetings.create`.
    const isCall = ['audio', 'video'].includes(body.call) && !!body.conversation_id;
    if (!can(req.membership.role, 'meetings.create')) {
      if (!isCall || !can(req.membership.role, 'calls')) throw appError('forbidden', 'Missing permission meetings.create');
      Object.assign(body, { title: '', scheduled_at: '', user_ids: [], guests: [] });
    }
    let conversation = null;
    if (body.conversation_id) conversation = await chat.requireConversation(req.org, req.user, body.conversation_id);
    const { meeting, guestTokens } = await meetings.create(
      req.org,
      req.user,
      req.membership.role,
      {
        title: body.title || (conversation ? req.t('client.callTitle', { name: conversation.name || req.user.name }) : ''),
        scheduledAt: body.scheduled_at || '',
        durationMin: body.duration_min,
        conversationId: conversation?.id || null,
        userIds: Array.isArray(body.user_ids) ? body.user_ids : [],
        guests: Array.isArray(body.guests) ? body.guests : [],
      },
      req.ip
    );
    sendGuestInvites(req.t, req.org, meeting, req.user, guestTokens);
    if (body.notify_members !== false) await sendMemberInvites(req.org, meeting, req.user, (Array.isArray(body.user_ids) ? body.user_ids : []).filter((id) => id !== req.user.id));
    const callKind = conversation && ['audio', 'video'].includes(body.call) ? body.call : null;
    let ringing = 0;
    if (conversation) {
      await chat.send(req.org, req.user, {
        conversationId: conversation.id,
        clientMessageId: `mtg_${newId()}`,
        kind: 'meeting',
        body: meeting.title,
        meta: { meeting_id: meeting.id, title: meeting.title, scheduled_at: meeting.scheduled_at, state: meeting.state, call: callKind },
      });
      if (callKind) ringing = (await calls.ring(req.org, req.user, conversation, meeting, callKind)).length;
    }
    res.json({ meeting: await meetingJson(await meetings.byId(meeting.id), req), ringing });
  });

  // A callee's answer from the incoming-call screen: every device of theirs
  // stops ringing; declining is shown to the caller. (Accepting also
  // happens by simply joining the room.)
  router.post('/api/o/:org/meetings/:id/ring', ...member, async (req, res) => {
    const meeting = await meetings.requireMeeting(req.org, req.params.id);
    if (!meeting.conversation_id) throw appError('not_found', 'Not a call');
    await chat.requireConversation(req.org, req.user, meeting.conversation_id);
    const answer = (await readJson(req)).answer === 'accept' ? 'accept' : 'decline';
    await calls.respond(meeting, req.user, answer);
    res.json({ ok: true });
  });

  async function managed(req) {
    const meeting = await meetings.requireMeeting(req.org, req.params.id);
    if (!(await meetings.canManage(meeting, req.user, req.membership.role))) throw appError('forbidden', 'Only the host can do that');
    return meeting;
  }

  router.get('/api/o/:org/meetings/:id', ...member, async (req, res) => {
    const meeting = await meetings.requireMeeting(req.org, req.params.id);
    const json = await meetingJson(meeting, req);
    const extra = json.can_manage ? { invitations: await meetings.invitations(meeting.id), participants: await meetings.participants(meeting.id) } : {};
    res.json({ meeting: json, ...extra });
  });

  router.post('/api/o/:org/meetings/:id/invitations', ...member, async (req, res) => {
    const meeting = await meetings.requireMeeting(req.org, req.params.id);
    const body = await readJson(req);
    if (body.email) {
      const inv = await meetings.inviteGuest(req.org, meeting, req.user, req.membership.role, { email: body.email, name: body.name }, req.ip);
      sendGuestInvites(req.t, req.org, meeting, req.user, [inv]);
      return res.json({ ok: true, invitation_id: inv.invitationId });
    }
    const added = await meetings.inviteMembers(req.org, meeting, req.user, req.membership.role, Array.isArray(body.user_ids) ? body.user_ids : [], req.ip);
    await sendMemberInvites(req.org, meeting, req.user, added);
    res.json({ ok: true, added });
  });

  // Revocation also closes the guest's join session and media path.
  router.post('/api/o/:org/meetings/:id/invitations/:iid/revoke', ...member, async (req, res) => {
    const meeting = await managed(req);
    const inv = await meetings.revokeInvitation(meeting, req.user, req.params.iid, req.ip);
    const affected = await db.all('SELECT id FROM meeting_participants WHERE meeting_id = ? AND (invitation_id = ? OR (user_id IS NOT NULL AND user_id = ?))', [meeting.id, inv.id, inv.user_id]);
    for (const p of affected) rooms.kickParticipant(meeting.id, p.id, 'removed');
    res.json({ ok: true });
  });

  for (const action of ['end', 'cancel']) {
    router.post(`/api/o/:org/meetings/:id/${action}`, ...member, async (req, res) => {
      const meeting = await managed(req);
      await meetings.close(meeting, req.user, action === 'end' ? 'ended' : 'canceled', req.ip);
      rooms.endRoom(meeting.id, 'ended');
      res.json({ ok: true });
    });
  }

  router.get('/o/:org/meet/:id', ...member, async (req, res) => {
    const meeting = await meetings.requireMeeting(req.org, req.params.id);
    const back = `/o/${req.org.slug}${meeting.conversation_id ? `/c/${meeting.conversation_id}` : '/meetings'}`;
    if (!meetings.isOpen(meeting)) return res.status(410).send(messagePage({ t: req.t, title: meeting.title, message: req.t('errors.meetingEnded'), back }));
    // ?call=audio|video: straight in from a call (no pre-join screen), camera per call kind.
    const call = ['audio', 'video'].includes(req.query.call) ? req.query.call : '';
    res.send(meetingRoomView({ t: req.t, meeting, org: req.org, mode: 'member', displayName: req.user.name, canInvite: req.membership.role !== 'external' && (await meetings.canManage(meeting, req.user, req.membership.role)), backHref: back, call, userId: req.user.id }));
  });

  // ---------------------------------------------------------- guest flow

  async function loadInvitation(req, res) {
    try {
      return await meetings.invitationByToken(req.params.token);
    } catch (err) {
      res.status(err.status || 400).send(messagePage({ t: req.t, title: req.t('guest.title'), message: req.t(`guest.invalid.${err.details?.reason || 'notFound'}`), back: '/' }));
      return null;
    }
  }

  function setGuestCookie(req, res, token, meeting) {
    const seconds = Math.max(60, Math.floor((Date.parse(meeting.expires_at) - Date.now()) / 1000));
    res.cookie(GUEST_COOKIE, token, { secure: req.secure, maxAgeSeconds: seconds, sameSite: 'Lax' });
  }

  router.get('/join/:token', async (req, res) => {
    const found = await loadInvitation(req, res);
    if (!found) return;
    if (found.inv.user_id) return res.redirect(`/o/${found.org.slug}/meet/${found.meeting.id}`);
    // Already verified in this browser for this meeting: straight in.
    const current = await meetings.guestFromToken(req.cookies[GUEST_COOKIE]);
    if (current && current.inv.id === found.inv.id) return res.redirect(`/meet/${found.meeting.id}`);
    const step = found.policy.guest_otp_required === false ? 'direct' : 'start';
    res.send(guestJoinView({ t: req.t, token: req.params.token, ...found, step }));
  });

  router.post('/join/:token/code', async (req, res) => {
    const found = await loadInvitation(req, res);
    if (!found) return;
    try {
      const code = await meetings.issueOtp(found.inv);
      mailer.queue({ to: found.inv.email, ...otpEmail({ t: req.t, title: found.meeting.title, code }) });
      res.send(guestJoinView({ t: req.t, token: req.params.token, ...found, step: 'code', notice: req.t('guest.codeSent', { email: found.inv.email }) }));
    } catch (err) {
      const message = err.details?.reason === 'wait' ? req.t('guest.wait', { seconds: err.details.seconds }) : translateError(req.t, err);
      res.status(err.status || 400).send(guestJoinView({ t: req.t, token: req.params.token, ...found, step: 'code', error: message }));
    }
  });

  router.post('/join/:token/verify', async (req, res) => {
    const found = await loadInvitation(req, res);
    if (!found) return;
    try {
      const token = await meetings.verifyOtp(found.inv, (await readForm(req)).get('code'), req.ip);
      setGuestCookie(req, res, token, found.meeting);
      res.redirect(`/meet/${found.meeting.id}`);
    } catch (err) {
      const key = err.details?.reason ? `guest.${err.details.reason}` : '';
      const error = key && req.t.has(key) ? req.t(key) : translateError(req.t, err);
      res.status(err.status || 400).send(guestJoinView({ t: req.t, token: req.params.token, ...found, step: 'code', error }));
    }
  });

  // Organizations that do not require the OTP: the link alone opens a guest
  // session (still bound to this invitation and subject to the lobby).
  router.post('/join/:token/continue', async (req, res) => {
    const found = await loadInvitation(req, res);
    if (!found) return;
    if (found.policy.guest_otp_required !== false) return res.redirect(`/join/${encodeURIComponent(req.params.token)}`);
    const token = await meetings.startGuestSession(found.inv, req.ip, 'link');
    setGuestCookie(req, res, token, found.meeting);
    res.redirect(`/meet/${found.meeting.id}`);
  });

  router.get('/meet/:id', async (req, res) => {
    const guest = await meetings.guestFromToken(req.cookies[GUEST_COOKIE]);
    if (!guest || guest.meeting.id !== req.params.id) {
      return res.status(403).send(messagePage({ t: req.t, title: req.t('guest.title'), message: req.t('guest.invalid.notVerified'), back: '/' }));
    }
    res.send(meetingRoomView({ t: req.t, meeting: guest.meeting, org: guest.org, mode: 'guest', displayName: guest.inv.name || '', backHref: `/meet/${guest.meeting.id}/left` }));
  });

  router.get('/meet/:id/left', (req, res) => res.send(messagePage({ t: req.t, title: req.t('guest.leftTitle'), message: req.t('guest.leftText'), back: `/meet/${req.params.id}` })));
}
