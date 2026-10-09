// HTTP-level security helpers shared by app.js and the WebSocket upgrade.

export function clientIp(req, trustProxy) {
  if (trustProxy) {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (forwarded) return forwarded.slice(0, 64);
  }
  return req.socket.remoteAddress || '';
}

export function isSecure(req, trustProxy) {
  return !!req.socket.encrypted || (trustProxy && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https');
}

// CSP without inline scripts: page data travels in <script type="application/json">
// blocks, behavior only in /js/*.js files.
const CSP = [
  "default-src 'self'",
  // wasm-unsafe-eval: lets WebAssembly compile (noise suppression in
  // calls); JavaScript eval stays forbidden.
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self' ws: wss:",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export function securityHeaders(res, secure) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  // Invitation and reset tokens live in URLs: never send them to other sites
  // as Referer. (Not no-referrer: that turns Origin into "null" on our own
  // form posts and would defeat the CSRF origin check.)
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), display-capture=(self), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  if (secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

// CSRF (spec §14): state-changing requests must come from our own pages.
// Browsers always send Origin on cross-site POST/PUT/DELETE; when present it
// must be this app's origin — scheme, host and port, not just the host (an
// http:// page on the same host is another origin). Requests without Origin
// and Referer (curl, scripts) carry no ambient browser cookies in practice
// and are allowed.
export function originMatches(source, req, appUrl, secure) {
  try {
    const { origin } = new URL(source);
    return origin === new URL(appUrl).origin || origin === `${secure ? 'https' : 'http'}://${req.headers.host}`;
  } catch {
    return false;
  }
}

export function sameOrigin(req, appUrl) {
  const source = req.headers.origin || req.headers.referer;
  return !source || originMatches(source, req, appUrl, req.secure);
}
