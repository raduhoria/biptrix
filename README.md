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
npm test                  # 103 tests: isolation, idempotency, catch-up, guests, MFA, push…
```

The first run asks you to create the platform operator account and the first
organization. Without `SMTP_HOST`, e-mails (invitations, OTP codes) are printed
to the console.

## What is implemented

| Area | Content |
|---|---|
| Identity | Global users, organizations (tenants), memberships with roles: owner, admin, compliance, member, external. Platform operator role. |
| Auth | scrypt passwords. Server-side sessions store only the cookie hash, with an `HttpOnly`/`SameSite` (and `__Host-`/`Secure` over HTTPS) cookie. Sessions slide: each use (at most every 5 minutes) extends them and their cookie, and they end `SESSION_TTL_HOURS` (720 = 30 days) after the last use; one still waiting for MFA is not extended. Sign-in throttling. Password reset by e-mail. TOTP MFA (setup shows a QR code), mandatory for the admin and operator consoles. |
| Security | Authorization is checked server-side on every route and WebSocket frame. CSRF protection uses an Origin check. Origin is also checked on WebSocket upgrade. CSP and security headers are set. The standard error envelope is `{error:{code,message}}`. |
| Chat | DMs and Spaces — called **groups** in the interface ("Space" stays the internal name: code, API, database). There is no separate group type: a Space does it all. Spaces are public or private, with moderators; their settings (name, description, visibility, with what each means) are editable after creation, and moderators can archive them. Per-person notifications per conversation: all, mentions only, none (default: all in DMs and Spaces of up to 20 people, mentions above). Markdown, mentions, reactions, threads, edit with `version` (`stale_version`), delete, pin, unread and mention counters, read receipts, typing, presence. **People**: the organization's members as a list (available first, search by name, e-mail, title, department; message or call from a row); external collaborators see only the people they share a conversation with. A profile card opens from any name, avatar or mention. |
| Unread and sound | Per-conversation badges (red with @ for mentions); on phones the back arrow counts what waits in the other conversations; the browser tab's icon gets a red count and the title "(n)"; the installed app's icon shows the unread total, also while closed (message pushes carry it; where the platform supports icon counts: Chrome/Edge on Windows and macOS, iOS home-screen apps). A short WebAudio sound, "Picătură" (a drop), for what would notify, while the app is open: not for the conversation on screen, not in "do not disturb", not when a push notification shows it instead; switched off per device from the status menu. |
| Announcements | Owners and admins publish company announcements (title, optional text with bold/italic/links, type: information, important, good news) for a period of calendar days, last day included. Members see the active ones pinned in the sidebar, live (publish, edit, delete reach open pages at once), with "More" for long text; days follow each viewer's own date. Anyone can hide one on their device (it comes back when edited). External collaborators see none. Audited. |
| Delivery | Each conversation has a `seq`. Sends are idempotent on `client_message_id`. The ACK `persisted` is sent only after commit. A durable event log (`events`) has a monotonic `event_id`. Clients catch up with `system.sync {since}`. The browser keeps a local outbox for offline sends. |
| Files | Uploads are streamed with an extension allowlist and magic-byte checks. Optional antivirus (`AV_SCAN_CMD`), quotas, opaque ids, storage outside the webroot, and authorized download. |
| Search | FTS5 that ignores diacritics. Scoped to the caller's conversations. Filters: conversation, author, date. Also searches file names. |
| Meetings | Instant or scheduled meetings, and calls from a DM or Space (posted as a card in the conversation). WebRTC mesh with lobby, host/co-host, admit, remove, end for all, screen share, active speaker. Microphone, camera and speaker can be changed during a call; optional AI noise suppression (RNNoise, WebAssembly, in the browser). Full screen per tile; shared screens keep their resolution. Each tile shows its connection (P2P, P2P · TURN, SFU), bitrate and latency. The header shows whether the call is **end-to-end encrypted** (green lock: peer to peer, directly or through TURN) or goes **through the media server** (amber shield: above `MESH_MAX_PARTICIPANTS`, via the SFU), live, with an explanation on tap. Calls survive dropped sockets and server restarts. |
| Calls | Audio or video call from a DM or a Space of up to 20 people: every tab and device of the others rings (incoming-call screen, ring tone, answer/decline) for 45 s. A push notification sounds once, so on a closed app the call is pushed again every 6 s (`CALL_RERING_MS`) until it is answered, declined, missed or over. Answered, declined, or missed: a "missed call" line in the conversation, an e-mail if they were offline. Bigger Spaces get the card only, no ringing; nobody with notifications off is rung. |
| Push notifications | Web Push (VAPID, RFC 8291 encryption, `node:crypto` only): direct messages, Space messages by each person's level, mentions, calls (answer/decline in the notification) and missed calls reach phones and computers with the app closed, unless the app is on screen. Installable app (manifest, service worker); on iPhone it works from the home-screen app. Each device subscription belongs to its session (signing out stops it); Contul meu lists devices, sends a test, and can hide message text. Keys: `node scripts/vapid-keys.js` → `VAPID_*` in the environment. |
| In-call chat | A call from a conversation chats in that conversation (its members only; the messages stay there). Other meetings have their own chat, shared with admitted guests, with history for late joiners and subject to message retention. |
| External guests | A personal link (only the token hash is stored) leads to an e-mailed OTP (rate limited, attempts counted), then a guest session bound to the meeting, then the lobby. Revoking or ending the meeting closes the sessions and the sockets. |
| External collaborators | Space moderators (or admins only, per policy) invite people from other companies by e-mail straight into a Space (someone with an address in the organization's company domains joins as a member instead). They get the `external` role with access that expires after N days (90 by default). They see only the conversations shared with them: no directory, no browsing, cannot create Spaces. Each person shows an "external · domain" badge, and a Space that contains them shows a banner. Access can be extended or revoked from the admin console (policy duration 0 = no expiry; "Extend" then removes the limit). Expired collaborators leave People and every picker at once. They can call within their conversations. |
| Passwordless sign-in | A 6-digit code sent by e-mail: stored as an HMAC, valid 10 minutes, single use, rate limited. MFA, when enabled, still follows. Accounts created from an invitation can have no password at all. |
| E-mail | Branded templates. Per-organization sender (e.g. `no-reply@company.com`, must be in the organization's company domains; account mail keeps the platform sender), with a test e-mail. Notification e-mails (direct messages and mentions to someone offline) are informative only: who wrote and where, never the message text. |
| Policies | Per organization and versioned: external invitations on/off, who may invite, allowed/blocked domains, OTP, lobby, guest screen share, daily limits, duration, participants, file size, retention, e-mail notifications. |
| Administration | Organization console: members and invitations, roles, revocation (closes sockets), Spaces (archive), announcements, policies, audit. Usable on phones: the sections wrap, tables become stacked cards. Operator console: tenants (create, suspend, limits), accounts (disable), health, platform audit. The operator has no access to tenant content. |
| Mobile | Installable app. The on-screen keyboard never pushes the page off screen: Android shrinks it (`interactive-widget=resizes-content`), and full-screen pages (chat, call) size themselves from the visible height (`lib.js` `fitViewport`, also for iOS Safari and Android phones whose `100dvh` includes the gesture bar). No `viewport-fit=cover`, so pages stay clear of the system bars. Message lists read at the bottom stay there when they resize; Send does not take the focus, so the keyboard stays open. |
| Languages | English (default), Romanian, Spanish; chosen per user on the account page. |
| Operations | `/healthz`, `/readyz`. Usage counters per tenant and month. Maintenance every 10 minutes: expired sessions, the 7-day event window, orphan uploads, retention, WAL checkpoint; collaborator expiry every minute. |

## Architecture

```
server.js            start, graceful shutdown
app.js               wiring, pre-routing (session, i18n, CSRF), errors, maintenance
config/env.js        all configuration from environment variables
db/connection.js     common async adapter: SQLite (node:sqlite, WAL) | rqlite (HTTP)
db/schema.sql        schema (§13) + FTS5 + triggers; db/migrate.js versioned migrations
core/                auth, orgs, policies, chat, events, realtime, meetings,
                     meeting-rooms, calls, media, sfu, files, notify, push, webpush,
                     announcements, login-codes, mailer, smtp, totp, qr, audit, i18n
routes/              auth, chat (API), meetings (+ guest flow), admin, platform, push, static
views/               pages and e-mails (template literals)
public/js            chat.js, meeting.js, lib.js, push.js, console.js, theme.js, noise-worklet.js
public/sw.js         service worker: push notifications, app icon count (no offline cache)
locales/             en (default), ro, es
```

**Data.** The DB interface is `get / all / run / batch`, with `?` parameters.
Anything that must be atomic is a single `batch()`: a local transaction on
SQLite, one `/db/execute?transaction` request on rqlite. Nothing relies on a
`BEGIN` held open across requests.

**Real time across nodes.** Each change writes its event in the same batch.
Delivery has one path: `events.pump()` reads the log after the last
dispatched id. It runs right after a local write and on a timer: 400 ms in
cluster mode (`CLUSTER=1`), so events written by other nodes are picked up
too, and 2 s on a single node, for writes from other processes (scripts). Clients recover anything lost through `system.sync`. Presence and
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
- **Topology** (`MEDIA_TOPOLOGY`):
  - `auto` (default): peer-to-peer while a call has up to
    `MESH_MAX_PARTICIPANTS` (6) people; when one more joins, the room moves to
    Cloudflare Realtime SFU, and back to peer-to-peer once it fits again (after
    `MEDIA_SFU_RETURN_MS`, 20 s). Moves are make-before-break: the server says
    `topology`, every client builds the new path while the old one still
    plays, switches each track once media flows on it (video through a cover
    element, so the decoder restart is not seen), then closes the old path.
    The room socket never drops. Measured with three browsers and the real
    SFU: about 0.2 s of video freeze at a move, nobody disconnected.
  - Peer-to-peer, each participant sends its picture once per other person,
    so each copy is capped as the call grows (setParameters, no
    renegotiation): 2 people 720p ~1.5 Mbps; 3–4 people ~540p 800 kbps; 5–6
    people ~360p 400 kbps — about 2 Mbps of upload in total at any size.
  - `mesh`: always peer-to-peer (capped at the mesh size); `sfu`: always SFU.
  - Without `CF_SFU_APP_ID` / `CF_SFU_APP_TOKEN` it is always mesh.
  - **Privacy.** Peer-to-peer media is encrypted between the participants
    (DTLS-SRTP); a TURN relay only forwards it. Through the SFU, Cloudflare
    terminates the media. The org policy "calls above 6 people may go through
    Cloudflare SFU" (`media_sfu_allowed`) turned off keeps every call of that
    organization peer-to-peer, capped at 6 (it is fixed per meeting when the
    meeting is created).
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

## Privacy

- Messages, files and backups live only on our server (SQLite and `files/`
  under `/var/lib/biptrix`). Administrators have no screen to read
  conversations they are not in; the operator has no access to tenant content.
- Messages are **not** end-to-end encrypted: whoever has root on the server
  or a backup can read them (the disk itself is not encrypted).
- Transport is always TLS. From the internet, `talk.altbetexchange.com` goes
  through Cloudflare's proxy, which terminates TLS (it does not store
  content); the internal DNS sends the office network straight to the host.
- Notification e-mails never contain message text. Push payloads are
  encrypted to the device (RFC 8291); each person can hide the text there too.
- Calls: see the encryption badge (Meetings) and `media_sfu_allowed`.

## Not done yet (next phases)

- F1: none.
- F3: Shared Spaces between organizations (the schema allows it; grants and the "most restrictive policy wins" rule are missing).
- F4: simulcast (lower resolution for thumbnails in large meetings).
- F5: cross-node presence and typing, rqlite load tests, billing.
- P1/P2: SSO (OIDC/SAML), external calendar, recordings, native apps.
- Backup: `deploy/biptrix-backup` (database, files, secret, with a restore check); rqlite deployments use rqlite's own backups.

## Production: talk.altbetexchange.com

```
Cloudflare (proxied CNAME talk -> balancer.altbetexchange.com)
  -> lb1/lb2 HAProxy, TLS, backend be_biptrix
  -> ai-wizz (10.50.1.126) nginx :443, vhost talk.altbetexchange.com (WebSocket upgrade)
  -> 127.0.0.1:3400, biptrix.service
```

- **Host:** `ai-wizz` (Debian 12, Node 22 from NodeSource), prepared once
  with `deploy/setup-ai-wizz.sh` (idempotent, backs up to
  `/root/codex-backups/biptrix-*`).
- **Layout:**
  - `/opt/biptrix/releases/<pipeline>-<sha>` plus a `current` symlink, owned by `biptrix-deploy`.
  - Data in `/var/lib/biptrix`: `biptrix.db`, `files/`, `backups/`, owned by `biptrix`.
  - Environment in `/etc/biptrix/biptrix.env`, from the `PROD_ENV` CI variable.
- **Pipeline** (`.gitlab-ci.yml`, `shell-deploy` runners on util1):
  1. test;
  2. release check (`npm ci`, `node --check`);
  3. env install;
  4. database backup;
  5. atomic switch and restart;
  6. `/readyz` check, directly and through nginx;
  7. automatic rollback if the check fails.
- **Backups:** daily at 03:30 by `biptrix-backup.timer`, plus one before every
  deploy, in `/var/lib/biptrix/backups/biptrix-<time>/` (owner-only): the
  database, the uploaded files (hard links), the environment with
  `APP_SECRET`. Each one is restored into a temporary directory and checked
  (integrity, every attachment has its file) before it counts. The last 14
  are kept; restore steps are at the top of `deploy/biptrix-backup`. Copy
  them off the host too.
- **Routing changes** (2026-10-08):
  - `use_backend be_biptrix` plus the `be_biptrix` backend on both load
    balancers; backups in `/root/codex-backups/talk-altbet-*`;
  - internal DNS `talk.altbetexchange.com A 10.50.1.72` on dns1/dns2 (serial 142);
  - `ai-wizz` received the standard root keys through the Salt state
    `os-common.horia_root_ssh_access`.
- **First run:** open `https://talk.altbetexchange.com/setup?token=<SETUP_TOKEN>`
  (the token is in `PROD_ENV`). Then remove `SETUP_TOKEN` from `PROD_ENV`.
