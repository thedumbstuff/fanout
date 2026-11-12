// One browser session per brand. A session is a separate cookie jar, cache
// and storage on disk, so the same site can be signed in to a different
// account in every brand, and stays signed in between runs.

import { session, dialog } from 'electron';
import path from 'node:path';

const ALLOWED = new Set(['clipboard-sanitized-write', 'fullscreen', 'pointerLock', 'keyboardLock']);

// Asked once per brand and site, then remembered. Anything not listed is refused.
const ASKED = {
  media: 'use your camera or microphone',
  notifications: 'show notifications',
  geolocation: 'know your location',
  'clipboard-read': 'read what you have copied',
  openExternal: 'open a link in another app',
};

const originOf = (url) => {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
};

export const partitionOf = (brandId) => `persist:brand-${brandId}`;

export class BrandSessions {
  #brandBySession = new Map();
  #asking = new Map(); // permission key -> Promise<boolean>
  #store;
  #uploads;
  #window;

  /**
   * @param {object} deps
   * @param {import('./store.js').JsonStore} deps.store   holds `permissions` and `brands`
   * @param {import('./sleeper.js').UploadActivity} deps.uploads
   * @param {() => import('electron').BrowserWindow | null} deps.window
   */
  constructor({ store, uploads, window }) {
    this.#store = store;
    this.#uploads = uploads;
    this.#window = window;
  }

  /** The session of a brand, set up on first use. */
  for(brandId) {
    const ses = session.fromPartition(partitionOf(brandId));
    if (!this.#brandBySession.has(ses)) {
      this.#brandBySession.set(ses, brandId);
      this.#watchUploads(ses, brandId);
      this.#guardPermissions(ses, brandId);
      this.#aimDownloads(ses, brandId);
    }
    return ses;
  }

  /** The brand a session belongs to, or null (the app's own interface). */
  brandOf(ses) {
    return this.#brandBySession.get(ses) ?? null;
  }

  /** Sign out everywhere: delete a brand's cookies, storage and cache. */
  async wipe(brandId) {
    const ses = this.for(brandId);
    await Promise.allSettled([ses.clearStorageData(), ses.clearCache()]);
    const prefix = `${brandId}|`;
    for (const key of Object.keys(this.#store.data.permissions)) {
      if (key.startsWith(prefix)) delete this.#store.data.permissions[key];
    }
    this.#store.touch();
  }

  // Only the method and the timing of a request are looked at, never its body.
  #watchUploads(ses, brandId) {
    const key = (details) => `${brandId}:${details.id}`;
    const ended = (details) => {
      if (details.method !== 'GET') this.#uploads.end(key(details), Date.now());
    };
    ses.webRequest.onSendHeaders((details) => {
      if (details.method === 'GET') return;
      this.#uploads.begin(key(details), details.webContentsId, details.method, Date.now());
    });
    ses.webRequest.onCompleted(ended);
    ses.webRequest.onErrorOccurred(ended);
  }

  #guardPermissions(ses, brandId) {
    const saved = (origin, permission) =>
      this.#store.data.permissions[`${brandId}|${origin}|${permission}`];

    ses.setPermissionCheckHandler((_contents, permission, requestingOrigin) =>
      ALLOWED.has(permission) || saved(originOf(requestingOrigin), permission) === true);

    ses.setPermissionRequestHandler((contents, permission, callback, details) => {
      if (ALLOWED.has(permission)) return callback(true);
      if (!ASKED[permission]) return callback(false);
      const origin = originOf(details.requestingUrl || contents.getURL());
      const remembered = saved(origin, permission);
      if (typeof remembered === 'boolean') return callback(remembered);
      this.#ask(brandId, origin, permission).then(callback, () => callback(false));
    });
  }

  #ask(brandId, origin, permission) {
    const key = `${brandId}|${origin}|${permission}`;
    const pending = this.#asking.get(key);
    if (pending) return pending;

    const brand = this.#store.data.brands.find((b) => b.id === brandId);
    const options = {
      type: 'question',
      message: `${new URL(origin).host} wants to ${ASKED[permission]}`,
      detail: brand ? `In the brand "${brand.name}".` : '',
      buttons: ['Allow', 'Block'],
      defaultId: 1,
      cancelId: 1,
      checkboxLabel: 'Remember for this site',
      checkboxChecked: true,
    };
    const win = this.#window();
    const asked = (win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options))
      .then(({ response, checkboxChecked }) => {
        const allowed = response === 0;
        if (checkboxChecked) {
          this.#store.data.permissions[key] = allowed;
          this.#store.touch();
        }
        return allowed;
      })
      .finally(() => this.#asking.delete(key));
    this.#asking.set(key, asked);
    return asked;
  }

  // A download's save dialog opens in the brand's own folder.
  #aimDownloads(ses, brandId) {
    ses.on('will-download', (_event, item) => {
      const folder = this.#store.data.brands.find((b) => b.id === brandId)?.folder;
      if (folder) item.setSaveDialogOptions({ defaultPath: path.join(folder, item.getFilename()) });
    });
  }
}
