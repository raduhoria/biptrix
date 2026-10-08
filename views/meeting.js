import { alerts, authPage, escapeHtml, icon, jsonData, page } from './layout.js';

// Meeting room (members at /o/:org/meet/:id, verified guests at /meet/:id).
// Pre-join (preview, devices, name) → lobby → room; all driven by
// public/js/meeting.js over /ws/meeting.
export function meetingRoomView({ t, meeting, org, mode, displayName = '', canInvite = false, backHref }) {
  const e = (key, params) => escapeHtml(t(key, params));
  const boot = {
    meeting: { id: meeting.id, title: meeting.title, host_id: meeting.host_id, expires_at: meeting.expires_at },
    org: { slug: org.slug, name: org.name },
    mode,
    displayName,
    canInvite,
    backHref,
    strings: t.client(),
  };
  const ctrl = (action, ic, label, extra = '') => `<button class="btn ctrl" data-action="${action}" title="${e(label)}" aria-label="${e(label)}" ${extra}>${icon(ic)}</button>`;
  return page({
    t,
    title: meeting.title,
    bodyClass: 'meet-body',
    scripts: ['meeting.js'],
    data: jsonData('boot', boot),
    body: `<div class="meet" id="meet" data-stage="prejoin">
  <header class="meet-top">
    <span class="brand-mini">${icon('logo')}</span>
    <div class="min-w-0">
      <div class="fw-semibold text-truncate">${escapeHtml(meeting.title)}</div>
      <div class="small opacity-75 text-truncate">${escapeHtml(org.name)} · <span id="meet-clock"></span></div>
    </div>
    <span class="badge text-bg-danger ms-2" id="rec-live" hidden>LIVE</span>
    <div class="ms-auto d-flex gap-2">
      <button class="btn btn-sm btn-outline-light" data-action="toggle-layout" title="${e('client.meet.layout')}">${icon('grid')}</button>
    </div>
  </header>

  <section class="stage stage-prejoin" id="stage-prejoin">
    <div class="prejoin card shadow-lg">
      <div class="prejoin-video">
        <video id="preview" autoplay playsinline muted></video>
        <div class="prejoin-off" id="preview-off">${icon('video-off')}</div>
        <div class="prejoin-controls">
          ${ctrl('pre-mic', 'mic', 'client.meet.mic')}
          ${ctrl('pre-cam', 'video', 'client.meet.camera')}
        </div>
      </div>
      <div class="card-body">
        <h1 class="h5 mb-3">${e('client.meet.ready')}</h1>
        ${mode === 'guest' ? `<div class="mb-3"><label class="form-label" for="guest-name">${e('client.meet.yourName')}</label><input class="form-control" id="guest-name" maxlength="60" value="${escapeHtml(displayName)}"></div>` : ''}
        <div class="row g-2 mb-3">
          <div class="col-sm-6"><label class="form-label small" for="sel-mic">${e('client.meet.microphone')}</label><select class="form-select form-select-sm" id="sel-mic"></select></div>
          <div class="col-sm-6"><label class="form-label small" for="sel-cam">${e('client.meet.camera')}</label><select class="form-select form-select-sm" id="sel-cam"></select></div>
        </div>
        <div class="alert alert-warning small py-2" id="media-error" hidden></div>
        <button class="btn btn-primary btn-lg w-100" data-action="join">${e('client.meet.join')}</button>
        <a class="btn btn-link w-100 mt-1" href="${escapeHtml(backHref)}">${e('common.back')}</a>
      </div>
    </div>
  </section>

  <section class="stage stage-lobby" id="stage-lobby">
    <div class="text-center">
      <div class="spinner-border mb-3" role="status"></div>
      <h2 class="h5">${e('client.meet.lobbyTitle')}</h2>
      <p class="opacity-75">${e('client.meet.lobbyText')}</p>
      <a class="btn btn-outline-light btn-sm" href="${escapeHtml(backHref)}">${e('client.meet.leave')}</a>
    </div>
  </section>

  <section class="stage stage-ended" id="stage-ended">
    <div class="text-center">
      <h2 class="h5" id="ended-title">${e('client.meet.ended')}</h2>
      <p class="opacity-75" id="ended-text"></p>
      <a class="btn btn-light" href="${escapeHtml(backHref)}">${e('common.back')}</a>
      <button class="btn btn-outline-light ms-2" data-action="rejoin" id="rejoin-btn" hidden>${e('client.meet.rejoin')}</button>
    </div>
  </section>

  <section class="stage stage-room" id="stage-room">
    <div class="tiles" id="tiles"></div>
    <aside class="meet-panel" id="meet-panel" hidden>
      <header class="d-flex align-items-center mb-2">
        <h3 class="h6 mb-0">${e('client.meet.people')}</h3>
        <button class="btn btn-sm btn-icon ms-auto text-white" data-action="panel" aria-label="${e('common.close')}">${icon('x')}</button>
      </header>
      <div id="lobby-box" hidden>
        <div class="small text-uppercase opacity-75 mb-1">${e('client.meet.waiting')}</div>
        <ul class="list-unstyled" id="lobby-list"></ul>
      </div>
      <div class="small text-uppercase opacity-75 mb-1">${e('client.meet.inCall')}</div>
      <ul class="list-unstyled" id="people-list"></ul>
      ${canInvite ? `<form id="invite-form" class="mt-3">
        <div class="small text-uppercase opacity-75 mb-1">${e('client.meet.inviteGuest')}</div>
        <input class="form-control form-control-sm mb-2" type="email" name="email" placeholder="email@firma.ro" required>
        <input class="form-control form-control-sm mb-2" name="name" placeholder="${e('client.meet.guestName')}">
        <button class="btn btn-sm btn-light w-100">${icon('mail')} ${e('client.meet.sendInvite')}</button>
        <div class="small mt-2" id="invite-status"></div>
      </form>` : ''}
    </aside>
  </section>

  <footer class="meet-bar" id="meet-bar">
    ${ctrl('mic', 'mic', 'client.meet.mic')}
    ${ctrl('cam', 'video', 'client.meet.camera')}
    ${ctrl('screen', 'screen', 'client.meet.share', 'id="btn-screen"')}
    ${ctrl('panel', 'users', 'client.meet.people')}<span class="badge rounded-pill text-bg-warning lobby-badge" id="lobby-badge" hidden></span>
    ${ctrl('copy-link', 'link', 'client.meet.copyLink')}
    <button class="btn ctrl ctrl-leave" data-action="leave" title="${e('client.meet.leave')}">${icon('phone-off')}</button>
    <button class="btn btn-sm btn-danger ms-2" data-action="end" id="btn-end" hidden>${e('client.meet.endAll')}</button>
  </footer>
</div>`,
  });
}

// External guest: the invitation link, then the e-mail code (spec §9).
export function guestJoinView({ t, token, inv, meeting, org, step, error = '', notice = '' }) {
  const e = (key, params) => escapeHtml(t(key, params));
  const header = `<div class="guest-meeting mb-4">
    ${icon('video', 'guest-ic')}
    <div><div class="fw-semibold">${escapeHtml(meeting.title)}</div>
    <div class="small text-body-secondary">${e('guest.hostedBy', { org: org.name })}</div>
    <div class="small text-body-secondary">${e('guest.invited', { email: inv.email })}</div></div>
  </div>`;
  const body =
    step === 'code'
      ? `<form method="post" action="/join/${escapeHtml(token)}/verify">
          <label class="form-label" for="otp">${e('guest.codeLabel')}</label>
          <input class="form-control form-control-lg text-center otp-input mb-3" id="otp" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="7" required autofocus>
          <button class="btn btn-primary btn-lg w-100">${e('guest.verify')}</button>
        </form>
        <form method="post" action="/join/${escapeHtml(token)}/code" class="text-center mt-3"><button class="btn btn-link">${e('guest.resend')}</button></form>`
      : step === 'direct'
        ? `<form method="post" action="/join/${escapeHtml(token)}/continue"><button class="btn btn-primary btn-lg w-100">${e('guest.continue')}</button></form>`
        : `<p>${e('guest.otpExplain', { email: inv.email })}</p>
          <form method="post" action="/join/${escapeHtml(token)}/code"><button class="btn btn-primary btn-lg w-100">${icon('mail')} ${e('guest.sendCode')}</button></form>`;
  return authPage({ t, title: t('guest.title'), path: `/join/${token}`, body: header + alerts({ error, notice }) + body });
}
