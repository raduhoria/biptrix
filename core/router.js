// Minimal closure-based router over node:http. No Express/Fastify.
// Handlers are (req, res, next); async handlers' errors become a JSON error
// (for /api/*) or an error page, via the onError hook given by app.js.

function compilePath(pathTemplate) {
  const keys = [];
  const pattern = pathTemplate
    .replace(/\/:([^/]+)/g, (_, key) => {
      keys.push(key);
      return '/([^/]+)';
    })
    .replace(/\/\*$/, () => {
      keys.push('wildcard');
      return '/(.*)';
    });
  return { regex: new RegExp(`^${pattern}/?$`), keys };
}

// decodeURIComponent throws on malformed input; a bad request must get a 400,
// never take the process down.
function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export function parseCookies(header) {
  const out = {};
  for (const pair of String(header || '').split(';')) {
    const idx = pair.indexOf('=');
    if (idx === -1) continue;
    const key = pair.slice(0, idx).trim();
    const decoded = safeDecode(pair.slice(idx + 1).trim());
    if (key && decoded != null) out[key] = decoded;
  }
  return out;
}

function decorateResponse(res) {
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.type = (mime) => {
    res.setHeader('Content-Type', mime);
    return res;
  };
  res.send = (body) => {
    if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', typeof body === 'string' ? 'text/html; charset=utf-8' : 'application/octet-stream');
    res.end(body);
  };
  res.json = (obj) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(obj));
  };
  res.redirect = (location, code = 303) => {
    res.statusCode = code;
    res.setHeader('Location', location);
    res.end();
  };
  res.cookie = (name, value, opts = {}) => {
    const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${opts.path || '/'}`];
    if (opts.maxAgeSeconds !== undefined) parts.push(`Max-Age=${opts.maxAgeSeconds}`);
    if (opts.httpOnly !== false) parts.push('HttpOnly');
    parts.push(`SameSite=${opts.sameSite || 'Lax'}`);
    if (opts.secure) parts.push('Secure');
    const existing = res.getHeader('Set-Cookie');
    res.setHeader('Set-Cookie', [...(existing ? [].concat(existing) : []), parts.join('; ')]);
    return res;
  };
  return res;
}

export function createRouter({ onError }) {
  const routes = { GET: [], POST: [], PUT: [], DELETE: [] };

  function add(method, pathTemplate, handlers) {
    routes[method].push({ ...compilePath(pathTemplate), handlers });
  }

  async function runHandlers(handlers, req, res) {
    for (const handler of handlers) {
      let calledNext = false;
      try {
        await handler(req, res, () => {
          calledNext = true;
        });
      } catch (err) {
        if (!res.writableEnded) onError(err, req, res);
        return;
      }
      if (res.writableEnded || !calledNext) return;
    }
  }

  function handle(req, res) {
    decorateResponse(res);
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      res.status(400).send('Bad request');
      return;
    }
    req.path = url.pathname;
    req.query = Object.fromEntries(url.searchParams);
    req.cookies = parseCookies(req.headers.cookie);
    const method = req.method === 'HEAD' ? 'GET' : req.method;
    for (const route of routes[method] || []) {
      const match = route.regex.exec(url.pathname);
      if (!match) continue;
      req.params = {};
      for (const [i, key] of route.keys.entries()) {
        const value = safeDecode(match[i + 1]);
        if (value == null) return res.status(400).send('Bad request');
        req.params[key] = value;
      }
      return runHandlers(route.handlers, req, res);
    }
    onError(Object.assign(new Error('Not found'), { code: 'not_found', status: 404, expose: true }), req, res);
  }

  return {
    get: (p, ...h) => add('GET', p, h),
    post: (p, ...h) => add('POST', p, h),
    put: (p, ...h) => add('PUT', p, h),
    delete: (p, ...h) => add('DELETE', p, h),
    handle,
  };
}

// Request bodies are capped; uploads use their own streaming path (core/files.js).
export function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('Payload too large'), { code: 'invalid', status: 413, expose: true }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export async function readForm(req) {
  return new URLSearchParams(await readBody(req));
}

export async function readJson(req) {
  const raw = await readBody(req);
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw Object.assign(new Error('Invalid JSON'), { code: 'invalid', status: 400, expose: true });
  }
}
