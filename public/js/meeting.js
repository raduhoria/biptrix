import { $, $$, api, esc, hue, icon, initials, translator } from './lib.js';

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
  devices: { mic: localStorage.getItem('meet.micId') || '', cam: localStorage.getItem('meet.camId') || '' },
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
  fill($('#sel-mic'), 'audioinput', state.local.audio?.getSettings().deviceId || state.devices.mic);
  fill($('#sel-cam'), 'videoinput', state.local.video?.getSettings().deviceId || state.devices.cam);
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
    teardownPeers();
    for (const w of state.waiting.values()) w.reject(new Error('disconnected'));
    state.waiting.clear();
    if (state.leaving || ['ended', 'removed', 'rejected', 'replaced'].includes(e.reason)) return;
    if (e.code === 1006 || e.code === 1001 || e.code === 1011 || e.reason === 'rejoin') {
      // Network drop: rejoin (the server re-checks admission).
      setTimeout(() => !state.leaving && connect(), 2000);
      return;
    }
    if (root.dataset.stage !== 'ended') setEnded('meet.disconnected', '', true);
  };
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
  send('join', { name, audio: state.mic && !!state.local.audio, video: state.cam && !!state.local.video });
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
      if (p) p.info.tracks = d.tracks;
      return sfuSync();
    }
    case 'peer.joined':
      addPeer(d, false);
      if (state.ringing) callBanner('');
      return renderPeople();
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
  state.joined = true;
  state.self = d.self;
  state.iceServers = d.ice_servers;
  state.icePolicy = d.ice_policy || 'all';
  state.canManage = d.can_manage;
  state.screenAllowed = d.screen_share;
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
    const stream = target.slot === 'screen' ? peer.screen : peer.stream;
    for (const tr of stream.getTracks()) if (tr.kind === e.track.kind) stream.removeTrack(tr);
    stream.addTrack(e.track);
    peer.tile?.classList.remove('connecting');
    e.track.onunmute = () => renderTile(peer);
    e.track.onmute = () => renderTile(peer);
    renderTile(peer);
    if (e.track.kind === 'audio') watchLevel(peer);
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
  const peer = { info, initiator, pc: null, pendingIce: [], stream: new MediaStream(), screen: new MediaStream(), tile: null, screenTile: null, level: 0 };
  state.peers.set(info.id, peer);
  createTile(peer);
  if (initiator) startCall(peer);
}

function createPc(peer) {
  const pc = new RTCPeerConnection({ iceServers: state.iceServers, iceTransportPolicy: state.icePolicy });
  peer.pc = pc;
  pc.onicecandidate = (e) => e.candidate && send('signal', { to: peer.info.id, data: { candidate: e.candidate } });
  pc.ontrack = (e) => {
    const slot = pc.getTransceivers().indexOf(e.transceiver);
    const target = slot === SLOT.screen ? peer.screen : peer.stream;
    for (const tr of target.getTracks()) if (tr.kind === e.track.kind) target.removeTrack(tr);
    target.addTrack(e.track);
    e.track.onunmute = () => renderTile(peer);
    e.track.onmute = () => renderTile(peer);
    renderTile(peer);
    if (e.track.kind === 'audio') watchLevel(peer);
  };
  pc.onconnectionstatechange = () => {
    peer.tile?.classList.toggle('connecting', !['connected', 'completed'].includes(pc.connectionState));
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
}

async function onSignal(from, data) {
  const peer = state.peers.get(from);
  if (!peer) return;
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
  if (state.sfu) sfuDrop();
  layout();
}

function teardownPeers() {
  const sfu = state.sfu;
  state.sfu = null;
  sfu?.pc.close();
  for (const id of [...state.peers.keys()]) removePeer(id);
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

function tileShell(id, name, extraClass = '') {
  const el = document.createElement('div');
  el.className = `tile ${extraClass}`;
  el.dataset.peer = id;
  el.innerHTML = `<video autoplay playsinline></video>
    <div class="tile-avatar"><span class="avatar avatar-xl" style="--h:${hue(id)}">${esc(initials(name))}</span></div>
    <div class="tile-name"><span class="tile-mic"></span><span class="text-truncate">${esc(name)}</span></div>`;
  $('#tiles').append(el);
  return el;
}

function createTile(peer) {
  peer.tile = tileShell(peer.info.id, peer.info.name + (peer.info.guest ? ` (${t('meet.guest')})` : ''), 'connecting');
  const video = $('video', peer.tile);
  video.srcObject = peer.stream;
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
  if (state.local.screen && !localScreenTile) {
    localScreenTile = tileShell('self:screen', t('meet.yourScreen'), 'screen-tile self-screen');
    const v = $('video', localScreenTile);
    v.muted = true;
    v.srcObject = new MediaStream([state.local.screen]);
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
}

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
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 15 }, audio: false });
    state.local.screen = stream.getVideoTracks()[0];
    state.local.screen.onended = stopScreen;
    if (state.sfu) sfuScreenOn();
    else pushTrack(SLOT.screen);
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
  if (state.sfu) sfuScreenOff();
  else pushTrack(SLOT.screen);
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
    case 'tab':
      return showPanel(btn.dataset.tab, false);
    case 'close-panel':
      $('#meet-panel').hidden = true;
      return;
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

for (const [sel, kind] of [
  ['#sel-mic', 'mic'],
  ['#sel-cam', 'cam'],
]) {
  $(sel).addEventListener('change', async (e) => {
    state.devices[kind] = e.target.value;
    localStorage.setItem(`meet.${kind}Id`, e.target.value);
    if (kind === 'mic') {
      stopTrack('audio');
      await startMic();
      pushTrack(SLOT.audio);
    } else if (state.cam) {
      stopTrack('video');
      await startCamera();
      pushTrack(SLOT.camera);
    }
    renderPreview();
    renderLocalTile();
  });
}

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
