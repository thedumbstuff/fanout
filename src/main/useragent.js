// Electron adds "fanout/0.1.0" and "Electron/45.3.0" to the user agent. Some
// sites (Google sign-in first among them) refuse browsers they do not
// recognise, so tabs present the plain Chrome string the engine really is.

/** Remove the app's own token and Electron's from a Chromium user agent. */
export function cleanUserAgent(userAgent, appName) {
  const names = ['Electron', appName].filter(Boolean).map(escapeRegExp).join('|');
  return String(userAgent)
    .replace(new RegExp(`\\s(?:${names})/\\S+`, 'gi'), '')
    .trim();
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
