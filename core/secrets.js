import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// Application secret: APP_SECRET from the environment (secret manager), or a
// random key generated once into a local file (chmod 600, gitignored), so a
// copy of the database alone does not reveal TOTP seeds or HMAC keys.
export function loadAppSecret({ envSecret, keyFile }) {
  if (envSecret) return envSecret;
  if (!existsSync(keyFile)) {
    mkdirSync(path.dirname(keyFile), { recursive: true });
    writeFileSync(keyFile, `${randomBytes(32).toString('base64url')}\n`, { mode: 0o600 });
    chmodSync(keyFile, 0o600);
  }
  return readFileSync(keyFile, 'utf8').trim();
}

// AES-256-GCM for values stored in the database (TOTP secrets).
export function createSecretBox(secret) {
  const key = createHash('sha256').update(`biptrix:box:${secret}`).digest();

  function encrypt(plain) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
    return `enc:v1:${Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64')}`;
  }

  function decrypt(stored) {
    const value = String(stored || '');
    if (!value.startsWith('enc:v1:')) return value;
    const raw = Buffer.from(value.slice(7), 'base64');
    const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  }

  return { encrypt, decrypt };
}
