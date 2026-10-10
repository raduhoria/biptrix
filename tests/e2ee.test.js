import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { decryptFrame, encryptFrame, headerLength, importFrameKey, TRAILER, tagHex } from '../public/js/e2ee-frame.js';
import { startApp } from './helpers.js';

// Call media encryption (public/js/e2ee-frame.js): what an SFU sees of a
// frame, and that nothing else can be read or altered.
describe('call frame encryption', () => {
  const tag = new Uint8Array([1, 2, 3, 4]);
  let key;
  let other;
  const frame = (n) => Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) & 255);
  const lookup = (k) => (t, index) => (t === tagHex(tag) && index === 7 ? k : undefined);

  before(async () => {
    key = await importFrameKey(crypto.getRandomValues(new Uint8Array(32)));
    other = await importFrameKey(crypto.getRandomValues(new Uint8Array(32)));
  });

  test('round trip; the codec header stays readable, the rest does not', async () => {
    for (const [kind, type] of [['video', 'key'], ['video', 'delta'], ['audio', undefined]]) {
      const plain = frame(500);
      const n = headerLength(kind, type, plain.length);
      const sealed = await encryptFrame(key, 7, tag, kind, type, plain);
      assert.equal(sealed.length, plain.length + 16 + TRAILER);
      assert.deepEqual(sealed.subarray(0, n), plain.subarray(0, n), `${kind} ${type}: header in clear`);
      assert.notDeepEqual(sealed.subarray(n, n + 32), plain.subarray(n, n + 32), 'payload encrypted');
      assert.equal(sealed.at(-1), 7);
      assert.deepEqual(sealed.subarray(sealed.length - 5, sealed.length - 1), tag);
      assert.deepEqual(await decryptFrame(lookup(key), kind, type, sealed), plain);
    }
  });

  test('a wrong key, an unknown sender, or a changed header: dropped', async () => {
    const sealed = await encryptFrame(key, 7, tag, 'video', 'key', frame(200));
    assert.equal(await decryptFrame(lookup(other), 'video', 'key', sealed), null);
    assert.equal(await decryptFrame(() => undefined, 'video', 'key', sealed), null);
    const tampered = sealed.slice();
    tampered[2] ^= 1;
    assert.equal(await decryptFrame(lookup(key), 'video', 'key', tampered), null, 'the header is authenticated');
    assert.equal(await decryptFrame(lookup(key), 'video', 'key', sealed.subarray(0, 10)), null);
  });

  test('every frame gets its own IV', async () => {
    const a = await encryptFrame(key, 7, tag, 'audio', undefined, frame(80));
    const b = await encryptFrame(key, 7, tag, 'audio', undefined, frame(80));
    assert.notDeepEqual(a.subarray(a.length - TRAILER, a.length - 5), b.subarray(b.length - TRAILER, b.length - 5));
  });
});

describe('call encryption assets', () => {
  let app;
  before(async () => {
    app = await startApp();
  });
  after(() => app.stop());

  test('the worker and its modules are served as JavaScript', async () => {
    for (const f of ['e2ee.js', 'e2ee-worker.js', 'e2ee-frame.js']) {
      const res = await fetch(`${app.base}/js/${f}`);
      assert.equal(res.status, 200, f);
      assert.match(res.headers.get('content-type'), /javascript/);
    }
  });
});
