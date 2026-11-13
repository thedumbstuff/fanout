// The fanout-media: address the media viewer loads files from (media.js
// answers it).
//
// Electron takes a scheme's privileges only before the app is ready, so
// importing this module registers them. main.js imports it before anything
// else; a tool that starts the app by importing main.js later must import this
// module itself first (tools/smoke.mjs, tools/measure-memory.mjs).

import { app, protocol, session } from 'electron';
import { MEDIA_SCHEME } from './media.js';

if (app.isReady()) {
  throw new Error(`The ${MEDIA_SCHEME}: scheme must be registered before the app is ready: import mediaprotocol.js first.`);
}
protocol.registerSchemesAsPrivileged([{
  scheme: MEDIA_SCHEME,
  // standard + secure: an ordinary address with an origin, which the
  // interface's content policy names (media-src, img-src). stream: video and
  // audio play while they load instead of waiting for the whole file.
  // Not bypassCSP, not fetch, CORS or service workers: nothing else needs them.
  privileges: { standard: true, secure: true, stream: true },
}]);

/**
 * Answer the scheme in the interface's session only. Every brand has its own
 * session (sessions.js) and none of them has this handler, so a page in a tab
 * cannot load a fanout-media address at all.
 * @param {import('./media.js').MediaServer} server
 */
export function serveMedia(server) {
  session.defaultSession.protocol.handle(MEDIA_SCHEME, (request) => server.handle(request));
}
