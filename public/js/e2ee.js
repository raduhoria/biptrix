import { tagHex } from './e2ee-frame.js';

// End-to-end encryption of a call (audio, camera, screen), the same on
// every path — peer to peer and through the SFU, which then forwards
// frames it cannot read. All keys are ephemeral: made in this page when
// the call starts, never stored, gone when it ends.
//
// - Each participant makes an ECDH key pair (P-256; the private key cannot
//   be exported) and a random 4-byte sender tag, and announces the public
//   key to every other participant through the room's signal relay.
// - Each participant has its own frame key (AES-GCM 256, "sender key"),
//   sent to each other participant wrapped with a key derived from their
//   ECDH secret (HKDF), bound to both ids, the tag and the key index. The
//   server relays only public keys and wrapped keys.
// - Every wrapped key is acknowledged; until it is, it is sent again
//   (backing off), so a message lost with a dropped socket is not lost for
//   good. After our own reconnect (resync) everyone is asked to send their
//   key again and gets ours again.
// - Whenever someone joins or leaves, everyone makes a new frame key and
//   sends it to those present; it is used once all of them acknowledged it
//   (at most SWITCH_MAX_MS later; receivers keep the last few keys). Someone
//   who left cannot decrypt what follows; someone who joins, what came
//   before.
// - The verification code is a hash of every participant's public key:
//   if everyone sees the same code, nobody (not even our server or the
//   proxy in front of it) swapped keys on the way.

const SWITCH_MAX_MS = 5000;
const REKEY_DEBOUNCE_MS = 300;
const RETRY_MS = 1000; // doubled per attempt, up to RETRY_MAX_MS
const RETRY_MAX_MS = 10_000;
const enc = new TextEncoder();
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

// 64 easy-to-name emoji: 6 of them = 36 bits.
const EMOJI = [...'🐶🐱🦊🐻🐼🐨🐯🦁🐮🐷🐸🐵🐔🐧🦆🦉🐴🦄🐝🐢🐙🦀🐬🐳🦋🐌🌵🌲🌻🌹🍄🌙🍎🍌🍇🍉🍓🍒🍋🥕🌽🥑🍕🍔🎈🎁🎸🎺🏀🚲🚗🚀⛵🔑🔔📚🎩👓🧲🔦🧩🎲🪁🧸'];

export const e2eeSupported = () => typeof window.RTCRtpScriptTransform === 'function' && !!window.crypto?.subtle;

export function createE2ee({ signal, onChange, worker = new Worker('/js/e2ee-worker.js', { type: 'module', name: 'e2ee' }) }) {
  const attached = new WeakSet();
  // id → { pub, tag, wrapKey, hasKey (theirs, current), acked: Set of our
  // key indexes they confirmed, retry, tries }
  const peers = new Map();
  const early = new Map(); // id → a message that came before we knew them
  let selfId = null;
  let keys = null; // { privateKey, pubB64 }
  let tag = null;
  let mine = null; // our newest frame key { index, raw }
  let active = null; // the one frames are sent with
  let rekeyTimer = null;
  let switchTimer = null;
  let code = '';

  const ready = (async () => {
    const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    keys = { privateKey: pair.privateKey, pubB64: b64(await crypto.subtle.exportKey('raw', pair.publicKey)) };
    tag = crypto.getRandomValues(new Uint8Array(4));
    mine = { index: 0, raw: crypto.getRandomValues(new Uint8Array(32)) };
    activate(mine);
  })();

  function activate(key) {
    active = key;
    worker.postMessage({ type: 'send-key', tag, index: key.index, raw: key.raw });
    onChange();
  }

  // Encrypt what this sender sends / decrypt what this receiver gets.
  function attach(senderOrReceiver, kind, side) {
    if (!senderOrReceiver || attached.has(senderOrReceiver)) return;
    attached.add(senderOrReceiver);
    senderOrReceiver.transform = new RTCRtpScriptTransform(worker, { side, kind });
  }

  async function wrapKeyFor(id, pubB64) {
    const theirs = await crypto.subtle.importKey('raw', unb64(pubB64), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const secret = await crypto.subtle.deriveBits({ name: 'ECDH', public: theirs }, keys.privateKey, 256);
    const hkdf = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
    const salt = enc.encode([selfId, id].sort().join('|'));
    return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode('biptrix-e2ee-v1') }, hkdf, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }

  const aad = (from, to, index, tagStr) => enc.encode(`${from}|${to}|${index}|${tagStr}`);
  // Still owed to this participant: our public key (no pairing yet) or our
  // newest frame key (not acknowledged).
  const owed = (p) => !p.wrapKey || !p.acked.has(mine.index);
  const hello = () => ({ v: 1, pub: keys.pubB64, tag: tagHex(tag) });

  // Our public key, and our newest frame key once we know theirs; sent
  // again until acknowledged. `want`: asks them to send theirs again.
  async function sendTo(id, { want = false } = {}) {
    await ready;
    const p = peers.get(id);
    if (!p) return;
    const msg = hello();
    if (want) msg.want = true;
    if (p.wrapKey && !p.acked.has(mine.index)) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const index = mine.index;
      const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(selfId, id, index, msg.tag) }, p.wrapKey, mine.raw);
      Object.assign(msg, { index, iv: b64(iv), key: b64(ct) });
    }
    signal(id, { e2ee: msg });
    clearTimeout(p.retry);
    p.retry = setTimeout(() => {
      p.retry = null;
      if (peers.get(id) === p && owed(p)) sendTo(id);
    }, Math.min(RETRY_MAX_MS, RETRY_MS * 2 ** p.tries++));
  }

  async function onSignal(from, m) {
    if (!m || m.v !== 1 || typeof m.pub !== 'string' || !/^[0-9a-f]{8}$/.test(m.tag || '')) return;
    await ready;
    let p = peers.get(from);
    if (!p) return early.set(from, m); // handled once they are listed
    if (p.pub !== m.pub) {
      // New (or first) public key for this participant: a fresh pairing.
      Object.assign(p, { pub: m.pub, tag: m.tag, wrapKey: await wrapKeyFor(from, m.pub).catch(() => null), hasKey: false, acked: new Set(), tries: 0 });
      if (!p.wrapKey) return;
      await updateCode();
    }
    p = peers.get(from);
    if (!p || p.pub !== m.pub) return;
    if (m.key && Number.isInteger(m.index)) {
      try {
        const raw = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(m.iv), additionalData: aad(from, selfId, m.index, m.tag) }, p.wrapKey, unb64(m.key));
        worker.postMessage({ type: 'recv-key', tag: m.tag, index: m.index & 255, raw });
        p.tag = m.tag;
        p.hasKey = true;
        signal(from, { e2ee: { ...hello(), ack: m.index } });
        onChange();
      } catch {
        // Not for this pairing (an older key pair): ignored.
      }
    }
    if (Number.isInteger(m.ack)) {
      p.acked.add(m.ack);
      if (p.acked.size > 8) p.acked.delete(p.acked.values().next().value);
      if (m.ack === mine.index) p.tries = 0;
      checkSwitch();
      onChange();
    }
    // They lost our key (their reconnect): send it again.
    if (m.want) {
      p.acked.delete(mine.index);
      p.tries = 0;
    }
    if (owed(p) && (m.want || !p.retry)) sendTo(from);
  }

  // Who is in the call now (self excluded). Newcomers get our public key;
  // any change makes a new frame key for everyone present.
  function setPeers(ids) {
    let changed = false;
    for (const id of ids) {
      if (peers.has(id)) continue;
      peers.set(id, { pub: null, tag: null, wrapKey: null, hasKey: false, acked: new Set(), retry: null, tries: 0 });
      changed = true;
      sendTo(id);
      if (early.has(id)) onSignal(id, early.get(id));
      early.delete(id);
    }
    for (const [id, p] of peers) {
      if (ids.includes(id)) continue;
      clearTimeout(p.retry);
      peers.delete(id);
      if (p.tag) worker.postMessage({ type: 'forget', tag: p.tag });
      changed = true;
    }
    if (!changed) return;
    updateCode();
    onChange();
    clearTimeout(rekeyTimer);
    rekeyTimer = setTimeout(rekey, REKEY_DEBOUNCE_MS);
  }

  async function rekey() {
    await ready;
    mine = { index: (mine.index + 1) & 255, raw: crypto.getRandomValues(new Uint8Array(32)) };
    for (const [id, p] of peers) {
      p.tries = 0;
      if (p.wrapKey) sendTo(id);
    }
    clearTimeout(switchTimer);
    const next = mine;
    switchTimer = setTimeout(() => mine === next && active !== next && activate(next), SWITCH_MAX_MS);
    checkSwitch();
  }

  // The newest key goes into use once everyone present holds it.
  function checkSwitch() {
    if (!mine || active === mine) return;
    if ([...peers.values()].every((p) => p.acked.has(mine.index))) {
      clearTimeout(switchTimer);
      activate(mine);
    }
  }

  // After our own socket came back: messages may have been lost both ways.
  async function resync() {
    await ready;
    for (const [id, p] of peers) {
      p.acked.clear();
      p.tries = 0;
      sendTo(id, { want: true });
    }
    onChange();
  }

  // The code everyone compares: every participant's public key, in order.
  async function updateCode() {
    await ready;
    const all = [[selfId, keys.pubB64], ...[...peers].map(([id, p]) => [id, p.pub])];
    if (all.some(([, pub]) => !pub)) {
      code = '';
      return onChange();
    }
    const lines = all.sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([id, pub]) => `${id}:${pub}`).join('\n');
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(lines)));
    code = Array.from(hash.subarray(0, 6), (byte) => EMOJI[byte & 63]).join(' ');
    onChange();
  }

  return {
    ready,
    attach,
    onSignal,
    setPeers,
    resync,
    start(id) {
      selfId = id;
      updateCode();
    },
    // ok: every participant holds the key we send with and we hold theirs;
    // pending: still exchanging (or re-exchanging after a reconnect).
    status: () => ([...peers.values()].every((p) => p.wrapKey && p.hasKey && active && p.acked.has(active.index)) ? 'ok' : 'pending'),
    code: () => code,
  };
}
