import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const MIME = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

// Static assets from public/, cached in memory with an ETag (304 on
// revalidation). Paths are resolved and confined to the public directory.
export function registerStatic(router, publicDir, { dev = false } = {}) {
  const root = path.resolve(publicDir);
  const cache = new Map();

  async function load(file) {
    if (!dev && cache.has(file)) return cache.get(file);
    const body = await readFile(file);
    const entry = { body, etag: `"${createHash('sha1').update(body).digest('base64url')}"`, type: MIME[path.extname(file)] || 'application/octet-stream' };
    cache.set(file, entry);
    return entry;
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
    res.setHeader('ETag', entry.etag);
    res.setHeader('Cache-Control', relative.startsWith('vendor/') ? 'public, max-age=604800' : 'public, max-age=300, must-revalidate');
    if (req.headers['if-none-match'] === entry.etag) return res.status(304).end();
    res.type(entry.type).send(entry.body);
  }

  for (const dir of ['vendor', 'css', 'js', 'img']) router.get(`/${dir}/*`, (req, res) => serve(req, res, `${dir}/${req.params.wildcard}`));
  router.get('/favicon.svg', (req, res) => serve(req, res, 'favicon.svg'));
}
