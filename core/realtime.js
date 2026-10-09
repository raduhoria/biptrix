import { WebSocketServer } from 'ws';
import { parseCookies } from './router.js';
import { createRateLimiter } from './rate-limit.js';
import { clientIp, isSecure, originMatches } from './http.js';

const PROTOCOL = 1;
const HEARTBEAT_MS = 25_000;
const CLOSE_REVOKED = 4001;
const MAX_FRAME = 64 * 1024;
const PRESENCE = new Set(['online', 'away', 'dnd']);

// Origin check on upgrade (spec §14): only pages served by this app may open
// a socket with the user's cookies.
export function originAllowed(req, appUrl, trustProxy = false) {
  return !!req.headers.origin && originMatches(req.headers.origin, req, appUrl, isSecure(req, trustProxy));
}

// createRealtime: the chat WebSocket (/ws?org=<slug>). One socket per tab,
// scoped to one organization. Protocol (JSON, versioned):
//   → { v, type, id?, data }            ← { v, type, re?, event_id?, data }
// Client → server: system.sync, message.send, conversation.read, typing,
// presence.set, ping. Server → client: the durable events from the log
// (message.created, message.updated, conversation.*), message.ack, typing,
// presence, system.sync, error. Durable events carry event_id; clients keep
// the highest one and resume from it after a reconnect.
// Presence and typing are ephemeral and per node (spec §12).
export function createRealtime({ config, auth, orgs, chat, events, rooms, notifier }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME });
  const byUser = new Map(); // `${orgId}:${userId}` → Set<socket>
  const byOrg = new Map(); // orgId → Set<socket>
  const presence = new Map(); // `${orgId}:${userId}` → status
  const limiter = createRateLimiter();

  // A collaborator's access can expire while the socket is open: from that
  // moment nothing more is delivered and the socket closes, without waiting
  // for the periodic re-check or the maintenance sweep.
  const expired = (ws) => {
    const until = ws.ctx?.membership?.access_expires_at;
    return !!until && until <= new Date().toISOString();
  };
  const send = (ws, type, data, extra = {}) => {
    if (ws.readyState !== ws.OPEN) return;
    if (expired(ws)) return ws.close(CLOSE_REVOKED, 'revoked');
    ws.send(JSON.stringify({ v: PROTOCOL, type, ...extra, data }));
  };

  function addSocket(ws) {
    const key = `${ws.ctx.org.id}:${ws.ctx.user.id}`;
    if (!byUser.has(key)) byUser.set(key, new Set());
    byUser.get(key).add(ws);
    if (!byOrg.has(ws.ctx.org.id)) byOrg.set(ws.ctx.org.id, new Set());
    byOrg.get(ws.ctx.org.id).add(ws);
    if (byUser.get(key).size === 1) setPresence(ws.ctx.org.id, ws.ctx.user.id, presence.get(key) || 'online', true);
  }

  function dropSocket(ws) {
    const key = `${ws.ctx.org.id}:${ws.ctx.user.id}`;
    byUser.get(key)?.delete(ws);
    byOrg.get(ws.ctx.org.id)?.delete(ws);
    if (!byUser.get(key)?.size) {
      byUser.delete(key);
      presence.delete(key);
      broadcastOrg(ws.ctx.org.id, 'presence', { user_id: ws.ctx.user.id, status: 'offline' });
    }
  }

  function setPresence(orgId, userId, status, force = false) {
    const key = `${orgId}:${userId}`;
    if (!force && presence.get(key) === status) return;
    presence.set(key, status);
    broadcastOrg(orgId, 'presence', { user_id: userId, status });
  }

  function broadcastOrg(orgId, type, data, except = null) {
    for (const ws of byOrg.get(orgId) || []) if (ws !== except) send(ws, type, data);
  }

  function sendToUsers(orgId, userIds, type, data, extra, except = null) {
    for (const uid of userIds) for (const ws of byUser.get(`${orgId}:${uid}`) || []) if (ws !== except) send(ws, type, data, extra);
  }

  // Durable event from the log (core/events.js pump) → the sockets on this
  // node allowed to see it. Membership is read at delivery time, so a
  // removed member stops receiving immediately.
  async function deliver(event) {
    if (!byOrg.get(event.org_id)?.size) return;
    const extra = { event_id: event.id, ts: event.created_at };
    if (event.user_id) return sendToUsers(event.org_id, [event.user_id], event.type, event.data, extra);
    if (!event.conversation_id) return broadcastOrg(event.org_id, event.type, event.data);
    const members = await chat.memberIds(event.conversation_id);
    sendToUsers(event.org_id, members, event.type, event.data, extra);
  }

  // Every frame runs with fresh rights: the session still exists (logout,
  // "sign out other sessions", expiry), the user is active, the membership
  // and its current role, the organization is not suspended. A failure
  // closes the socket.
  async function revalidate(ws) {
    const user = await auth.userForSessionHash(ws.ctx.sessionHash);
    const membership = user && (await orgs.membership(ws.ctx.org.id, user.id));
    const org = membership && (await orgs.byId(ws.ctx.org.id));
    if (!org || org.status !== 'active') {
      ws.close(CLOSE_REVOKED, 'revoked');
      return false;
    }
    ws.ctx.user = user;
    ws.ctx.membership = membership;
    ws.ctx.org = org;
    return true;
  }

  async function onMessage(ws, raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return send(ws, 'error', { code: 'invalid', message: 'Bad frame' });
    }
    const { type, id, data = {} } = msg || {};
    const reply = (t, d) => send(ws, t, d, id ? { re: id } : {});
    if (type === 'ping') return reply('pong', {});
    try {
      if (!(await revalidate(ws))) return;
    } catch (err) {
      return reply('error', { code: 'db_unavailable', message: err.message });
    }
    const { org, user } = ws.ctx;
    try {
      switch (type) {
        case 'system.sync': {
          const result = await events.since(org.id, user.id, Number(data.since) || 0);
          return reply('system.sync', result);
        }
        case 'message.send': {
          if (!limiter.take(`send:${user.id}`, 30, 10_000)) throw Object.assign(new Error('Slow down'), { code: 'rate_limited' });
          const { message, duplicate, mentioned } = await chat.send(org, user, {
            conversationId: data.conversation_id,
            clientMessageId: data.client_message_id,
            body: data.body,
            parentId: data.parent_id || null,
            attachmentIds: data.attachment_ids || [],
          });
          reply('message.ack', { status: 'persisted', client_message_id: data.client_message_id, conversation_id: data.conversation_id, duplicate, message });
          if (!duplicate) notifier.afterSend(org, user, await chat.one(org, data.conversation_id, user), message, mentioned).catch(() => {});
          return;
        }
        case 'conversation.read':
          return chat.markRead(org, user, data.conversation_id, data.seq);
        case 'typing': {
          if (!limiter.take(`typing:${user.id}`, 20, 10_000)) return;
          const members = await chat.memberIds(data.conversation_id);
          if (!members.includes(user.id)) return;
          return sendToUsers(org.id, members, 'typing', { conversation_id: data.conversation_id, user_id: user.id, parent_id: data.parent_id || null }, {}, ws);
        }
        case 'client.visible':
          // The app is on screen (visible and focused) in this tab: no push
          // notification is needed for this organization meanwhile.
          ws.visible = !!data.visible;
          return;
        case 'presence.set':
          if (PRESENCE.has(data.status)) setPresence(org.id, user.id, data.status);
          return;
        default:
          return reply('error', { code: 'invalid', message: `Unknown type ${type}` });
      }
    } catch (err) {
      const error = { code: err.code || 'internal', message: err.expose ? err.message : 'Internal error', details: err.details };
      if (!err.expose) console.error('WS handler failed:', err);
      if (type === 'message.send') return reply('message.ack', { status: 'failed', client_message_id: data.client_message_id, conversation_id: data.conversation_id, error });
      reply('error', error);
    }
  }

  function attach(ws, ctx) {
    ws.ctx = ctx;
    ws.alive = true;
    ws.on('pong', () => {
      ws.alive = true;
    });
    ws.on('message', (raw) => onMessage(ws, raw.toString()));
    ws.on('close', () => dropSocket(ws));
    ws.on('error', () => {});
    addSocket(ws);
    send(ws, 'hello', { protocol: PROTOCOL, node: config.nodeId, cursor: events.cursor() });
  }

  // Chat sockets only: meeting sockets share this WebSocket server but have
  // their own liveness check (core/meeting-rooms.js). Two loops flipping the
  // same flag killed healthy meeting sockets whenever one ran between the
  // other's ping and its pong.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.ctx?.org) continue;
      if (!ws.alive) {
        ws.terminate();
        continue;
      }
      ws.alive = false;
      ws.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  function reject(socket, status) {
    socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  }

  // HTTP upgrade: /ws (chat) or /ws/meeting (meeting room). Origin and the
  // session are checked before the WebSocket handshake completes.
  async function handleUpgrade(req, socket, head) {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (!originAllowed(req, config.appUrl, config.trustProxy)) return reject(socket, '403 Forbidden');
      req.cookies = parseCookies(req.headers.cookie);
      req.ip = clientIp(req, config.trustProxy);
      if (url.pathname === '/ws/meeting') {
        const ctx = await rooms.authorizeUpgrade(req, url);
        if (!ctx) return reject(socket, '401 Unauthorized');
        return wss.handleUpgrade(req, socket, head, (ws) => rooms.attach(ws, ctx));
      }
      if (url.pathname !== '/ws') return reject(socket, '404 Not Found');
      const found = await auth.sessionFromToken(auth.readToken(req));
      // (MFA-pending sessions are already refused by sessionFromToken.)
      if (!found) return reject(socket, '401 Unauthorized');
      const org = await orgs.bySlug(url.searchParams.get('org') || '');
      if (!org || org.status !== 'active') return reject(socket, '403 Forbidden');
      const membership = await orgs.membership(org.id, found.user.id);
      if (!membership) return reject(socket, '403 Forbidden');
      wss.handleUpgrade(req, socket, head, (ws) => attach(ws, { org, user: found.user, membership, sessionHash: found.session.id_hash }));
    } catch (err) {
      console.error('Upgrade failed:', err.message);
      reject(socket, '500 Internal Server Error');
    }
  }

  // Revocation: close the user's sockets (all orgs, or one), code 4001.
  function disconnectUser(userId, orgId = null) {
    for (const ws of wss.clients) {
      if (ws.ctx?.user?.id === userId && (!orgId || ws.ctx.org?.id === orgId)) ws.close(CLOSE_REVOKED, 'revoked');
    }
    rooms.disconnectUser(userId, orgId);
  }

  // Revoked sessions (logout, other sessions signed out, expiry, password
  // reset) close their chat and meeting sockets at once.
  auth.onRevoke((hashes) => {
    const set = new Set(hashes);
    for (const ws of wss.clients) if (ws.ctx?.sessionHash && set.has(ws.ctx.sessionHash)) ws.close(CLOSE_REVOKED, 'revoked');
  });

  // Idle sockets are re-checked too (expiry, suspension, revocation done by
  // another node).
  const sweep = setInterval(() => {
    for (const ws of wss.clients) if (ws.ctx?.org && ws.readyState === ws.OPEN) revalidate(ws).catch(() => {});
  }, 30_000);
  sweep.unref();

  const presenceSnapshot = (orgId) => {
    const out = {};
    for (const [key, status] of presence) if (key.startsWith(`${orgId}:`)) out[key.slice(orgId.length + 1)] = status;
    return out;
  };

  return {
    handleUpgrade,
    deliver,
    disconnectUser,
    presenceSnapshot,
    // An event could not be delivered: clients of the org reload their state.
    resetOrg: (orgId) => broadcastOrg(orgId, 'system.reset', {}),
    isOnline: (orgId, userId) => !!byUser.get(`${orgId}:${userId}`)?.size,
    isWatching: (orgId, userId) => [...(byUser.get(`${orgId}:${userId}`) || [])].some((ws) => ws.visible && ws.readyState === ws.OPEN),
    stats: () => ({ sockets: wss.clients.size, users: byUser.size }),
    close: () => {
      clearInterval(heartbeat);
      clearInterval(sweep);
      limiter.stop();
      for (const ws of wss.clients) ws.terminate();
      wss.close();
    },
  };
}
