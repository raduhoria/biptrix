import { $, $$, EMOJI, api, debounce, esc, hue, icon, initials, randomId, renderMarkdown, toast, translator } from './lib.js';
import { enablePush, needsInstall, pushSupported, refreshPush } from './push.js';

// Chat client for /o/:org. State lives in plain Maps; the DOM is re-rendered
// per region (sidebar lists, message list, panel). Durable updates arrive as
// events with an event_id: the client keeps the highest one (cursor) and
// after a reconnect asks the server for everything after it (system.sync).
// Outgoing messages go to a local outbox (localStorage) with a
// client_message_id, so a send interrupted by a disconnect or a reload is
// retried and the server stores it exactly once.

const boot = JSON.parse($('#boot').textContent);
const t = translator(boot.strings);
const ME = boot.me.id;
const ORG = boot.org;
const API = `/api/o/${ORG.slug}`;
const OUTBOX_KEY = `outbox:${ORG.id}:${ME}`;
const INTL = { en: 'en-GB', ro: 'ro-RO', es: 'es-ES' }[boot.locale] || 'en-GB';
const dateFmt = new Intl.DateTimeFormat(INTL, { dateStyle: 'full' });
const timeFmt = new Intl.DateTimeFormat(INTL, { timeStyle: 'short' });
const shortFmt = new Intl.DateTimeFormat(INTL, { day: 'numeric', month: 'short' });

const state = {
  cursor: 0,
  conversations: new Map(),
  directory: new Map(),
  presence: {},
  messages: new Map(), // convId → { list: [], hasMore: true, loaded: false }
  threads: new Map(), // parentId → { parent, list: [] }
  threadLoad: null, // { parentId, arriving: [] } while a thread loads
  outbox: new Map(JSON.parse(localStorage.getItem(OUTBOX_KEY) || '[]')),
  typing: new Map(), // convId → Map<userId, expiresAt>
  reads: new Map(), // convId → Map<userId, seq>
  current: null,
  thread: null,
  panel: null,
  markerSeq: null, // "new messages" line: last read seq when the conversation was opened
  view: 'empty',
  staged: { main: [], thread: [] },
};

// ---------------------------------------------------------------- helpers

const person = (id) => state.directory.get(id) || { id, name: t('unknownUser'), email: '' };
const avatar = (id, size = '') => `<span class="avatar ${size}" style="--h:${hue(id)}">${esc(initials(person(id).name))}<span class="presence-dot ${state.presence[id] || 'offline'}"></span></span>`;
const replyLabel = (n) => t(n === 1 ? 'replyOne' : 'replies', { n });
// "extern · company.com" next to people from outside the organization.
const extBadge = (id) => {
  const p = person(id);
  return p.role === 'external' ? ` <span class="ext-badge" title="${esc(t('externalTitle'))}">${esc(t('external'))} · ${esc((p.email || '').split('@')[1] || '')}</span>` : '';
};
const mentionHtml = (id) => `<span class="mention${id === ME ? ' mention-me' : ''}" data-person="${esc(id)}" role="button" tabindex="0">@${esc(person(id).name)}</span>`;

function convName(c) {
  if (!c) return '';
  if (c.type === 'space') return c.name;
  if (c.name) return c.name;
  const others = (c.member_ids || []).filter((id) => id !== ME);
  if (!others.length) return `${person(ME).name} (${t('you')})`;
  return others.map((id) => person(id).name).join(', ');
}

function convIcon(c) {
  if (c.type === 'space') return `<span class="conv-ic space">${icon(c.visibility === 'private' ? 'lock' : 'hash')}</span>`;
  const others = (c.member_ids || []).filter((id) => id !== ME);
  if (c.type === 'dm') return avatar(others[0] || ME, 'avatar-sm');
  return `<span class="conv-ic group">${icon('users')}</span>`;
}

const saveOutbox = () => localStorage.setItem(OUTBOX_KEY, JSON.stringify([...state.outbox]));
const isVisible = () => document.visibilityState === 'visible' && document.hasFocus();
// Same as the server (core/chat.js): small Spaces ring and notify everything.
const SMALL_SPACE = 20;

function setUrl(path) {
  if (location.pathname !== path) history.pushState({}, '', path);
}

function errorText(err) {
  const key = `errors.${err.details?.reason || err.code}`;
  const text = t(key);
  return text === key ? err.message : text;
}

// ------------------------------------------------------------- websocket

const socket = (() => {
  let ws = null;
  let attempts = 0;
  let syncing = false;
  let buffered = [];
  const waiting = new Map();
  let seq = 0;

  function setConn(stateName) {
    const el = $('#conn-state');
    el.dataset.state = stateName;
    $('.conn-text', el).textContent = t(`conn.${stateName}`);
  }

  function connect() {
    setConn(attempts ? 'reconnecting' : 'connecting');
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?org=${encodeURIComponent(ORG.slug)}`);
    ws.onopen = () => {
      attempts = 0;
      syncing = true;
      buffered = [];
      send('system.sync', { since: state.cursor });
      send('presence.set', { status: localStorage.getItem('presence') || 'online' });
    };
    ws.onmessage = (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg.re && waiting.has(msg.re)) {
        waiting.get(msg.re)(msg);
        waiting.delete(msg.re);
      }
      if (msg.type === 'hello') reportVisible();
      if (msg.type === 'system.sync') return onSync(msg.data);
      if (msg.event_id && syncing) return buffered.push(msg);
      handle(msg);
    };
    ws.onclose = (e) => {
      ws = null;
      for (const resolve of waiting.values()) resolve(null);
      waiting.clear();
      if (e.code === 4001) {
        setConn('revoked');
        return setTimeout(() => location.reload(), 1500);
      }
      setConn('offline');
      const delay = Math.min(30_000, 500 * 2 ** attempts++) + Math.random() * 500;
      setTimeout(connect, delay);
    };
  }

  async function onSync(data) {
    if (data.reset) {
      await loadAll();
    } else {
      for (const ev of data.events) handle({ type: ev.type, event_id: ev.id, data: ev.data });
      state.cursor = Math.max(state.cursor, data.cursor || 0);
    }
    syncing = false;
    for (const msg of buffered) handle(msg);
    buffered = [];
    setConn('online');
    flushOutbox();
  }

  function send(type, data) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return null;
    const id = `c${++seq}`;
    ws.send(JSON.stringify({ v: 1, type, id, data }));
    return id;
  }

  // request: send and wait for the reply frame (re = id), null if offline.
  function request(type, data, timeoutMs = 15_000) {
    const id = send(type, data);
    if (!id) return Promise.resolve(null);
    return new Promise((resolve) => {
      waiting.set(id, resolve);
      setTimeout(() => {
        if (waiting.has(id)) {
          waiting.delete(id);
          resolve(null);
        }
      }, timeoutMs);
    });
  }

  return { connect, send, request, isOpen: () => ws?.readyState === WebSocket.OPEN && !syncing };
})();

// Every server frame. Durable events advance the cursor; duplicates (an
// event already seen through sync) are ignored.
function handle(msg) {
  if (msg.event_id) {
    if (msg.event_id <= state.cursor) return;
    state.cursor = msg.event_id;
  }
  const d = msg.data || {};
  switch (msg.type) {
    case 'message.created':
    case 'message.updated':
      return onMessage(d, msg.type === 'message.created');
    case 'conversation.created':
    case 'conversation.members':
    case 'conversation.updated':
      return refreshConversation(d.id);
    case 'conversation.removed':
      return dropConversation(d.id);
    case 'conversation.read':
      return onRead(d);
    case 'typing':
      return onTyping(d);
    case 'system.reset':
      return loadAll().catch(() => {});
    case 'presence':
      state.presence[d.user_id] = d.status;
      return renderPresence(d.user_id);
    case 'member.removed':
      // Removed from the organization or access expired: gone from People
      // and every picker at once.
      state.directory.delete(d.user_id);
      delete state.presence[d.user_id];
      return renderPresence(d.user_id);
    case 'call.ring':
      return onRing(d);
    case 'call.stop':
      return stopRinging(d.meeting_id);
    case 'announcements.changed':
      return refreshAnnouncements();
    default:
  }
}

// --------------------------------------------------------------- loading

async function loadAll() {
  const data = await api(`${API}/bootstrap`);
  state.cursor = Math.max(state.cursor, data.cursor);
  state.directory = new Map(data.directory.map((u) => [u.id, u]));
  state.directory.set(ME, { ...boot.me, ...(state.directory.get(ME) || {}) });
  state.presence = data.presence;
  state.conversations = new Map(data.conversations.map((c) => [c.id, c]));
  // Cached message pages may be stale after a reset: refetch on open.
  for (const cache of state.messages.values()) cache.stale = true;
  const live = $('#live-count');
  live.hidden = !data.meetings_live;
  live.textContent = data.meetings_live || '';
  state.announcements = data.announcements || [];
  renderAnnouncements();
  renderSidebar();
  if (state.current) {
    if (!state.conversations.has(state.current)) showEmpty();
    else await openConversation(state.current, { push: false });
  }
}

async function refreshConversation(id) {
  try {
    const { conversation } = await api(`${API}/conversations/${id}`);
    const old = state.conversations.get(id);
    state.conversations.set(id, old ? { ...conversation, unread: old.unread, mentions: old.mentions, last_message: old.last_message } : conversation);
    for (const uid of conversation.member_ids || []) if (!state.directory.has(uid)) await refreshDirectory();
    renderSidebar();
    if (state.current === id) renderHeader();
    if (state.panel === 'members' && state.current === id) openMembers();
  } catch (err) {
    if (err.code === 'not_found') dropConversation(id);
  }
}

const refreshDirectory = debounce(async () => {
  const data = await api(`${API}/bootstrap`);
  state.directory = new Map(data.directory.map((u) => [u.id, u]));
  renderSidebar();
}, 300);

function dropConversation(id) {
  state.conversations.delete(id);
  state.messages.delete(id);
  renderSidebar();
  if (state.current === id) {
    toast(t('removedFromConversation'), 'warning');
    showEmpty();
  }
}

// ---------------------------------------------------------------- sidebar

function renderSidebar() {
  const list = [...state.conversations.values()].sort((a, b) => (b.last_message_at || b.created_at).localeCompare(a.last_message_at || a.created_at));
  const item = (c) => {
    const unread = c.unread > 0 && c.id !== state.current;
    const lm = c.last_message;
    const preview = !lm ? '' : lm.kind === 'meeting' ? `📹 ${lm.body}` : lm.kind === 'call_missed' ? `📞 ${t(lm.author_id === ME ? 'callNoAnswer' : 'callMissed')}` : lm.body.replace(/<@([A-Za-z0-9_-]+)>/g, (m, id) => `@${person(id).name}`);
    return `<li><a class="conv-item${c.id === state.current ? ' active' : ''}${unread ? ' unread' : ''}" href="/o/${esc(ORG.slug)}/c/${esc(c.id)}" data-conv="${esc(c.id)}">
      ${convIcon(c)}
      <span class="conv-text"><span class="conv-name">${esc(convName(c))}</span>${preview ? `<span class="conv-preview">${esc(preview.slice(0, 80))}</span>` : ''}</span>
      ${c.notify === 'none' ? icon('bell-off', 'text-body-tertiary') : ''}
      ${unread ? `<span class="badge rounded-pill ${c.mentions ? 'text-bg-danger' : 'text-bg-primary'}">${c.mentions ? '@' : ''}${c.unread > 99 ? '99+' : c.unread}</span>` : ''}
    </a></li>`;
  };
  const direct = list.filter((c) => c.type !== 'space');
  const spaces = list.filter((c) => c.type === 'space');
  $('#list-direct').innerHTML = direct.map(item).join('') || `<li class="side-empty">${esc(t('noDirect'))}</li>`;
  $('#list-spaces').innerHTML = spaces.map(item).join('') || `<li class="side-empty">${esc(t('noSpaces'))}</li>`;
  renderOnlineCount();
  // Unread total on the installed app's icon.
  const unreadTotal = list.reduce((n, c) => n + (c.notify === 'none' ? 0 : c.unread || 0), 0);
  if (navigator.setAppBadge) (unreadTotal ? navigator.setAppBadge(unreadTotal) : navigator.clearAppBadge()).catch(() => {});
  const total = list.reduce((n, c) => n + (c.id === state.current && isVisible() ? 0 : c.unread || 0), 0);
  document.title = `${total ? `(${total}) ` : ''}${ORG.name}`;
}

// Re-render the places that show presence (cheap at this scale).
function renderPresence(userId) {
  renderSidebar();
  if (state.view === 'people') renderPeopleList();
  if (state.current) renderHeader();
  if (state.panel === 'members') openMembers();
  if (userId === ME) {
    $('#presence-btn .presence-dot').className = `presence-dot ${state.presence[ME] || 'online'}`;
  }
}

// ----------------------------------------------------------- conversation

function cacheFor(id) {
  if (!state.messages.has(id)) state.messages.set(id, { list: [], hasMore: true, loaded: false });
  return state.messages.get(id);
}

function showView(name) {
  state.view = name;
  for (const v of $$('.view')) v.classList.toggle('active', v.id === `view-${name}`);
  $('#app').dataset.view = name;
}

function showEmpty() {
  state.current = null;
  closePanel();
  showView('empty');
  setUrl(`/o/${ORG.slug}`);
  renderSidebar();
}

async function openConversation(id, { push = true } = {}) {
  const c = state.conversations.get(id);
  if (!c) return showEmpty();
  if (state.current !== id) {
    closePanel();
    state.staged.main = [];
    state.markerSeq = c.unread ? c.last_read_seq : null;
  }
  state.current = id;
  showView('conv');
  if (push) setUrl(`/o/${ORG.slug}/c/${id}`);
  renderHeader();
  renderComposer('main');
  const cache = cacheFor(id);
  if (!cache.loaded || cache.stale) {
    if (cache.load) cache.load.superseded = true;
    $('#msg-list').innerHTML = `<div class="msg-loading"><div class="spinner-border spinner-border-sm"></div></div>`;
    // Live messages arriving while the page loads are kept and merged into
    // it, so the response cannot overwrite them. Only the newest load is
    // installed: an older, overlapping one is dropped when it answers.
    const load = (cache.load = { arriving: [] });
    const data = await api(`${API}/conversations/${id}/messages?limit=50`).finally(() => {
      if (cache.load === load) cache.load = null;
    });
    if (load.superseded || cache.load || state.current !== id) return;
    cache.list = data.messages;
    const oldest = data.has_more ? data.messages[0]?.seq ?? Infinity : -Infinity;
    for (const m of load.arriving) if (m.seq >= oldest) upsert(cache.list, m);
    cache.hasMore = data.has_more;
    cache.loaded = true;
    cache.stale = false;
  }
  renderMessages({ scroll: 'bottom' });
  renderSidebar();
  markRead();
  $('#composer-main textarea')?.focus();
}

function renderHeader() {
  const c = state.conversations.get(state.current);
  if (!c) return;
  $('#conv-name').innerHTML = `${c.type === 'space' ? icon(c.visibility === 'private' ? 'lock' : 'hash') : ''} ${esc(convName(c))}`;
  let sub = '';
  if (c.type === 'dm') {
    const other = (c.member_ids || []).find((uid) => uid !== ME);
    sub = other ? `${t(`status.${state.presence[other] || 'offline'}`)}${person(other).title ? ` · ${person(other).title}` : ''}` : '';
  } else {
    sub = `${t('memberCount', { n: c.member_count })}${c.description ? ` · ${c.description}` : ''}`;
  }
  $('#conv-sub').textContent = sub;
  // Spaces with people from other companies say so, for everyone inside.
  const banner = $('#ext-banner');
  if (boot.role === 'external') {
    banner.hidden = false;
    banner.innerHTML = `${icon('globe')} ${esc(t('youAreExternal', { org: ORG.name }))}`;
  } else {
    banner.hidden = !(c.external_count > 0);
    banner.innerHTML = c.external_count > 0 ? `${icon('globe')} ${esc(t(c.external_count === 1 ? 'externalBannerOne' : 'externalBanner', { n: c.external_count }))}` : '';
  }
  const canEdit = c.type === 'space' && (c.my_role === 'moderator' || ['owner', 'admin'].includes(boot.role));
  $('#conv-menu').innerHTML = [
    // On phones, pinned and members live here (the header keeps the calls).
    `<li class="d-sm-none"><button class="dropdown-item" data-action="pinned">${icon('pin')} ${esc(t('pinned'))}</button></li>`,
    `<li class="d-sm-none"><button class="dropdown-item" data-action="members">${icon('users')} ${esc(t('members'))}</button></li>`,
    c.type === 'space' ? `<li><button class="dropdown-item" data-action="space-settings">${icon('settings')} ${esc(t(canEdit ? 'spaceSettings' : 'spaceAbout'))}</button></li>` : '',
    `<li><hr class="dropdown-divider"></li><li><h6 class="dropdown-header">${esc(t('notifyTitle'))}</h6></li>`,
    ...(c.type === 'dm' ? ['all', 'none'] : ['all', 'mentions', 'none']).map(
      (level) => `<li><button class="dropdown-item d-flex align-items-center gap-2" data-action="notify" data-level="${level}">${icon(c.notify === level ? 'check' : level === 'none' ? 'bell-off' : 'bell', c.notify === level ? '' : 'opacity-50')} ${esc(t(`notify.${level}`))}</button></li>`
    ),
    `<li><hr class="dropdown-divider"></li>`,
    `<li><button class="dropdown-item" data-action="search-here">${icon('search')} ${esc(t('searchHere'))}</button></li>`,
    c.type !== 'dm' ? `<li><hr class="dropdown-divider"></li><li><button class="dropdown-item text-danger" data-action="leave">${icon('door')} ${esc(t('leave'))}</button></li>` : '',
  ].join('');
  for (const btn of $$('[data-action="call"]')) btn.hidden = !boot.perms.calls;
}

const SAME_AUTHOR_MS = 5 * 60_000;

function messageHtml(m, prev, { thread = false } = {}) {
  const author = person(m.author_id);
  const grouped = prev && prev.author_id === m.author_id && prev.kind === m.kind && m.kind === 'text' && Date.parse(m.created_at) - Date.parse(prev.created_at) < SAME_AUTHOR_MS && !prev.deleted_at;
  const time = timeFmt.format(new Date(m.created_at));
  const pending = m._pending;
  let body;
  if (m.deleted_at) body = `<div class="msg-deleted">${esc(t('messageDeleted'))}</div>`;
  else if (m.kind === 'meeting') body = meetingCard(m);
  else if (m.kind === 'call_missed') body = missedCallHtml(m);
  else body = `<div class="msg-body">${renderMarkdown(m.body, { mention: mentionHtml })}${m.edited_at ? ` <span class="msg-edited">(${esc(t('edited'))})</span>` : ''}</div>`;
  const files = !m.deleted_at && m.attachments?.length ? `<div class="msg-files">${m.attachments.map(fileHtml).join('')}</div>` : '';
  const reactions = groupReactions(m.reactions || []);
  const reactHtml = reactions.length
    ? `<div class="msg-reactions">${reactions.map((r) => `<button class="reaction${r.mine ? ' mine' : ''}" data-react="${esc(r.emoji)}" title="${esc(r.users.map((u) => person(u).name).join(', '))}">${esc(r.emoji)} <span>${r.users.length}</span></button>`).join('')}</div>`
    : '';
  const replies = !thread && m.reply_count ? `<button class="msg-thread-link" data-action="thread">${icon('reply')} ${esc(replyLabel(m.reply_count))}</button>` : '';
  const actions =
    pending || m.deleted_at
      ? ''
      : `<div class="msg-actions btn-group shadow-sm">
          ${EMOJI.slice(0, 3).map((e) => `<button class="btn btn-sm" data-react="${e}" title="${e}">${e}</button>`).join('')}
          <button class="btn btn-sm" data-action="emoji" title="${esc(t('react'))}">${icon('smile')}</button>
          ${!thread && !m.parent_id ? `<button class="btn btn-sm" data-action="thread" title="${esc(t('replyThread'))}">${icon('reply')}</button>` : ''}
          ${m.author_id === ME && m.kind === 'text' ? `<button class="btn btn-sm" data-action="edit" title="${esc(t('edit'))}">${icon('edit')}</button>` : ''}
          <button class="btn btn-sm" data-action="pin" title="${esc(t(m.pinned_at ? 'unpin' : 'pin'))}">${icon('pin')}</button>
          ${m.author_id === ME || canModerate() ? `<button class="btn btn-sm" data-action="delete" title="${esc(t('delete'))}">${icon('trash')}</button>` : ''}
        </div>`;
  const status = pending ? `<span class="msg-status ${m._failed ? 'failed' : ''}">${m._failed ? `${icon('alert')} ${esc(t('sendFailed'))} <button class="btn btn-link btn-sm p-0" data-action="retry">${esc(t('retry'))}</button>` : icon('clock')}</span>` : '';
  return `<div class="msg${grouped ? ' grouped' : ''}${pending ? ' pending' : ''}${m.pinned_at ? ' pinned' : ''}${m.author_id === ME ? ' mine' : ''}" data-id="${esc(m.id)}" data-cid="${esc(m.client_message_id)}" data-seq="${m.seq || ''}">
    <div class="msg-gutter">${grouped ? `<span class="msg-time-hover">${esc(time)}</span>` : `<button class="person-link" data-person="${esc(m.author_id)}" aria-label="${esc(author.name)}">${avatar(m.author_id)}</button>`}</div>
    <div class="msg-main">
      ${grouped ? '' : `<div class="msg-head"><button class="person-link person-name" data-person="${esc(m.author_id)}">${esc(author.name)}</button>${extBadge(m.author_id)}<span class="msg-time" title="${esc(new Date(m.created_at).toLocaleString())}">${esc(time)}</span>${m.pinned_at ? `<span class="msg-pin">${icon('pin')}</span>` : ''}</div>`}
      ${body}${files}${reactHtml}${replies}${status}
    </div>
    ${actions}
  </div>`;
}

// "m:ss" or "h:mm:ss".
function fmtDuration(s) {
  const h = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
}

// A call card offers "Join" only while the call is on; afterwards it says
// how it ended (the server updates the card when the meeting closes).
function meetingCard(m) {
  const meta = m.meta || {};
  const call = meta.call ? `?call=${encodeURIComponent(meta.call)}` : '';
  const over = meta.state === 'ended' || meta.state === 'canceled';
  const started = t(meta.call === 'audio' ? 'audioCallStarted' : 'meetingStarted', { name: person(m.author_id).name });
  const status = over ? callOutcome(m, meta) : started;
  return `<div class="meeting-card card${over ? ' ended' : ''}">
    <div class="card-body d-flex align-items-center gap-3">
      <span class="meeting-ic">${icon(over ? 'phone-off' : meta.call === 'audio' ? 'phone' : 'video')}</span>
      <div class="flex-grow-1 min-w-0"><div class="fw-semibold text-truncate">${esc(meta.title || m.body)}</div>
        <div class="small text-body-secondary">${esc(status)}</div></div>
      ${over ? '' : `<a class="btn btn-success btn-sm" href="/o/${esc(ORG.slug)}/meet/${esc(meta.meeting_id)}${call}" target="_blank" rel="noopener">${esc(t('joinCall'))}</a>`}
    </div>
  </div>`;
}

// Seen by the caller (the author): "no answer", nothing to click. Seen by
// the people who were called: "missed call from X" and "call back".
function missedCallHtml(m) {
  const kind = m.meta?.kind === 'audio' ? 'audio' : 'video';
  if (m.author_id === ME) {
    const c = state.conversations.get(m.conversation_id);
    return `<div class="msg-call">${icon('phone-off')} ${esc(t(c?.type === 'dm' ? 'callNoAnswer' : 'callNobodyAnswered'))}</div>`;
  }
  const back = boot.perms.calls ? ` <button class="btn btn-sm btn-link p-0" data-action="call" data-kind="${kind}">${esc(t('callBack'))}</button>` : '';
  return `<div class="msg-call">${icon('phone-off')} ${esc(t('callMissedFrom', { name: person(m.author_id).name }))}${back}</div>`;
}

// How an ended call reads, from where the viewer stood (caller or called).
function callOutcome(m, meta) {
  const caller = m.author_id === ME;
  if (meta.state === 'canceled') return t('callCanceled');
  if (meta.outcome === 'missed') return t(caller ? 'callNoAnswer' : 'callMissed');
  if (meta.outcome === 'declined') return t(caller ? 'callDeclinedShort' : 'callYouDeclined');
  return meta.duration_s ? t('callEndedAfter', { duration: fmtDuration(meta.duration_s) }) : t('callEnded');
}

// ------------------------------------------------------------ incoming call
// `call.ring` (a user-scoped durable event) opens the incoming-call screen
// in every tab, with a ring tone, until the caller's deadline, an answer
// here or on another device (`call.stop`), or a decline.

const ringing = { call: null, timer: null, audio: null, notification: null };

function onRing(d) {
  const left = Date.parse(d.ring_until) - Date.now();
  if (left <= 0 || ringing.call?.meeting_id === d.meeting_id) return;
  stopRinging();
  ringing.call = d;
  const name = person(d.from).name || d.from_name;
  const box = document.createElement('div');
  box.className = 'incoming-call';
  box.id = 'incoming-call';
  box.innerHTML = `<div class="incoming-card" role="dialog" aria-live="assertive">
    <span class="avatar" style="--h:${hue(d.from)}">${esc(initials(name))}</span>
    <div class="fs-5 fw-semibold text-truncate">${esc(name)}</div>
    <div class="small opacity-75">${esc(t(d.kind === 'audio' ? 'incomingAudio' : 'incomingVideo'))}</div>
    <div class="incoming-actions">
      <div><button class="btn btn-danger" data-ring="decline" aria-label="${esc(t('callDecline'))}">${icon('phone-off')}</button><small>${esc(t('callDecline'))}</small></div>
      <div><button class="btn btn-success" data-ring="accept" aria-label="${esc(t('callAccept'))}">${icon(d.kind === 'audio' ? 'phone' : 'video')}</button><small>${esc(t('callAccept'))}</small></div>
    </div></div>`;
  document.body.append(box);
  ringing.timer = setTimeout(stopRinging, left);
  ringing.audio = ringTone();
  navigator.vibrate?.([400, 200, 400]);
  if (!state.pushActive && 'Notification' in window && Notification.permission === 'granted' && !isVisible()) {
    ringing.notification = new Notification(t('callIncoming', { name }), { body: t(d.kind === 'audio' ? 'incomingAudio' : 'incomingVideo'), tag: `call-${d.meeting_id}`, icon: '/favicon.svg', requireInteraction: true });
    ringing.notification.onclick = () => window.focus();
  }
}

function stopRinging(meetingId = null) {
  if (!ringing.call || (meetingId && ringing.call.meeting_id !== meetingId)) return;
  clearTimeout(ringing.timer);
  ringing.audio?.stop();
  ringing.notification?.close();
  $('#incoming-call')?.remove();
  Object.assign(ringing, { call: null, timer: null, audio: null, notification: null });
}

// A two-tone ring made with WebAudio (no sound file): 1 s on, 2 s off.
function ringTone() {
  try {
    const ctx = new AudioContext();
    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.connect(ctx.destination);
    for (const f of [440, 480]) {
      const osc = ctx.createOscillator();
      osc.frequency.value = f;
      osc.connect(gain);
      osc.start();
    }
    const beat = () => {
      const now = ctx.currentTime;
      gain.gain.setValueAtTime(0.08, now);
      gain.gain.setValueAtTime(0, now + 1);
    };
    beat();
    const loop = setInterval(beat, 3000);
    return { stop: () => (clearInterval(loop), ctx.close().catch(() => {})) };
  } catch {
    return null;
  }
}

// The meeting tab is opened right away (still inside the click, so it is
// not blocked as a pop-up) and pointed at the room once the server answered.
function openCallTab() {
  const w = window.open('about:blank', '_blank');
  if (w) w.opener = null;
  return w;
}

async function answerCall(answer) {
  const d = ringing.call;
  if (!d) return;
  const w = answer === 'accept' ? openCallTab() : null;
  stopRinging();
  api(`${API}/meetings/${d.meeting_id}/ring`, { method: 'POST', body: { answer } }).catch(() => {});
  if (w) w.location = `/o/${ORG.slug}/meet/${d.meeting_id}?call=${d.kind}`;
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-ring]');
  if (btn) answerCall(btn.dataset.ring);
});

function fileHtml(f) {
  const url = `${API}/files/${encodeURIComponent(f.id)}`;
  if (/^image\//.test(f.mime)) return `<a class="msg-image" href="${url}" target="_blank" rel="noopener"><img src="${url}" alt="${esc(f.name)}" loading="lazy"></a>`;
  return `<a class="file-chip" href="${url}?download=1">${icon('file')}<span class="text-truncate">${esc(f.name)}</span><small>${fmtSize(f.size)}</small>${icon('download')}</a>`;
}

const fmtSize = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

function groupReactions(list) {
  const map = new Map();
  for (const r of list) {
    if (!map.has(r.emoji)) map.set(r.emoji, { emoji: r.emoji, users: [], mine: false });
    const g = map.get(r.emoji);
    g.users.push(r.user_id);
    if (r.user_id === ME) g.mine = true;
  }
  return [...map.values()];
}

function canModerate() {
  const c = state.conversations.get(state.current);
  return c?.type === 'space' && (c.my_role === 'moderator' || ['owner', 'admin'].includes(boot.role));
}

// Messages of the current conversation: confirmed ones by seq, then the
// local outbox entries still waiting for their ACK.
function visibleMessages() {
  const cache = cacheFor(state.current);
  const pending = [...state.outbox.values()].filter((p) => p.conversation_id === state.current && !p.parent_id).map(pendingAsMessage);
  return [...cache.list, ...pending];
}

function pendingAsMessage(p) {
  return {
    id: `pending-${p.client_message_id}`,
    client_message_id: p.client_message_id,
    author_id: ME,
    kind: 'text',
    body: p.body,
    created_at: p.created_at,
    attachments: p.attachments || [],
    reactions: [],
    parent_id: p.parent_id,
    _pending: true,
    _failed: p.failed,
  };
}

function renderMessages({ scroll } = {}) {
  const box = $('#msg-scroll');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  const prevHeight = box.scrollHeight;
  const prevTop = box.scrollTop;
  const list = visibleMessages();
  const cache = cacheFor(state.current);
  const c = state.conversations.get(state.current);
  let html = '';
  let prev = null;
  let lastDay = '';
  let markerShown = false;
  for (const m of list) {
    const day = dateFmt.format(new Date(m.created_at));
    if (day !== lastDay) {
      html += `<div class="day-sep"><span>${esc(day)}</span></div>`;
      lastDay = day;
      prev = null;
    }
    if (!markerShown && state.markerSeq !== null && m.seq > state.markerSeq && m.author_id !== ME) {
      html += `<div class="new-sep"><span>${esc(t('newMessages'))}</span></div>`;
      markerShown = true;
    }
    html += messageHtml(m, prev);
    prev = m;
  }
  $('#msg-top').innerHTML = cache.hasMore ? `<button class="btn btn-sm btn-outline-secondary" data-action="older">${esc(t('loadOlder'))}</button>` : `<div class="conv-start">${convIcon(c || {})}<div><strong>${esc(convName(c))}</strong><div class="small text-body-secondary">${esc(t('conversationStart'))}</div></div></div>`;
  $('#msg-list').innerHTML = html || `<div class="msg-empty text-body-secondary">${esc(t('noMessages'))}</div>`;
  renderReadReceipt();
  if (scroll === 'bottom' || (scroll !== 'keep' && nearBottom)) box.scrollTop = box.scrollHeight;
  else if (scroll === 'keep') box.scrollTop = prevTop + (box.scrollHeight - prevHeight);
}

// "Seen" under my last message in a DM.
function renderReadReceipt() {
  const c = state.conversations.get(state.current);
  if (c?.type !== 'dm') return;
  const other = (c.member_ids || []).find((id) => id !== ME);
  const seen = state.reads.get(c.id)?.get(other) || 0;
  const mine = cacheFor(c.id).list.filter((m) => m.author_id === ME && !m.parent_id);
  const last = mine.at(-1);
  if (!last || !seen || seen < last.seq) return;
  const el = $(`.msg[data-id="${CSS.escape(last.id)}"] .msg-main`);
  if (el) el.insertAdjacentHTML('beforeend', `<span class="msg-seen">${icon('check2')} ${esc(t('seen'))}</span>`);
}

async function loadOlder() {
  const cache = cacheFor(state.current);
  const first = cache.list[0];
  if (!first) return;
  const id = state.current;
  const data = await api(`${API}/conversations/${id}/messages?before=${first.seq}&limit=50`);
  if (state.current !== id) return;
  cache.list = [...data.messages, ...cache.list];
  cache.hasMore = data.has_more;
  renderMessages({ scroll: 'keep' });
}

function upsert(list, m) {
  const i = list.findIndex((x) => x.id === m.id);
  if (i >= 0) {
    if ((list[i].version || 0) <= m.version) list[i] = m;
    return;
  }
  let j = list.length;
  while (j > 0 && list[j - 1].seq > m.seq) j--;
  list.splice(j, 0, m);
}

function onMessage(m, created) {
  // My own message confirmed (possibly from another tab): drop the outbox copy.
  if (m.author_id === ME && state.outbox.has(m.client_message_id)) {
    state.outbox.delete(m.client_message_id);
    saveOutbox();
  }
  const c = state.conversations.get(m.conversation_id);
  if (!c) return refreshConversation(m.conversation_id);
  // A thread being loaded keeps its replies and parent updates for later.
  if (state.threadLoad && (m.parent_id || m.id) === state.threadLoad.parentId) state.threadLoad.arriving.push(m);
  if (m.parent_id) {
    const th = state.threads.get(m.parent_id);
    if (th) upsert(th.list, m);
    if (state.thread === m.parent_id) renderThread();
  } else {
    const cache = state.messages.get(m.conversation_id);
    if (cache?.load) cache.load.arriving.push(m);
    else if (cache?.loaded) upsert(cache.list, m);
  }
  // The thread may still be loading (no cache entry yet): openThread
  // fetches the current parent itself.
  const loadedThread = state.threads.get(m.id);
  if (state.thread === m.id && loadedThread) {
    loadedThread.parent = m;
    renderThread();
  }
  if (created) {
    c.last_seq = Math.max(c.last_seq, m.seq);
    c.last_message_at = m.created_at;
    c.last_message = { author_id: m.author_id, body: m.body, kind: m.kind, created_at: m.created_at };
    const viewing = state.current === m.conversation_id && state.view === 'conv' && isVisible();
    if (m.author_id !== ME && !viewing) {
      c.unread = (c.unread || 0) + 1;
      const mentioned = m.body.includes(`<@${ME}>`);
      if (mentioned) c.mentions = (c.mentions || 0) + 1;
      // (A call that rings has its own screen, see onRing.)
      const rings = m.kind === 'meeting' && m.meta?.call && (c.type === 'dm' || c.member_count <= SMALL_SPACE) && c.notify !== 'none';
      if (c.notify !== 'none' && !rings && (mentioned || c.notify === 'all' || m.kind === 'meeting')) notify(c, m);
    }
  }
  renderSidebar();
  if (state.current === m.conversation_id && !m.parent_id) {
    renderMessages();
    if (created) markRead();
  }
}

function onRead(d) {
  const c = state.conversations.get(d.id);
  if (!c) return;
  if (d.user_id === ME) {
    c.last_read_seq = Math.max(c.last_read_seq || 0, d.seq);
    if (c.last_read_seq >= c.last_seq) {
      c.unread = 0;
      c.mentions = 0;
    }
    return renderSidebar();
  }
  if (!state.reads.has(d.id)) state.reads.set(d.id, new Map());
  state.reads.get(d.id).set(d.user_id, d.seq);
  if (state.current === d.id) renderMessages({ scroll: 'none' });
}

// Read state is sent when the conversation is on screen, focused, and the
// newest message has been reached.
const markRead = debounce(() => {
  const c = state.conversations.get(state.current);
  if (!c || state.view !== 'conv' || !isVisible()) return;
  const box = $('#msg-scroll');
  if (box.scrollHeight - box.scrollTop - box.clientHeight > 120) return;
  if ((c.last_read_seq || 0) >= c.last_seq && !c.unread) return;
  c.unread = 0;
  c.mentions = 0;
  c.last_read_seq = c.last_seq;
  socket.send('conversation.read', { conversation_id: c.id, seq: c.last_seq }) || api(`${API}/conversations/${c.id}/read`, { method: 'POST', body: { seq: c.last_seq } }).catch(() => {});
  renderSidebar();
}, 400);

// ------------------------------------------------------------ notifications

function notify(c, m) {
  // With push on this device, the service worker shows it (no duplicate).
  if (state.pushActive || !('Notification' in window) || Notification.permission !== 'granted' || isVisible()) return;
  const n = new Notification(m.kind === 'meeting' ? t('callIncoming', { name: person(m.author_id).name }) : `${person(m.author_id).name} · ${convName(c)}`, {
    body: m.kind === 'meeting' ? m.body : m.body.replace(/<@([A-Za-z0-9_-]+)>/g, (x, id) => `@${person(id).name}`).slice(0, 140),
    tag: c.id,
    icon: '/favicon.svg',
  });
  n.onclick = () => {
    window.focus();
    openConversation(c.id);
    n.close();
  };
}

function askNotifications() {
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
}

// ------------------------------------------------------------------ typing

function onTyping(d) {
  if (d.user_id === ME) return;
  if (!state.typing.has(d.conversation_id)) state.typing.set(d.conversation_id, new Map());
  state.typing.get(d.conversation_id).set(d.user_id, Date.now() + 6000);
  renderTyping();
}

function renderTyping() {
  const map = state.typing.get(state.current);
  const now = Date.now();
  const names = map ? [...map].filter(([, until]) => until > now).map(([id]) => person(id).name) : [];
  $('#typing').innerHTML = names.length ? `<span class="typing-dots"><i></i><i></i><i></i></span> ${esc(names.length > 2 ? t('typingMany') : t('typing', { names: names.join(', ') }))}` : '';
}
setInterval(renderTyping, 2000);

let lastTyping = 0;
function sendTyping(parentId = null) {
  if (Date.now() - lastTyping < 3000) return;
  lastTyping = Date.now();
  socket.send('typing', { conversation_id: state.current, parent_id: parentId });
}

// ------------------------------------------------------------------ sending

function queueMessage({ conversationId, body, parentId = null, attachments = [] }) {
  const entry = { client_message_id: randomId(), conversation_id: conversationId, body, parent_id: parentId, attachments, created_at: new Date().toISOString(), failed: false };
  state.outbox.set(entry.client_message_id, entry);
  saveOutbox();
  deliver(entry);
  if (parentId) renderThread();
  else renderMessages({ scroll: 'bottom' });
}

// One outbox entry: WebSocket when connected, HTTP otherwise. Both are
// idempotent on client_message_id, so retries never duplicate.
async function deliver(entry) {
  entry.failed = false;
  let result = null;
  if (socket.isOpen()) {
    const reply = await socket.request('message.send', {
      conversation_id: entry.conversation_id,
      client_message_id: entry.client_message_id,
      body: entry.body,
      parent_id: entry.parent_id,
      attachment_ids: entry.attachments.map((a) => a.id),
    });
    result = reply?.data || null;
  } else {
    try {
      const data = await api(`${API}/conversations/${entry.conversation_id}/messages`, {
        method: 'POST',
        body: { client_message_id: entry.client_message_id, body: entry.body, parent_id: entry.parent_id, attachment_ids: entry.attachments.map((a) => a.id) },
      });
      result = { status: 'persisted', message: data.message };
    } catch (err) {
      result = err.status && err.status < 500 ? { status: 'failed', error: { code: err.code, message: err.message, details: err.details } } : null;
    }
  }
  if (!state.outbox.has(entry.client_message_id)) return;
  if (result?.status === 'persisted') {
    state.outbox.delete(entry.client_message_id);
    saveOutbox();
    onMessage(result.message, !result.duplicate);
    return;
  }
  // Rejected by the server (validation, permission): keep it, marked failed.
  // No answer (offline): it stays queued and is retried after reconnect.
  if (result?.status === 'failed') {
    entry.failed = true;
    toast(errorText(result.error), 'danger');
  }
  saveOutbox();
  if (entry.parent_id) renderThread();
  else if (state.current === entry.conversation_id) renderMessages();
}

function flushOutbox() {
  for (const entry of state.outbox.values()) if (!entry.failed) deliver(entry);
}

// ----------------------------------------------------------------- composer

function renderComposer(where) {
  const host = $(where === 'main' ? '#composer-main' : '#composer-thread');
  const c = state.conversations.get(state.current);
  const placeholder = where === 'thread' ? t('replyPlaceholder') : t('messagePlaceholder', { name: convName(c) });
  host.innerHTML = `<form class="composer" data-where="${where}">
    <div class="staged" data-staged></div>
    <div class="composer-box">
      <textarea rows="1" placeholder="${esc(placeholder)}" aria-label="${esc(placeholder)}" maxlength="10000"></textarea>
      <div class="composer-tools">
        <label class="btn btn-icon" title="${esc(t('attach'))}">${icon('paperclip')}<input type="file" multiple hidden data-file></label>
        <button class="btn btn-icon" type="button" data-action="emoji-insert" title="${esc(t('emoji'))}">${icon('smile')}</button>
        <button class="btn btn-icon" type="button" data-action="mention-insert" title="${esc(t('mention'))}">@</button>
        <span class="composer-hint d-none d-md-inline">${esc(t('composerHint'))}</span>
        <button class="btn btn-primary btn-send ms-auto" type="submit" title="${esc(t('send'))}">${icon('send')}</button>
      </div>
    </div>
    <div class="mention-pop list-group shadow" hidden></div>
  </form>`;
  renderStaged(where);
}

function renderStaged(where) {
  const host = $(`${where === 'main' ? '#composer-main' : '#composer-thread'} [data-staged]`);
  if (!host) return;
  host.innerHTML = state.staged[where]
    .map((f, i) => `<span class="file-chip staged-chip${f.uploading ? ' uploading' : ''}">${icon('file')}<span class="text-truncate">${esc(f.name)}</span>${f.uploading ? `<span class="spinner-border spinner-border-sm"></span>` : `<small>${fmtSize(f.size)}</small>`}<button type="button" class="btn-close btn-sm" data-unstage="${i}" aria-label="${esc(t('remove'))}"></button></span>`)
    .join('');
}

function uploadFile(file, where) {
  const max = boot.maxUploadMb * 1048576;
  if (file.size > max) return toast(t('fileTooLarge', { name: file.name, max: boot.maxUploadMb }), 'danger');
  const entry = { name: file.name, size: file.size, uploading: true };
  state.staged[where].push(entry);
  renderStaged(where);
  const xhr = new XMLHttpRequest();
  xhr.open('POST', `${API}/files`);
  xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name));
  xhr.onload = () => {
    let data = null;
    try {
      data = JSON.parse(xhr.responseText);
    } catch {
      data = null;
    }
    if (xhr.status === 200 && data?.file) Object.assign(entry, data.file, { uploading: false });
    else {
      state.staged[where] = state.staged[where].filter((f) => f !== entry);
      toast(data?.error ? errorText(data.error) : t('uploadFailed'), 'danger');
    }
    renderStaged(where);
  };
  xhr.onerror = () => {
    state.staged[where] = state.staged[where].filter((f) => f !== entry);
    renderStaged(where);
    toast(t('uploadFailed'), 'danger');
  };
  xhr.send(file);
}

function submitComposer(form) {
  const where = form.dataset.where;
  const ta = $('textarea', form);
  const body = ta.value.trim();
  if (state.staged[where].some((f) => f.uploading)) return toast(t('waitUpload'), 'warning');
  const attachments = state.staged[where].map(({ id, name, mime, size }) => ({ id, name, mime, size }));
  if (!body && !attachments.length) return;
  queueMessage({ conversationId: state.current, body: encodeMentions(body), parentId: where === 'thread' ? state.thread : null, attachments });
  ta.value = '';
  autosize(ta);
  state.staged[where] = [];
  renderStaged(where);
}

// "@Name" chosen from the picker is stored as <@id>.
const mentionMap = new Map();
function encodeMentions(text) {
  let out = text;
  for (const [label, id] of mentionMap) out = out.split(label).join(`<@${id}>`);
  return out;
}

function autosize(ta) {
  ta.style.height = 'auto';
  ta.style.height = `${Math.min(ta.scrollHeight, 220)}px`;
}

function mentionCandidates(query) {
  const c = state.conversations.get(state.current);
  const ids = c?.type === 'space' ? [...state.directory.keys()] : c?.member_ids || [];
  const q = query.toLowerCase();
  return ids
    .filter((id) => id !== ME)
    .map(person)
    .filter((p) => p.name.toLowerCase().includes(q) || p.email?.toLowerCase().includes(q))
    .slice(0, 6);
}

function updateMentionPop(form) {
  const ta = $('textarea', form);
  const pop = $('.mention-pop', form);
  const before = ta.value.slice(0, ta.selectionStart);
  const match = before.match(/(?:^|\s)@([\p{L}\p{N}._-]{0,30})$/u);
  if (!match) {
    pop.hidden = true;
    return;
  }
  const list = mentionCandidates(match[1]);
  if (!list.length) {
    pop.hidden = true;
    return;
  }
  pop.hidden = false;
  pop.innerHTML = list.map((p, i) => `<button type="button" class="list-group-item list-group-item-action d-flex align-items-center gap-2${i === 0 ? ' active' : ''}" data-mention="${esc(p.id)}">${avatar(p.id, 'avatar-sm')} ${esc(p.name)} <small class="text-body-secondary ms-auto">${esc(p.email || '')}</small></button>`).join('');
}

function insertMention(form, id) {
  const ta = $('textarea', form);
  const p = person(id);
  const label = `@${p.name}`;
  mentionMap.set(label, id);
  const before = ta.value.slice(0, ta.selectionStart).replace(/@([\p{L}\p{N}._-]{0,30})$/u, `${label} `);
  ta.value = before + ta.value.slice(ta.selectionStart);
  ta.selectionStart = ta.selectionEnd = before.length;
  $('.mention-pop', form).hidden = true;
  ta.focus();
}

// --------------------------------------------------------- message actions

function findMessage(id) {
  for (const cache of state.messages.values()) {
    const m = cache.list.find((x) => x.id === id);
    if (m) return m;
  }
  for (const th of state.threads.values()) {
    if (th.parent?.id === id) return th.parent;
    const m = th.list.find((x) => x.id === id);
    if (m) return m;
  }
  return null;
}

async function messageAction(action, el, value) {
  const id = el.closest('.msg')?.dataset.id;
  const m = id && findMessage(id);
  const base = m ? `${API}/conversations/${m.conversation_id}/messages/${m.id}` : '';
  try {
    if (action === 'react') return await api(`${base}/react`, { method: 'POST', body: { emoji: value } });
    if (action === 'thread') return openThread(m.id);
    if (action === 'pin') return await api(`${base}/pin`, { method: 'POST', body: { pinned: !m.pinned_at } });
    if (action === 'delete') {
      if (!(await confirmBox(t('deleteConfirm')))) return;
      return await api(`${base}/delete`, { method: 'POST', body: {} });
    }
    if (action === 'edit') return startEdit(el.closest('.msg'), m);
    if (action === 'emoji') return emojiPicker(el, (emoji) => api(`${base}/react`, { method: 'POST', body: { emoji } }).catch((err) => toast(errorText(err), 'danger')));
    if (action === 'retry') {
      const entry = state.outbox.get(el.closest('.msg').dataset.cid);
      if (entry) deliver(entry);
    }
  } catch (err) {
    toast(errorText(err), 'danger');
  }
}

function startEdit(node, m) {
  const bodyEl = $('.msg-body', node);
  if (!bodyEl || node.classList.contains('editing')) return;
  node.classList.add('editing');
  const text = m.body.replace(/<@([A-Za-z0-9_-]+)>/g, (x, id) => {
    const label = `@${person(id).name}`;
    mentionMap.set(label, id);
    return label;
  });
  bodyEl.outerHTML = `<form class="edit-form"><textarea class="form-control" rows="2">${esc(text)}</textarea>
    <div class="mt-1 d-flex gap-2"><button class="btn btn-sm btn-primary">${esc(t('save'))}</button><button type="button" class="btn btn-sm btn-outline-secondary" data-action="cancel-edit">${esc(t('cancel'))}</button><small class="text-body-secondary align-self-center">${esc(t('editHint'))}</small></div></form>`;
  const form = $('.edit-form', node);
  const ta = $('textarea', form);
  ta.focus();
  ta.selectionStart = ta.value.length;
  const done = () => (m.parent_id || state.thread === m.id ? renderThread() : renderMessages({ scroll: 'none' }));
  form.onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api(`${API}/conversations/${m.conversation_id}/messages/${m.id}/edit`, { method: 'POST', body: { body: encodeMentions(ta.value), version: m.version } });
    } catch (err) {
      toast(errorText(err), 'danger');
      done();
    }
  };
  ta.onkeydown = (e) => {
    if (e.key === 'Escape') done();
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  };
  $('[data-action="cancel-edit"]', form).onclick = done;
}

function emojiPicker(anchor, onPick) {
  document.querySelector('.emoji-pop')?.remove();
  const pop = document.createElement('div');
  pop.className = 'emoji-pop card shadow';
  pop.innerHTML = EMOJI.map((e) => `<button type="button" class="btn btn-sm" data-emoji="${e}">${e}</button>`).join('');
  document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.top = `${Math.max(8, r.top - pop.offsetHeight - 6)}px`;
  pop.style.left = `${Math.min(window.innerWidth - pop.offsetWidth - 8, r.left)}px`;
  pop.onclick = (e) => {
    const b = e.target.closest('[data-emoji]');
    if (b) onPick(b.dataset.emoji);
    pop.remove();
  };
  setTimeout(() => document.addEventListener('click', () => pop.remove(), { once: true }), 0);
}

// ------------------------------------------------------------------- panel

function openPanel(kind, title) {
  state.panel = kind;
  $('#panel').hidden = false;
  $('#panel-title').textContent = title;
  $('#composer-thread').innerHTML = '';
  $('#app').classList.add('with-panel');
}

function closePanel() {
  state.panel = null;
  state.thread = null;
  $('#panel').hidden = true;
  $('#app').classList.remove('with-panel');
}

async function openThread(parentId) {
  state.thread = parentId;
  openPanel('thread', t('thread'));
  $('#panel-body').innerHTML = `<div class="msg-loading"><div class="spinner-border spinner-border-sm"></div></div>`;
  const c = state.conversations.get(state.current);
  // Same rule as conversations: events received meanwhile are merged, and
  // only the newest load of the thread is installed.
  const load = (state.threadLoad = { parentId, arriving: [] });
  const data = await api(`${API}/conversations/${c.id}/messages?parent=${encodeURIComponent(parentId)}&limit=200`).finally(() => {
    if (state.threadLoad === load) state.threadLoad = null;
  });
  if (state.threadLoad || state.thread !== parentId) return;
  const thread = { parent: data.parent, list: data.messages };
  for (const m of load.arriving) {
    if (m.id === parentId) {
      if (!thread.parent || (thread.parent.version || 0) <= m.version) thread.parent = m;
    } else upsert(thread.list, m);
  }
  state.threads.set(parentId, thread);
  state.staged.thread = [];
  renderComposer('thread');
  renderThread();
  $('#composer-thread textarea')?.focus();
}

function renderThread() {
  if (state.panel !== 'thread' || !state.thread) return;
  const th = state.threads.get(state.thread);
  if (!th) return;
  const pending = [...state.outbox.values()].filter((p) => p.parent_id === state.thread).map(pendingAsMessage);
  let prev = null;
  const replies = [...th.list, ...pending].map((m) => {
    const html = messageHtml(m, prev, { thread: true });
    prev = m;
    return html;
  });
  const body = $('#panel-body');
  const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 60;
  body.innerHTML = `<div class="thread-parent">${th.parent ? messageHtml(th.parent, null, { thread: true }) : ''}</div>
    <div class="thread-count">${esc(replyLabel(th.list.length))}</div>
    <div class="thread-list">${replies.join('')}</div>`;
  if (atBottom) body.scrollTop = body.scrollHeight;
}

async function openMembers() {
  const c = state.conversations.get(state.current);
  if (!c) return;
  openPanel('members', t('members'));
  const { members } = await api(`${API}/conversations/${c.id}/members`);
  const moderator = canModerate();
  const canAdd = c.type === 'group' || (c.type === 'space' && (c.visibility === 'public' || moderator));
  const canInviteEmail = c.type === 'space' && moderator;
  const invites = canInviteEmail ? (await api(`${API}/conversations/${c.id}/invites`).catch(() => ({ invites: [] }))).invites : [];
  $('#panel-body').innerHTML = `<div class="px-3">${canAdd ? `<button class="btn btn-outline-primary btn-sm w-100 mb-2" data-action="add-members">${icon('user-plus')} ${esc(t('addPeople'))}</button>` : ''}
    ${canInviteEmail ? `<button class="btn btn-outline-secondary btn-sm w-100 mb-3" data-action="invite-email">${icon('mail')} ${esc(t('inviteByEmail'))}</button>` : ''}</div>
    ${invites.length ? `<div class="side-label px-3">${esc(t('pendingInvites'))}</div><ul class="list-unstyled member-list mb-3">${invites
      .map((i) => `<li class="d-flex align-items-center gap-2 py-1" data-invite="${esc(i.id)}">${icon('mail', 'text-body-tertiary')}<span class="min-w-0 flex-grow-1 text-truncate small">${esc(i.email)}</span><button class="btn btn-sm btn-link text-danger p-0" data-action="revoke-invite">${esc(t('revoke'))}</button></li>`)
      .join('')}</ul>` : ''}
    <ul class="list-unstyled member-list">${members
      .map(
        (m) => `<li class="d-flex align-items-center gap-2 py-1" data-user="${esc(m.id)}"><button class="person-link" data-person="${esc(m.id)}" aria-label="${esc(m.name)}">${avatar(m.id, 'avatar-sm')}</button>
        <div class="min-w-0 flex-grow-1"><div class="text-truncate"><button class="person-link person-name" data-person="${esc(m.id)}">${esc(m.name)}</button>${m.id === ME ? ` <small class="text-body-secondary">(${esc(t('you'))})</small>` : ''}</div><small class="text-body-secondary">${esc(m.role === 'moderator' ? t('moderator') : t(`status.${state.presence[m.id] || 'offline'}`))}</small>${extBadge(m.id)}</div>
        ${m.id !== ME ? `<button class="btn btn-sm btn-icon" data-action="dm-user" title="${esc(t('message'))}">${icon('chat')}</button>` : ''}
        ${moderator && m.id !== ME ? `<div class="dropdown"><button class="btn btn-sm btn-icon" data-bs-toggle="dropdown">${icon('more')}</button><ul class="dropdown-menu dropdown-menu-end">
          <li><button class="dropdown-item" data-action="toggle-mod">${esc(t(m.role === 'moderator' ? 'removeModerator' : 'makeModerator'))}</button></li>
          <li><button class="dropdown-item text-danger" data-action="remove-member">${esc(t('removeFromSpace'))}</button></li></ul></div>` : ''}
      </li>`
      )
      .join('')}</ul>`;
}

async function openPinned() {
  const c = state.conversations.get(state.current);
  openPanel('pinned', t('pinned'));
  const { messages } = await api(`${API}/conversations/${c.id}/pinned`);
  $('#panel-body').innerHTML = messages.length ? messages.map((m) => messageHtml(m, null, { thread: true })).join('') : `<div class="text-body-secondary text-center py-4">${esc(t('noPinned'))}</div>`;
}

// ------------------------------------------------------------------- modals

const modalEl = $('#modal');
let modal = null;
const getModal = () => (modal ||= window.bootstrap.Modal.getOrCreateInstance(modalEl));

// All dialogs share one container: each starts with no handlers left over
// from the previous one (they set root.onclick / root.onchange).
function openModal(html, onReady) {
  const root = $('#modal-content');
  root.innerHTML = html;
  root.onclick = null;
  root.onchange = null;
  getModal().show();
  onReady?.(root);
}

const closeModal = () => getModal().hide();

function confirmBox(text) {
  return new Promise((resolve) => {
    openModal(
      `<div class="modal-body p-4"><p class="mb-4">${esc(text)}</p><div class="d-flex justify-content-end gap-2">
        <button class="btn btn-outline-secondary" data-answer="0">${esc(t('cancel'))}</button><button class="btn btn-danger" data-answer="1">${esc(t('confirm'))}</button></div></div>`,
      (root) => {
        let answered = false;
        root.onclick = (e) => {
          const b = e.target.closest('[data-answer]');
          if (!b) return;
          answered = true;
          closeModal();
          resolve(b.dataset.answer === '1');
        };
        modalEl.addEventListener('hidden.bs.modal', () => answered || resolve(false), { once: true });
      }
    );
  });
}

// People picker used by new DM / group / space / meeting / add members.
function pickerHtml({ multi, exclude = [] }) {
  const people = [...state.directory.values()].filter((p) => p.id !== ME && !exclude.includes(p.id)).sort((a, b) => a.name.localeCompare(b.name));
  return `<input class="form-control mb-2" type="search" placeholder="${esc(t('searchPeople'))}" data-filter>
    <div class="picked mb-2" data-picked></div>
    <div class="list-group picker-list">${people
      .map(
        (p) => `<label class="list-group-item d-flex align-items-center gap-2" data-name="${esc(`${p.name} ${p.email}`.toLowerCase())}">
        <input class="form-check-input m-0" type="${multi ? 'checkbox' : 'radio'}" name="people" value="${esc(p.id)}">
        ${avatar(p.id, 'avatar-sm')}<span class="min-w-0"><span class="d-block text-truncate">${esc(p.name)}${extBadge(p.id)}</span><small class="text-body-secondary">${esc(p.title || p.email)}</small></span></label>`
      )
      .join('') || `<div class="text-body-secondary p-3">${esc(t('noPeople'))}</div>`}</div>`;
}

function wirePicker(root) {
  const filter = $('[data-filter]', root);
  if (!filter) return;
  filter.oninput = () => {
    const q = filter.value.trim().toLowerCase();
    for (const row of $$('.picker-list label', root)) row.hidden = q && !row.dataset.name.includes(q);
  };
  root.onchange = () => {
    $('[data-picked]', root).innerHTML = $$('input[name="people"]:checked', root)
      .map((i) => `<span class="badge text-bg-primary me-1">${esc(person(i.value).name)}</span>`)
      .join('');
  };
}

const picked = (root) => $$('input[name="people"]:checked', root).map((i) => i.value);

function modalShell(title, body, submitLabel) {
  return `<form class="modal-form"><div class="modal-header"><h2 class="modal-title h5">${esc(title)}</h2><button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="${esc(t('close'))}"></button></div>
    <div class="modal-body">${body}<div class="alert alert-danger py-2 mt-3 mb-0" data-error hidden></div></div>
    <div class="modal-footer"><button type="button" class="btn btn-outline-secondary" data-bs-dismiss="modal">${esc(t('cancel'))}</button><button class="btn btn-primary">${esc(submitLabel)}</button></div></form>`;
}

function onModalSubmit(root, handler) {
  const form = $('form', root);
  form.onsubmit = async (e) => {
    e.preventDefault();
    const err = $('[data-error]', root);
    err.hidden = true;
    const btn = $('.modal-footer .btn-primary', root);
    btn.disabled = true;
    try {
      await handler(form);
      closeModal();
    } catch (ex) {
      err.textContent = errorText(ex);
      err.hidden = false;
    } finally {
      btn.disabled = false;
    }
  };
}

// ------------------------------------------------------------ profile card
// A click on a name, an avatar or a mention: who it is, and a direct
// message or a call to them in one click.

function closeProfile() {
  $('#profile-card')?.remove();
}

function showProfile(anchor, id) {
  closeProfile();
  const p = person(id);
  if (!state.directory.has(id)) return;
  const card = document.createElement('div');
  card.className = 'profile-card shadow';
  card.id = 'profile-card';
  card.dataset.user = id;
  const job = [p.title, p.department].filter(Boolean).join(' · ');
  const others = id !== ME;
  card.innerHTML = `<div class="d-flex align-items-center gap-3">
      ${avatar(id, 'avatar-lg')}
      <div class="min-w-0"><div class="fw-semibold text-truncate">${esc(p.name)}</div>${extBadge(id)}
        ${job ? `<div class="small text-body-secondary text-truncate">${esc(job)}</div>` : ''}
        <div class="small text-body-secondary">${esc(t(`status.${state.presence[id] || 'offline'}`))}</div></div>
    </div>
    ${p.email ? `<div class="d-flex align-items-center gap-1 mt-2 min-w-0"><a class="small text-truncate" href="mailto:${esc(p.email)}">${esc(p.email)}</a>
      <button class="btn btn-icon btn-sm profile-copy" data-copy="${esc(p.email)}" data-copied="emailCopied" title="${esc(t('copyEmail'))}" aria-label="${esc(t('copyEmail'))}">${icon('copy')}</button></div>` : ''}
    ${
      others
        ? `<div class="d-flex gap-2 mt-3">
      <button class="btn btn-primary btn-sm flex-grow-1" data-profile="dm">${icon('chat')} ${esc(t('message'))}</button>
      ${boot.perms.calls ? `<button class="btn btn-outline-secondary btn-sm" data-profile="audio" title="${esc(t('startAudioCall'))}">${icon('phone')}</button>
      <button class="btn btn-outline-secondary btn-sm" data-profile="video" title="${esc(t('startCall'))}">${icon('video')}</button>` : ''}
    </div>`
        : ''
    }`;
  document.body.append(card);
  // Next to what was clicked, kept inside the window.
  const r = anchor.getBoundingClientRect();
  const w = card.offsetWidth;
  const h = card.offsetHeight;
  card.style.left = `${Math.max(8, Math.min(r.left, innerWidth - w - 8))}px`;
  card.style.top = `${r.bottom + h + 8 < innerHeight ? r.bottom + 6 : Math.max(8, r.top - h - 6)}px`;
  $('[data-profile]', card)?.focus();
}

async function profileAction(kind, id) {
  closeProfile();
  // A call tab must be opened inside the click, before any request.
  const w = kind === 'dm' ? null : openCallTab();
  try {
    const { conversation } = await api(`${API}/dms`, { method: 'POST', body: { user_id: id } });
    await adopt(conversation);
    if (!w) return;
    const { meeting } = await api(`${API}/meetings`, { method: 'POST', body: { conversation_id: conversation.id, notify_members: false, call: kind } });
    w.location = `/o/${ORG.slug}/meet/${meeting.id}?call=${kind}`;
  } catch (err) {
    w?.close();
    toast(errorText(err), 'danger');
  }
}

document.addEventListener('click', (e) => {
  const card = $('#profile-card');
  const btn = e.target.closest('[data-profile]');
  if (btn && card) return profileAction(btn.dataset.profile, card.dataset.user);
  if (card && !card.contains(e.target) && !e.target.closest('[data-person]')) closeProfile();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeProfile();
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('span[data-person]')) {
    e.preventDefault();
    showProfile(e.target, e.target.dataset.person);
  }
});
document.addEventListener('scroll', closeProfile, true);

async function adopt(conversation) {
  state.conversations.set(conversation.id, { ...conversation, unread: 0, mentions: 0 });
  renderSidebar();
  await openConversation(conversation.id);
}

// Name, description and visibility of a Space, each with what it means.
function spaceFields(c) {
  const radio = (value, ic) => `<div class="form-check mb-2"><input class="form-check-input" type="radio" name="visibility" value="${value}" id="v-${value}"${c.visibility === value ? ' checked' : ''}>
    <label class="form-check-label" for="v-${value}">${icon(ic)} <strong>${esc(t(`visibility.${value}`))}</strong>
    <small class="text-body-secondary d-block">${esc(t(value === 'public' ? 'visibilityPublicHelp' : 'visibilityPrivateHelp'))}</small></label></div>`;
  return `<div class="mb-3"><label class="form-label">${esc(t('spaceName'))}</label><input class="form-control" name="name" maxlength="80" required value="${esc(c.name || '')}">
      <div class="form-text">${esc(t('spaceNameHelp'))}</div></div>
    <div class="mb-3"><label class="form-label">${esc(t('description'))}</label><textarea class="form-control" name="description" rows="2" maxlength="500">${esc(c.description || '')}</textarea>
      <div class="form-text">${esc(t('spaceDescriptionHelp'))}</div></div>
    <div class="mb-3"><div class="form-label">${esc(t('spaceVisibility'))}</div>${radio('public', 'hash')}${radio('private', 'lock')}</div>`;
}

const modals = {
  'new-dm': () =>
    openModal(modalShell(t('newDm'), pickerHtml({ multi: false }), t('open')), (root) => {
      wirePicker(root);
      onModalSubmit(root, async () => {
        const [id] = picked(root);
        if (!id) throw new Error(t('pickSomeone'));
        await adopt((await api(`${API}/dms`, { method: 'POST', body: { user_id: id } })).conversation);
      });
    }),
  'new-space': () =>
    openModal(
      modalShell(
        t('newSpace'),
        `${spaceFields({ name: '', description: '', visibility: 'public' })}
        <label class="form-label">${esc(t('addPeople'))}</label>${pickerHtml({ multi: true })}
        <p class="small text-body-secondary mt-2 mb-0">${icon('crown')} ${esc(t('spaceYouModerate'))}</p>`,
        t('create')
      ),
      (root) => {
        wirePicker(root);
        onModalSubmit(root, async (form) => {
          const body = { name: form.name.value, description: form.description.value, visibility: form.visibility.value, user_ids: picked(root) };
          await adopt((await api(`${API}/spaces`, { method: 'POST', body })).conversation);
        });
      }
    ),
  // Space settings: editable by moderators and org owners/admins, read-only
  // (an "about" view) for everyone else.
  'space-settings': () => {
    const c = state.conversations.get(state.current);
    if (!c || c.type !== 'space') return;
    const canEdit = c.my_role === 'moderator' || ['owner', 'admin'].includes(boot.role);
    const extras = `<div class="space-help small">
        <div class="fw-semibold mb-1">${icon('crown')} ${esc(t('spaceModeratorsTitle'))}</div>
        <div class="text-body-secondary mb-2">${esc(t('spaceModeratorsHelp'))}</div>
        <button type="button" class="btn btn-sm btn-outline-secondary" data-action="members" data-bs-dismiss="modal">${icon('users')} ${esc(t('spaceManageMembers'))}</button>
      </div>
      <div class="space-help small">
        <div class="fw-semibold mb-1">${icon('globe')} ${esc(t('spaceExternalsTitle'))}</div>
        <div class="text-body-secondary">${esc(t(c.external_count ? 'spaceExternalsSome' : 'spaceExternalsNone', { n: c.external_count || 0 }))}</div>
      </div>
      <div class="space-help small">
        <div class="fw-semibold mb-1">${icon('bell')} ${esc(t('notifyTitle'))}</div>
        <div class="text-body-secondary">${esc(t('spaceNotifyHelp', { n: SMALL_SPACE }))}</div>
      </div>`;
    if (!canEdit) {
      return openModal(
        `<div class="modal-header"><h2 class="modal-title h5">${icon(c.visibility === 'private' ? 'lock' : 'hash')} ${esc(c.name)}</h2><button type="button" class="btn-close" data-bs-dismiss="modal"></button></div>
        <div class="modal-body"><p>${esc(c.description || t('spaceNoDescription'))}</p>
        <p class="small text-body-secondary">${esc(t(c.visibility === 'private' ? 'visibilityPrivateHelp' : 'visibilityPublicHelp'))}</p>${extras}</div>`
      );
    }
    openModal(
      modalShell(
        t('spaceSettings'),
        `${spaceFields(c)}
        <div class="alert alert-warning small py-2" data-public-warning hidden>${icon('alert')} ${esc(t('spaceGoPublicWarning'))}</div>
        ${extras}
        <div class="space-help small border-danger-subtle">
          <div class="fw-semibold mb-1">${icon('door')} ${esc(t('spaceArchiveTitle'))}</div>
          <div class="text-body-secondary mb-2">${esc(t('spaceArchiveHelp'))}</div>
          <button type="button" class="btn btn-sm btn-outline-danger" data-archive-space>${esc(t('spaceArchive'))}</button>
        </div>`,
        t('save')
      ),
      (root) => {
        const warn = $('[data-public-warning]', root);
        root.onchange = () => (warn.hidden = !(c.visibility === 'private' && root.querySelector('[name=visibility]:checked')?.value === 'public'));
        $('[data-archive-space]', root).addEventListener('click', async () => {
          if (!(await confirmBox(t('spaceArchiveConfirm', { name: c.name })))) return;
          try {
            await api(`${API}/conversations/${c.id}/archive`, { method: 'POST', body: {} });
            dropConversation(c.id);
          } catch (err) {
            toast(errorText(err), 'danger');
          }
        });
        onModalSubmit(root, async (form) => {
          await api(`${API}/conversations/${c.id}/update`, { method: 'POST', body: { name: form.name.value, description: form.description.value, visibility: form.visibility.value } });
          Object.assign(c, { name: form.name.value.trim() || c.name, description: form.description.value.trim(), visibility: form.visibility.value });
          renderHeader();
          renderSidebar();
          toast(t('saved'), 'success');
        });
      }
    );
  },
  'browse-spaces': async () => {
    const { spaces } = await api(`${API}/spaces`);
    openModal(
      `<div class="modal-header"><h2 class="modal-title h5">${esc(t('browseSpaces'))}</h2><button type="button" class="btn-close" data-bs-dismiss="modal"></button></div>
      <div class="modal-body"><div class="list-group">${spaces
        .map(
          (s) => `<div class="list-group-item d-flex align-items-center gap-3"><span class="conv-ic space">${icon('hash')}</span>
          <div class="flex-grow-1 min-w-0"><div class="fw-semibold">${esc(s.name)}</div><small class="text-body-secondary">${esc(t('memberCount', { n: s.member_count }))}${s.description ? ` · ${esc(s.description)}` : ''}</small></div>
          ${s.joined ? `<button class="btn btn-sm btn-outline-secondary" data-open="${esc(s.id)}">${esc(t('open'))}</button>` : `<button class="btn btn-sm btn-primary" data-join="${esc(s.id)}">${esc(t('join'))}</button>`}</div>`
        )
        .join('') || `<div class="text-body-secondary p-3">${esc(t('noPublicSpaces'))}</div>`}</div></div>`,
      (root) => {
        root.onclick = async (e) => {
          const join = e.target.closest('[data-join]');
          const open = e.target.closest('[data-open]');
          if (join) {
            closeModal();
            await adopt((await api(`${API}/spaces/${join.dataset.join}/join`, { method: 'POST', body: {} })).conversation);
          } else if (open) {
            closeModal();
            openConversation(open.dataset.open);
          }
        };
      }
    );
  },
  'new-meeting': (preset = {}) => {
    const local = new Date(Date.now() + 3600_000);
    local.setMinutes(0, 0, 0);
    const value = new Date(local.getTime() - local.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
    openModal(
      modalShell(
        t('newMeeting'),
        `<div class="mb-3"><label class="form-label">${esc(t('meetingTitle'))}</label><input class="form-control" name="title" maxlength="120" required value="${esc(preset.title || '')}"></div>
        <div class="form-check form-switch mb-2"><input class="form-check-input" type="checkbox" id="m-now" name="now" checked><label class="form-check-label" for="m-now">${esc(t('startNow'))}</label></div>
        <div class="row g-2 mb-3" data-when hidden><div class="col-7"><input class="form-control" type="datetime-local" name="when" value="${value}"></div>
          <div class="col-5"><select class="form-select" name="duration">${[15, 30, 45, 60, 90, 120].map((m) => `<option value="${m}"${m === 60 ? ' selected' : ''}>${m} min</option>`).join('')}</select></div></div>
        <label class="form-label">${esc(t('inviteColleagues'))}</label>${pickerHtml({ multi: true })}
        <label class="form-label mt-3">${esc(t('inviteGuests'))}</label>
        <textarea class="form-control" name="guests" rows="2" placeholder="ana@partener.ro, Ion Pop &lt;ion@client.com&gt;"></textarea>
        <div class="form-text">${esc(t('guestsHelp'))}</div>`,
        t('create')
      ),
      (root) => {
        wirePicker(root);
        const form = $('form', root);
        form.now.onchange = () => ($('[data-when]', root).hidden = form.now.checked);
        onModalSubmit(root, async () => {
          const guests = form.guests.value
            .split(/[,;\n]+/)
            .map((s) => s.trim())
            .filter(Boolean)
            .map((s) => {
              const m = s.match(/^(.*?)\s*<([^>]+)>$/);
              return m ? { name: m[1].trim(), email: m[2].trim() } : { email: s };
            });
          const body = { title: form.title.value, user_ids: picked(root), guests, duration_min: Number(form.duration.value) };
          if (!form.now.checked) body.scheduled_at = new Date(form.when.value).toISOString();
          const { meeting } = await api(`${API}/meetings`, { method: 'POST', body });
          if (form.now.checked) window.open(`/o/${ORG.slug}/meet/${meeting.id}`, '_blank', 'noopener');
          if (state.view === 'meetings') renderMeetings();
          toast(t('meetingCreated'), 'success');
        });
      }
    );
  },
  'add-members': async () => {
    const c = state.conversations.get(state.current);
    // Spaces do not carry their member list: fetch it, so people already in
    // are not offered again.
    const current = c.type === 'space' ? (await api(`${API}/conversations/${c.id}/members`)).members.map((m) => m.id) : c.member_ids || [];
    openModal(modalShell(t('addPeople'), pickerHtml({ multi: true, exclude: current }), t('add')), (root) => {
      wirePicker(root);
      onModalSubmit(root, async () => {
        const ids = picked(root);
        if (!ids.length) throw new Error(t('pickSomeone'));
        await api(`${API}/conversations/${c.id}/members`, { method: 'POST', body: { user_ids: ids } });
      });
    });
  },
  'invite-email': () => {
    const c = state.conversations.get(state.current);
    openModal(
      modalShell(
        t('inviteByEmail'),
        `<p class="small text-body-secondary">${esc(t('inviteByEmailHelp', { space: c.name }))}</p>
        <label class="form-label">${esc(t('emailLabel'))}</label><input class="form-control" type="email" name="email" required placeholder="ion@firmapartenera.ro" autofocus>`,
        t('invite')
      ),
      (root) =>
        onModalSubmit(root, async (form) => {
          const res = await api(`${API}/conversations/${c.id}/invite`, { method: 'POST', body: { email: form.email.value } });
          toast(t(res.status === 'added' ? 'memberAdded' : 'inviteSent'), 'success');
          if (state.panel === 'members') openMembers();
        })
    );
  },
};

// ---------------------------------------------------------------- meetings

// ------------------------------------------------------------------ people
// The organization's members (for external collaborators: the people they
// share a conversation with), available first, then by name. A row opens
// the profile card; the buttons message or call at once.

const PRESENCE_ORDER = { online: 0, dnd: 1, away: 2 };

function renderPeople() {
  showView('people');
  setUrl(`/o/${ORG.slug}/people`);
  closePanel();
  state.current = null;
  renderSidebar();
  renderPeopleList();
  if (matchMedia('(min-width: 992px)').matches) $('#people-search').focus();
}

function renderPeopleList() {
  const q = $('#people-search').value.trim().toLowerCase();
  const all = [...state.directory.values()];
  const rank = (p) => PRESENCE_ORDER[state.presence[p.id]] ?? 3;
  const list = all
    .filter((p) => !q || `${p.name} ${p.email} ${p.title || ''} ${p.department || ''}`.toLowerCase().includes(q))
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  const online = all.filter((p) => p.id !== ME && state.presence[p.id] && state.presence[p.id] !== 'offline').length;
  $('#people-sub').textContent = t('peopleCount', { n: all.length, online });
  const callButtons = (p) =>
    boot.perms.calls
      ? `<button class="btn btn-icon btn-sm" data-person-act="audio" title="${esc(t('startAudioCall'))}">${icon('phone')}</button>
         <button class="btn btn-icon btn-sm" data-person-act="video" title="${esc(t('startCall'))}">${icon('video')}</button>`
      : '';
  $('#people-body').innerHTML = list.length
    ? `<ul class="list-unstyled people-list">${list
        .map((p) => {
          const job = [p.title, p.department].filter(Boolean).join(' · ');
          return `<li class="people-row" data-user="${esc(p.id)}">
            <button class="person-link" data-person="${esc(p.id)}" aria-label="${esc(p.name)}">${avatar(p.id)}</button>
            <div class="min-w-0 flex-grow-1">
              <div class="text-truncate"><button class="person-link person-name" data-person="${esc(p.id)}">${esc(p.name)}</button>${p.id === ME ? ` <small class="text-body-secondary">(${esc(t('you'))})</small>` : ''}${extBadge(p.id)}</div>
              <div class="small text-body-secondary text-truncate">${esc(job || p.email)}</div>
            </div>
            <span class="small text-body-secondary d-none d-sm-inline">${esc(t(`status.${state.presence[p.id] || 'offline'}`))}</span>
            ${p.id === ME ? '' : `<div class="people-actions"><button class="btn btn-icon btn-sm" data-person-act="dm" title="${esc(t('message'))}">${icon('chat')}</button>${callButtons(p)}</div>`}
          </li>`;
        })
        .join('')}</ul>`
    : `<div class="empty-hero">${icon('users', 'hero-ic')}<p class="text-body-secondary">${esc(t(q ? 'noResults' : 'noPeople'))}</p></div>`;
}

// How many colleagues are available now, next to "People" in the sidebar.
function renderOnlineCount() {
  const online = [...state.directory.keys()].filter((id) => id !== ME && state.presence[id] && state.presence[id] !== 'offline').length;
  const badge = $('#online-count');
  badge.hidden = !online;
  badge.textContent = online;
}

$('#people-search').addEventListener('input', () => renderPeopleList());
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-person-act]');
  if (btn) profileAction(btn.dataset.personAct, btn.closest('[data-user]').dataset.user);
});

async function renderMeetings() {
  showView('meetings');
  setUrl(`/o/${ORG.slug}/meetings`);
  const body = $('#meetings-body');
  body.innerHTML = `<div class="msg-loading"><div class="spinner-border spinner-border-sm"></div></div>`;
  const { meetings } = await api(`${API}/meetings`);
  const card = (m) => {
    const when = new Date(m.scheduled_at);
    const badge = !m.open ? `<span class="badge text-bg-secondary">${esc(t(`meetingState.${m.state === 'canceled' ? 'canceled' : 'ended'}`))}</span>` : m.state === 'live' ? `<span class="badge text-bg-danger">${esc(t('meetingState.live'))} · ${m.live_count}</span>` : `<span class="badge text-bg-primary">${esc(t(`meetingState.${m.state}`))}</span>`;
    return `<div class="card meeting-row mb-2" data-meeting="${esc(m.id)}"><div class="card-body d-flex flex-wrap align-items-center gap-3">
      <div class="meeting-date text-center"><div class="small text-uppercase">${esc(shortFmt.format(when))}</div><div class="fw-semibold">${esc(timeFmt.format(when))}</div></div>
      <div class="flex-grow-1 min-w-0"><div class="fw-semibold text-truncate">${esc(m.title)} ${badge}</div><small class="text-body-secondary">${esc(t('hostedBy', { name: m.host_name || '—' }))} · ${m.duration_min} min</small></div>
      <div class="d-flex gap-2">
        ${m.open ? `<a class="btn btn-success btn-sm" href="/o/${esc(ORG.slug)}/meet/${esc(m.id)}" target="_blank" rel="noopener">${icon('video')} ${esc(t('joinCall'))}</a>
        <button class="btn btn-outline-secondary btn-sm" data-copy="${esc(m.url)}" title="${esc(t('copyLink'))}">${icon('link')}</button>` : ''}
        ${m.can_manage && m.open ? `<button class="btn btn-outline-secondary btn-sm" data-manage="${esc(m.id)}">${icon('settings')}</button>` : ''}
      </div></div></div>`;
  };
  body.innerHTML = meetings.length ? meetings.map(card).join('') : `<div class="empty-hero">${icon('calendar', 'hero-ic')}<p class="text-body-secondary">${esc(t('noMeetings'))}</p></div>`;
}

async function manageMeeting(id) {
  const data = await api(`${API}/meetings/${id}`);
  const m = data.meeting;
  const invRow = (i) => `<li class="list-group-item d-flex align-items-center gap-2">
    <div class="min-w-0 flex-grow-1"><div class="text-truncate">${esc(i.user_name || i.name || i.email)}</div><small class="text-body-secondary">${esc(i.email || t('colleague'))} · ${esc(i.revoked_at ? t('revoked') : i.verified_at ? t('verified') : t('invited'))}</small></div>
    ${i.revoked_at ? '' : `<button class="btn btn-sm btn-outline-danger" data-revoke="${esc(i.id)}">${esc(t('revoke'))}</button>`}</li>`;
  openModal(
    `<div class="modal-header"><h2 class="modal-title h5">${esc(m.title)}</h2><button type="button" class="btn-close" data-bs-dismiss="modal"></button></div>
    <div class="modal-body">
      <h3 class="h6">${esc(t('invitations'))}</h3>
      <ul class="list-group mb-3">${data.invitations.map(invRow).join('') || `<li class="list-group-item text-body-secondary">${esc(t('noInvitations'))}</li>`}</ul>
      <form class="d-flex gap-2" data-invite><input class="form-control form-control-sm" type="email" name="email" placeholder="email@firma.ro" required><button class="btn btn-sm btn-primary text-nowrap">${icon('mail')} ${esc(t('invite'))}</button></form>
      <div class="alert alert-danger py-2 mt-3 mb-0" data-error hidden></div>
    </div>
    <div class="modal-footer"><button class="btn btn-outline-danger me-auto" data-cancel-meeting>${esc(t(m.state === 'scheduled' ? 'cancelMeeting' : 'endMeeting'))}</button><button class="btn btn-outline-secondary" data-bs-dismiss="modal">${esc(t('close'))}</button></div>`,
    (root) => {
      const fail = (err) => {
        const box = $('[data-error]', root);
        box.textContent = errorText(err);
        box.hidden = false;
      };
      $('[data-invite]', root).onsubmit = async (e) => {
        e.preventDefault();
        try {
          await api(`${API}/meetings/${id}/invitations`, { method: 'POST', body: { email: e.target.email.value } });
          manageMeeting(id);
        } catch (err) {
          fail(err);
        }
      };
      root.onclick = async (e) => {
        const revoke = e.target.closest('[data-revoke]');
        try {
          if (revoke) {
            await api(`${API}/meetings/${id}/invitations/${revoke.dataset.revoke}/revoke`, { method: 'POST', body: {} });
            manageMeeting(id);
          } else if (e.target.closest('[data-cancel-meeting]')) {
            if (!(await confirmBox(t('endMeetingConfirm')))) return;
            await api(`${API}/meetings/${id}/${m.state === 'scheduled' ? 'cancel' : 'end'}`, { method: 'POST', body: {} });
            renderMeetings();
          }
        } catch (err) {
          fail(err);
        }
      };
    }
  );
}

// ------------------------------------------------------------------ search

async function runSearch(params) {
  showView('search');
  const form = $('#search-filters');
  for (const [k, v] of Object.entries(params)) if (form[k]) form[k].value = v;
  const convSel = form.conversation;
  if (convSel.options.length <= 1) {
    for (const c of state.conversations.values()) convSel.add(new Option(convName(c), c.id));
    for (const p of state.directory.values()) form.author.add(new Option(p.name, p.id));
    if (params.conversation) convSel.value = params.conversation;
  }
  const q = form.q.value.trim();
  const out = $('#search-results');
  if (!q) {
    out.innerHTML = '';
    return;
  }
  out.innerHTML = `<div class="msg-loading"><div class="spinner-border spinner-border-sm"></div></div>`;
  const qs = new URLSearchParams({ q, conversation: form.conversation.value, author: form.author.value });
  if (form.from.value) qs.set('from', new Date(form.from.value).toISOString());
  if (form.to.value) qs.set('to', new Date(new Date(form.to.value).getTime() + 86400_000).toISOString());
  const data = await api(`${API}/search?${qs}`);
  const snippet = (s) => esc(s).replace(/\[\[/g, '<mark>').replace(/\]\]/g, '</mark>').replace(/&lt;@([A-Za-z0-9_-]+)&gt;/g, (m, id) => `@${esc(person(id).name)}`);
  out.innerHTML =
    (data.files.length ? `<h3 class="h6 mt-2">${esc(t('files'))}</h3><div class="d-flex flex-wrap gap-2 mb-3">${data.files.map(fileHtml).join('')}</div>` : '') +
    `<h3 class="h6">${esc(t('messages'))}</h3>` +
    (data.messages
      .map((m) => {
        const c = state.conversations.get(m.conversation_id);
        return `<a class="search-hit card mb-2" href="/o/${esc(ORG.slug)}/c/${esc(m.conversation_id)}" data-conv="${esc(m.conversation_id)}"><div class="card-body py-2">
          <div class="small text-body-secondary">${esc(convName(c))} · ${esc(person(m.author_id).name)} · ${esc(new Date(m.created_at).toLocaleString())}</div>
          <div>${snippet(m.snippet)}</div></div></a>`;
      })
      .join('') || `<div class="text-body-secondary">${esc(t('noResults'))}</div>`);
}

// -------------------------------------------------------------- dom events

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-person], [data-action], [data-conv], [data-react], [data-view], [data-presence], [data-mention], [data-unstage], [data-copy], [data-manage]');
  if (!el) return;
  if (el.dataset.person) return showProfile(el, el.dataset.person);
  if (el.dataset.conv && el.tagName === 'A') {
    if (e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    return openConversation(el.dataset.conv);
  }
  if (el.dataset.react) return messageAction('react', el, el.dataset.react);
  if (el.dataset.view === 'meetings') return renderMeetings();
  if (el.dataset.view === 'people') return renderPeople();
  if (el.dataset.presence) {
    localStorage.setItem('presence', el.dataset.presence);
    state.presence[ME] = el.dataset.presence;
    socket.send('presence.set', { status: el.dataset.presence });
    return renderPresence(ME);
  }
  if (el.dataset.mention) return insertMention(el.closest('form'), el.dataset.mention);
  if (el.dataset.unstage !== undefined) {
    const where = el.closest('form').dataset.where;
    state.staged[where].splice(Number(el.dataset.unstage), 1);
    return renderStaged(where);
  }
  if (el.dataset.copy) {
    await navigator.clipboard.writeText(el.dataset.copy).catch(() => {});
    return toast(t(el.dataset.copied || 'linkCopied'), 'success');
  }
  if (el.dataset.manage) return manageMeeting(el.dataset.manage);
  const action = el.dataset.action;
  const c = state.conversations.get(state.current);
  switch (action) {
    case 'thread':
    case 'pin':
    case 'delete':
    case 'edit':
    case 'emoji':
    case 'retry':
      return messageAction(action, el);
    case 'older':
      return loadOlder();
    case 'members':
      return state.panel === 'members' ? closePanel() : openMembers();
    case 'pinned':
      return state.panel === 'pinned' ? closePanel() : openPinned();
    case 'close-panel':
      return closePanel();
    case 'back':
      return showEmpty();
    case 'close-search':
      return state.current ? openConversation(state.current) : showEmpty();
    case 'call': {
      if (!c) return;
      const kind = el.dataset.kind === 'audio' ? 'audio' : 'video';
      const w = openCallTab();
      try {
        const { meeting } = await api(`${API}/meetings`, { method: 'POST', body: { conversation_id: c.id, notify_members: false, call: kind } });
        const url = `/o/${ORG.slug}/meet/${meeting.id}?call=${kind}`;
        if (w) w.location = url;
        else window.open(url, '_blank', 'noopener');
      } catch (err) {
        w?.close();
        toast(errorText(err), 'danger');
      }
      return;
    }
    case 'notify': {
      const { conversation } = await api(`${API}/conversations/${c.id}/notify`, { method: 'POST', body: { level: el.dataset.level } });
      Object.assign(c, { notify: conversation.notify, muted: conversation.muted });
      toast(t('notifySaved', { level: t(`notify.${conversation.notify}`) }), 'success');
      renderHeader();
      return renderSidebar();
    }
    case 'space-settings':
      return modals['space-settings']();
    case 'leave':
      if (!(await confirmBox(t('leaveConfirm', { name: convName(c) })))) return;
      try {
        await api(`${API}/conversations/${c.id}/members/${ME}/remove`, { method: 'POST', body: {} });
        dropConversation(c.id);
      } catch (err) {
        toast(errorText(err), 'danger');
      }
      return;
    case 'search-here':
      return runSearch({ conversation: c.id, q: '' });
    case 'dm-user': {
      const uid = el.closest('[data-user]').dataset.user;
      return adopt((await api(`${API}/dms`, { method: 'POST', body: { user_id: uid } })).conversation);
    }
    case 'revoke-invite':
      try {
        await api(`${API}/conversations/${c.id}/invites/${el.closest('[data-invite]').dataset.invite}/revoke`, { method: 'POST', body: {} });
        openMembers();
      } catch (err) {
        toast(errorText(err), 'danger');
      }
      return;
    case 'toggle-mod':
    case 'remove-member': {
      const uid = el.closest('[data-user]').dataset.user;
      try {
        if (action === 'remove-member') await api(`${API}/conversations/${c.id}/members/${uid}/remove`, { method: 'POST', body: {} });
        else {
          const row = (await api(`${API}/conversations/${c.id}/members`)).members.find((m) => m.id === uid);
          await api(`${API}/conversations/${c.id}/members/${uid}/role`, { method: 'POST', body: { role: row?.role === 'moderator' ? 'member' : 'moderator' } });
        }
        openMembers();
      } catch (err) {
        toast(errorText(err), 'danger');
      }
      return;
    }
    case 'emoji-insert': {
      const ta = $('textarea', el.closest('form'));
      return emojiPicker(el, (emoji) => {
        ta.setRangeText(emoji, ta.selectionStart, ta.selectionEnd, 'end');
        ta.focus();
      });
    }
    case 'mention-insert': {
      const ta = $('textarea', el.closest('form'));
      ta.setRangeText('@', ta.selectionStart, ta.selectionEnd, 'end');
      ta.focus();
      return updateMentionPop(el.closest('form'));
    }
    default:
      if (modals[action]) {
        askNotifications();
        return modals[action]();
      }
  }
});

document.addEventListener('submit', (e) => {
  const form = e.target.closest('.composer');
  if (form) {
    e.preventDefault();
    submitComposer(form);
  }
});

document.addEventListener('keydown', (e) => {
  const ta = e.target.closest?.('.composer textarea');
  if (!ta) return;
  const form = ta.closest('form');
  const pop = $('.mention-pop', form);
  if (!pop.hidden && ['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(e.key)) {
    const items = $$('[data-mention]', pop);
    const i = items.findIndex((b) => b.classList.contains('active'));
    if (e.key === 'Escape') pop.hidden = true;
    else if (e.key === 'Enter' || e.key === 'Tab') insertMention(form, items[Math.max(0, i)].dataset.mention);
    else {
      items[i]?.classList.remove('active');
      items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].classList.add('active');
    }
    e.preventDefault();
    return;
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    form.requestSubmit();
  } else if (e.key === 'ArrowUp' && !ta.value && form.dataset.where === 'main') {
    // Edit my last message, like most chat apps.
    const mine = cacheFor(state.current).list.filter((m) => m.author_id === ME && m.kind === 'text' && !m.deleted_at).at(-1);
    const node = mine && $(`.msg[data-id="${CSS.escape(mine.id)}"]`);
    if (node) {
      e.preventDefault();
      startEdit(node, mine);
    }
  }
});

document.addEventListener('input', (e) => {
  const ta = e.target.closest?.('.composer textarea');
  if (!ta) return;
  autosize(ta);
  updateMentionPop(ta.closest('form'));
  if (ta.value) sendTyping(ta.closest('form').dataset.where === 'thread' ? state.thread : null);
});

document.addEventListener('change', (e) => {
  const input = e.target.closest?.('[data-file]');
  if (!input) return;
  const where = input.closest('form').dataset.where;
  for (const file of input.files) uploadFile(file, where);
  input.value = '';
});

// Paste or drop files into a composer.
document.addEventListener('paste', (e) => {
  const form = e.target.closest?.('.composer');
  if (!form || !e.clipboardData?.files?.length) return;
  e.preventDefault();
  for (const file of e.clipboardData.files) uploadFile(file, form.dataset.where);
});
for (const type of ['dragover', 'drop']) {
  document.addEventListener(type, (e) => {
    const zone = e.target.closest?.('.view-conv, .panel');
    if (!zone || !state.current) return;
    e.preventDefault();
    if (type === 'drop') for (const file of e.dataTransfer.files) uploadFile(file, zone.classList.contains('panel') && state.thread ? 'thread' : 'main');
  });
}

$('#msg-scroll').addEventListener('scroll', () => {
  const box = $('#msg-scroll');
  if (box.scrollTop < 40 && cacheFor(state.current).hasMore && !box.dataset.loading) {
    box.dataset.loading = '1';
    loadOlder().finally(() => delete box.dataset.loading);
  }
  markRead();
});

$('#search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  runSearch({ q: e.target.q.value });
});
$('#search-filters').addEventListener('change', () => runSearch({}));
$('#search-filters').addEventListener('submit', (e) => {
  e.preventDefault();
  runSearch({});
});

window.addEventListener('focus', () => {
  markRead();
  renderSidebar();
});
document.addEventListener('visibilitychange', markRead);

// Idle → away (unless the user chose DND); back → their chosen status.
let idleTimer = null;
const resetIdle = debounce(() => {
  clearTimeout(idleTimer);
  const chosen = localStorage.getItem('presence') || 'online';
  if (state.presence[ME] === 'away' && chosen === 'online') socket.send('presence.set', { status: 'online' });
  idleTimer = setTimeout(() => chosen === 'online' && socket.send('presence.set', { status: 'away' }), 10 * 60_000);
}, 1000);
for (const ev of ['mousemove', 'keydown', 'focus']) window.addEventListener(ev, resetIdle);

function route() {
  const m = location.pathname.match(/^\/o\/[^/]+\/(c\/([^/]+)|meetings|people)/);
  if (m?.[2]) openConversation(decodeURIComponent(m[2]), { push: false });
  else if (m?.[1] === 'meetings') renderMeetings();
  else if (m?.[1] === 'people') renderPeople();
  else showEmpty();
}
window.addEventListener('popstate', route);

// ------------------------------------------------------------------- start

// ------------------------------------------------------------ push / visible
// The server sends push notifications only while the app is not on screen
// in this organization, so the tab says when it is (visible and focused).
function reportVisible() {
  socket.send('client.visible', { visible: isVisible() });
}
for (const ev of ['visibilitychange', 'focus', 'blur']) (ev === 'visibilitychange' ? document : window).addEventListener(ev, reportVisible);

// Offer notifications on this device once (dismissable); refresh silently
// where they were already allowed. iPhone: only in the installed app.
function renderPushBanner() {
  const box = $('#push-banner');
  const dismissed = localStorage.getItem('push.dismissed') === '1';
  const offer = boot.push && pushSupported() && !state.pushActive && Notification.permission === 'default' && !dismissed;
  const install = boot.push && needsInstall() && !dismissed;
  box.hidden = !(offer || install);
  if (box.hidden) return;
  box.innerHTML = `<div class="small">${icon('bell')} ${esc(t(install ? 'pushInstallHint' : 'pushOffer'))}</div>
    <div class="d-flex gap-2 mt-2">${install ? '' : `<button class="btn btn-primary btn-sm" data-push="enable">${esc(t('pushEnable'))}</button>`}
    <button class="btn btn-link btn-sm p-0" data-push="dismiss">${esc(t('pushLater'))}</button></div>`;
}
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-push]');
  if (!btn) return;
  if (btn.dataset.push === 'dismiss') localStorage.setItem('push.dismissed', '1');
  else {
    state.pushActive = await enablePush(boot.push).catch(() => false);
    toast(t(state.pushActive ? 'pushOn' : 'pushBlocked'), state.pushActive ? 'success' : 'warning');
  }
  renderPushBanner();
});

// Company announcements pinned in the sidebar, each between two calendar
// days of the viewer's own date. Hiding one is per device and lasts until
// the announcement is edited (the stored updated_at no longer matches).
const ANN_KEY = `ann.hidden:${ORG.id}`;
const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const hiddenAnnouncements = () => JSON.parse(localStorage.getItem(ANN_KEY) || '{}');

function renderAnnouncements() {
  const box = $('#announcements');
  const today = localDay();
  const hidden = hiddenAnnouncements();
  const shown = (state.announcements || []).filter((a) => a.starts_on <= today && a.ends_on >= today && hidden[a.id] !== a.updated_at);
  box.hidden = !shown.length;
  box.innerHTML = shown
    .map(
      (a) => `<div class="ann ann-${esc(a.level)}" data-ann="${esc(a.id)}">
      <div class="ann-head">${icon(a.level === 'warning' ? 'alert' : 'megaphone')}<span class="ann-title">${esc(a.title)}</span>
        <button class="btn btn-icon btn-sm ann-hide" data-ann-hide="${esc(a.id)}" title="${esc(t('annHide'))}" aria-label="${esc(t('annHide'))}">${icon('x')}</button></div>
      ${a.body ? `<div class="ann-body">${renderMarkdown(a.body)}</div><button class="btn btn-link btn-sm p-0 ann-toggle" data-ann-toggle hidden>${esc(t('annMore'))}</button>` : ''}
    </div>`
    )
    .join('');
  annToggles();
}

// "More" only where the text is cut off. Measured again whenever the box
// changes size: on phones the sidebar is hidden (nothing to measure) while
// a conversation is open, and at start-up before the first view is chosen.
function annToggles() {
  for (const el of $$('.ann', $('#announcements'))) {
    const body = $('.ann-body', el);
    if (body && body.clientHeight && !el.classList.contains('open')) $('[data-ann-toggle]', el).hidden = body.scrollHeight <= body.clientHeight + 1;
  }
}
new ResizeObserver(annToggles).observe($('#announcements'));

async function refreshAnnouncements() {
  try {
    state.announcements = (await api(`${API}/announcements`)).announcements;
    renderAnnouncements();
  } catch {
    // The next reload brings them.
  }
}

$('#announcements').addEventListener('click', (e) => {
  const hide = e.target.closest('[data-ann-hide]');
  if (hide) {
    const a = state.announcements.find((x) => x.id === hide.dataset.annHide);
    // Only ids still published are kept, so the map does not grow.
    const hidden = Object.fromEntries(Object.entries(hiddenAnnouncements()).filter(([id]) => state.announcements.some((x) => x.id === id)));
    if (a) hidden[a.id] = a.updated_at;
    localStorage.setItem(ANN_KEY, JSON.stringify(hidden));
    return renderAnnouncements();
  }
  const toggle = e.target.closest('[data-ann-toggle]');
  if (toggle) {
    const open = toggle.closest('.ann').classList.toggle('open');
    toggle.textContent = t(open ? 'annLess' : 'annMore');
  }
});
// Day changes (midnight, a laptop waking up) start and end announcements;
// the server only sends those around today, so the list is fetched again.
setInterval(refreshAnnouncements, 5 * 60_000);

(async () => {
  try {
    await loadAll();
  } catch (err) {
    toast(errorText(err), 'danger');
  }
  route();
  socket.connect();
  state.pushActive = await refreshPush(boot.push);
  renderPushBanner();
  // Outbox entries from before a reload are retried once connected; if the
  // socket never opens, fall back to HTTP after a few seconds.
  setTimeout(() => !socket.isOpen() && flushOutbox(), 5000);
})();
