import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { qrMatrix, qrSvg } from '../core/qr.js';
import { client, startApp } from './helpers.js';

const fingerprint = (m) => createHash('sha256').update(m.map((r) => r.map((b) => (b ? 1 : 0)).join('')).join('/')).digest('hex').slice(0, 16);

// The generator was checked module by module against the `qrcode` npm
// package (5 texts × 4 levels × 8 masks, and the automatic mask on 40 MFA
// links); these fingerprints pin that verified output.
describe('QR codes', () => {
  test('same modules as the reference implementation', () => {
    const uri = 'otpauth://totp/BipTrix:horia%40unicorndev.eu?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=BipTrix';
    const small = qrMatrix(uri, { level: 'M' });
    assert.equal(small.length, 41, 'version 6');
    assert.equal(fingerprint(small), 'dad1db1d26e12e61');
    const large = qrMatrix('z'.repeat(1200), { level: 'M' });
    assert.equal(large.length, 133, 'version 29, with version information');
    assert.equal(fingerprint(large), '2c4def7f66bb67f6');
  });

  test('finder patterns, quiet zone, escaped label', () => {
    const m = qrMatrix('hello');
    for (const [x, y] of [[0, 0], [m.length - 7, 0], [0, m.length - 7]]) {
      assert.ok(m[y][x] && m[y + 6][x + 6] && !m[y + 1][x + 1] && m[y + 3][x + 3], 'finder at a corner');
    }
    const svg = qrSvg('hello', { label: 'a "b" <c>' });
    assert.match(svg, /viewBox="0 0 29 29"/);
    assert.match(svg, /aria-label="a &#34;b&#34; &#60;c&#62;"/);
  });
});

describe('MFA enrollment shows a QR code', () => {
  let app;
  before(async () => {
    app = await startApp();
    await app.user(await app.org('Q'), { email: 'q@q.ro' });
  });
  after(() => app.stop());

  test('the setup page renders the otpauth link as a QR SVG', async () => {
    const c = client(app.base);
    await c.login('q@q.ro');
    const page = await c.get('/account/mfa');
    assert.equal(page.status, 200);
    const svg = page.text.match(/<div class="mfa-qr[^"]*">(<svg[\s\S]*?<\/svg>)/);
    assert.ok(svg, 'QR present');
    const secret = page.text.match(/secret=([A-Z2-7]+)/)[1];
    const uri = page.text.match(/href="(otpauth:\/\/[^"]+)"/)[1].replace(/&amp;/g, '&');
    assert.ok(uri.includes(secret));
    assert.equal(svg[1], qrSvg(uri, { label: svg[1].match(/aria-label="([^"]*)"/)[1].replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n)) }));
  });
});
