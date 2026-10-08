# Biptrix

Multi-tenant chat and meetings platform (working name). Built from
`Altbet_Chat_Specificatii_Final_v1` (8 Oct 2026). It started for Altbet and is
designed to be sold as SaaS or self-hosted.

## Principles

- Node.js ≥ 22.13, ESM, no TypeScript, no build step.
- One dependency: `ws`. Everything else uses Node built-ins: `node:http` with
  our own router, `node:sqlite`, `node:crypto` (scrypt, AES-GCM, TOTP),
  and an SMTP client on `node:net`/`node:tls`.
- Services are closures (`createXxx(deps)`) wired in `app.js`. No classes, no
  global singletons.
- Server-rendered pages use template literals. The UI is Bootstrap 5 served
  from `public/vendor`, with vanilla ES modules in `public/js`. No CDN.
- Strict CSP: no inline scripts. Page data goes in `<script type="application/json">`.

## Run

```bash
npm install
cp .env.example .env      # optional; every value has a default
npm run dev               # http://localhost:3000 → /setup on first run
npm test                  # 20 tests: isolation, idempotency, catch-up, guests, MFA…
```

The first run asks you to create the platform operator account and the first
organization. Without `SMTP_HOST`, e-mails (invitations, OTP codes) are printed
to the console.

## What is implemented

| Area | Content |
|---|---|
| Identity | Global users, organizations (tenants), memberships with roles: owner, admin, compliance, member, external. Platform operator role. |
| Auth | scrypt passwords. Server-side sessions store only the cookie hash, with an `HttpOnly`/`SameSite` (and `__Host-`/`Secure` over HTTPS) cookie. Sign-in throttling. Password reset by e-mail. TOTP MFA, mandatory for the admin and operator consoles. |
| Security | Authorization is checked server-side on every route and WebSocket frame. CSRF protection uses an Origin check. Origin is also checked on WebSocket upgrade. CSP and security headers are set. The standard error envelope is `{error:{code,message}}`. |
| Chat | DMs, groups, public and private Spaces with moderators. Markdown, mentions, reactions, threads, edit with `version` (`stale_version`), delete, pin, mute, unread and mention counters, read receipts, typing, presence. |
| Delivery | Each conversation has a `seq`. Sends are idempotent on `client_message_id`. The ACK `persisted` is sent only after commit. A durable event log (`events`) has a monotonic `event_id`. Clients catch up with `system.sync {since}`. The browser keeps a local outbox for offline sends. |
| Files | Uploads are streamed with an extension allowlist and magic-byte checks. Optional antivirus (`AV_SCAN_CMD`), quotas, opaque ids, storage outside the webroot, and authorized download. |
| Search | FTS5 that ignores diacritics. Scoped to the caller's conversations. Filters: conversation, author, date. Also searches file names. |
| Meetings | Instant or scheduled meetings, and calls from a DM or Space (posted as a card in the conversation). WebRTC mesh with lobby, host/co-host, admit, remove, end for all, screen share, device selection, active speaker. |
| External guests | A personal link (only the token hash is stored) leads to an e-mailed OTP (rate limited, attempts counted), then a guest session bound to the meeting, then the lobby. Revoking or ending the meeting closes the sessions and the sockets. |
| Policies | Per organization and versioned: external invitations on/off, who may invite, allowed/blocked domains, OTP, lobby, guest screen share, daily limits, duration, participants, file size, retention, e-mail notifications. |
| Administration | Organization console: members and invitations, roles, revocation (closes sockets), Spaces (archive), policies, audit. Operator console: tenants (create, suspend, limits), accounts (disable), health, platform audit. The operator has no access to tenant content. |
| Operations | `/healthz`, `/readyz`. Usage counters per tenant and month. Hourly maintenance: expired sessions, the 7-day event window, orphan uploads, retention, WAL checkpoint. |

## Architecture

```
server.js            start, graceful shutdown
app.js               wiring, pre-routing (session, i18n, CSRF), errors, maintenance
config/env.js        all configuration from environment variables
db/connection.js     common async adapter: SQLite (node:sqlite, WAL) | rqlite (HTTP)
db/schema.sql        schema (§13) + FTS5 + triggers; db/migrate.js versioned migrations
core/                auth, orgs, policies, chat, events, realtime, meetings,
                     meeting-rooms, media, files, notify, audit, smtp, totp, i18n
routes/              auth, chat (API), meetings (+ guest flow), admin, platform, static
views/               pages and e-mails (template literals)
public/js            chat.js, meeting.js, lib.js, console.js, theme.js
locales/             ro (default), en
```

**Data.** The DB interface is `get / all / run / batch`, with `?` parameters.
Anything that must be atomic is a single `batch()`: a local transaction on
SQLite, one `/db/execute?transaction` request on rqlite. Nothing relies on a
`BEGIN` held open across requests.

**Real time across nodes.** Each change writes its event in the same batch.
Delivery has one path: `events.pump()` reads the log after the last
dispatched id. It runs right after a local write and, in cluster mode
(`CLUSTER=1`), on a 400 ms timer, so events written by other nodes are picked
up too. Clients recover anything lost through `system.sync`. Presence and
typing are ephemeral and per node.

**Meetings across nodes.** Rooms live in the memory of the node that holds the
meeting's WebSocket. In HA, the load balancer routes `/ws/meeting` by the `id`
parameter (consistent hash).

## WebRTC and TURN

- Without TURN, only static STUN is used (`ICE_SERVERS`), so there is no relay behind a strict NAT.
- With **Cloudflare Realtime TURN** (`CF_TURN_KEY_ID`, `CF_TURN_API_TOKEN`), each
  participant gets short-lived credentials (4h), issued only after admission.
- With coturn, set `TURN_URLS` + `TURN_SECRET` (TURN REST scheme).
- `MEDIA_FORCE_RELAY=1` (test only) forces all media through TURN, to simulate a
  restrictive NAT (criterion 24). Tested with two Chrome browsers through
  Cloudflare TURN: video both ways and screen share.
- **Topology** (`MEDIA_TOPOLOGY=auto`): Cloudflare Realtime SFU when
  `CF_SFU_APP_ID` / `CF_SFU_APP_TOKEN` are set, otherwise a peer-to-peer mesh.
  - **SFU** (`core/sfu.js`): one session per participant. Every push and pull
    goes through `/ws/meeting` and the server, so the token never reaches the
    browser and a pull only works between admitted participants of the same
    room. The server assigns track names and closes a participant's tracks when
    they leave. Capacity comes from the policy (`max_participants`, default 25).
  - Cloudflare refuses to pull a track that has not sent packets yet. Because
    of that, audio and camera always send something: the real track, or a
    placeholder (silence, a black frame at 1–2 fps) while muted or off. The
    camera itself is released. The screen is published only while shared and
    is announced only once packets flow. A failed pull is retried.
  - **Mesh**: 3 fixed transceivers per connection, created by whoever joins.
    The limit is `MESH_MAX_PARTICIPANTS` (6).
  - In both cases the camera and the screen switch with `replaceTrack`.
- Tested with real headless Chrome browsers: 2 people over mesh with relay
  forced through Cloudflare TURN, and 3 people over Cloudflare SFU (video,
  screen share, camera off, leaving).
- Cost (Oct 2026): SFU and TURN are $0.05/GB of egress, with the first
  1,000 GB/month free, shared between the two services.

## Not done yet (next phases)

- F1: none.
- F3: Shared Spaces between organizations (the schema allows it; grants and the "most restrictive policy wins" rule are missing).
- F4: simulcast (lower resolution for thumbnails in large meetings).
- F5: cross-node presence and typing, rqlite load tests, billing.
- P1/P2: SSO (OIDC/SAML), external calendar, recordings, native apps.
- Backup: `db.backup()` (`VACUUM INTO`) exists; the orchestration script and restore test are not written yet.
