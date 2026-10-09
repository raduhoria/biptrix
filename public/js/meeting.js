import { $, $$, api, esc, hue, icon, initials, randomId, translator } from './lib.js';

// Meeting room client. Media is a peer-to-peer mesh over WebRTC; the server
// (/ws/meeting) only admits people and relays SDP/ICE between admitted
// participants.
//
// Two topologies, chosen by the server per room:
// - mesh: one RTCPeerConnection per peer. The newcomer is always the offerer
//   and creates exactly three transceivers — 0 audio, 1 camera, 2 screen — so
//   there is no glare; ICE restarts come from the same side.
// - sfu: one RTCPeerConnection to Cloudflare Realtime SFU. We publish the same
//   three fixed transceivers once (sfu.push) and subscribe to the others'
//   tracks (sfu.pull → SFU offer → our answer, sfu.renegotiate). The server
//   proxies every call and checks room membership.
// Either way, camera/screen on/off is replaceTrack() on a fixed transceiver.

const boot = JSON.parse($('#boot').textContent);
const t = translator(boot.strings);
const root = $('#meet');
const SLOT = { audio: 0, camera: 1, screen: 2 };

// Reconnection without dropping the call: when the room socket drops (network,
// server restart), the media connections are kept — on peer-to-peer they do
// not need the server — and the socket comes back in the background
// (`resume`). The server keeps the place for 20 s and peers that still hold a
// connection to this page (same PAGE id) keep it. After RESUME_GIVE_UP_MS
// without success the call ends as before.
const PAGE = randomId();
const RESUME_GIVE_UP_MS = 45_000;
const STALE_PEER_MS = 15_000;
const resume = { active: false, since: 0, attempt: 0, timer: null, stale: new Map() };

const state = {
  ws: null,
  self: null,
  peers: new Map(), // participantId → peer
  topology: 'mesh',
  sfu: null, // { pc, senders, midMap: Map<mid, {pid, slot}>, pulled: Map<pid, mids[]>, queue }
  waiting: new Map(),
  reqSeq: 0,
  iceServers: [],
  icePolicy: 'all',
  canManage: false,
  screenAllowed: false,
  local: { audio: null, video: null, screen: null },
  mic: localStorage.getItem('meet.mic') !== '0',
  cam: localStorage.getItem('meet.cam') !== '0',
  devices: { mic: localStorage.getItem('meet.micId') || '', cam: localStorage.getItem('meet.camId') || '', spk: localStorage.getItem('meet.spkId') || '' },
  joined: false,
  leaving: false,
  spotlight: true,
  lobby: [],
  audioCtx: null,
  // In-call chat: mode conversation | meeting | none (see core/meeting-rooms.js).
  chat: { mode: 'none', messages: [], pending: new Map(), unread: 0 },
  ringing: false,
};
// From a call (?call=audio|video): the camera follows the call kind.
if (boot.call) state.cam = boot.call === 'video';

function stage(name) {
  root.dataset.stage = name;
}

// Leaving the room by any path (ended, removed, rejected, disconnected)
// releases the camera, microphone and screen, and the media connections.
function setEnded(titleKey, textKey = '', allowRejoin = false) {
  stage('ended');
  teardownPeers();
  for (const kind of ['audio', 'video', 'screen']) stopTrack(kind);
  $('#ended-title').textContent = t(titleKey);
  $('#ended-text').textContent = textKey ? t(textKey) : '';
  $('#rejoin-btn').hidden = !allowRejoin;
}

// ------------------------------------------------------------- local media

async function startCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: state.devices.cam ? { exact: state.devices.cam } : undefined, width: { ideal: 1280 }, height: { ideal: 720 } } });
    state.local.video = stream.getVideoTracks()[0];
  } catch (err) {
    state.cam = false;
    showMediaError(err);
  }
}

async function startMic() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: state.devices.mic ? { exact: state.devices.mic } : undefined, echoCancellation: true, noiseSuppression: true } });
    state.local.audio = stream.getAudioTracks()[0];
    state.local.audio.enabled = state.mic;
  } catch (err) {
    state.mic = false;
    showMediaError(err);
  }
}

function showMediaError(err) {
  const box = $('#media-error');
  box.hidden = false;
  box.textContent = !window.isSecureContext ? t('meet.insecure') : err?.name === 'NotAllowedError' ? t('meet.permissionDenied') : t('meet.deviceError');
}

function stopTrack(kind) {
  state.local[kind]?.stop();
  state.local[kind] = null;
}

async function listDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  const devices = await navigator.mediaDevices.enumerateDevices();
  const fill = (sel, kind, current) => {
    const list = devices.filter((d) => d.kind === kind);
    sel.innerHTML = list.map((d, i) => `<option value="${esc(d.deviceId)}"${d.deviceId === current ? ' selected' : ''}>${esc(d.label || `${kind} ${i + 1}`)}</option>`).join('') || `<option>—</option>`;
  };
  // The same choices before joining and in the call's settings tab.
  for (const sel of $$('[data-device="mic"]')) fill(sel, 'audioinput', state.local.audio?.getSettings().deviceId || state.devices.mic);
  for (const sel of $$('[data-device="cam"]')) fill(sel, 'videoinput', state.local.video?.getSettings().deviceId || state.devices.cam);
  // Speaker choice: only where the browser can route audio (not Safari/iOS).
  const outputs = devices.filter((d) => d.kind === 'audiooutput');
  $('#set-spk-box').hidden = !canPickSpeaker || !outputs.length;
  if (canPickSpeaker) fill($('#set-spk'), 'audiooutput', state.devices.spk || 'default');
}

const canPickSpeaker = 'setSinkId' in HTMLMediaElement.prototype;

// Remote audio plays through the tiles' video elements.
function applySpeaker(el = null) {
  if (!canPickSpeaker || !state.devices.spk) return;
  for (const video of el ? [el] : $$('#tiles .tile:not(.self-tile) video')) video.setSinkId(state.devices.spk).catch(() => {});
}

// Switching a device during the call replaces the track on the existing
// connections (no renegotiation, nobody notices but the sound/picture).
async function changeDevice(kind, id) {
  state.devices[kind] = id;
  localStorage.setItem(`meet.${kind}Id`, id);
  if (kind === 'spk') return applySpeaker();
  if (kind === 'mic') {
    stopTrack('audio');
    await startMic();
    pushTrack(SLOT.audio);
    announceMedia();
  } else if (state.cam) {
    stopTrack('video');
    await startCamera();
    pushTrack(SLOT.camera);
    announceMedia();
  }
  renderPreview();
  renderLocalTile();
  await listDevices().catch(() => {});
}

// Microphone level in the settings tab, so a choice can be checked.
let meter = null;
function runMeter() {
  const on = !$('#meet-panel').hidden && $('#meet-panel').dataset.tab === 'settings' && state.local.audio && state.mic;
  if (!on) {
    $('#mic-level').style.width = '0';
    meter = null;
    return;
  }
  try {
    if (meter?.trackId !== state.local.audio.id) {
      state.audioCtx ||= new AudioContext();
      const analyser = state.audioCtx.createAnalyser();
      analyser.fftSize = 512;
      state.audioCtx.createMediaStreamSource(new MediaStream([state.local.audio])).connect(analyser);
      meter = { trackId: state.local.audio.id, analyser, buf: new Uint8Array(analyser.frequencyBinCount) };
    }
    meter.analyser.getByteFrequencyData(meter.buf);
    const level = meter.buf.reduce((a, b) => a + b, 0) / meter.buf.length;
    $('#mic-level').style.width = `${Math.min(100, level * 2)}%`;
  } catch {
    return;
  }
  setTimeout(runMeter, 120);
}

function renderPreview() {
  const video = $('#preview');
  video.srcObject = state.local.video ? new MediaStream([state.local.video]) : null;
  $('#preview-off').hidden = !!state.local.video;
  for (const btn of $$('[data-action="pre-mic"], [data-action="mic"]')) setToggle(btn, state.mic, 'mic');
  for (const btn of $$('[data-action="pre-cam"], [data-action="cam"]')) setToggle(btn, state.cam && !!state.local.video, 'video');
}

function setToggle(btn, on, name) {
  btn.classList.toggle('off', !on);
  btn.innerHTML = icon(on ? name : `${name}-off`);
}

// ----------------------------------------------------------------- signaling

function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/meeting?id=${encodeURIComponent(boot.meeting.id)}`);
  state.ws = ws;
  ws.onopen = () => sendJoin();
  ws.onmessage = (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    if (msg.re && state.waiting.has(msg.re)) {
      const { resolve, reject } = state.waiting.get(msg.re);
      state.waiting.delete(msg.re);
      return msg.type === 'error' ? reject(new Error(msg.data?.message || 'error')) : resolve(msg.data || {});
    }
    onServer(msg.type, msg.data || {});
  };
  ws.onclose = (e) => {
    if (state.ws !== ws) return;
    state.ws = null;
    for (const w of state.waiting.values()) w.reject(new Error('disconnected'));
    state.waiting.clear();
    if (state.leaving || ['ended', 'removed', 'rejected', 'replaced'].includes(e.reason)) return teardownPeers();
    // Network drop or server restart while in the room: keep the call and
    // reconnect in the background (the server re-checks admission).
    if ([1001, 1006, 1011, 1012].includes(e.code) && state.joined && root.dataset.stage === 'room') return startResume();
    teardownPeers();
    if (e.code === 1006 || e.code === 1001 || e.code === 1011 || e.reason === 'rejoin') {
      // Not in the room yet (or the SFU path broke): rejoin from scratch.
      setTimeout(() => !state.leaving && connect(), 2000);
      return;
    }
    if (root.dataset.stage !== 'ended') setEnded('meet.disconnected', '', true);
  };
}

function startResume() {
  if (!resume.active) {
    resume.active = true;
    resume.since = Date.now();
    resume.attempt = 0;
    root.dataset.reconnecting = '1';
    callBanner(t('meet.reconnecting'));
  }
  if (Date.now() - resume.since > RESUME_GIVE_UP_MS) {
    endResume();
    teardownPeers();
    return setEnded('meet.disconnected', '', true);
  }
  const delay = Math.min(5000, 500 * 2 ** resume.attempt++);
  clearTimeout(resume.timer);
  resume.timer = setTimeout(() => !state.leaving && connect(), delay);
}

function endResume() {
  resume.active = false;
  clearTimeout(resume.timer);
  delete root.dataset.reconnecting;
  callBanner('');
}

// Reconciling after a resume, without two sides offering at once:
// - a side that kept its connection to a peer marks it `kept` (for
//   STALE_PEER_MS): an offer arriving for it means the other side rebuilt, so
//   it rebuilds too and answers; a `rebuild` request makes it rebuild and offer;
// - the resuming side offers to peers it could not keep;
// - a side that sees a resumed peer it cannot keep waits for an offer and
//   asks for one (`rebuild`), which a side that is already offering ignores.
function markKept(peer) {
  peer.kept = true;
  clearTimeout(peer.keptTimer);
  peer.keptTimer = setTimeout(() => (peer.kept = false), STALE_PEER_MS);
}

function rebuildPeer(id, initiator) {
  const info = state.peers.get(id)?.info;
  if (!info) return null;
  removePeer(id);
  addPeer(info, initiator);
  return state.peers.get(id);
}

// A peer we hold a working connection to, from the same page.
function keepable(peer, info) {
  if (!peer || !info.page || peer.info.page !== info.page) return false;
  if (state.topology === 'sfu') return true;
  return !!peer.pc && !['failed', 'closed'].includes(peer.pc.connectionState);
}

// After a resumed join: keep what still works, rebuild what does not, and
// give peers that are not back yet a moment before dropping them.
function onResumed(d) {
  endResume();
  const listed = new Set(d.peers.map((p) => p.id));
  for (const info of d.peers) {
    const peer = state.peers.get(info.id);
    clearTimeout(resume.stale.get(info.id));
    resume.stale.delete(info.id);
    if (keepable(peer, info)) {
      peer.info = { ...peer.info, ...info };
      markKept(peer);
      renderTile(peer);
    } else addPeer(info, d.topology !== 'sfu');
  }
  for (const id of state.peers.keys()) {
    if (listed.has(id) || resume.stale.has(id)) continue;
    resume.stale.set(id, setTimeout(() => {
      resume.stale.delete(id);
      removePeer(id);
      renderPeople();
    }, STALE_PEER_MS));
  }
  if (d.topology === 'sfu' && !(d.sfu_resumed && state.sfu)) {
    const sfu = state.sfu;
    state.sfu = null;
    sfu?.pc.close();
    state.topology = 'sfu';
    sfuStart();
  } else if (d.topology !== state.topology) moveTo(d.topology);
  renderPeople();
  layout();
}

function send(type, data = {}, id = undefined) {
  if (state.ws?.readyState !== WebSocket.OPEN) return false;
  state.ws.send(JSON.stringify({ v: 1, type, id, data }));
  return true;
}

// request: a frame whose reply carries `re` (SFU calls).
function request(type, data) {
  const id = `r${++state.reqSeq}`;
  return new Promise((resolve, reject) => {
    state.waiting.set(id, { resolve, reject });
    if (!send(type, data, id)) {
      state.waiting.delete(id);
      reject(new Error('disconnected'));
    }
    setTimeout(() => {
      if (state.waiting.delete(id)) reject(new Error(`timeout ${type}`));
    }, 20_000);
  });
}

function sendJoin() {
  const name = $('#guest-name')?.value.trim() || boot.displayName;
  send('join', { name, page: PAGE, resume: resume.active, audio: state.mic && !!state.local.audio, video: state.cam && !!state.local.video });
}

function onServer(type, d) {
  switch (type) {
    case 'lobby':
      return stage('lobby');
    case 'admitted':
      return sendJoin();
    case 'rejected':
      return setEnded('meet.rejectedTitle', 'meet.rejectedText');
    case 'removed':
      return setEnded('meet.removedTitle', 'meet.removedText');
    case 'replaced':
      return setEnded('meet.replacedTitle');
    case 'ended':
      return setEnded('meet.ended', 'meet.endedText');
    case 'joined':
      return onJoined(d);
    case 'peer.tracks': {
      const p = state.peers.get(d.id);
      if (p) {
        p.info.tracks = d.tracks;
        meshDoneFor(p);
      }
      return sfuSync();
    }
    case 'peer.joined': {
      clearTimeout(resume.stale.get(d.id));
      resume.stale.delete(d.id);
      // A peer coming back from a dropped socket, to whom our media path
      // still works: nothing to rebuild.
      const known = state.peers.get(d.id);
      if (d.resume && keepable(known, d)) {
        known.info = { ...known.info, ...d };
        markKept(known);
        renderTile(known);
        return renderPeople();
      }
      addPeer(d, false);
      // It kept a connection to us that we no longer have: ask it to offer.
      if (d.resume && state.topology !== 'sfu') send('signal', { to: d.id, data: { rebuild: true } });
      if (state.ringing) callBanner('');
      return renderPeople();
    }
    case 'chat.message':
      return onChatMessage(d);
    case 'call.declined':
      state.ringing = false;
      return callBanner(t('meet.callDeclined', { name: d.name }));
    case 'call.missed':
      state.ringing = false;
      return state.peers.size ? callBanner('') : callBanner(t('meet.callMissed'));
    case 'peer.left':
      removePeer(d.id);
      return renderPeople();
    case 'peer.media': {
      const p = state.peers.get(d.id);
      if (p) {
        p.info.media = d.media;
        renderTile(p);
        layout();
      }
      return renderPeople();
    }
    case 'peer.role': {
      const p = state.peers.get(d.id);
      if (p) p.info.role = d.role;
      if (state.self?.id === d.id) state.self.role = d.role;
      return renderPeople();
    }
    case 'role':
      state.canManage = d.can_manage;
      return renderControls();
    case 'topology':
      return moveTo(d.topology);
    case 'signal':
      return onSignal(d.from, d.data);
    case 'lobby.update':
      return onLobby(d.waiting);
    case 'error':
      if (d.code === 'room_full') return setEnded('meet.fullTitle', 'meet.fullText', true);
      if (d.reason === 'screenShare') stopScreen();
      return console.warn('meeting error', d);
    default:
  }
}

function onJoined(d) {
  const resuming = resume.active && state.joined;
  state.joined = true;
  state.self = d.self;
  state.iceServers = d.ice_servers;
  state.icePolicy = d.ice_policy || 'all';
  state.canManage = d.can_manage;
  state.screenAllowed = d.screen_share;
  if (resuming) {
    renderControls();
    onChatState(d.chat);
    return onResumed(d);
  }
  stage('room');
  renderControls();
  addLocalTile();
  state.topology = d.topology;
  if (d.topology === 'sfu') {
    for (const info of d.peers) addPeer(info, false);
    sfuStart();
  } else {
    // Newcomer offers to everyone already in the room.
    for (const info of d.peers) addPeer(info, true);
  }
  renderPeople();
  layout();
  onChatState(d.chat);
  // The caller, alone in the room while the others' phones ring.
  state.ringing = !!d.call?.ringing && !state.peers.size && state.self.role === 'host';
  if (state.ringing) callBanner(t('meet.calling'), true);
  else if (!state.peers.size && state.self.role === 'host' && d.call?.outcome === 'declined') callBanner(t('meet.callDeclinedEarly'));
  else if (!state.peers.size && state.self.role === 'host' && d.call?.outcome === 'missed') callBanner(t('meet.callMissed'));
}

// ------------------------------------------------------------------- calls

function callBanner(text, ringing = false) {
  const el = $('#call-banner');
  el.hidden = !text;
  el.innerHTML = text ? `${ringing ? '<span class="ring-dot"></span>' : ''}${esc(text)}` : '';
}

// --------------------------------------------------------------- room chat
// Messages are sent over the room socket and confirmed (chat.ok); until
// then they show as pending, and are sent again after a reconnect with the
// same client id (the server stores each once).

function onChatState(chat) {
  state.chat.mode = chat?.mode || 'none';
  state.chat.messages = chat?.messages || [];
  $('#btn-chat').hidden = state.chat.mode === 'none' && !state.chat.messages.length;
  $('#chat-none').hidden = state.chat.mode !== 'none';
  $('#chat-form').hidden = state.chat.mode === 'none';
  for (const p of state.chat.pending.values()) sendChat(p);
  renderChat(true);
}

const isMine = (m) => (m.participant_id && m.participant_id === state.self?.id) || (!!m.author_id && m.author_id === boot.userId);

function onChatMessage(m) {
  const list = state.chat.messages;
  const i = list.findIndex((x) => x.id === m.id);
  if (m.deleted) {
    if (i >= 0) list.splice(i, 1);
  } else if (i >= 0) list[i] = m;
  else {
    list.push(m);
    if (!isMine(m) && !chatOpen()) {
      state.chat.unread++;
      renderChatBadge();
    }
  }
  state.chat.pending.delete(m.client_id);
  renderChat();
}

const chatOpen = () => !$('#meet-panel').hidden && $('#meet-panel').dataset.tab === 'chat';

function renderChatBadge() {
  const badge = $('#chat-badge');
  badge.hidden = !state.chat.unread;
  badge.textContent = state.chat.unread > 9 ? '9+' : state.chat.unread;
}

function renderChat(scroll = false) {
  const box = $('#chat-list');
  const atBottom = scroll || box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  const time = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const files = (m) => (m.attachments || []).map((a) => `<div><a href="/api/o/${esc(boot.org.slug)}/files/${esc(a.id)}" target="_blank" rel="noopener">📎 ${esc(a.name)}</a></div>`).join('');
  const row = (m, pending = false) => {
    const mine = pending || isMine(m);
    return `<div class="meet-msg${mine ? ' mine' : ''}${pending ? ' pending' : ''}">
      <div class="meet-msg-head">${mine ? '' : `${esc(m.name)} · `}${esc(time(m.created_at))}</div>
      <div class="meet-msg-body">${esc(m.body)}${files(m)}</div></div>`;
  };
  box.innerHTML = [...state.chat.messages.map((m) => row(m)), ...[...state.chat.pending.values()].map((p) => row(p, true))].join('');
  if (atBottom) box.scrollTop = box.scrollHeight;
}

function sendChat(p) {
  request('chat.send', { client_id: p.client_id, body: p.body }).catch(() => {
    // Kept as pending; sent again on the next join.
  });
}

// Bar buttons toggle their tab; the tab headers only switch.
function showPanel(tab, toggle = true) {
  const panel = $('#meet-panel');
  panel.hidden = toggle && !panel.hidden && panel.dataset.tab === tab;
  panel.dataset.tab = tab;
  if (!panel.hidden && tab === 'settings') {
    listDevices().catch(() => {});
    if (!meter) runMeter();
  }
  if (!panel.hidden && tab === 'chat') {
    state.chat.unread = 0;
    renderChatBadge();
    renderChat(true);
    $('#chat-form textarea').focus();
  }
}

$('#chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const area = e.target.body;
  const body = area.value.trim();
  if (!body || state.chat.mode === 'none') return;
  const p = { client_id: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`, body, created_at: new Date().toISOString() };
  state.chat.pending.set(p.client_id, p);
  area.value = '';
  renderChat(true);
  sendChat(p);
});

$('#chat-form textarea').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $('#chat-form').requestSubmit();
  }
});

// ---------------------------------------------------------------------- sfu
// Cloudflare refuses to pull a track that has not sent packets yet, so audio
// and camera always send something: the real track, or a placeholder
// (silence / a black 1 fps frame) while muted or off — the camera itself is
// still released. The screen is published only while shared.

const placeholders = {};

function placeholderTrack(kind) {
  if (placeholders[kind]?.readyState === 'live') return placeholders[kind];
  if (kind === 'audio') {
    state.audioCtx ||= new AudioContext();
    const dest = state.audioCtx.createMediaStreamDestination();
    const osc = state.audioCtx.createOscillator();
    const gain = state.audioCtx.createGain();
    gain.gain.value = 0;
    osc.connect(gain).connect(dest);
    osc.start();
    placeholders.audio = dest.stream.getAudioTracks()[0];
  } else {
    const canvas = Object.assign(document.createElement('canvas'), { width: 160, height: 90 });
    const ctx = canvas.getContext('2d');
    let tick = 0;
    const paint = () => {
      ctx.fillStyle = tick++ % 2 ? '#000' : '#010101';
      ctx.fillRect(0, 0, 160, 90);
    };
    paint();
    setInterval(paint, 500);
    placeholders.video = canvas.captureStream(2).getVideoTracks()[0];
  }
  return placeholders[kind];
}

function sfuTrackFor(slot) {
  if (slot === 'audio') return state.local.audio || placeholderTrack('audio');
  return (state.cam && state.local.video) || placeholderTrack('video');
}

function sfuEnqueue(fn) {
  const sfu = state.sfu;
  sfu.queue = sfu.queue.then(fn).catch((err) => console.error('SFU', err));
  return sfu.queue;
}

// Resolves once the sender has put packets on the wire (or after ~6 s).
async function sending(sender) {
  for (let i = 0; i < 20; i++) {
    const stats = await sender.getStats();
    for (const r of stats.values()) if (r.type === 'outbound-rtp' && r.packetsSent > 0) return;
    await new Promise((res) => setTimeout(res, 300));
  }
}

async function sfuStart() {
  const pc = new RTCPeerConnection({ iceServers: state.iceServers, iceTransportPolicy: state.icePolicy, bundlePolicy: 'max-bundle' });
  const sfu = (state.sfu = { pc, senders: {}, screen: null, midMap: new Map(), pulled: new Map(), failures: new Map(), queue: Promise.resolve(), connected: false });
  pc.ontrack = (e) => {
    const target = sfu.midMap.get(e.transceiver.mid);
    const peer = target && state.peers.get(target.pid);
    if (!peer) return;
    // Back on peer-to-peer with a working connection: that one is shown.
    if (state.topology === 'mesh' && peer.pc?.connectionState === 'connected') return;
    whenLive(e.track, () => {
      if (state.sfu !== sfu || (state.topology === 'mesh' && peer.pc?.connectionState === 'connected')) return;
      showTrack(peer, target.slot, e.track);
      peer.sfuGot.add(target.slot);
      meshDoneFor(peer);
    });
  };
  pc.onconnectionstatechange = async () => {
    if (pc.connectionState === 'connected' && !sfu.connected) {
      sfu.connected = true;
      await Promise.all([sending(sfu.senders.audio.sender), sending(sfu.senders.camera.sender)]);
      send('sfu.publish', { slots: ['audio', 'camera'] });
      if (state.local.screen) sfuScreenOn();
      sfuSync();
    }
    // A broken SFU connection: rejoin from scratch (the server re-admits).
    if (pc.connectionState === 'failed') state.ws?.close(4000, 'rejoin');
  };
  await sfuEnqueue(async () => {
    sfu.senders.audio = pc.addTransceiver(sfuTrackFor('audio'), { direction: 'sendonly' });
    sfu.senders.camera = pc.addTransceiver(sfuTrackFor('camera'), { direction: 'sendonly' });
    await pc.setLocalDescription(await pc.createOffer());
    const res = await request('sfu.push', { sdp: pc.localDescription, tracks: [{ mid: sfu.senders.audio.mid, slot: 'audio' }, { mid: sfu.senders.camera.mid, slot: 'camera' }] });
    await pc.setRemoteDescription(res.sdp);
  });
}

// Brings subscriptions in line with what everyone has published: pull new
// tracks, close the ones that disappeared (a screen share that ended, a
// participant who left). Failed pulls are retried shortly.
function sfuSync() {
  const sfu = state.sfu;
  if (!sfu?.connected) return;
  return sfuEnqueue(async () => {
    const live = new Map();
    for (const peer of state.peers.values()) for (const [slot, trackName] of Object.entries(peer.info.tracks || {})) live.set(trackName, { pid: peer.info.id, slot });
    const stale = [...sfu.pulled].filter(([name]) => !live.has(name));
    if (stale.length) {
      for (const [name, t] of stale) {
        sfu.pulled.delete(name);
        sfu.midMap.delete(t.mid);
        const peer = state.peers.get(t.pid);
        if (peer && t.slot === 'screen') {
          for (const tr of peer.screen.getTracks()) peer.screen.removeTrack(tr);
          renderTile(peer);
        }
      }
      await request('sfu.close', { mids: stale.map(([, t]) => t.mid) });
    }
    const wanted = [...live].filter(([name]) => !sfu.pulled.has(name)).map(([, t]) => ({ participant_id: t.pid, slot: t.slot }));
    if (!wanted.length) return;
    const res = await request('sfu.pull', { tracks: wanted });
    for (const t of res.tracks) {
      sfu.midMap.set(t.mid, { pid: t.participant_id, slot: t.slot });
      sfu.pulled.set(t.trackName, { pid: t.participant_id, slot: t.slot, mid: t.mid });
    }
    if (res.sdp && res.renegotiate) {
      await sfu.pc.setRemoteDescription(res.sdp);
      await sfu.pc.setLocalDescription(await sfu.pc.createAnswer());
      await request('sfu.renegotiate', { sdp: sfu.pc.localDescription });
    }
    for (const f of res.failed) {
      const n = (sfu.failures.get(f.trackName) || 0) + 1;
      sfu.failures.set(f.trackName, n);
      if (n <= 10) setTimeout(sfuSync, 1000 * n);
    }
  });
}

function sfuScreenOn() {
  const sfu = state.sfu;
  if (!sfu?.connected || !state.local.screen) return;
  return sfuEnqueue(async () => {
    sfu.screen = sfu.pc.addTransceiver(state.local.screen, { direction: 'sendonly' });
    await sfu.pc.setLocalDescription(await sfu.pc.createOffer());
    const res = await request('sfu.push', { sdp: sfu.pc.localDescription, tracks: [{ mid: sfu.screen.mid, slot: 'screen' }] });
    await sfu.pc.setRemoteDescription(res.sdp);
    await sending(sfu.screen.sender);
    send('sfu.publish', { slots: ['screen'] });
  });
}

function sfuScreenOff() {
  const sfu = state.sfu;
  if (!sfu?.screen) return;
  const tr = sfu.screen;
  sfu.screen = null;
  return sfuEnqueue(async () => {
    await request('sfu.unpublish', { slot: 'screen' });
    await tr.sender.replaceTrack(null);
  });
}

function sfuDrop() {
  // A participant who left: their tracks vanish from the published set.
  sfuSync();
}

// ------------------------------------------------------------------- peers

function addPeer(info, initiator = false) {
  if (state.peers.has(info.id)) removePeer(info.id);
  const peer = { info, initiator, pc: null, pendingIce: [], stream: new MediaStream(), screen: new MediaStream(), tile: null, screenTile: null, level: 0, meshTracks: {}, sfuGot: new Set() };
  state.peers.set(info.id, peer);
  createTile(peer);
  if (initiator) startCall(peer);
  capAll();
}

function createPc(peer) {
  const pc = new RTCPeerConnection({ iceServers: state.iceServers, iceTransportPolicy: state.icePolicy });
  peer.pc = pc;
  pc.onicecandidate = (e) => e.candidate && send('signal', { to: peer.info.id, data: { candidate: e.candidate } });
  pc.ontrack = (e) => {
    const slot = SLOT_NAMES[pc.getTransceivers().indexOf(e.transceiver)];
    peer.meshTracks[slot] = e.track;
    // While the SFU still carries this peer, switch only once this
    // connection is up (make before break).
    if (state.topology === 'mesh' && (!state.sfu || pc.connectionState === 'connected')) showTrack(peer, slot, e.track);
  };
  pc.onconnectionstatechange = () => {
    if (state.topology === 'mesh') peer.tile?.classList.toggle('connecting', !['connected', 'completed'].includes(pc.connectionState));
    if (pc.connectionState === 'connected' && state.topology === 'mesh') {
      for (const [slot, track] of Object.entries(peer.meshTracks)) {
        whenLive(track, () => {
          if (peer.pc !== pc || state.topology !== 'mesh') return;
          showTrack(peer, slot, track);
          sfuDoneCheck();
        });
      }
      sfuDoneCheck();
    }
    // Only the side that offered restarts ICE, so restarts never collide.
    if (pc.connectionState === 'failed' && peer.initiator) {
      pc.restartIce();
      offer(peer, { iceRestart: true });
    }
  };
  return pc;
}

function localTrackFor(slot) {
  if (slot === SLOT.audio) return state.local.audio;
  if (slot === SLOT.camera) return state.cam ? state.local.video : null;
  return state.local.screen;
}

async function startCall(peer) {
  const pc = createPc(peer);
  for (const kind of ['audio', 'video', 'video']) pc.addTransceiver(kind, { direction: 'sendrecv' });
  pc.getTransceivers().forEach((tr, i) => tr.sender.replaceTrack(localTrackFor(i)));
  await offer(peer);
}

async function offer(peer, options = {}) {
  const sdp = await peer.pc.createOffer(options);
  await peer.pc.setLocalDescription(sdp);
  send('signal', { to: peer.info.id, data: { sdp: peer.pc.localDescription } });
  capPeer(peer);
}

// ------------------------------------------------------------- mesh quality
// Peer-to-peer, every participant sends its picture once per other person,
// so the quality of each copy goes down as the call grows: the total upload
// stays around 2 Mbps (fine on a phone or weak Wi-Fi) instead of growing to
// 10+ Mbps at six people. Applied with setParameters, no renegotiation;
// re-applied whenever someone joins or leaves. (On the SFU each picture is
// sent once and the SFU adapts it per receiver.)
function meshCaps(others) {
  if (others <= 1) return { camera: { maxBitrate: 1_500_000, scaleResolutionDownBy: 1 }, screen: { maxBitrate: 2_500_000 } };
  if (others <= 3) return { camera: { maxBitrate: 800_000, scaleResolutionDownBy: 4 / 3 }, screen: { maxBitrate: 1_500_000 } };
  return { camera: { maxBitrate: 400_000, scaleResolutionDownBy: 2 }, screen: { maxBitrate: 1_000_000 } };
}

async function capSender(sender, cap, degradation = 'balanced') {
  const params = sender.getParameters();
  if (!params.encodings?.length) return; // not negotiated yet; applied after
  const enc = params.encodings[0];
  if (enc.maxBitrate === cap.maxBitrate && (enc.scaleResolutionDownBy || 1) === (cap.scaleResolutionDownBy || 1) && params.degradationPreference === degradation) return;
  Object.assign(enc, cap);
  params.degradationPreference = degradation;
  await sender.setParameters(params).catch(() => {});
}

function capPeer(peer) {
  if (!peer.pc) return;
  const caps = meshCaps(state.peers.size);
  const tr = peer.pc.getTransceivers();
  if (tr[SLOT.camera]) capSender(tr[SLOT.camera].sender, caps.camera);
  if (tr[SLOT.screen]) capSender(tr[SLOT.screen].sender, caps.screen, 'maintain-resolution');
}

const capAll = () => {
  for (const peer of state.peers.values()) capPeer(peer);
};

async function onSignal(from, data) {
  let peer = state.peers.get(from);
  if (!peer) return;
  if (data.rebuild) {
    if (peer.kept) rebuildPeer(from, true);
    return;
  }
  // An offer for a connection we kept across a resume: the other side
  // rebuilt it, so we do too.
  if (data.sdp?.type === 'offer' && peer.kept) {
    peer = rebuildPeer(from, false);
    if (!peer) return;
  }
  try {
    if (data.sdp) {
      if (data.sdp.type === 'offer') {
        if (!peer.pc) createPc(peer);
        await peer.pc.setRemoteDescription(data.sdp);
        // The offer created our three transceivers; attach local tracks.
        peer.pc.getTransceivers().forEach((tr, i) => {
          tr.direction = 'sendrecv';
          tr.sender.replaceTrack(localTrackFor(i));
        });
        await peer.pc.setLocalDescription(await peer.pc.createAnswer());
        send('signal', { to: from, data: { sdp: peer.pc.localDescription } });
        capPeer(peer);
      } else if (peer.pc) {
        await peer.pc.setRemoteDescription(data.sdp);
      }
      for (const c of peer.pendingIce.splice(0)) await peer.pc.addIceCandidate(c).catch(() => {});
    } else if (data.candidate) {
      if (peer.pc?.remoteDescription) await peer.pc.addIceCandidate(data.candidate).catch(() => {});
      else peer.pendingIce.push(data.candidate);
    }
  } catch (err) {
    console.error('signal failed', err);
  }
}

function removePeer(id) {
  const peer = state.peers.get(id);
  if (!peer) return;
  peer.pc?.close();
  peer.tile?.remove();
  peer.screenTile?.remove();
  state.peers.delete(id);
  capAll();
  if (state.sfu) sfuDrop();
  layout();
}

function teardownPeers() {
  clearTimeout(moveTimer);
  const sfu = state.sfu;
  state.sfu = null;
  sfu?.pc.close();
  for (const id of [...state.peers.keys()]) removePeer(id);
}

// ---------------------------------------------------------- topology moves
// The server moves a call between peer-to-peer and the SFU (core/
// meeting-rooms.js) and says so with `topology`. The new path is built
// while the old one still plays; a peer's tile switches to the new path
// track by track as it becomes live, and the old path is closed when the
// new one carries everything (or after MOVE_TIMEOUT_MS). The room socket
// stays connected throughout.
const SLOT_NAMES = ['audio', 'camera', 'screen'];
const MOVE_TIMEOUT_MS = 12_000;
let moveTimer = null;

// A new track is only shown once media flows on it (a track starts muted
// until its first packets), so a move never shows a frozen picture.
function whenLive(track, fn) {
  if (!track.muted) return fn();
  track.addEventListener('unmute', fn, { once: true });
}

// Calls fn once the element has painted a frame (or after 3 s).
function onFrame(video, fn) {
  let done = false;
  const once = () => !done && ((done = true), fn());
  if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(once);
  else video.addEventListener('playing', once, { once: true });
  setTimeout(once, 3000);
}

function showTrack(peer, slot, track) {
  const target = slot === 'screen' ? peer.screen : peer.stream;
  if (target.getTracks().includes(track)) return;
  // Replacing the picture of a tile that is playing: a video element whose
  // track changes restarts its decoder (about a second of frozen picture).
  // The new track plays first in a cover element over the tile; the tile's
  // own element switches underneath, and the cover goes once it paints.
  const current = target.getVideoTracks()[0];
  const main = slot !== 'screen' && peer.tile && $('video', peer.tile);
  if (track.kind === 'video' && main && current?.readyState === 'live' && !current.muted) {
    $('.tile-cover', peer.tile)?.remove();
    const cover = Object.assign(document.createElement('video'), { className: 'tile-cover', muted: true, autoplay: true, playsInline: true });
    cover.srcObject = new MediaStream([track]);
    peer.tile.append(cover);
    onFrame(cover, () => {
      target.removeTrack(current);
      target.addTrack(track);
      track.onunmute = () => renderTile(peer);
      track.onmute = () => renderTile(peer);
      renderTile(peer);
      onFrame(main, () => cover.remove());
    });
    return;
  }
  for (const tr of target.getTracks()) if (tr.kind === track.kind) target.removeTrack(tr);
  target.addTrack(track);
  track.onunmute = () => renderTile(peer);
  track.onmute = () => renderTile(peer);
  peer.tile?.classList.remove('connecting');
  renderTile(peer);
  if (track.kind === 'audio') watchLevel(peer);
}

function closeMesh(peer) {
  peer.pc?.close();
  peer.pc = null;
  peer.meshTracks = {};
  peer.pendingIce = [];
}

// On the SFU: a peer's direct connection goes once the SFU brings all it
// publishes.
function meshDoneFor(peer) {
  if (state.topology !== 'sfu' || !peer.pc) return;
  const published = Object.keys(peer.info.tracks || {}).filter((slot) => slot !== 'screen');
  if (published.length && published.every((slot) => peer.sfuGot.has(slot))) closeMesh(peer);
}

// Back on peer-to-peer: the SFU session goes once every peer is connected
// directly and their sound (and picture, if their camera is on) arrives
// that way.
function sfuDoneCheck() {
  if (state.topology !== 'mesh' || !state.sfu) return;
  const live = (track) => track && !track.muted;
  const direct = (p) => p.pc?.connectionState === 'connected' && live(p.meshTracks.audio) && (p.info.media?.video === false || live(p.meshTracks.camera));
  if ([...state.peers.values()].every(direct)) leaveSfu();
}

function leaveSfu() {
  const sfu = state.sfu;
  if (!sfu) return;
  state.sfu = null;
  clearTimeout(moveTimer);
  request('sfu.leave', {}).catch(() => {});
  sfu.pc.close();
  for (const peer of state.peers.values()) {
    peer.sfuGot.clear();
    for (const [slot, track] of Object.entries(peer.meshTracks)) whenLive(track, () => peer.meshTracks[slot] === track && showTrack(peer, slot, track));
  }
}

function moveTo(topology) {
  if (!state.joined || state.topology === topology) return;
  state.topology = topology;
  clearTimeout(moveTimer);
  if (topology === 'sfu') {
    for (const peer of state.peers.values()) peer.sfuGot.clear();
    if (!state.sfu) sfuStart();
    // Whatever has not moved by then is closed anyway.
    moveTimer = setTimeout(() => {
      for (const peer of state.peers.values()) if (state.topology === 'sfu') closeMesh(peer);
    }, MOVE_TIMEOUT_MS);
  } else {
    // Each pair connects directly; the lower id offers, so no two offers cross.
    for (const peer of state.peers.values()) {
      if (peer.pc) continue;
      peer.initiator = state.self.id < peer.info.id;
      if (peer.initiator) startCall(peer);
    }
    moveTimer = setTimeout(() => state.topology === 'mesh' && leaveSfu(), MOVE_TIMEOUT_MS);
    sfuDoneCheck();
  }
}

// Track changes reach every peer without renegotiation.
function pushTrack(slot) {
  const track = localTrackFor(slot);
  if (state.sfu && slot !== SLOT.screen) state.sfu.senders[slot === SLOT.audio ? 'audio' : 'camera']?.sender.replaceTrack(sfuTrackFor(slot === SLOT.audio ? 'audio' : 'camera')).catch(() => {});
  for (const peer of state.peers.values()) {
    const tr = peer.pc?.getTransceivers()[slot];
    if (tr) tr.sender.replaceTrack(track).catch(() => {});
  }
}

function announceMedia() {
  send('media', { audio: state.mic && !!state.local.audio, video: state.cam && !!state.local.video, screen: !!state.local.screen });
}

// ------------------------------------------------------------------- tiles

// Full screen for one tile (button or double-click). iPhone Safari has no
// element full screen: its own video player is used there.
function toggleFullscreen(tile) {
  if (!tile) return;
  if (document.fullscreenElement) return document.exitFullscreen().catch(() => {});
  if (tile.requestFullscreen) return tile.requestFullscreen().catch(() => {});
  $('video', tile)?.webkitEnterFullscreen?.();
}
document.addEventListener('fullscreenchange', () => {
  for (const b of $$('.tile-full')) b.innerHTML = icon(b.closest('.tile') === document.fullscreenElement ? 'minimize' : 'maximize');
});
$('#tiles').addEventListener('dblclick', (e) => toggleFullscreen(e.target.closest('.tile')));

function tileShell(id, name, extraClass = '') {
  const el = document.createElement('div');
  el.className = `tile ${extraClass}`;
  el.dataset.peer = id;
  el.innerHTML = `<video autoplay playsinline></video>
    <div class="tile-avatar"><span class="avatar avatar-xl" style="--h:${hue(id)}">${esc(initials(name))}</span></div>
    <div class="tile-name"><span class="tile-mic"></span><span class="text-truncate">${esc(name)}</span></div>
    <div class="tile-net" hidden></div>
    <button class="tile-full" data-action="fullscreen" title="${esc(t('meet.fullscreen'))}" aria-label="${esc(t('meet.fullscreen'))}">${icon('maximize')}</button>`;
  $('#tiles').append(el);
  return el;
}

// ------------------------------------------------------- connection label
// A small corner label on every tile: how that person's media arrives
// (P2P direct, P2P through a TURN relay, or SFU), the bitrate received from
// them and the round trip; on your own tile, what you send. From getStats
// every 2 s; a dot colors the quality (loss and latency).
const NET_EVERY_MS = 2000;
const netPrev = new Map(); // key → { bytes, at, lost, recv }

const fmtRate = (bps) => (bps >= 1e6 ? `${(bps / 1e6).toFixed(1)} Mbps` : `${Math.max(0, Math.round(bps / 1000))} kbps`);

async function pcInfo(pc) {
  const stats = await pc.getStats();
  let pair = null;
  const byId = new Map();
  for (const r of stats.values()) {
    byId.set(r.id, r);
    if (r.type === 'transport' && r.selectedCandidatePairId) pair = r.selectedCandidatePairId;
  }
  const selected = pair ? byId.get(pair) : [...stats.values()].find((r) => r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded');
  const local = selected && byId.get(selected.localCandidateId);
  const remote = selected && byId.get(selected.remoteCandidateId);
  return { stats, rtt: selected?.currentRoundTripTime, relay: local?.candidateType === 'relay' || remote?.candidateType === 'relay' };
}

function rate(key, bytes, extra = {}) {
  const now = performance.now();
  const prev = netPrev.get(key);
  netPrev.set(key, { bytes, at: now, ...extra });
  return prev && now > prev.at ? { bps: ((bytes - prev.bytes) * 8 * 1000) / (now - prev.at), prev } : null;
}

function paintNet(tile, path, text, quality, title) {
  const el = tile && $('.tile-net', tile);
  if (!el) return;
  el.hidden = false;
  el.title = title;
  el.innerHTML = `<span class="net-dot ${quality}"></span>${esc(path)}${text ? ` · ${esc(text)}` : ''}`;
}

const qualityOf = (rtt, lossPct) => (rtt > 0.3 || lossPct > 5 ? 'bad' : rtt > 0.15 || lossPct > 1 ? 'fair' : 'good');

async function updateNet() {
  if (!state.joined || root.dataset.stage !== 'room') return;
  const sources = [];
  if (state.sfu?.pc) sources.push({ pc: state.sfu.pc, kind: 'sfu' });
  for (const peer of state.peers.values()) if (peer.pc) sources.push({ pc: peer.pc, kind: 'p2p', peer });
  let sent = 0;
  let selfPath = state.topology === 'sfu' ? 'SFU' : 'P2P';
  let selfRtt = 0;
  const perPeer = new Map(); // peer id → { path, relay, bytes, lost, recv, rtt }
  for (const src of sources) {
    let info;
    try {
      info = await pcInfo(src.pc);
    } catch {
      continue;
    }
    if (src.kind === 'sfu' && info.relay) selfPath = 'SFU · TURN';
    if (info.rtt) selfRtt = Math.max(selfRtt, info.rtt);
    for (const r of info.stats.values()) {
      if (r.type === 'outbound-rtp') sent += r.bytesSent || 0;
      if (r.type !== 'inbound-rtp') continue;
      // Which person this media belongs to: the tile showing that track.
      const peer = [...state.peers.values()].find((p) => [...p.stream.getTracks(), ...p.screen.getTracks()].some((t) => t.id === r.trackIdentifier));
      if (!peer) continue;
      const entry = perPeer.get(peer.info.id) || { path: src.kind === 'sfu' ? 'SFU' : info.relay ? 'P2P · TURN' : 'P2P', bytes: 0, lost: 0, recv: 0, rtt: info.rtt || 0 };
      entry.bytes += r.bytesReceived || 0;
      entry.lost += Math.max(0, r.packetsLost || 0);
      entry.recv += r.packetsReceived || 0;
      perPeer.set(peer.info.id, entry);
    }
  }
  for (const peer of state.peers.values()) {
    const e = perPeer.get(peer.info.id);
    if (!e) continue;
    const r = rate(`in:${peer.info.id}`, e.bytes, { lost: e.lost, recv: e.recv });
    const dLost = r ? e.lost - (r.prev.lost || 0) : 0;
    const dRecv = r ? e.recv - (r.prev.recv || 0) : 0;
    const loss = dLost + dRecv > 0 ? (100 * dLost) / (dLost + dRecv) : 0;
    const text = [r ? fmtRate(r.bps) : '', e.rtt ? `${Math.round(e.rtt * 1000)} ms` : ''].filter(Boolean).join(' · ');
    paintNet(peer.tile, e.path, text, qualityOf(e.rtt, loss), t(e.path === 'SFU' ? 'meet.netSfu' : e.path === 'P2P' ? 'meet.netP2p' : 'meet.netRelay'));
  }
  const up = rate('out', sent);
  paintNet(localTile, selfPath, up ? `↑ ${fmtRate(up.bps)}` : '', qualityOf(selfRtt, 0), t(selfPath.startsWith('SFU') ? 'meet.netSfu' : 'meet.netP2p'));
}
setInterval(() => updateNet().catch(() => {}), NET_EVERY_MS);

function createTile(peer) {
  peer.tile = tileShell(peer.info.id, peer.info.name + (peer.info.guest ? ` (${t('meet.guest')})` : ''), 'connecting');
  const video = $('video', peer.tile);
  video.srcObject = peer.stream;
  applySpeaker(video);
  renderTile(peer);
}

function renderTile(peer) {
  if (!peer.tile) return;
  const media = peer.info.media || {};
  const hasVideo = peer.stream.getVideoTracks().some((tr) => !tr.muted) && media.video !== false;
  peer.tile.classList.toggle('no-video', !hasVideo);
  $('.tile-mic', peer.tile).innerHTML = media.audio === false ? icon('mic-off') : '';
  const sharing = media.screen && peer.screen.getVideoTracks().some((tr) => !tr.muted);
  if (sharing && !peer.screenTile) {
    peer.screenTile = tileShell(`${peer.info.id}:screen`, t('meet.screenOf', { name: peer.info.name }), 'screen-tile');
    $('video', peer.screenTile).srcObject = peer.screen;
  } else if (!sharing && peer.screenTile) {
    peer.screenTile.remove();
    peer.screenTile = null;
  }
  layout();
}

let localTile = null;
let localScreenTile = null;
function addLocalTile() {
  localTile?.remove();
  localTile = tileShell('self', `${boot.displayName || $('#guest-name')?.value || ''} (${t('meet.you')})`, 'self-tile');
  renderLocalTile();
}

function renderLocalTile() {
  if (!localTile) return;
  const video = $('video', localTile);
  video.muted = true;
  video.srcObject = state.cam && state.local.video ? new MediaStream([state.local.video]) : null;
  localTile.classList.toggle('no-video', !(state.cam && state.local.video));
  $('.tile-mic', localTile).innerHTML = state.mic && state.local.audio ? '' : icon('mic-off');
  // Your own share is not played back to you: a live preview of a screen
  // that contains this window would film itself (an endless mirror) — for
  // you and for everyone watching. A card says you are presenting instead.
  if (state.local.screen && !localScreenTile) {
    localScreenTile = tileShell('self:screen', t('meet.yourScreen'), 'self-screen presenting no-video');
    $('.tile-avatar', localScreenTile).innerHTML = `<div class="text-center px-3">${icon('screen', 'presenting-ic')}
      <div class="fw-semibold mt-2">${esc(t('meet.presenting'))}</div>
      <div class="small opacity-75 mb-3">${esc(t('meet.presentingHint'))}</div>
      <button class="btn btn-danger btn-sm" data-action="screen">${esc(t('meet.stopPresenting'))}</button></div>`;
  } else if (!state.local.screen && localScreenTile) {
    localScreenTile.remove();
    localScreenTile = null;
  }
  layout();
}

// Grid sized to the number of tiles; a shared screen takes the stage when
// spotlight mode is on.
function layout() {
  const tiles = $('#tiles');
  const all = $$('.tile', tiles);
  const screen = state.spotlight && all.find((el) => el.classList.contains('screen-tile'));
  tiles.classList.toggle('has-spotlight', !!screen);
  for (const el of all) el.classList.toggle('spotlight', el === screen);
  const n = screen ? all.length - 1 : all.length;
  const cols = n <= 1 ? 1 : n <= 4 ? 2 : n <= 9 ? 3 : 4;
  tiles.style.setProperty('--cols', cols);
  tiles.style.setProperty('--rows', Math.ceil(n / cols) || 1);
  if (screen) {
    // The shared screen is exactly as tall as the visible area.
    const pad = parseFloat(getComputedStyle(tiles).paddingTop) + parseFloat(getComputedStyle(tiles).paddingBottom);
    tiles.style.setProperty('--side', Math.max(1, n));
    tiles.style.setProperty('--stage-h', `${tiles.clientHeight - pad}px`);
  }
}
window.addEventListener('resize', () => layout());

// Active speaker: a light outline on the tile of whoever is talking.
function watchLevel(peer) {
  try {
    state.audioCtx ||= new AudioContext();
    const src = state.audioCtx.createMediaStreamSource(new MediaStream(peer.stream.getAudioTracks()));
    const analyser = state.audioCtx.createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser);
    const buf = new Uint8Array(analyser.frequencyBinCount);
    const tick = () => {
      if (!state.peers.has(peer.info.id)) return;
      analyser.getByteFrequencyData(buf);
      const level = buf.reduce((a, b) => a + b, 0) / buf.length;
      peer.tile?.classList.toggle('speaking', level > 18);
      setTimeout(tick, 250);
    };
    tick();
  } catch {
    // Level metering is optional.
  }
}

// ------------------------------------------------------------- people/lobby

function renderPeople() {
  const row = (id, info, self = false) => `<li class="d-flex align-items-center gap-2 py-1" data-pid="${esc(id)}">
    <span class="avatar avatar-sm" style="--h:${hue(id)}">${esc(initials(info.name))}</span>
    <span class="flex-grow-1 min-w-0 text-truncate">${esc(info.name)}${self ? ` (${esc(t('meet.you'))})` : ''}
      ${info.role === 'host' ? `<span class="badge text-bg-warning ms-1">${esc(t('meet.host'))}</span>` : info.role === 'cohost' ? `<span class="badge text-bg-info ms-1">${esc(t('meet.cohost'))}</span>` : info.guest ? `<span class="badge text-bg-secondary ms-1">${esc(t('meet.guest'))}</span>` : ''}</span>
    ${info.media?.audio === false ? icon('mic-off', 'opacity-75') : ''}
    ${state.canManage && !self && info.role !== 'host' ? `<div class="dropdown"><button class="btn btn-sm btn-icon text-white" data-bs-toggle="dropdown">${icon('more')}</button><ul class="dropdown-menu dropdown-menu-end">
      ${info.guest ? '' : `<li><button class="dropdown-item" data-act="cohost">${esc(t(info.role === 'cohost' ? 'meet.removeCohost' : 'meet.makeCohost'))}</button></li>`}
      <li><button class="dropdown-item text-danger" data-act="remove">${esc(t('meet.remove'))}</button></li></ul></div>` : ''}
  </li>`;
  const list = [state.self ? row(state.self.id, state.self, true) : '', ...[...state.peers.values()].map((p) => row(p.info.id, p.info))];
  $('#people-list').innerHTML = list.join('');
}

function onLobby(waiting) {
  const grew = waiting.length > state.lobby.length;
  state.lobby = waiting;
  $('#lobby-box').hidden = !waiting.length;
  $('#lobby-list').innerHTML = waiting
    .map(
      (w) => `<li class="lobby-item" data-pid="${esc(w.id)}"><div class="min-w-0"><div class="text-truncate fw-semibold">${esc(w.name)}</div><small class="opacity-75">${esc(w.email)}${w.guest ? ` · ${esc(t('meet.guest'))}` : ''}</small></div>
      <div class="d-flex gap-1"><button class="btn btn-sm btn-success" data-admit="1">${esc(t('meet.admit'))}</button><button class="btn btn-sm btn-outline-light" data-admit="0">${esc(t('meet.deny'))}</button></div></li>`
    )
    .join('');
  const badge = $('#lobby-badge');
  badge.hidden = !waiting.length;
  badge.textContent = waiting.length;
  if (grew) {
    $('#meet-panel').hidden = false;
    $('#meet-panel').dataset.tab = 'people';
    if (document.visibilityState !== 'visible' && 'Notification' in window && Notification.permission === 'granted') {
      new Notification(t('meet.someoneWaiting'), { body: waiting.at(-1).name, icon: '/favicon.svg' });
    }
  }
}

function renderControls() {
  $('#btn-end').hidden = !state.canManage;
  $('#btn-screen').hidden = !state.screenAllowed || !navigator.mediaDevices?.getDisplayMedia;
  $('[data-action="copy-link"]').hidden = boot.mode === 'guest';
  $('#btn-screen').classList.toggle('active', !!state.local.screen);
  renderPreview();
  renderPeople();
}

// ------------------------------------------------------------------ actions

async function toggleMic() {
  state.mic = !state.mic;
  localStorage.setItem('meet.mic', state.mic ? '1' : '0');
  if (state.mic && !state.local.audio) {
    await startMic();
    pushTrack(SLOT.audio);
  }
  if (state.local.audio) state.local.audio.enabled = state.mic;
  renderPreview();
  renderLocalTile();
  announceMedia();
}

async function toggleCam() {
  state.cam = !state.cam;
  localStorage.setItem('meet.cam', state.cam ? '1' : '0');
  // Off really releases the camera (the light goes off).
  if (state.cam) await startCamera();
  else stopTrack('video');
  pushTrack(SLOT.camera);
  renderPreview();
  renderLocalTile();
  announceMedia();
}

async function toggleScreen() {
  if (state.local.screen) return stopScreen();
  try {
    // selfBrowserSurface: Chrome/Edge leave this tab out of the picker
    // (sharing the call's own tab is the classic mirror); other browsers
    // ignore the hint.
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 15 }, audio: false, selfBrowserSurface: 'exclude', surfaceSwitching: 'include' });
    state.local.screen = stream.getVideoTracks()[0];
    // Text and code: keep the resolution, give up frame rate when bandwidth is short.
    state.local.screen.contentHint = 'detail';
    state.local.screen.onended = stopScreen;
    pushTrack(SLOT.screen);
    if (state.sfu) sfuScreenOn();
    renderControls();
    renderLocalTile();
    announceMedia();
  } catch {
    // Picker cancelled.
  }
}

function stopScreen() {
  if (!state.local.screen) return;
  stopTrack('screen');
  pushTrack(SLOT.screen);
  if (state.sfu) sfuScreenOff();
  renderControls();
  renderLocalTile();
  announceMedia();
}

function leave() {
  state.leaving = true;
  send('leave');
  state.ws?.close();
  teardownPeers();
  for (const kind of ['audio', 'video', 'screen']) stopTrack(kind);
  location.href = boot.backHref;
}

root.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-action], [data-admit], [data-act]');
  if (!btn) return;
  if (btn.dataset.admit !== undefined) {
    return send('admit', { participant_id: btn.closest('[data-pid]').dataset.pid, accept: btn.dataset.admit === '1' });
  }
  if (btn.dataset.act) {
    const pid = btn.closest('[data-pid]').dataset.pid;
    if (btn.dataset.act === 'remove') return send('remove', { participant_id: pid });
    const p = state.peers.get(pid);
    return send('cohost', { participant_id: pid, on: p?.info.role !== 'cohost' });
  }
  switch (btn.dataset.action) {
    case 'pre-mic':
    case 'mic':
      return toggleMic();
    case 'pre-cam':
    case 'cam':
      return toggleCam();
    case 'screen':
      return toggleScreen();
    case 'panel':
      return showPanel('people');
    case 'chat':
      return showPanel('chat');
    case 'settings':
      return showPanel('settings');
    case 'tab':
      return showPanel(btn.dataset.tab, false);
    case 'close-panel':
      $('#meet-panel').hidden = true;
      return;
    case 'fullscreen':
      return toggleFullscreen(btn.closest('.tile'));
    case 'toggle-layout':
      state.spotlight = !state.spotlight;
      return layout();
    case 'copy-link':
      await navigator.clipboard.writeText(location.href).catch(() => {});
      btn.classList.add('active');
      setTimeout(() => btn.classList.remove('active'), 1200);
      return;
    case 'leave':
      return leave();
    case 'end':
      if (confirm(t('meet.endConfirm'))) send('end');
      return;
    case 'join':
      btn.disabled = true;
      if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
      return connect();
    case 'rejoin': {
      state.leaving = false;
      $('[data-action="join"]').disabled = false;
      $('#media-error').hidden = true;
      stage('prejoin');
      if (navigator.mediaDevices?.getUserMedia) {
        if (state.cam) await startCamera();
        await startMic();
      }
      renderPreview();
      return;
    }
    default:
  }
});

$('#invite-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const status = $('#invite-status');
  try {
    await api(`/api/o/${boot.org.slug}/meetings/${boot.meeting.id}/invitations`, { method: 'POST', body: { email: e.target.email.value, name: e.target.name.value } });
    status.textContent = t('meet.inviteSent');
    e.target.reset();
  } catch (err) {
    status.textContent = err.message;
  }
});

for (const sel of $$('[data-device]')) sel.addEventListener('change', (e) => changeDevice(e.target.dataset.device, e.target.value));
// A headset plugged in or removed mid-call shows up in the lists.
navigator.mediaDevices?.addEventListener?.('devicechange', () => listDevices().catch(() => {}));

window.addEventListener('beforeunload', () => {
  state.leaving = true;
  send('leave');
});

// Wall clock in the top bar.
setInterval(() => {
  $('#meet-clock').textContent = new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}, 1000);

(async () => {
  if (!navigator.mediaDevices?.getUserMedia) {
    showMediaError(new Error('unsupported'));
  } else {
    if (state.cam) await startCamera();
    await startMic();
  }
  await listDevices().catch(() => {});
  renderPreview();
  // A call goes straight into the room.
  if (boot.call) {
    $('[data-action="join"]').disabled = true;
    connect();
  }
})();
