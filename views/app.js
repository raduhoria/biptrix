import { can } from '../core/orgs.js';
import { escapeHtml, icon, initials, jsonData, page } from './layout.js';

// The chat application shell for /o/:org. Server-rendered frame; lists,
// messages and dialogs are filled by public/js/chat.js from the JSON API and
// the WebSocket. Everything the client needs to start is in #boot.
export function chatView({ t, user, org, membership, orgs, config, isOperator }) {
  const role = membership.role;
  const e = (key, params) => escapeHtml(t(key, params));
  const admin = can(role, 'members.manage') || can(role, 'policies.manage') || can(role, 'audit.read');

  const rail = orgs
    .map(
      (o) => `<a class="rail-org${o.id === org.id ? ' active' : ''}" href="/o/${escapeHtml(o.slug)}" title="${escapeHtml(o.name)}" style="--org:${escapeHtml(o.brand_color || '#4f46e5')}">
        ${escapeHtml(o.name.slice(0, 2).toUpperCase())}<span class="rail-badge" data-org-badge="${escapeHtml(o.id)}" hidden></span></a>`
    )
    .join('');

  const boot = {
    me: { id: user.id, name: user.name, email: user.email },
    org: { id: org.id, slug: org.slug, name: org.name },
    role,
    perms: {
      directory: can(role, 'directory'),
      spaces: can(role, 'spaces.browse'),
      meetings: can(role, 'meetings.create'),
      calls: can(role, 'calls'),
      admin,
    },
    locale: t.locale,
    strings: t.client(),
    maxUploadMb: Math.round(config.maxUploadBytes / 1048576),
    // Web Push: the server's public key ('' when push is not configured).
    push: config.push.publicKey && config.push.privateKey ? config.push.publicKey : '',
  };

  return page({
    t,
    title: org.name,
    bodyClass: 'app-body',
    scripts: ['chat.js'],
    data: jsonData('boot', boot),
    body: `<div class="app" id="app">
  <nav class="rail" aria-label="${e('nav.orgs')}">
    <a class="rail-logo" href="/" title="${e('app.name')}">${icon('logo')}</a>
    <div class="rail-orgs">${rail}</div>
    <div class="rail-bottom">
      ${isOperator ? `<a class="rail-btn" href="/platform" title="${e('platform.title')}">${icon('building')}</a>` : ''}
      <button class="rail-btn theme-toggle" type="button" title="${e('nav.theme')}">${icon('moon', 'only-light')}${icon('sun', 'only-dark')}</button>
      <a class="rail-btn" href="/account" title="${e('account.title')}"><span class="avatar avatar-sm">${escapeHtml(initials(user.name))}</span></a>
    </div>
  </nav>

  <aside class="side" id="side">
    <div class="side-head">
      <div class="dropdown flex-grow-1 min-w-0">
        <button class="btn side-org dropdown-toggle" data-bs-toggle="dropdown" aria-expanded="false">
          <span class="text-truncate">${escapeHtml(org.name)}</span>
        </button>
        <ul class="dropdown-menu shadow">
          <li><h6 class="dropdown-header">${escapeHtml(user.email)} · ${e(`roles.${role}`)}</h6></li>
          ${admin ? `<li><a class="dropdown-item" href="/o/${escapeHtml(org.slug)}/admin">${icon('settings')} ${e('nav.admin')}</a></li>` : ''}
          <li><a class="dropdown-item" href="/account">${icon('user')} ${e('account.title')}</a></li>
          <li><hr class="dropdown-divider"></li>
          <li><form method="post" action="/logout"><button class="dropdown-item">${icon('logout')} ${e('auth.signOut')}</button></form></li>
        </ul>
      </div>
      <div class="dropdown">
        <button class="btn btn-icon presence-btn" data-bs-toggle="dropdown" aria-label="${e('client.presence')}" id="presence-btn"><span class="presence-dot online"></span></button>
        <ul class="dropdown-menu dropdown-menu-end shadow" id="presence-menu">
          <li><button class="dropdown-item" data-presence="online"><span class="presence-dot online"></span> ${e('client.status.online')}</button></li>
          <li><button class="dropdown-item" data-presence="away"><span class="presence-dot away"></span> ${e('client.status.away')}</button></li>
          <li><button class="dropdown-item" data-presence="dnd"><span class="presence-dot dnd"></span> ${e('client.status.dnd')}</button></li>
          <li><hr class="dropdown-divider"></li>
          <li><button class="dropdown-item d-flex align-items-center gap-2" data-action="toggle-sound" id="sound-toggle" title="${e('client.soundHelp')}">${icon('bell')} ${e('client.soundOn')}</button></li>
        </ul>
      </div>
    </div>

    <form class="side-search" id="search-form" role="search">
      ${icon('search')}<input class="form-control" type="search" name="q" placeholder="${e('client.searchPlaceholder')}" aria-label="${e('client.search')}" autocomplete="off">
    </form>

    <div class="dropdown px-3 mb-2"${boot.perms.directory || boot.perms.spaces || boot.perms.meetings ? '' : ' hidden'}>
      <button class="btn btn-primary w-100 new-btn" data-bs-toggle="dropdown">${icon('plus')} ${e('client.new')}</button>
      <ul class="dropdown-menu shadow w-100">
        ${boot.perms.directory ? `<li><button class="dropdown-item" data-action="new-dm">${icon('user')} ${e('client.newDm')}</button></li>` : ''}
        ${boot.perms.spaces ? `<li><button class="dropdown-item" data-action="new-space">${icon('hash')} ${e('client.newSpace')}</button></li>
        <li><button class="dropdown-item" data-action="browse-spaces">${icon('globe')} ${e('client.browseSpaces')}</button></li>` : ''}
        ${boot.perms.meetings ? `<li><hr class="dropdown-divider"></li><li><button class="dropdown-item" data-action="new-meeting">${icon('video')} ${e('client.newMeeting')}</button></li>` : ''}
      </ul>
    </div>

    <div class="side-scroll">
      <div class="announcements" id="announcements" hidden></div>
      <div class="push-banner" id="push-banner" hidden></div>
      <button class="side-link" data-view="people">${icon('users')} <span>${e('client.people')}</span><span class="badge rounded-pill text-bg-success ms-auto" id="online-count" hidden></span></button>
      <button class="side-link" data-view="meetings">${icon('calendar')} <span>${e('client.meetings')}</span><span class="badge rounded-pill text-bg-danger ms-auto" id="live-count" hidden></span></button>
      <div class="side-section">
        <div class="side-label">${e('client.directMessages')}</div>
        <ul class="conv-list" id="list-direct"></ul>
      </div>
      <div class="side-section">
        <div class="side-label">${e('client.spaces')}</div>
        <ul class="conv-list" id="list-spaces"></ul>
      </div>
    </div>
    <div class="side-foot" id="conn-state" data-state="connecting"><span class="conn-dot"></span><span class="conn-text">${e('client.connecting')}</span></div>
  </aside>

  <main class="main" id="main">
    <section class="view view-empty active" id="view-empty">
      <div class="empty-hero">
        ${icon('chat', 'hero-ic')}
        <h2 class="h4">${e('client.welcome', { name: user.name.split(' ')[0] })}</h2>
        <p class="text-body-secondary">${e('client.welcomeHint')}</p>
      </div>
    </section>

    <section class="view view-conv" id="view-conv" aria-live="polite">
      <header class="conv-head">
        <button class="btn btn-icon d-lg-none" data-action="back" aria-label="${e('common.back')}">${icon('chevron-left')}</button>
        <div class="conv-title min-w-0">
          <h2 class="h6 mb-0 text-truncate" id="conv-name"></h2>
          <div class="small text-body-secondary text-truncate" id="conv-sub"></div>
        </div>
        <div class="conv-actions">
          <button class="btn btn-icon" data-action="call" data-kind="audio" title="${e('client.startAudioCall')}">${icon('phone')}</button>
          <button class="btn btn-icon" data-action="call" data-kind="video" title="${e('client.startCall')}">${icon('video')}</button>
          <button class="btn btn-icon d-none d-sm-inline-flex" data-action="pinned" title="${e('client.pinned')}">${icon('pin')}</button>
          <button class="btn btn-icon d-none d-sm-inline-flex" data-action="members" title="${e('client.members')}">${icon('users')}</button>
          <div class="dropdown">
            <button class="btn btn-icon" data-bs-toggle="dropdown" title="${e('client.more')}">${icon('more')}</button>
            <ul class="dropdown-menu dropdown-menu-end shadow" id="conv-menu"></ul>
          </div>
        </div>
      </header>
      <div class="ext-banner" id="ext-banner" hidden></div>
      <div class="msg-scroll" id="msg-scroll">
        <div class="msg-top" id="msg-top"></div>
        <div class="msg-list" id="msg-list"></div>
      </div>
      <div class="typing" id="typing"></div>
      <div class="composer-wrap" id="composer-main"></div>
    </section>

    <section class="view view-people" id="view-people">
      <header class="conv-head">
        <button class="btn btn-icon d-lg-none" data-action="back" aria-label="${e('common.back')}">${icon('chevron-left')}</button>
        <div class="min-w-0"><h2 class="h6 mb-0">${e('client.people')}</h2><div class="small text-body-secondary" id="people-sub"></div></div>
        <input class="form-control form-control-sm ms-auto people-search" type="search" id="people-search" placeholder="${e('client.searchPeople')}" aria-label="${e('client.searchPeople')}">
      </header>
      <div class="view-body" id="people-body"></div>
    </section>

    <section class="view view-meetings" id="view-meetings">
      <header class="conv-head">
        <button class="btn btn-icon d-lg-none" data-action="back" aria-label="${e('common.back')}">${icon('chevron-left')}</button>
        <h2 class="h6 mb-0">${e('client.meetings')}</h2>
        ${boot.perms.meetings ? `<button class="btn btn-primary btn-sm ms-auto" data-action="new-meeting">${icon('plus')} ${e('client.newMeeting')}</button>` : ''}
      </header>
      <div class="view-body" id="meetings-body"></div>
    </section>

    <section class="view view-search" id="view-search">
      <header class="conv-head">
        <button class="btn btn-icon" data-action="close-search" aria-label="${e('common.back')}">${icon('chevron-left')}</button>
        <h2 class="h6 mb-0">${e('client.searchResults')}</h2>
      </header>
      <div class="view-body">
        <form class="row g-2 mb-3" id="search-filters">
          <div class="col-md-4"><input class="form-control form-control-sm" name="q" placeholder="${e('client.searchPlaceholder')}"></div>
          <div class="col-md-3"><select class="form-select form-select-sm" name="conversation"><option value="">${e('client.allConversations')}</option></select></div>
          <div class="col-md-2"><select class="form-select form-select-sm" name="author"><option value="">${e('client.anyAuthor')}</option></select></div>
          <div class="col-md-3 d-flex gap-1"><input class="form-control form-control-sm" type="date" name="from" aria-label="${e('client.from')}"><input class="form-control form-control-sm" type="date" name="to" aria-label="${e('client.to')}"></div>
        </form>
        <div id="search-results"></div>
      </div>
    </section>
  </main>

  <aside class="panel" id="panel" hidden>
    <header class="panel-head">
      <h3 class="h6 mb-0" id="panel-title"></h3>
      <button class="btn btn-icon ms-auto" data-action="close-panel" aria-label="${e('common.close')}">${icon('x')}</button>
    </header>
    <div class="panel-body" id="panel-body"></div>
    <div class="composer-wrap" id="composer-thread"></div>
  </aside>
</div>

<div class="modal fade" id="modal" tabindex="-1" aria-hidden="true">
  <div class="modal-dialog modal-dialog-centered modal-dialog-scrollable">
    <div class="modal-content" id="modal-content"></div>
  </div>
</div>
<div class="toast-container position-fixed bottom-0 end-0 p-3" id="toasts"></div>`,
  });
}
