const PROTOCOL = 1;
const RECHECK_MS = 10_000;
// A participant whose socket drops without leaving (network blip, server
// restart on the other side of a deploy) stays in the room this long, so the
// others keep their media to them and the client can resume in place.
const GRACE_MS = 20_000;

// createRooms: meeting signaling over /ws/meeting?id=<meetingId> (spec §8).
// Members authenticate with their session (and must belong to the meeting's
// organization); guests with the guest session cookie issued after OTP
// verification, bound to exactly this meeting. Every action is authorized
// against the database (core/meetings.js) — host decisions, removals and
// revocations take effect on the next frame, and a periodic recheck closes
// rooms whose meeting ended or expired on another node.
//
// Media, per room (core/media.js decides): 'mesh' — peer-to-peer, the
// server relays SDP/ICE between admitted participants only; or 'sfu' — each
// participant has one session on Cloudflare Realtime SFU and every push/pull
// goes through this server (the API token never reaches the browser), so a
// pull is only possible from someone admitted to the same room. ICE/TURN
// credentials are handed out after admission in both cases.
// Rooms are per Node instance: in a multi-node deployment the load balancer
// routes /ws/meeting by the `id` query parameter (see deploy/nginx.conf).
//
// Client → server: join {name?}, signal {to, data} (mesh), sfu.push {sdp,
// tracks: [{mid, slot}]}, sfu.publish {slots}, sfu.unpublish {slot},
// sfu.pull {tracks: [{participant_id, slot}]}, sfu.renegotiate {sdp},
// sfu.close {mids} (sfu; replies carry `re`), media {audio, video, screen}, admit
// {participant_id, accept}, remove {participant_id}, cohost {participant_id,
// on}, chat.send {client_id, body}, end, leave.
// Server → client: lobby, admitted, rejected, joined, peer.joined,
// peer.left, peer.media, peer.tracks, peer.role, signal, lobby.update,
// chat.message, chat.ok, call.declined, call.missed, removed, ended, error.
//
// In-call chat: a meeting started from a conversation chats in that
// conversation — only participants who are its members see it (history
// included) and their messages are ordinary conversation messages; anyone
// else in the room (guests, colleagues let in from the lobby) gets no chat.
// Other meetings have their own chat (meeting_messages), shared by everyone
// admitted.
const SLOTS = ['audio', 'camera', 'screen'];
const CHAT_RATE = [10, 10_000]; // messages per window, per connection
export function createRooms({ auth, orgs, meetings, media, chat, users, notifier }) {
  const rooms = new Map(); // meetingId → { meeting, peers: Map<pid, ws>, lobby: Map<pid, ws> }
  // Calls (core/calls.js) follow who joins and when a room empties.
  const hooks = { joined: async () => {}, empty: async () => {} };
  let closing = false; // shutdown: rooms empty because the server stops, not because people left

  // Revoked sessions leave their meetings at once.
  auth.onRevoke((hashes) => {
    const set = new Set(hashes);
    for (const r of rooms.values()) for (const ws of [...r.peers.values(), ...r.lobby.values()]) if (ws.ctx.sessionHash && set.has(ws.ctx.sessionHash)) closeWith(ws, 'removed');
  });

  const send = (ws, type, data = {}, re = undefined) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ v: PROTOCOL, type, data, re }));
  };

  // Topology per room. mode (fixed for the room): 'mesh', 'sfu', or 'auto'
  // — peer-to-peer while the call fits MESH_MAX_PARTICIPANTS, moved to the
  // SFU when one more person joins, back to peer-to-peer once it is small
  // again (after MEDIA_SFU_RETURN_MS, default 20 s, so a 6↔7 coming and going does not flap).
  // A move is announced with `topology`; clients build the new media path
  // before closing the old one, so nobody is disconnected. The org policy
  // media_sfu_allowed=false keeps a meeting peer-to-peer (and caps its size).
  function room(meeting) {
    let r = rooms.get(meeting.id);
    if (!r) {
      const sfuAllowed = JSON.parse(meeting.policy_snapshot || '{}').media_sfu_allowed !== false;
      const mode = sfuAllowed ? media.topology : 'mesh';
      r = { meeting, peers: new Map(), lobby: new Map(), mode, topology: mode === 'sfu' ? 'sfu' : 'mesh', backTimer: null };
      rooms.set(meeting.id, r);
    }
    r.meeting = meeting;
    return r;
  }

  function switchTopology(r, topology) {
    clearTimeout(r.backTimer);
    r.backTimer = null;
    if (r.topology === topology) return;
    console.log(`Meeting ${r.meeting.id}: ${r.topology} → ${topology} (${r.peers.size} in the room)`);
    r.topology = topology;
    broadcast(r, 'topology', { topology });
  }

  // After someone left an auto room on the SFU: back to peer-to-peer if it
  // stays small.
  function maybeReturnToMesh(r) {
    if (r.mode !== 'auto' || r.topology !== 'sfu' || !r.peers.size || r.peers.size > media.meshMax || r.backTimer) return;
    r.backTimer = setTimeout(() => {
      r.backTimer = null;
      if (rooms.get(r.meeting.id) === r && r.topology === 'sfu' && r.peers.size && r.peers.size <= media.meshMax) switchTopology(r, 'mesh');
    }, media.sfuReturnMs);
    r.backTimer.unref?.();
  }

  // `page`: one id per loaded meeting page, so a peer can tell a resumed
  // connection (keep the media path) from a reloaded page (rebuild it).
  const peerInfo = (ws) => ({ id: ws.participant.id, page: ws.page || '', name: ws.participant.display_name, role: ws.participant.role, guest: !ws.participant.user_id, user_id: ws.participant.user_id || null, media: ws.media, tracks: ws.sfu?.published || {} });
  // One Cloudflare session per participant connection, created on first use.
  async function sfuOf(ws) {
    ws.sfu ||= { sessionId: await media.sfu.newSession(), pending: {}, published: {}, screens: 0 };
    return ws.sfu;
  }
  const guestScreenAllowed = (r) => !!JSON.parse(r.meeting.policy_snapshot || '{}').guest_screen_share;

  function broadcast(r, type, data, except = null) {
    for (const ws of r.peers.values()) if (ws !== except) send(ws, type, data);
  }

  // Managers (host, co-hosts, org owners/admins) see the lobby.
  async function managers(r) {
    const out = [];
    for (const ws of r.peers.values()) if (ws.ctx.user && (await meetings.canManage(r.meeting, ws.ctx.user, ws.ctx.orgRole))) out.push(ws);
    return out;
  }

  async function lobbyUpdate(r) {
    const waiting = [...r.lobby.values()].map((ws) => ({ id: ws.participant.id, name: ws.participant.display_name, guest: !ws.participant.user_id, email: ws.ctx.inv?.email || ws.ctx.user?.email || '' }));
    for (const ws of await managers(r)) send(ws, 'lobby.update', { waiting });
  }

  async function authorizeUpgrade(req, url) {
    const meetingId = url.searchParams.get('id') || '';
    const guest = await meetings.guestFromToken(req.cookies.gsid);
    if (guest && guest.meeting.id === meetingId) return { kind: 'guest', meetingId, ip: req.ip, inv: guest.inv, guestToken: req.cookies.gsid };
    const found = await auth.sessionFromToken(auth.readToken(req));
    if (!found) return null;
    const ctx = { kind: 'member', meetingId, ip: req.ip, sessionHash: found.session.id_hash, user: found.user, orgRole: null };
    return (await refresh(ctx)) ? ctx : null;
  }

  // Current rights of a member connection: the session is still valid, the
  // user still belongs to the meeting's organization (with their current
  // role, not the one they had when the socket opened), and the organization
  // is active. Updates ctx; false if any of it no longer holds.
  async function refresh(ctx) {
    const user = await auth.userForSessionHash(ctx.sessionHash);
    const meeting = user && (await meetings.byId(ctx.meetingId));
    const membership = meeting && (await orgs.membership(meeting.org_id, user.id));
    const org = membership && (await orgs.byId(meeting.org_id));
    if (!org || org.status !== 'active') return false;
    ctx.user = user;
    ctx.orgRole = membership.role;
    return true;
  }

  // Re-validates the socket's right to be here (session, membership, role,
  // organization, meeting state). Guests: their guest session (which also
  // checks the invitation and the organization).
  async function currentMeeting(ws) {
    const meeting = await meetings.byId(ws.ctx.meetingId);
    if (!meeting || !meetings.isOpen(meeting)) return null;
    if (ws.ctx.kind === 'guest') {
      const guest = await meetings.guestFromToken(ws.ctx.guestToken);
      return guest && guest.meeting.id === meeting.id ? meeting : null;
    }
    return (await refresh(ws.ctx)) ? meeting : null;
  }

  async function join(ws, data) {
    const meeting = await currentMeeting(ws);
    if (!meeting) return closeWith(ws, 'ended');
    const r = room(meeting);
    const participant =
      ws.ctx.kind === 'guest'
        ? await meetings.joinAsGuest(await meetings.guestFromToken(ws.ctx.guestToken), data.name)
        : await meetings.joinAsMember(meeting, ws.ctx.user);
    ws.participant = participant;
    // The media as the page says it is now: after a reconnect a screen that
    // is still being shared stays shown (if this person may share).
    const policy = JSON.parse(meeting.policy_snapshot || '{}');
    ws.media = { audio: !!data.audio, video: !!data.video, screen: !!data.screen && (!!participant.user_id || !!policy.guest_screen_share) };
    ws.page = typeof data.page === 'string' ? data.page.slice(0, 40) : '';
    if (participant.state === 'lobby') {
      r.lobby.set(participant.id, ws);
      send(ws, 'lobby', { meeting: { id: meeting.id, title: meeting.title } });
      return lobbyUpdate(r);
    }
    r.lobby.delete(participant.id);
    // Everything that waits on the database or the network first: from the
    // moment this connection is in r.peers until `joined` and `peer.joined`
    // are sent nothing may wait, or someone joining at the same moment
    // could hear of this participant before this participant hears it is
    // in — and two clients would disagree on who connects to whom.
    const canManage = !!ws.ctx.user && (await meetings.canManage(meeting, ws.ctx.user, ws.ctx.orgRole));
    const chatState = await chatFor(ws, meeting);
    const iceServers = await media.iceServersFor(participant.id);
    if (ws.readyState !== ws.OPEN) return;
    const capacity = r.mode === 'mesh' ? Math.min(media.meshMax, policy.max_participants || media.meshMax) : policy.max_participants || 25;
    // The same participant again: a dropped connection coming back within the
    // grace period takes its place (and its SFU session) without anyone
    // noticing; a second open tab replaces the first.
    const previous = r.peers.get(participant.id);
    let resumed = false;
    if (previous && previous !== ws && previous.ghost) {
      clearTimeout(previous.ghostTimer);
      previous.ghost = false;
      resumed = true;
      ws.joinedAt = previous.joinedAt;
      if (data.resume && previous.sfu) ws.sfu = previous.sfu;
      else if (previous.sfu) {
        // A reloaded page builds a new SFU session; the old one stops publishing.
        const mids = Object.values(previous.sfu.pending || {}).map((t) => t.mid);
        if (mids.length) media.sfu.close(previous.sfu.sessionId, mids).catch(() => {});
      }
    } else if (previous && previous !== ws) closeWith(previous, 'replaced');
    else if (r.peers.size >= capacity) return send(ws, 'error', { code: 'room_full', max: capacity });
    // One more than peer-to-peer can carry: the room moves to the SFU first.
    if (r.mode === 'auto' && !previous && r.peers.size + 1 > media.meshMax) switchTopology(r, 'sfu');
    else if (r.backTimer && r.peers.size + 1 > media.meshMax) {
      clearTimeout(r.backTimer);
      r.backTimer = null;
    }
    r.peers.set(participant.id, ws);
    ws.joinedAt ||= Date.now();
    send(ws, 'joined', {
      self: peerInfo(ws),
      // Participants in their grace period are left out: they announce
      // themselves when (if) they come back.
      peers: [...r.peers.values()].filter((p) => p !== ws && !p.ghost).map(peerInfo),
      resumed,
      sfu_resumed: !!ws.sfu,
      ice_servers: iceServers,
      topology: r.topology,
      ice_policy: media.icePolicy,
      can_manage: canManage,
      screen_share: participant.user_id ? true : !!policy.guest_screen_share,
      meeting: { id: meeting.id, title: meeting.title, host_id: meeting.host_id, expires_at: meeting.expires_at },
      chat: chatState,
      // (outcome: a decline or a missed deadline that happened before this
      // connection was in the room — the caller's tab may still be opening.)
      call: meeting.call_kind ? { kind: meeting.call_kind, ringing: meeting.ring_state === 'ringing' && meeting.ring_until > new Date().toISOString(), outcome: meeting.ring_state } : null,
    });
    // `resume`: the client kept its media connections; peers that still hold
    // one to this page keep it too.
    broadcast(r, 'peer.joined', { ...peerInfo(ws), resume: !!data.resume }, ws);
    if (r.peers.size === 1) await meetings.markLive(meeting);
    if (canManage) lobbyUpdate(r);
    if (!resumed) hooks.joined(meeting, ws).catch((err) => console.error('Call hook failed:', err.message));
  }

  // ------------------------------------------------------------- room chat

  // The chat this connection may use: 'conversation' (a member of the
  // meeting's conversation), 'meeting' (a meeting without one), or 'none'.
  async function chatFor(ws, meeting) {
    ws.chatMode = 'none';
    if (!meeting.conversation_id) {
      ws.chatMode = 'meeting';
      return { mode: 'meeting', messages: await meetings.chatMessages(meeting.id) };
    }
    if (!ws.ctx.user) return { mode: 'none', messages: [] };
    const org = await orgs.byId(meeting.org_id);
    try {
      const { messages } = await chat.history(org, ws.ctx.user, meeting.conversation_id, { limit: 50 });
      ws.chatMode = 'conversation';
      return { mode: 'conversation', messages: (await Promise.all(messages.map(fromConversation))).filter(Boolean) };
    } catch {
      return { mode: 'none', messages: [] };
    }
  }

  // Display names of conversation authors (the room has no directory).
  const names = new Map();
  async function nameOf(userId) {
    if (!userId) return '';
    if (!names.has(userId)) {
      if (names.size > 5000) names.clear();
      names.set(userId, (await users.byId(userId))?.name || '');
    }
    return names.get(userId);
  }

  // A conversation message as the room shows it (top-level text only).
  async function fromConversation(m) {
    if (m.parent_id || m.kind !== 'text') return null;
    return {
      id: m.id,
      author_id: m.author_id,
      name: await nameOf(m.author_id),
      body: m.body.replace(/<@([A-Za-z0-9_-]+)>/g, '@…'),
      client_id: m.client_message_id,
      created_at: m.created_at,
      deleted: !!m.deleted_at,
      attachments: (m.attachments || []).map((a) => ({ id: a.id, name: a.name })),
    };
  }

  function chatAllowed(ws) {
    const now = Date.now();
    ws.chatTimes = (ws.chatTimes || []).filter((t) => t > now - CHAT_RATE[1]);
    if (ws.chatTimes.length >= CHAT_RATE[0]) return false;
    ws.chatTimes.push(now);
    return true;
  }

  async function chatSend(ws, r, data, id) {
    if (!chatAllowed(ws)) throw Object.assign(new Error('Slow down'), { code: 'rate_limited', expose: true });
    const meeting = r.meeting;
    if (ws.chatMode === 'meeting') {
      const message = await meetings.addChatMessage(meeting, ws.participant, data.client_id, data.body);
      for (const peer of r.peers.values()) if (peer.chatMode === 'meeting') send(peer, 'chat.message', message);
      return send(ws, 'chat.ok', { client_id: message.client_id }, id);
    }
    if (ws.chatMode !== 'conversation') throw Object.assign(new Error('No chat here'), { code: 'forbidden', expose: true });
    // An ordinary conversation message: the event log brings it back to
    // the room (onEvent) and to the conversation everywhere else.
    const org = await orgs.byId(meeting.org_id);
    const result = await chat.send(org, ws.ctx.user, { conversationId: meeting.conversation_id, clientMessageId: data.client_id, body: data.body });
    if (!result.duplicate && notifier) {
      chat.one(org, meeting.conversation_id, ws.ctx.user).then((conv) => conv && notifier.afterSend(org, ws.ctx.user, conv, result.message, result.mentioned)).catch(() => {});
    }
    send(ws, 'chat.ok', { client_id: result.message.client_message_id }, id);
  }

  // Durable chat events (core/events.js): new and changed messages of a
  // conversation reach the rooms of its meetings, for the participants who
  // are still its members.
  async function onEvent(event) {
    if ((event.type !== 'message.created' && event.type !== 'message.updated') || !event.conversation_id) return;
    const targets = [...rooms.values()].filter((r) => r.meeting.conversation_id === event.conversation_id);
    if (!targets.length) return;
    const message = await fromConversation(event.data);
    if (!message) return;
    const members = new Set(await chat.memberIds(event.conversation_id));
    for (const r of targets) {
      for (const ws of r.peers.values()) if (ws.chatMode === 'conversation' && members.has(ws.ctx.user?.id)) send(ws, 'chat.message', message);
    }
  }

  async function requireManager(ws) {
    const meeting = await currentMeeting(ws);
    if (!meeting || !ws.ctx.user || !(await meetings.canManage(meeting, ws.ctx.user, ws.ctx.orgRole))) {
      throw Object.assign(new Error('Only the host can do that'), { code: 'forbidden', expose: true });
    }
    return meeting;
  }

  const actor = (ws) => ({ id: ws.ctx.user.id, email: ws.ctx.user.email });

  async function onMessage(ws, raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const { type, id, data = {} } = msg || {};
    const r = rooms.get(ws.ctx.meetingId);
    const inRoom = !!(r && ws.participant && r.peers.get(ws.participant.id) === ws);
    // ICE/SDP relays are too frequent to re-check one by one; they are only
    // possible inside the room, which revocations and the periodic recheck
    // leave immediately.
    if (type !== 'signal' && type !== 'join' && !(await currentMeeting(ws).catch(() => null))) return closeWith(ws, 'removed');
    try {
      switch (type) {
        case 'join':
          return await join(ws, data);
        case 'signal': {
          // Relay only between admitted participants of this room.
          if (!inRoom) return;
          const target = r.peers.get(String(data.to || ''));
          if (target) send(target, 'signal', { from: ws.participant.id, data: data.data });
          return;
        }
        case 'sfu.push': {
          // Publish local tracks; names are assigned here (`<participant>-<slot>`,
          // screen shares numbered) so a client cannot impersonate another.
          if (!inRoom || r.topology !== 'sfu') return;
          const sfu = await sfuOf(ws);
          const tracks = (Array.isArray(data.tracks) ? data.tracks : [])
            .filter((t) => SLOTS.includes(t.slot) && typeof t.mid === 'string')
            .map((t) => ({ mid: t.mid, slot: t.slot, trackName: `${ws.participant.id}-${t.slot}${t.slot === 'screen' ? `-${++sfu.screens}` : ''}` }));
          const res = await media.sfu.push(sfu.sessionId, data.sdp, tracks);
          for (const t of tracks) sfu.pending[t.slot] = { trackName: t.trackName, mid: t.mid };
          return send(ws, 'sfu.answer', { sdp: res.sessionDescription }, id);
        }
        case 'sfu.publish': {
          // Announced once packets flow: Cloudflare refuses to pull a track
          // that has not sent data yet.
          if (!inRoom || !ws.sfu) return;
          for (const slot of Array.isArray(data.slots) ? data.slots : []) if (ws.sfu.pending[slot]) ws.sfu.published[slot] = ws.sfu.pending[slot].trackName;
          return broadcast(r, 'peer.tracks', { id: ws.participant.id, tracks: ws.sfu.published }, ws);
        }
        case 'sfu.unpublish': {
          if (!inRoom || !ws.sfu || !SLOTS.includes(data.slot)) return;
          const t = ws.sfu.pending[data.slot];
          delete ws.sfu.published[data.slot];
          delete ws.sfu.pending[data.slot];
          if (t) await media.sfu.close(ws.sfu.sessionId, [t.mid]).catch(() => {});
          send(ws, 'sfu.ok', {}, id);
          return broadcast(r, 'peer.tracks', { id: ws.participant.id, tracks: ws.sfu.published }, ws);
        }
        case 'sfu.pull': {
          // Only published tracks of admitted participants of this room; a
          // guest's screen only if the policy lets guests share.
          if (!inRoom || r.topology !== 'sfu') return;
          const sfu = await sfuOf(ws);
          const wanted = [];
          for (const want of Array.isArray(data.tracks) ? data.tracks : []) {
            const peer = r.peers.get(String(want.participant_id));
            const trackName = peer?.sfu?.published[want.slot];
            if (!trackName || peer === ws) continue;
            if (want.slot === 'screen' && !peer.participant.user_id && !guestScreenAllowed(r)) continue;
            wanted.push({ sessionId: peer.sfu.sessionId, trackName, participant_id: peer.participant.id, slot: want.slot });
          }
          if (!wanted.length) return send(ws, 'sfu.offer', { tracks: [], failed: [] }, id);
          const res = await media.sfu.pull(sfu.sessionId, wanted);
          const byName = new Map(wanted.map((w) => [w.trackName, w]));
          const result = (res.tracks || []).map((t) => ({ ...byName.get(t.trackName), mid: t.mid, error: t.errorCode || null }));
          return send(ws, 'sfu.offer', {
            sdp: res.sessionDescription,
            renegotiate: !!res.requiresImmediateRenegotiation,
            tracks: result.filter((t) => !t.error).map(({ participant_id, slot, trackName, mid }) => ({ participant_id, slot, trackName, mid })),
            failed: result.filter((t) => t.error).map(({ participant_id, slot, trackName }) => ({ participant_id, slot, trackName })),
          }, id);
        }
        case 'sfu.renegotiate':
          if (!inRoom || !ws.sfu) return;
          await media.sfu.renegotiate(ws.sfu.sessionId, data.sdp);
          return send(ws, 'sfu.ok', {}, id);
        case 'sfu.close':
          if (!inRoom || !ws.sfu) return;
          await media.sfu.close(ws.sfu.sessionId, (Array.isArray(data.mids) ? data.mids : []).map(String)).catch(() => {});
          return send(ws, 'sfu.ok', {}, id);
        case 'sfu.leave': {
          // Back on peer-to-peer: this participant's SFU session is done.
          if (!inRoom || !ws.sfu) return send(ws, 'sfu.ok', {}, id);
          const mids = Object.values(ws.sfu.pending).map((t) => t.mid);
          if (mids.length) await media.sfu.close(ws.sfu.sessionId, mids).catch(() => {});
          ws.sfu = null;
          send(ws, 'sfu.ok', {}, id);
          return broadcast(r, 'peer.tracks', { id: ws.participant.id, tracks: {} }, ws);
        }
        case 'media': {
          if (!inRoom) return;
          const screen = !!data.screen && (!!ws.participant.user_id || !!JSON.parse(r.meeting.policy_snapshot || '{}').guest_screen_share);
          ws.media = { audio: !!data.audio, video: !!data.video, screen };
          if (data.screen && !screen) send(ws, 'error', { code: 'policy_denied', reason: 'screenShare' });
          return broadcast(r, 'peer.media', { id: ws.participant.id, media: ws.media }, ws);
        }
        case 'admit': {
          const meeting = await requireManager(ws);
          const p = await meetings.admit(meeting, actor(ws), String(data.participant_id || ''), !!data.accept, ws.ctx.ip);
          const waiting = r?.lobby.get(p.id);
          if (waiting) {
            r.lobby.delete(p.id);
            if (p.state === 'admitted') send(waiting, 'admitted', {});
            else closeWith(waiting, 'rejected');
          }
          return lobbyUpdate(room(meeting));
        }
        case 'remove': {
          const meeting = await requireManager(ws);
          const p = await meetings.removeParticipant(meeting, actor(ws), String(data.participant_id || ''), ws.ctx.ip);
          kickParticipant(meeting.id, p.id, 'removed');
          return;
        }
        case 'cohost': {
          const meeting = await requireManager(ws);
          await meetings.setCohost(meeting, actor(ws), String(data.participant_id || ''), !!data.on, ws.ctx.ip);
          const target = r?.peers.get(String(data.participant_id));
          if (target) {
            target.participant.role = data.on ? 'cohost' : 'participant';
            broadcast(r, 'peer.role', { id: target.participant.id, role: target.participant.role });
            send(target, 'role', { can_manage: !!data.on });
            if (data.on) lobbyUpdate(r);
          }
          return;
        }
        case 'end': {
          const meeting = await requireManager(ws);
          await meetings.close(meeting, actor(ws), 'ended', ws.ctx.ip);
          return endRoom(meeting.id, 'ended');
        }
        case 'chat.send':
          if (!inRoom) return;
          return await chatSend(ws, r, data, id);
        case 'leave':
          ws.final = true;
          return ws.close(1000, 'left');
        default:
          return;
      }
    } catch (err) {
      if (!err.expose) console.error('Meeting WS failed:', err);
      send(ws, 'error', { code: err.code || 'internal', message: err.expose ? err.message : 'Internal error', reason: err.details?.reason }, id);
    }
  }

  // A deliberate close (kick, end, replaced, revoked): no grace period; a
  // participant already in theirs leaves now.
  function closeWith(ws, reason) {
    ws.final = true;
    send(ws, reason, {});
    ws.close(4000, reason);
    if (ws.ghost) {
      clearTimeout(ws.ghostTimer);
      leaveRoom(ws);
    }
  }

  function onClose(ws) {
    const r = rooms.get(ws.ctx.meetingId);
    if (!r || !ws.participant) return;
    if (r.lobby.get(ws.participant.id) === ws) {
      r.lobby.delete(ws.participant.id);
      lobbyUpdate(r);
    }
    // Dropped without leaving: the connection died without a close frame
    // (1006: network gone, or terminated after missed pongs). A clean close
    // (tab closed, leave) is a departure. Keep the place for GRACE_MS.
    if (r.peers.get(ws.participant.id) === ws && !ws.final && !closing && ws.closeCode === 1006) {
      ws.ghost = true;
      ws.ghostTimer = setTimeout(() => {
        ws.ghost = false;
        leaveRoom(ws);
      }, GRACE_MS);
      ws.ghostTimer.unref?.();
      return;
    }
    leaveRoom(ws);
  }

  function leaveRoom(ws) {
    const r = rooms.get(ws.ctx.meetingId);
    if (!r || !ws.participant) return;
    // Stop publishing on the SFU, so nobody keeps receiving a removed participant.
    const mids = Object.values(ws.sfu?.pending || {}).map((t) => t.mid);
    if (mids.length) media.sfu.close(ws.sfu.sessionId, mids).catch(() => {});
    if (r.peers.get(ws.participant.id) === ws) {
      r.peers.delete(ws.participant.id);
      broadcast(r, 'peer.left', { id: ws.participant.id });
      meetings.recordLeave(ws.participant.id, (Date.now() - ws.joinedAt) / 60_000, r.meeting.org_id).catch(() => {});
      maybeReturnToMesh(r);
      if (!r.peers.size) {
        clearTimeout(r.backTimer);
        meetings.markIdle(r.meeting.id).catch(() => {});
        if (!closing) hooks.empty(r.meeting).catch((err) => console.error('Call hook failed:', err.message));
      }
    }
    if (!r.peers.size && !r.lobby.size) rooms.delete(r.meeting.id);
  }

  function attach(ws, ctx) {
    ws.ctx = ctx;
    ws.missedPongs = 0;
    ws.on('pong', () => {
      ws.missedPongs = 0;
    });
    ws.on('message', (raw) => onMessage(ws, raw.toString()));
    ws.on('close', (code) => {
      ws.closeCode = code;
      onClose(ws);
    });
    ws.on('error', () => {});
    send(ws, 'hello', { protocol: PROTOCOL, kind: ctx.kind });
  }

  function kickParticipant(meetingId, participantId, reason = 'removed') {
    const r = rooms.get(meetingId);
    if (!r) return;
    for (const map of [r.peers, r.lobby]) {
      const ws = map.get(participantId);
      if (ws) closeWith(ws, reason);
    }
  }

  function endRoom(meetingId, reason = 'ended') {
    const r = rooms.get(meetingId);
    if (!r) return;
    for (const ws of [...r.peers.values(), ...r.lobby.values()]) closeWith(ws, reason);
  }

  function disconnectUser(userId, orgId = null) {
    for (const r of rooms.values()) {
      if (orgId && r.meeting.org_id !== orgId) continue;
      for (const ws of [...r.peers.values(), ...r.lobby.values()]) if (ws.ctx.user?.id === userId) closeWith(ws, 'removed');
    }
  }

  // Revocations made on another node, expiry, ended meetings.
  const recheck = setInterval(async () => {
    for (const r of rooms.values()) {
      for (const ws of [...r.peers.values(), ...r.lobby.values()]) {
        if (ws.ghost) continue;
        // Dead only after two pings in a row went unanswered (~20 s): a
        // single slow pong (mobile network, busy tab) must not end a call.
        if (ws.missedPongs >= 2) {
          ws.terminate();
          continue;
        }
        ws.missedPongs += 1;
        ws.ping();
        const meeting = await currentMeeting(ws).catch(() => r.meeting);
        if (!meeting) closeWith(ws, 'ended');
        else if (ws.participant) {
          const p = await meetings.participant(meeting.id, ws.participant.id).catch(() => null);
          if (p && (p.state === 'removed' || p.state === 'rejected')) closeWith(ws, 'removed');
        }
      }
    }
  }, RECHECK_MS);
  recheck.unref();

  // A notice to everyone in a meeting's room on this node (calls).
  function notifyRoom(meetingId, type, data = {}) {
    const r = rooms.get(meetingId);
    if (r) broadcast(r, type, data);
  }

  return {
    authorizeUpgrade,
    attach,
    onEvent,
    notifyRoom,
    setHooks: (h) => Object.assign(hooks, h),
    kickParticipant,
    endRoom,
    disconnectUser,
    live: (meetingId) => (rooms.get(meetingId)?.peers.size || 0),
    stats: () => ({ rooms: rooms.size, peers: [...rooms.values()].reduce((n, r) => n + r.peers.size, 0) }),
    close: () => {
      closing = true;
      clearInterval(recheck);
    },
  };
}
