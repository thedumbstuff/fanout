// What the address bar accepts, and how a URL is named in the interface.
// Pure functions: no Electron, no I/O.

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const HOST_WITH_PORT = /^[a-z0-9.-]+:\d{1,5}(\/|$)/i;
const HOSTLIKE = /^(localhost|[a-z0-9-]+(\.[a-z0-9-]+)+)(:\d{1,5})?([/?#].*)?$/i;
const LOCAL = /^(localhost|127\.|10\.|192\.168\.|\[?::1\]?)/i;
const GENERIC_SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'gov', 'edu', 'ac']);

export const SEARCH_URL = 'https://duckduckgo.com/?q=';

/** True for http and https URLs, the only kind a tab may show. */
export function isWebUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Turn what somebody typed into the address bar into a URL to load.
 * Returns null when the text is empty or names a scheme a tab must not open
 * (file:, javascript:, data: ...). Anything that is not an address is searched.
 */
export function toUrl(input) {
  const text = String(input ?? '').trim();
  if (!text) return null;

  if (SCHEME.test(text) && !HOST_WITH_PORT.test(text)) {
    return isWebUrl(text) ? new URL(text).href : null;
  }
  if (!/\s/.test(text) && HOSTLIKE.test(text)) {
    const candidate = `${LOCAL.test(text) ? 'http' : 'https'}://${text}`;
    if (isWebUrl(candidate)) return new URL(candidate).href;
  }
  return SEARCH_URL + encodeURIComponent(text);
}

/** "https://www.studio.youtube.com/x" -> "studio.youtube.com" ('' if not a URL). */
export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** A short human name for a site: "https://studio.youtube.com" -> "Youtube". */
export function siteName(url) {
  const host = hostOf(url);
  if (!host) return '';
  const parts = host.split('.');
  if (parts.length === 1 || /^\d+$/.test(parts.at(-1))) return host;
  let label = parts.at(-2);
  if (GENERIC_SECOND_LEVEL.has(label) && parts.length > 2) label = parts.at(-3);
  return label.charAt(0).toUpperCase() + label.slice(1);
}
