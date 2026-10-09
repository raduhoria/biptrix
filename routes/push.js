import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { readJson } from '../core/router.js';

// Push notifications: the service worker (served from the root so its scope
// is the whole app), the web app manifest (installable app — needed on
// iPhone for notifications at all), and a device's (un)subscription.
export function registerPushRoutes(router, { auth, push, config }) {
  const swFile = path.join(import.meta.dirname, '..', 'public', 'sw.js');
  let sw = null;

  router.get('/sw.js', async (req, res) => {
    sw ||= await readFile(swFile);
    // Always revalidated: a new release must reach installed devices.
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Service-Worker-Allowed', '/');
    res.type('text/javascript; charset=utf-8').send(config.dev ? await readFile(swFile) : sw);
  });

  const manifest = JSON.stringify({
    name: 'BipTrix',
    short_name: 'BipTrix',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#111318',
    theme_color: '#4f46e5',
    icons: [
      { src: '/img/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/img/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/img/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  });
  router.get('/manifest.webmanifest', (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.type('application/manifest+json').send(manifest);
  });

  router.post('/api/push/subscribe', auth.requireUser, async (req, res) => {
    await push.subscribe(req.user, req.session, await readJson(req), req.headers['user-agent']);
    res.json({ ok: true });
  });

  router.post('/api/push/unsubscribe', auth.requireUser, async (req, res) => {
    await push.unsubscribe(req.user.id, (await readJson(req)).endpoint);
    res.json({ ok: true });
  });
}
