import { LOCALES } from '../core/i18n.js';

// Page shells, rendered with template literals (no template engine).
// Bootstrap 5 is served locally from /vendor; app.css adds the product look.
// No inline scripts (CSP): page data goes in <script type="application/json">.

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export const icon = (name, cls = '') => `<svg class="ic ${cls}" aria-hidden="true"><use href="/img/icons.svg#${name}"/></svg>`;

// JSON for <script type="application/json">: "<" is escaped so the data
// can never close the script element.
export function jsonData(id, value) {
  const json = JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return `<script type="application/json" id="${id}">${json}</script>`;
}

export const initials = (name) =>
  String(name || '?')
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0])
    .join('')
    .toUpperCase();

export function alerts({ notice = '', error = '' }) {
  return (
    (notice ? `<div class="alert alert-success py-2" role="status">${escapeHtml(notice)}</div>` : '') +
    (error ? `<div class="alert alert-danger py-2" role="alert">${escapeHtml(error)}</div>` : '')
  );
}

export function languageMenu(t, next) {
  return `<form method="post" action="/locale" class="d-inline-flex lang-form">
    <input type="hidden" name="next" value="${escapeHtml(next)}">
    ${LOCALES.map((code) => `<button class="btn btn-sm ${t.locale === code ? 'btn-secondary' : 'btn-outline-secondary'}" name="locale" value="${code}" lang="${code}">${code.toUpperCase()}</button>`).join('')}
  </form>`;
}

function head(t, title) {
  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(title)} · ${escapeHtml(t('app.name'))}</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="apple-touch-icon" href="/img/apple-touch-icon.png">
<meta name="theme-color" content="#4f46e5">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="BipTrix">
<link rel="stylesheet" href="/vendor/bootstrap/bootstrap.min.css">
<link rel="stylesheet" href="/css/app.css">
<script src="/js/theme.js"></script>`;
}

// page: full-height app pages (chat, meetings, admin). `nav` is the left
// rail; `scripts` are ES modules from /js.
export function page({ t, title, body, bodyClass = '', scripts = [], data = '' }) {
  return `<!doctype html>
<html lang="${t.locale}">
<head>
${head(t, title)}
</head>
<body class="${bodyClass}">
${body}
${data}
<script src="/vendor/bootstrap/bootstrap.bundle.min.js" defer></script>
${scripts.map((s) => `<script type="module" src="/js/${s}"></script>`).join('\n')}
</body>
</html>`;
}

// authPage: centered card for sign-in, setup, invitations, guest join.
export function authPage({ t, title, subtitle = '', body, path = '/', wide = false, scripts = [], data = '' }) {
  return page({
    t,
    title,
    bodyClass: 'auth-body',
    scripts,
    data,
    body: `<main class="auth-shell">
  <div class="auth-top">
    <a class="brand" href="/">${icon('logo', 'brand-logo')}<span>${escapeHtml(t('app.name'))}</span></a>
    ${languageMenu(t, path)}
  </div>
  <section class="card auth-card shadow-sm${wide ? ' auth-card-wide' : ''}">
    <div class="card-body p-4 p-md-5">
      <h1 class="h4 mb-1">${escapeHtml(title)}</h1>
      ${subtitle ? `<p class="text-body-secondary mb-4">${subtitle}</p>` : '<div class="mb-3"></div>'}
      ${body}
    </div>
  </section>
  <p class="auth-foot">${escapeHtml(t('app.footer'))}</p>
</main>`,
  });
}

export function messagePage({ t, title, message, back = '/', status = '' }) {
  return authPage({
    t,
    title,
    body: `<div class="text-center py-2">
      <div class="display-6 text-body-tertiary mb-3">${escapeHtml(status)}</div>
      <p class="mb-4">${escapeHtml(message)}</p>
      <a class="btn btn-primary" href="${escapeHtml(back)}">${escapeHtml(t('common.back'))}</a>
    </div>`,
  });
}

// Admin/operator console: top bar + side navigation + content.
export function consolePage({ t, title, user, org = null, nav, active, body, path, scripts = [], data = '' }) {
  const links = nav
    .map(({ href, key, label, ic }) => `<a class="list-group-item list-group-item-action d-flex align-items-center gap-2${active === key ? ' active' : ''}" href="${href}">${icon(ic)}<span>${escapeHtml(label)}</span></a>`)
    .join('');
  return page({
    t,
    title,
    bodyClass: 'console-body',
    scripts: ['console.js', ...scripts],
    data,
    body: `<header class="console-top border-bottom">
  <a class="brand" href="${org ? `/o/${escapeHtml(org.slug)}` : '/'}">${icon('logo', 'brand-logo')}<span class="d-none d-sm-inline">${escapeHtml(t('app.name'))}</span></a>
  ${org ? `<span class="badge text-bg-light border console-org">${escapeHtml(org.name)}</span>` : `<span class="badge text-bg-warning console-org">${escapeHtml(t('platform.badge'))}</span>`}
  <div class="ms-auto d-flex align-items-center gap-2 flex-shrink-0">
    ${org ? `<a class="btn btn-sm btn-outline-secondary" href="/o/${escapeHtml(org.slug)}" title="${escapeHtml(t('nav.backToChat'))}">${icon('chat')} <span class="d-none d-md-inline">${escapeHtml(t('nav.backToChat'))}</span></a>` : ''}
    <button class="btn btn-sm btn-outline-secondary theme-toggle" type="button" aria-label="${escapeHtml(t('nav.theme'))}">${icon('moon', 'only-light')}${icon('sun', 'only-dark')}</button>
    ${languageMenu(t, path)}
    <a class="btn btn-sm btn-outline-secondary" href="/account" title="${escapeHtml(user.email)}">${icon('user')} <span class="d-none d-md-inline">${escapeHtml(user.name)}</span></a>
  </div>
</header>
<div class="console-wrap">
  <nav class="console-nav"><div class="list-group list-group-flush">${links}</div></nav>
  <main class="console-main">
    <h1 class="h4 mb-4">${escapeHtml(title)}</h1>
    ${body}
  </main>
</div>`,
  });
}

export function table(headers, rows, empty) {
  if (!rows.length) return `<div class="text-body-secondary py-4 text-center">${escapeHtml(empty)}</div>`;
  return `<div class="table-responsive"><table class="table table-hover align-middle mb-0 table-stack">
    <thead><tr>${headers.map((h) => `<th scope="col">${escapeHtml(h)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((cells) => `<tr>${cells.map((c, i) => `<td data-label="${escapeHtml(headers[i] || '')}">${c}</td>`).join('')}</tr>`).join('')}</tbody>
  </table></div>`;
}

// <time> with a UTC fallback; public/js/console.js shows it in the reader's
// own time zone.
export const fmtDate = (iso) => (iso ? `<time datetime="${escapeHtml(iso)}">${escapeHtml(iso.slice(0, 16).replace('T', ' '))} UTC</time>` : '—');
