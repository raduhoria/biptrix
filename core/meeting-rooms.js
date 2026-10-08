const PROTOCOL = 1;
const RECHECK_MS = 30_000;

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
// on}, end, leave.
// Server → client: lobby, admitted, rejected, joined, peer.joined,
// peer.left, peer.media, peer.tracks, peer.role, signal, lobby.update,
// removed, ended, error.
const SLOTS = ['audio', 'camera', 'screen'];
export function createRooms({ auth, orgs, meetings, media }) {
  const rooms = new Map(); // meetingId → { meeting, peers: Map<pid, ws>, lobby: Map<pid, ws> }

  const send = (ws, type, data = {}, re = undefined) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ v: PROTOCOL, type, data, re }));
  };

  function room(meeting) {
    let r = rooms.get(meeting.id);
    if (!r) {
      r = { meeting, peers: new Map(), lobby: new Map(), topology: media.topology };
      rooms.set(meeting.id, r);
    }
    r.meeting = meeting;
    return r;
  }

  const peerInfo = (ws) => ({ id: ws.participant.id, name: ws.participant.display_name, role: ws.participant.role, guest: !ws.participant.user_id, media: ws.media, tracks: ws.sfu?.published || {} });
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
    const meeting = await meetings.byId(meetingId);
    if (!meeting) return null;
    const membership = await orgs.membership(meeting.org_id, found.user.id);
    if (!membership) return null;
    return { kind: 'member', meetingId, ip: req.ip, user: found.user, orgRole: membership.role };
  }

  // Re-validates the socket's right to be here (session, membership, meeting).
  async function currentMeeting(ws) {
    const meeting = await meetings.byId(ws.ctx.meetingId);
    if (!meeting || !meetings.isOpen(meeting)) return null;
    if (ws.ctx.kind === 'guest') {
      const guest = await meetings.guestFromToken(ws.ctx.guestToken);
      return guest && guest.meeting.id === meeting.id ? meeting : null;
    }
    const membership = await orgs.membership(meeting.org_id, ws.ctx.user.id);
    return membership ? meeting : null;
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
    ws.media = { audio: !!data.audio, video: !!data.video, screen: false };
    if (participant.state === 'lobby') {
      r.lobby.set(participant.id, ws);
      send(ws, 'lobby', { meeting: { id: meeting.id, title: meeting.title } });
      return lobbyUpdate(r);
    }
    r.lobby.delete(participant.id);
    const policy = JSON.parse(meeting.policy_snapshot || '{}');
    const capacity = r.topology === 'sfu' ? policy.max_participants || 25 : Math.min(media.meshMax, policy.max_participants || media.meshMax);
    // Re-joining from a second tab replaces the first.
    const previous = r.peers.get(participant.id);
    if (previous && previous !== ws) closeWith(previous, 'replaced');
    else if (r.peers.size >= capacity) return send(ws, 'error', { code: 'room_full', max: capacity });
    r.peers.set(participant.id, ws);
    ws.joinedAt = Date.now();
    if (r.peers.size === 1) await meetings.markLive(meeting);
    const canManage = !!ws.ctx.user && (await meetings.canManage(meeting, ws.ctx.user, ws.ctx.orgRole));
    send(ws, 'joined', {
      self: peerInfo(ws),
      peers: [...r.peers.values()].filter((p) => p !== ws).map(peerInfo),
      ice_servers: await media.iceServersFor(participant.id),
      topology: r.topology,
      ice_policy: media.icePolicy,
      can_manage: canManage,
      screen_share: participant.user_id ? true : !!policy.guest_screen_share,
      meeting: { id: meeting.id, title: meeting.title, host_id: meeting.host_id, expires_at: meeting.expires_at },
    });
    broadcast(r, 'peer.joined', peerInfo(ws), ws);
    if (canManage) lobbyUpdate(r);
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
        case 'leave':
          return ws.close(1000, 'left');
        default:
          return;
      }
    } catch (err) {
      if (!err.expose) console.error('Meeting WS failed:', err);
      send(ws, 'error', { code: err.code || 'internal', message: err.expose ? err.message : 'Internal error', reason: err.details?.reason }, id);
    }
  }

  function closeWith(ws, reason) {
    send(ws, reason, {});
    ws.close(4000, reason);
  }

  function onClose(ws) {
    const r = rooms.get(ws.ctx.meetingId);
    if (!r || !ws.participant) return;
    if (r.lobby.get(ws.participant.id) === ws) {
      r.lobby.delete(ws.participant.id);
      lobbyUpdate(r);
    }
    // Stop publishing on the SFU, so nobody keeps receiving a removed participant.
    const mids = Object.values(ws.sfu?.pending || {}).map((t) => t.mid);
    if (mids.length) media.sfu.close(ws.sfu.sessionId, mids).catch(() => {});
    if (r.peers.get(ws.participant.id) === ws) {
      r.peers.delete(ws.participant.id);
      broadcast(r, 'peer.left', { id: ws.participant.id });
      meetings.recordLeave(ws.participant.id, (Date.now() - ws.joinedAt) / 60_000, r.meeting.org_id).catch(() => {});
      if (!r.peers.size) meetings.markIdle(r.meeting.id).catch(() => {});
    }
    if (!r.peers.size && !r.lobby.size) rooms.delete(r.meeting.id);
  }

  function attach(ws, ctx) {
    ws.ctx = ctx;
    ws.alive = true;
    ws.on('pong', () => {
      ws.alive = true;
    });
    ws.on('message', (raw) => onMessage(ws, raw.toString()));
    ws.on('close', () => onClose(ws));
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
        if (!ws.alive) {
          ws.terminate();
          continue;
        }
        ws.alive = false;
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

  return {
    authorizeUpgrade,
    attach,
    kickParticipant,
    endRoom,
    disconnectUser,
    live: (meetingId) => (rooms.get(meetingId)?.peers.size || 0),
    stats: () => ({ rooms: rooms.size, peers: [...rooms.values()].reduce((n, r) => n + r.peers.size, 0) }),
    close: () => clearInterval(recheck),
  };
}
