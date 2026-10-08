import en from '../locales/en.js';
import ro from '../locales/ro.js';
import es from '../locales/es.js';

// UI translations, nested objects looked up by dot path ("chat.send"). A key
// missing in ro.js or es.js falls back to English, then to the key itself.
const DICTIONARIES = { en, ro, es };
export const LOCALES = Object.keys(DICTIONARIES);
export const DEFAULT_LOCALE = 'en';
export const LOCALE_COOKIE = 'lang';

export function normalizeLocale(value) {
  const code = String(value || '').toLowerCase().slice(0, 2);
  return LOCALES.includes(code) ? code : null;
}

// The language chosen in the selector (cookie) first; app.js then applies the
// signed-in user's saved language; otherwise English. The browser's
// Accept-Language is deliberately not used: English is the default.
export function resolveLocale(cookies) {
  return normalizeLocale(cookies?.[LOCALE_COOKIE]) || DEFAULT_LOCALE;
}

// Intl locale for dates and times.
export const INTL_LOCALE = { en: 'en-GB', ro: 'ro-RO', es: 'es-ES' };

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
