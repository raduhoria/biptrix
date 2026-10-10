// End-to-end encryption of call media, one encoded frame at a time (used by
// e2ee-worker.js; pure, so it is also tested in Node).
//
// Frame on the wire:
//   [clear header][AES-GCM ciphertext + 16-byte tag][IV 12][sender tag 4][key index 1]
// The clear header is what an SFU or a depacketizer may need to read: the
// first byte of an Opus frame, the VP8 payload header (10 bytes for a key
// frame, 3 for a delta frame). It is authenticated as additional data, so
// it cannot be altered either. The sender tag says whose key to use (the
// same on every path: peer to peer or through the SFU); the key index lets
// receivers keep decrypting the previous key while a new one comes in.

export const TRAILER = 12 + 4 + 1;

export function headerLength(kind, type, length) {
  const n = kind === 'audio' ? 1 : type === 'key' ? 10 : 3;
  return Math.min(n, length);
}

export async function encryptFrame(key, index, tag, kind, type, data) {
  const n = headerLength(kind, type, data.length);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: data.subarray(0, n) }, key, data.subarray(n)));
  const out = new Uint8Array(n + ct.length + TRAILER);
  out.set(data.subarray(0, n));
  out.set(ct, n);
  out.set(iv, n + ct.length);
  out.set(tag, n + ct.length + 12);
  out[out.length - 1] = index;
  return out;
}

// lookup(tagHex, index) → CryptoKey | undefined. Null when the frame cannot
// be decrypted (no key yet, a key we never got, tampering): it is dropped.
export async function decryptFrame(lookup, kind, type, data) {
  if (data.length < TRAILER + 1) return null;
  const index = data[data.length - 1];
  const tag = tagHex(data.subarray(data.length - 5, data.length - 1));
  const key = lookup(tag, index);
  if (!key) return null;
  const iv = data.subarray(data.length - TRAILER, data.length - 5);
  const n = headerLength(kind, type, data.length - TRAILER);
  try {
    const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: data.subarray(0, n) }, key, data.subarray(n, data.length - TRAILER)));
    const out = new Uint8Array(n + plain.length);
    out.set(data.subarray(0, n));
    out.set(plain, n);
    return out;
  } catch {
    return null;
  }
}

export const tagHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

export const importFrameKey = (raw) => crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
