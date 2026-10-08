import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { createApp } from '../app.js';
import { loadConfig } from '../config/env.js';
import { nowIso } from '../core/util.js';

// Starts a full app on a random port with a temporary database and files
// directory; mails go to `mailer.sent` instead of SMTP.
export async function startApp(env = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'biptrix-test-'));
  const config = loadConfig({ SQLITE_PATH: path.join(dir, 'test.db'), FILES_DIR: path.join(dir, 'files'), APP_SECRET: 'test-secret', PORT: '0', ...env });
  const app = await createApp(config, { quiet: true });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  config.appUrl = base;
  const { services } = app;

  // A user with a password and an active membership, created directly.
  async function user(org, { email, name = email.split('@')[0], role = 'member', password = 'Parola12345' }) {
    const existing = await services.users.byEmail(email);
    const u = existing || (await services.users.create({ email, name, passwordHash: await services.auth.hashPassword(password) }));
    if (org) {
      await app.db.run(
        `INSERT INTO memberships (org_id, user_id, role, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)
         ON CONFLICT(org_id, user_id) DO UPDATE SET role = excluded.role, status = 'active'`,
        [org.id, u.id, role, nowIso(), nowIso()]
      );
    }
    return u;
  }

  const org = (name) => services.orgs.create({ name, actor: { id: null, email: 'test' } });

  return {
    ...app,
    base,
    config,
    services,
    mailer: services.mailer,
    user,
    org,
    async stop() {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// HTTP client with a cookie jar. Sends Origin like a browser would.
export function client(base) {
  const jar = new Map();
  async function request(method, url, { json, form, body, headers = {}, redirect = 'manual' } = {}) {
    const h = { Origin: base, ...headers };
    if (jar.size) h.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    let payload = body;
    if (json !== undefined) {
      h['Content-Type'] = 'application/json';
      payload = JSON.stringify(json);
    } else if (form) {
      h['Content-Type'] = 'application/x-www-form-urlencoded';
      payload = new URLSearchParams(form).toString();
    }
    const res = await fetch(base + url, { method, headers: h, body: payload, redirect });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      const v = pair.slice(i + 1);
      if (v) jar.set(pair.slice(0, i), v);
      else jar.delete(pair.slice(0, i));
    }
    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
    return { status: res.status, location: res.headers.get('location'), text, data };
  }
  return {
    jar,
    get: (url, opts) => request('GET', url, opts),
    post: (url, opts) => request('POST', url, opts),
    async login(email, password = 'Parola12345') {
      const res = await request('POST', '/login', { form: { email, password, next: '/' } });
      if (res.status !== 303) throw new Error(`login failed ${res.status}`);
      return res;
    },
    cookieHeader: () => [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
  };
}

// WebSocket with the client's cookies; collects frames; next(type) waits.
export function socket(base, path, c, { origin = base } = {}) {
  const ws = new WebSocket(base.replace('http', 'ws') + path, { headers: { Cookie: c.cookieHeader(), Origin: origin } });
  const frames = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    const i = waiters.findIndex((w) => w.match(msg));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
    else frames.push(msg);
  });
  let seq = 0;
  const api = {
    ws,
    frames,
    opened: new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
      ws.once('unexpected-response', (req, res) => reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode })));
    }),
    closed: new Promise((resolve) => ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() }))),
    send(type, data = {}) {
      const id = `t${++seq}`;
      ws.send(JSON.stringify({ v: 1, type, id, data }));
      return id;
    },
    next(type, timeoutMs = 3000, predicate = () => true) {
      const match = (m) => m.type === type && predicate(m);
      const i = frames.findIndex(match);
      if (i >= 0) return Promise.resolve(frames.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        const w = { match, resolve };
        waiters.push(w);
        setTimeout(() => {
          const j = waiters.indexOf(w);
          if (j >= 0) {
            waiters.splice(j, 1);
            reject(new Error(`timeout waiting for ${type}`));
          }
        }, timeoutMs);
      });
    },
    request(type, data) {
      const id = api.send(type, data);
      return new Promise((resolve, reject) => {
        const w = { match: (m) => m.re === id, resolve };
        waiters.push(w);
        setTimeout(() => reject(new Error(`timeout on ${type}`)), 3000);
      });
    },
    close: () => ws.close(),
  };
  return api;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
