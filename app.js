import http from 'node:http';
import path from 'node:path';

import { createDb } from './db/connection.js';
import { runMigrations } from './db/migrate.js';
import { createAudit } from './core/audit.js';
import { createCalls } from './core/calls.js';
import { createPush } from './core/push.js';
import { createAuth } from './core/auth.js';
import { createChat } from './core/chat.js';
import { createEvents } from './core/events.js';
import { createFiles } from './core/files.js';
import { clientIp, isSecure, sameOrigin, securityHeaders } from './core/http.js';
import { createTranslator, resolveLocale, translateError } from './core/i18n.js';
import { createLoginCodes } from './core/login-codes.js';
import { createMailer } from './core/mailer.js';
import { createMedia } from './core/media.js';
import { createRooms } from './core/meeting-rooms.js';
import { createMeetings } from './core/meetings.js';
import { createNotifier } from './core/notify.js';
import { createOrgs } from './core/orgs.js';
import { createPolicies } from './core/policies.js';
import { createRealtime } from './core/realtime.js';
import { createRouter, parseCookies } from './core/router.js';
import { createSecretBox, loadAppSecret } from './core/secrets.js';
import { createUsers } from './core/users.js';
import { configureEmails } from './views/emails.js';
import { messagePage } from './views/layout.js';

import { registerAdminRoutes } from './routes/admin.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerChatRoutes } from './routes/chat.js';
import { registerMeetingRoutes } from './routes/meetings.js';
import { registerPlatformRoutes } from './routes/platform.js';
import { registerPushRoutes } from './routes/push.js';
import { registerStatic } from './routes/static.js';

const MAINTENANCE_MS = 10 * 60_000;

// createApp: wires database, services and routes into an HTTP server (not
// yet listening). server.js uses it with the real config; tests with a
// temporary database and a console mailer.
export async function createApp(config, { quiet = false } = {}) {
  const db = await createDb(config.db);
  await runMigrations(db);

  const appSecret = loadAppSecret({ envSecret: config.appSecret, keyFile: config.appSecretFile });
  const secretBox = createSecretBox(appSecret);
  const audit = createAudit(db);
  const users = createUsers(db);
  const auth = createAuth({ db, users, config, secretBox });
  const events = createEvents({ db, nodeId: config.nodeId, cluster: config.cluster });
  const orgs = createOrgs({ db, users, audit, events });
  const policies = createPolicies({ db, audit });
  const chat = createChat({ db, events, audit, policies });
  const files = createFiles({ db, config, policies });
  const meetings = createMeetings({ db, policies, audit, appSecret, events });
  const media = createMedia(config);
  configureEmails({ name: config.smtp.fromName, url: config.appUrl });
  const mailer = createMailer({ smtp: config.smtp, quiet });
  const loginCodes = createLoginCodes({ db, secret: appSecret });
  let realtime = null;
  const isOnline = (orgId, userId) => realtime.isOnline(orgId, userId);
  const isWatching = (orgId, userId) => realtime.isWatching(orgId, userId);
  const push = createPush({ db, config });
  const notifier = createNotifier({ db, mailer, policies, config, isOnline, isWatching, push });
  const rooms = createRooms({ auth, orgs, meetings, media, chat, users, notifier });
  realtime = createRealtime({ config, auth, orgs, chat, events, rooms, notifier });
  const calls = createCalls({ db, events, chat, meetings, orgs, users, mailer, config, rooms, isOnline, isWatching, push });
  // Durable events go to the chat sockets, and conversation messages also
  // to the rooms of meetings started from that conversation (in-call chat).
  const deliver = async (event) => {
    await realtime.deliver(event);
    rooms.onEvent(event).catch((err) => console.error('Room chat delivery failed:', err.message));
  };
  await events.start(deliver, (event) => realtime.resetOrg(event.org_id));

  // Readiness: the database answers (rqlite: a quorum-backed read).
  async function health() {
    const started = Date.now();
    await db.get('SELECT 1 AS ok');
    return { status: 'ok', node: config.nodeId, db: config.db.driver, db_ms: Date.now() - started, event_cursor: events.cursor(), uptime_s: Math.round(process.uptime()), rss_mb: Math.round(process.memoryUsage().rss / 1048576) };
  }

  // Standard error envelope for /api/* (spec §14), an error page otherwise.
  function onError(err, req, res) {
    const status = err.status || (err.code === 'db_unavailable' ? 503 : 500);
    if (status >= 500 && err.code !== 'db_unavailable') console.error(`${req.method} ${req.url}:`, err);
    const t = req.t || createTranslator('en');
    const message = err.expose || err.code === 'db_unavailable' ? translateError(t, err) : t('errors.internal');
    if (req.path?.startsWith('/api/')) return res.status(status).json({ error: { code: err.code || 'internal', message, details: err.expose ? err.details : undefined } });
    if (status === 401) return res.redirect(`/login?next=${encodeURIComponent(req.url)}`);
    const title = t.has(`errors.title${status}`) ? t(`errors.title${status}`) : t('errors.titleGeneric');
    res.status(status).send(messagePage({ t, title, message, status: String(status), back: '/' }));
  }

  const router = createRouter({ onError });
  registerStatic(router, path.join(import.meta.dirname, 'public'), { dev: config.dev });
  const deps = { push, calls, db, config, loginCodes, auth, users, orgs, policies, events, chat, files, meetings, media, mailer, rooms, realtime, notifier, audit, secretBox, health };
  registerAuthRoutes(router, deps);
  registerChatRoutes(router, deps);
  registerMeetingRoutes(router, deps);
  registerAdminRoutes(router, deps);
  registerPlatformRoutes(router, deps);
  registerPushRoutes(router, deps);

  router.get('/healthz', (req, res) => res.json({ status: 'ok', node: config.nodeId }));
  router.get('/readyz', async (req, res) => {
    try {
      res.json(await health());
    } catch (err) {
      res.status(503).json({ status: 'unavailable', error: err.message });
    }
  });

  const isAsset = (p) => /^\/(vendor|css|js|img)\/|^\/favicon\.svg$/.test(p);

  const server = http.createServer(async (req, res) => {
    req.ip = clientIp(req, config.trustProxy);
    req.secure = config.cookieSecure || isSecure(req, config.trustProxy);
    securityHeaders(res, req.secure);
    req.cookies = parseCookies(req.headers.cookie);
    req.t = createTranslator(resolveLocale(req.cookies));
    if (!['GET', 'HEAD'].includes(req.method) && !sameOrigin(req, config.appUrl)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      return res.end('Cross-site request blocked');
    }
    if (!isAsset(req.url.split('?')[0])) {
      try {
        await auth.loadUser(req);
      } catch (err) {
        console.error('Session lookup failed:', err.message);
        res.writeHead(503, { 'Content-Type': 'text/plain', 'Retry-After': '5' });
        return res.end('Service temporarily unavailable');
      }
      if (req.user?.locale && !req.cookies.lang) req.t = createTranslator(req.user.locale);
    }
    router.handle(req, res);
  });
  server.on('upgrade', (req, socket, head) => realtime.handleUpgrade(req, socket, head));

  // Housekeeping: expired sessions/tokens/login codes, the event replay window, orphan
  // uploads, calls past their ringing deadline, message retention per policy (in-call chat included), the file deletion queue, WAL
  // checkpoint. Retention also removes the copies of deleted messages kept
  // in the event log, so no text outlives the policy there either.
  async function maintenance() {
    try {
      await auth.pruneExpired();
      await loginCodes.prune();
      await push.prune();
      await calls.sweep();
      await meetings.closeExpired();
      for (const r of await orgs.expireCollaborators()) realtime.disconnectUser(r.user_id, r.org_id);
      await events.prune(7);
      await files.pruneOrphans();
      for (const row of await db.all("SELECT org_id, json_extract(data, '$.message_retention_days') AS days FROM policies WHERE json_extract(data, '$.message_retention_days') > 0")) {
        const cutoff = new Date(Date.now() - row.days * 86400_000).toISOString();
        await db.batch([
          ['DELETE FROM messages WHERE org_id = ? AND created_at < ? AND pinned_at IS NULL', [row.org_id, cutoff]],
          ['DELETE FROM meeting_messages WHERE org_id = ? AND created_at < ?', [row.org_id, cutoff]],
          [
            `DELETE FROM events WHERE org_id = ? AND type IN ('message.created', 'message.updated')
               AND NOT EXISTS (SELECT 1 FROM messages WHERE id = json_extract(events.data, '$.id'))`,
            [row.org_id],
          ],
        ]);
      }
      await files.processDeletions();
      await db.checkpoint();
    } catch (err) {
      console.error('Maintenance failed:', err.message);
    }
  }
  const timer = setInterval(maintenance, MAINTENANCE_MS);
  timer.unref();

  async function close() {
    clearInterval(timer);
    events.stop();
    rooms.close();
    realtime.close();
    calls.close();
    await new Promise((resolve) => server.close(resolve));
    await db.close();
  }

  return { server, db, close, maintenance, services: deps };
}
