#!/usr/bin/env node
// Demo / load test of a real call in production: N automated participants
// (headless Chrome with a fake camera and microphone) join a meeting, then
// a real person is rung in last ("ring into"). With the default 6 bots the
// person is the 7th: the call moves from peer to peer to the SFU, end-to-end
// encrypted. Every 15 s it prints, for each bot, the path, the encryption
// state, the verification code and the video frames decoded.
//
//   node scripts/demo-call.mjs --call horia@unicorndev.eu
//     [--bots 6] [--minutes 10] [--org unicorn-dev]
//     [--base https://talk.altbetexchange.com] [--ssh root@10.50.1.126]
//     [--keep]   (leave the bot accounts in place at the end)
//
// The bot accounts (demo-bot-<n>@<domain of --call>) are created on the
// server over SSH, with a fresh random password per run, and deleted at the
// end (also on Ctrl+C), with the meeting they hosted and its traces.
// Needs playwright-core (not a dependency of the app): PLAYWRIGHT_CORE=<path
// to playwright-core/index.mjs>, or installed where node finds it. Chrome:
// CHROME_PATH, or Playwright's own.

import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const CALL = arg('call');
const BOTS = Number(arg('bots', 6));
const MINUTES = Number(arg('minutes', 10));
const ORG = arg('org', 'unicorn-dev');
const BASE = arg('base', 'https://talk.altbetexchange.com');
const SSH = arg('ssh', 'root@10.50.1.126');
const KEEP = process.argv.includes('--keep');
if (!CALL) {
  console.error('Usage: node scripts/demo-call.mjs --call <e-mail of the person to ring last> [--bots 6] [--minutes 10]');
  process.exit(1);
}
const domain = CALL.split('@')[1];
const bots = Array.from({ length: BOTS }, (_, i) => ({ name: `Demo ${i + 1}`, email: `demo-bot-${i + 1}@${domain}`, password: randomBytes(18).toString('base64url') }));

// ------------------------------------------------------------ server side
// Runs on the server as the app's user, with the app's own modules.
const SERVER_SCRIPT = String.raw`
import { randomBytes, scrypt } from 'node:crypto';
import { promisify } from 'node:util';
const { loadConfig } = await import('/opt/biptrix/current/config/env.js');
const { createDb } = await import('/opt/biptrix/current/db/connection.js');
const { createUsers } = await import('/opt/biptrix/current/core/users.js');
const { createEvents } = await import('/opt/biptrix/current/core/events.js');
const input = JSON.parse(process.env.DEMO_INPUT);
const db = await createDb(loadConfig().db);
const users = createUsers(db);
const events = createEvents({ db, nodeId: 'demo', cluster: false });
const org = await db.get('SELECT id FROM organizations WHERE slug = ?', [input.org]);
if (!org) throw new Error('organization not found: ' + input.org);
const now = new Date().toISOString();
if (input.action === 'create') {
  for (const b of input.bots) {
    const salt = randomBytes(16);
    const hash = await promisify(scrypt)(b.password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    const passwordHash = 'scrypt$32768$' + salt.toString('base64') + '$' + hash.toString('base64');
    let u = await users.byEmail(b.email);
    if (!u) u = await users.create({ email: b.email, name: b.name, passwordHash });
    else await db.run('UPDATE users SET password_hash = ?, status = ? WHERE id = ?', [passwordHash, 'active', u.id]);
    await db.run("INSERT INTO memberships (org_id, user_id, role, status, created_at, updated_at) VALUES (?, ?, 'member', 'active', ?, ?) ON CONFLICT(org_id, user_id) DO UPDATE SET role = 'member', status = 'active', access_expires_at = NULL", [org.id, u.id, now, now]);
  }
  console.log('created ' + input.bots.length);
} else {
  let n = 0;
  for (const b of input.bots) {
    const u = await db.get('SELECT id FROM users WHERE email = ?', [b.email]);
    if (!u) continue;
    const dms = (await db.all("SELECT c.id FROM conversations c JOIN conversation_members cm ON cm.conversation_id = c.id WHERE cm.user_id = ? AND c.type = 'dm'", [u.id])).map((r) => r.id);
    await db.batch([
      ['DELETE FROM meetings WHERE host_id = ?', [u.id]],
      ...dms.map((id) => ['DELETE FROM conversations WHERE id = ?', [id]]),
      ['DELETE FROM users WHERE id = ?', [u.id]],
      events.statement({ orgId: org.id, type: 'member.removed', data: { user_id: u.id } }),
    ]);
    n++;
  }
  console.log('removed ' + n);
}
process.exit(0);
`;

function onServer(action) {
  const input = JSON.stringify({ action, org: ORG, bots: bots.map(({ name, email, password }) => ({ name, email, password: action === 'create' ? password : undefined })) });
  const remote = `f=$(mktemp /tmp/demo-XXXX.mjs) && cat > $f && chmod 644 $f && cd /opt/biptrix/current && sudo -u biptrix env DEMO_INPUT=${shellQuote(input)} bash -c 'set -a; . /etc/biptrix/biptrix.env; set +a; node --disable-warning=ExperimentalWarning '$f 2>&1 | grep -v -i sss; rm -f $f`;
  const res = spawnSync('ssh', [SSH, remote], { input: SERVER_SCRIPT, encoding: 'utf8' });
  if (res.status !== 0 && !/created|removed/.test(res.stdout)) throw new Error(`server ${action} failed: ${res.stdout}${res.stderr}`);
  return res.stdout.trim();
}
const shellQuote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

// ------------------------------------------------------------- HTTP side
function session() {
  const jar = new Map();
  async function req(method, path, json) {
    const headers = { Origin: BASE };
    if (jar.size) headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    let body;
    if (json && method === 'FORM') {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(json).toString();
      method = 'POST';
    } else if (json) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(json);
    }
    const res = await fetch(BASE + path, { method, headers, body, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      jar.set(pair.slice(0, i), pair.slice(i + 1));
    }
    const text = await res.text();
    try {
      return { status: res.status, data: JSON.parse(text) };
    } catch {
      return { status: res.status, data: null };
    }
  }
  return { jar, req };
}

// ------------------------------------------------------------------ run
let browser = null;
let cleaned = false;
async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  await browser?.close().catch(() => {});
  if (KEEP) return console.log('Bot accounts kept (--keep).');
  console.log(`Cleanup: ${onServer('remove')} bot account(s), with their meeting.`);
}
process.on('SIGINT', async () => {
  console.log('\nStopping…');
  await cleanup();
  process.exit(0);
});

try {
  const { chromium } = await import(process.env.PLAYWRIGHT_CORE || 'playwright-core');
  console.log(`Server: ${onServer('create')} bot account(s) in ${ORG}.`);
  const sessions = [];
  for (const b of bots) {
    const s = session();
    const r = await s.req('FORM', '/login', { email: b.email, password: b.password, next: '/' });
    if (r.status !== 303) throw new Error(`login failed for ${b.email}: ${r.status}`);
    sessions.push(s);
  }
  const API = `/api/o/${ORG}`;
  const directory = (await sessions[0].req('GET', `${API}/bootstrap`)).data.directory;
  const target = directory.find((u) => u.email === CALL.toLowerCase());
  if (!target) throw new Error(`${CALL} is not a member of ${ORG}`);
  // The bots are invited (straight in, no lobby); the person is rung later.
  const botIds = bots.slice(1).map((b) => directory.find((u) => u.email === b.email)?.id).filter(Boolean);
  const meeting = (await sessions[0].req('POST', `${API}/meetings`, { title: `Demo · ${BOTS + 1} participants`, user_ids: botIds, notify_members: false })).data.meeting;
  console.log(`Meeting "${meeting.title}" (${meeting.id}).`);

  browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || undefined,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  });
  const pages = [];
  for (const [i, s] of sessions.entries()) {
    const ctx = await browser.newContext({ viewport: { width: 640, height: 480 }, permissions: ['camera', 'microphone'] });
    // Host-only cookies (url, not domain): __Host-sid allows no Domain.
    await ctx.addCookies([...s.jar].map(([name, value]) => ({ name, value, url: BASE, secure: BASE.startsWith('https'), httpOnly: true })));
    const p = await ctx.newPage();
    await p.addInitScript(() => {
      window.__pcs = [];
      const P = window.RTCPeerConnection;
      window.RTCPeerConnection = class extends P {
        constructor(...a) {
          super(...a);
          window.__pcs.push(this);
        }
      };
    });
    p.on('pageerror', (e) => console.log(`  ${bots[i].name}: page error ${e.message}`));
    await p.goto(`${BASE}/o/${ORG}/meet/${meeting.id}`);
    await p.waitForSelector('[data-action="join"]:not([disabled])');
    await p.click('[data-action="join"]');
    await p.waitForFunction(() => document.querySelector('#meet')?.dataset.stage === 'room', null, { timeout: 30_000 });
    pages.push(p);
    console.log(`  ${bots[i].name} joined.`);
  }
  await pages[0].waitForTimeout(5000);
  const rung = (await sessions[0].req('POST', `${API}/meetings/${meeting.id}/ring-members`, { user_ids: [target.id] })).data;
  console.log(rung?.ringing?.length ? `Ringing ${CALL}… (answer on your phone or computer)` : `Could not ring ${CALL}: ${JSON.stringify(rung)}`);

  const status = async () => {
    const lines = [];
    for (const [i, p] of pages.entries()) {
      const r = await p.evaluate(async () => {
        let frames = 0;
        for (const pc of window.__pcs) {
          if (pc.connectionState === 'closed') continue;
          for (const s of (await pc.getStats()).values()) if (s.type === 'inbound-rtp' && s.kind === 'video') frames += s.framesDecoded || 0;
        }
        const b = document.querySelector('#sec-badge');
        return {
          people: document.querySelectorAll('#people-list > li').length,
          sfu: /media server|server media|servidor de medios/i.test(b.title),
          green: b.classList.contains('e2e'),
          code: (b.title.match(/code: ([^\n]+)/i) || [])[1] || '-',
          frames,
        };
      });
      lines.push(`  ${bots[i].name}: ${r.people} in call, ${r.sfu ? 'SFU' : 'P2P'}, ${r.green ? 'encrypted' : 'keys pending'}, code ${r.code}, ${r.frames} video frames decoded`);
    }
    console.log(`[${new Date().toLocaleTimeString()}]\n${lines.join('\n')}`);
  };
  const until = Date.now() + MINUTES * 60_000;
  while (Date.now() < until) {
    await status();
    await new Promise((r) => setTimeout(r, 15_000));
  }
  console.log('Time is up.');
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await cleanup();
}
