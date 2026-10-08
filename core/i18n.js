import ro from '../locales/ro.js';
import en from '../locales/en.js';

// UI translations, nested objects looked up by dot path ("chat.send"). A key
// missing in en.js falls back to Romanian, then to the key itself.
const DICTIONARIES = { ro, en };
export const LOCALES = Object.keys(DICTIONARIES);
export const DEFAULT_LOCALE = 'ro';
export const LOCALE_COOKIE = 'lang';

export function normalizeLocale(value) {
  const code = String(value || '').toLowerCase().slice(0, 2);
  return LOCALES.includes(code) ? code : null;
}

// Explicit cookie choice first, then the browser's Accept-Language order.
export function resolveLocale(cookies, acceptLanguage = '') {
  const fromCookie = normalizeLocale(cookies?.[LOCALE_COOKIE]);
  if (fromCookie) return fromCookie;
  for (const part of String(acceptLanguage).split(',')) {
    const code = normalizeLocale(part.trim());
    if (code) return code;
  }
  return DEFAULT_LOCALE;
}

const lookup = (dict, key) => key.split('.').reduce((node, part) => (node == null ? undefined : node[part]), dict);

export function createTranslator(locale) {
  const dict = DICTIONARIES[locale] || DICTIONARIES[DEFAULT_LOCALE];
  function t(key, params = {}) {
    const value = lookup(dict, key) ?? lookup(DICTIONARIES[DEFAULT_LOCALE], key) ?? key;
    if (typeof value !== 'string') return value;
    return value.replace(/\{(\w+)\}/g, (match, name) => params[name] ?? match);
  }
  t.locale = DICTIONARIES[locale] ? locale : DEFAULT_LOCALE;
  t.has = (key) => lookup(dict, key) !== undefined || lookup(DICTIONARIES[DEFAULT_LOCALE], key) !== undefined;
  // The client bundle (public/js) gets only the `client` subtree.
  t.client = () => ({ ...lookup(DICTIONARIES[DEFAULT_LOCALE], 'client'), ...lookup(dict, 'client') });
  return t;
}

// Errors carry a standard `code` (core/util.js appError); the reader's
// language comes from errors.<code>, `message` stays English for logs.
export function translateError(t, err) {
  const reason = err?.details?.reason;
  if (reason && t.has(`errors.reason_${reason}`)) return t(`errors.reason_${reason}`, err.details);
  return err?.code && t.has(`errors.${err.code}`) ? t(`errors.${err.code}`, err.details || {}) : err?.message || String(err);
}
