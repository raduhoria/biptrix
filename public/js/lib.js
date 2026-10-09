// Small shared helpers for the browser modules. No framework.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// Full-screen pages (chat, call) take the height that is actually visible
// (--app-h), not 100dvh: some Android phones count the gesture bar in 100dvh
// for installed apps (the call's buttons went under it), and iOS Safari
// does not shrink the page for the on-screen keyboard but scrolls it up,
// out of the header. Skipped while pinch-zoomed.
export function fitViewport() {
  const vv = window.visualViewport;
  if (!vv) return;
  const fit = () => {
    if (vv.scale > 1.01) return;
    document.documentElement.style.setProperty('--app-h', `${Math.round(Math.min(vv.height, window.innerHeight))}px`);
    if (window.scrollY || vv.offsetTop) window.scrollTo(0, 0);
  };
  vv.addEventListener('resize', fit);
  vv.addEventListener('scroll', fit);
  fit();
}

export const icon = (name, cls = '') => `<svg class="ic ${cls}" aria-hidden="true"><use href="/img/icons.svg#${name}"/></svg>`;

export const initials = (name) =>
  String(name || '?')
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0])
    .join('')
    .toUpperCase();

// Stable avatar color from an id.
export function hue(id) {
  let h = 0;
  for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

// Translator over the `client` strings subtree sent in #boot.
export function translator(strings) {
  return (key, params = {}) => {
    const value = key.split('.').reduce((node, part) => (node == null ? undefined : node[part]), strings);
    return typeof value === 'string' ? value.replace(/\{(\w+)\}/g, (m, k) => params[k] ?? m) : key;
  };
}

// fetch wrapper for the JSON API: throws { code, message } on errors.
export async function api(path, { method = 'GET', body, signal } = {}) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
    signal,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    if (res.status === 401) location.href = `/login?next=${encodeURIComponent(location.pathname)}`;
    throw Object.assign(new Error(data?.error?.message || res.statusText), { code: data?.error?.code || 'internal', status: res.status, details: data?.error?.details });
  }
  return data;
}

export const randomId = () => (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`);

export function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export function toast(message, kind = 'secondary') {
  const box = document.getElementById('toasts');
  if (!box) return;
  const el = document.createElement('div');
  el.className = `toast align-items-center text-bg-${kind} border-0 show`;
  el.setAttribute('role', 'status');
  el.innerHTML = `<div class="d-flex"><div class="toast-body">${esc(message)}</div><button type="button" class="btn-close btn-close-white me-2 m-auto" aria-label="Close"></button></div>`;
  el.querySelector('button').onclick = () => el.remove();
  box.append(el);
  setTimeout(() => el.remove(), 5000);
}

// Safe "markdown light": the text is escaped first; only then a few
// patterns become markup. Links are http(s)/mailto only.
export function renderMarkdown(text, { mention } = {}) {
  const blocks = [];
  let src = esc(text).replace(/```([\s\S]*?)```/g, (m, code) => {
    blocks.push(`<pre class="md-pre"><code>${code.replace(/^\n/, '')}</code></pre>`);
    return `\u0000${blocks.length - 1}\u0000`;
  });
  const inline = [];
  src = src.replace(/`([^`\n]+)`/g, (m, code) => {
    inline.push(`<code class="md-code">${code}</code>`);
    return `\u0001${inline.length - 1}\u0001`;
  });
  src = src
    .replace(/&lt;@([A-Za-z0-9_-]{10,40})&gt;/g, (m, id) => (mention ? mention(id) : '@'))
    .replace(/(^|[\s(])((?:https?:\/\/|mailto:)[^\s<]+[^\s<.,;:!?)'"])/g, (m, pre, url) => `${pre}<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`)
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s).,!?])/g, '$1<em>$2</em>')
    .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
    .replace(/^&gt; (.*)$/gm, '<span class="md-quote">$1</span>')
    .replace(/\n/g, '<br>');
  return src.replace(/\u0001(\d+)\u0001/g, (m, i) => inline[i]).replace(/\u0000(\d+)\u0000/g, (m, i) => blocks[i]);
}

export const EMOJI = ['👍', '❤️', '😂', '🎉', '😮', '😢', '🙏', '👀', '✅', '🔥', '👏', '🚀', '😊', '🤔', '💯', '👌'];
