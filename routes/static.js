import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { gzip as gzipCb } from 'node:zlib';

const gzip = promisify(gzipCb);

const MIME = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
  '.tflite': 'application/octet-stream',
};
// Compressed once, kept with the file: text and WebAssembly shrink a lot
// (the background segmentation's 13 MB wasm to about 4 MB); images do not.
const COMPRESSIBLE = new Set(['.css', '.js', '.mjs', '.svg', '.wasm', '.map', '.tflite']);

// Static assets from public/, cached in memory with an ETag (304 on
// revalidation). Paths are resolved and confined to the public directory.
export function registerStatic(router, publicDir, { dev = false } = {}) {
  const root = path.resolve(publicDir);
  const cache = new Map();

  // One load per file, shared by concurrent requests; compressing runs off
  // the event loop (zlib's thread pool), so a big file does not stall calls.
  function load(file) {
    if (!dev && cache.has(file)) return cache.get(file);
    const loading = (async () => {
      const body = await readFile(file);
      const ext = path.extname(file);
      const entry = { body, etag: `"${createHash('sha1').update(body).digest('base64url')}"`, type: MIME[ext] || 'application/octet-stream', gzip: null };
      if (COMPRESSIBLE.has(ext) && body.length > 1024) {
        const gz = await gzip(body, { level: 9 });
        if (gz.length < body.length * 0.9) entry.gzip = gz;
      }
      return entry;
    })();
    cache.set(file, loading);
    loading.catch(() => cache.delete(file));
    return loading;
  }

  async function serve(req, res, relative) {
    const file = path.resolve(root, relative);
    if (!file.startsWith(root + path.sep)) return res.status(403).send('Forbidden');
    let entry;
    try {
      entry = await load(file);
    } catch {
      return res.status(404).send('Not found');
    }
    const gzip = entry.gzip && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    const etag = gzip ? `${entry.etag.slice(0, -1)}-gz"` : entry.etag;
    res.setHeader('ETag', etag);
    if (entry.gzip) res.setHeader('Vary', 'Accept-Encoding');
    // Our JS and CSS are always revalidated (a 304 when unchanged): right
    // after a release, a new module importing from a cached old one would
    // not start. Vendor files only change with their path.
    const always = relative.startsWith('js/') || relative.startsWith('css/');
    res.setHeader('Cache-Control', relative.startsWith('vendor/') ? 'public, max-age=604800' : always ? 'no-cache' : 'public, max-age=300, must-revalidate');
    if (req.headers['if-none-match'] === etag) return res.status(304).end();
    if (gzip) res.setHeader('Content-Encoding', 'gzip');
    res.type(entry.type).send(gzip ? entry.gzip : entry.body);
  }

  for (const dir of ['vendor', 'css', 'js', 'img']) router.get(`/${dir}/*`, (req, res) => serve(req, res, `${dir}/${req.params.wildcard}`));
  router.get('/favicon.svg', (req, res) => serve(req, res, 'favicon.svg'));
}
