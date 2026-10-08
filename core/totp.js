import { createHmac, randomBytes } from 'node:crypto';

// TOTP (RFC 6238: SHA-1, 6 digits, 30 s) on node:crypto, for the mandatory
// MFA of administrators (spec §15). Accepts ±1 step of clock drift.
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function newTotpSecret() {
  const bytes = randomBytes(20);
  let bits = '';
  for (const b of bytes) bits += b.toString(2).padStart(8, '0');
  return bits.match(/.{1,5}/g).map((chunk) => ALPHABET[parseInt(chunk.padEnd(5, '0'), 2)]).join('');
}

function base32Decode(secret) {
  const bits = String(secret).replace(/=+$/, '').toUpperCase().split('').map((c) => ALPHABET.indexOf(c).toString(2).padStart(5, '0')).join('');
  return Buffer.from(bits.match(/.{8}/g)?.map((b) => parseInt(b, 2)) || []);
}

function codeAt(secret, step) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  return String((hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

export function verifyTotp(secret, code, now = Date.now()) {
  const given = String(code || '').replace(/\D/g, '');
  if (given.length !== 6) return false;
  const step = Math.floor(now / 30_000);
  return [-1, 0, 1].some((d) => codeAt(secret, step + d) === given);
}

export function totpUri({ secret, account, issuer }) {
  return `otpauth://totp/${encodeURIComponent(`${issuer}:${account}`)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

export const totpNow = (secret) => codeAt(secret, Math.floor(Date.now() / 30_000));
