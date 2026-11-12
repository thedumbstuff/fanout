// New versions. electron-updater reads a feed (latest.yml) from the address in
// the build config, downloads the installer in the background and checks it
// against the SHA-512 in the feed. Installing is fanout's own business, because
// Electron's quit is not used here (docs/gotchas.md):
//
//   "Restart to update"  save everything, start the installer, end the process;
//                        the installer waits for that, installs and starts fanout.
//   closing the window   if an update is waiting, the same without the restart.
//
// macOS only installs updates for signed apps, and fanout is not signed yet:
// there it says a new version is out and opens the download page.

import { app, shell } from 'electron';
import { notesText, whatsNew } from './notes.js';

export const DOWNLOAD_PAGE = 'https://thedumbstuff.page/';
const FIRST_CHECK_MS = 15_000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

export class Updates {
  #store;
  #changed;
  #save;
  #updater = null;
  #timer = null;
  #installing = false;
  /** 'off' | 'idle' | 'checking' | 'downloading' | 'ready' | 'available' | 'current' | 'error' */
  #status = 'off';
  #version = '';
  #percent = 0;
  #problem = '';
  #news;

  /**
   * @param {object} deps
   * @param {import('./store.js').JsonStore} deps.store
   * @param {() => void} deps.changed       the interface should redraw
   * @param {() => Promise<void>} deps.save write everything to disk (data, cookies, storage)
   */
  constructor({ store, changed, save }) {
    this.#store = store;
    this.#changed = changed;
    this.#save = save;
    const current = app.getVersion();
    this.#news = whatsNew(store.data.lastVersion, current, store.data.releaseNotes);
    if (store.data.lastVersion !== current) {
      store.data.lastVersion = current;
      store.touch();
    }
  }

  /** Begin checking: shortly after start, then every six hours. */
  async start() {
    // Only an installed copy can be updated. FANOUT_UPDATE_URL points a test at its own feed.
    const testFeed = process.env.FANOUT_UPDATE_URL;
    if (!app.isPackaged && !testFeed) return;
    try {
      const { default: electronUpdater } = await import('electron-updater');
      this.#updater = electronUpdater.autoUpdater;
    } catch (error) {
      return this.#fail(error);
    }
    const updater = this.#updater;
    updater.logger = null;
    updater.autoDownload = process.platform !== 'darwin';
    updater.autoInstallOnAppQuit = false; // shutdown() below does it instead
    updater.forceDevUpdateConfig = !app.isPackaged;
    if (testFeed) updater.setFeedURL({ provider: 'generic', url: testFeed });

    updater.on('checking-for-update', () => this.#set('checking'));
    updater.on('update-not-available', () => this.#set('current'));
    updater.on('update-available', (info) => {
      this.#version = info.version;
      this.#percent = 0;
      this.#set(updater.autoDownload ? 'downloading' : 'available');
    });
    updater.on('download-progress', (progress) => {
      const percent = Math.floor(progress.percent);
      if (percent === this.#percent) return;
      this.#percent = percent;
      this.#set('downloading');
    });
    updater.on('update-downloaded', (info) => {
      this.#version = info.version;
      this.#store.data.releaseNotes = { version: info.version, text: notesText(info.releaseNotes) };
      this.#store.touch();
      this.#set('ready');
    });
    updater.on('error', (error) => this.#fail(error));

    this.#status = 'idle';
    this.#timer = setInterval(() => this.#auto(), CHECK_EVERY_MS);
    this.#timer.unref();
    setTimeout(() => this.#auto(), FIRST_CHECK_MS).unref();
  }

  #auto() {
    if (this.#store.data.settings.autoUpdate) this.check();
  }

  /** Look for a new version now. Resolves with view() once the answer is in. */
  async check() {
    if (!this.#updater || ['checking', 'downloading', 'ready'].includes(this.#status)) return this.view();
    try {
      const result = await this.#updater.checkForUpdates();
      // A failed download is reported through the 'error' event; the promise only repeats it.
      result?.downloadPromise?.catch(() => {});
    } catch (error) {
      this.#fail(error);
    }
    return this.view();
  }

  /** The owner pressed "Restart to update" (or "Get it" on macOS). */
  async install() {
    if (this.#status === 'available') return shell.openExternal(DOWNLOAD_PAGE);
    if (this.#status !== 'ready' || this.#installing) return;
    await this.#save();
    this.#launchInstaller({ restart: true });
    // quitAndInstall asks Electron to quit; main.js turns that into closing
    // the window, which ends in shutdown() and the end of the process.
  }

  /**
   * Called on the way out. If an update is waiting, start its installer so
   * the next start is the new version. Returns true if one was started.
   */
  installOnExit() {
    if (this.#status !== 'ready' || this.#installing) return this.#installing;
    return this.#launchInstaller({ restart: false });
  }

  #launchInstaller({ restart }) {
    this.#installing = true;
    try {
      this.#updater.quitAndInstall(true, restart); // silent; start fanout afterwards only on "restart"
      return true;
    } catch (error) {
      this.#installing = false;
      this.#fail(error);
      return false;
    }
  }

  /** The notes were read: do not offer them again. */
  dismissNews() {
    this.#news = null;
    this.#changed();
  }

  /** What the interface shows. */
  view() {
    return {
      status: this.#status,
      version: this.#version,
      percent: this.#percent,
      problem: this.#problem,
      current: app.getVersion(),
      news: this.#news,
    };
  }

  #set(status) {
    this.#status = status;
    this.#problem = '';
    this.#changed();
  }

  #fail(error) {
    // A failed check is not the owner's problem: it is retried in six hours,
    // and shown only where they asked (Settings, "Check for updates").
    this.#status = this.#status === 'ready' ? 'ready' : 'error';
    this.#problem = String(error?.message ?? error).split('\n')[0].slice(0, 200);
    this.#changed();
  }
}
