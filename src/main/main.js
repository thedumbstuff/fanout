// fanout's main process: one window, the saved data, and the pieces that
// work on them. Start reading here.
//
//   model.js     the saved shape (brands, tabs, settings)       pure
//   store.js     JSON file, written a moment after each change
//   sessions.js  one isolated browser session per brand
//   tabs.js      pages: loading, showing, sleeping, closing
//   sleeper.js   which tabs to put to sleep                      pure
//   pages.js     rules every web page lives under
//   files.js     the brand folder: listing, text preview, watching
//   posted.js    which file went to which tab
//   ipc.js       what the interface may ask for
//   menus.js     application menu, shortcuts, right-click menus

import { app, BrowserWindow, Menu, dialog, nativeImage, nativeTheme, screen } from 'electron';
import path from 'node:path';
import { FolderWatcher } from './files.js';
import { registerIpc } from './ipc.js';
import { buildAppMenu } from './menus.js';
import { BRAND_COLORS, deleteBrand, findBrand, sanitize } from './model.js';
import { hardenPage } from './pages.js';
import { PostedStore } from './posted.js';
import { BrandSessions } from './sessions.js';
import { UploadActivity } from './sleeper.js';
import { JsonStore } from './store.js';
import { TabManager } from './tabs.js';
import { siteName } from './urls.js';
import { cleanUserAgent } from './useragent.js';

/**
 * @typedef {object} Context
 * @property {BrowserWindow} window
 * @property {JsonStore} store
 * @property {PostedStore} posted
 * @property {BrandSessions} sessions
 * @property {TabManager} tabs
 * @property {FolderWatcher} watcher
 * @property {Electron.NativeImage} dragIcon
 * @property {() => object} snapshot                  the state the interface draws
 * @property {() => void} changed                     send that state soon
 * @property {(channel: string, ...args: any[]) => void} send
 * @property {(brandId: string, options?: {ask?: boolean}) => Promise<boolean>} deleteBrand
 * @property {() => Promise<void>} shutdown           save everything and end the process
 */

const ROOT = path.join(import.meta.dirname, '..', '..');
const PUSH_MS = 40; // state changes within this window reach the interface as one message

// Tests run against a throwaway profile instead of the real one.
if (process.env.FANOUT_USER_DATA) app.setPath('userData', process.env.FANOUT_USER_DATA);

/** Resolves to the Context once the window exists (null if another copy is already running). */
export const ready = boot();

async function boot() {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return null;
  }
  await app.whenReady();
  app.userAgentFallback = cleanUserAgent(app.userAgentFallback, app.getName());

  const dataDir = app.getPath('userData');
  const store = new JsonStore(path.join(dataDir, 'fanout.json'), { sanitize });
  const posted = new PostedStore(path.join(dataDir, 'posted.json'));
  const uploads = new UploadActivity();

  /** @type {Context} */
  const ctx = { store, posted };
  ctx.sessions = new BrandSessions({ store, uploads, window: () => ctx.window ?? null });

  // Every page that belongs to a brand (tabs and the popups they open) gets
  // the same rules. The interface itself uses the default session.
  app.on('web-contents-created', (_event, contents) => {
    if (!ctx.sessions.brandOf(contents.session)) return;
    hardenPage(contents, {
      window: () => ctx.window ?? null,
      openTab: (opener, url, background) => ctx.tabs.openFromPage(opener, url, background),
    });
  });

  ctx.window = createWindow(store);
  ctx.dragIcon = nativeImage.createFromPath(path.join(ROOT, 'build', 'drag.png'));

  ctx.send = (channel, ...args) => {
    if (!ctx.window.isDestroyed()) ctx.window.webContents.send(channel, ...args);
  };

  let pushTimer = null;
  ctx.changed = () => {
    pushTimer ??= setTimeout(() => {
      pushTimer = null;
      ctx.send('state', ctx.snapshot());
    }, PUSH_MS);
  };

  ctx.tabs = new TabManager({
    window: ctx.window,
    store,
    sessions: ctx.sessions,
    uploads,
    changed: ctx.changed,
  });
  ctx.watcher = new FolderWatcher((brandId, rel) => ctx.send('files:changed', brandId, rel));

  ctx.snapshot = () => ({
    platform: process.platform,
    version: app.getVersion(),
    colors: BRAND_COLORS,
    settings: store.data.settings,
    activeBrandId: store.data.activeBrandId,
    brands: store.data.brands.map((brand) => ({
      id: brand.id,
      name: brand.name,
      color: brand.color,
      folder: brand.folder,
      activeTabId: brand.activeTabId,
      tabs: brand.tabs.map((tab) => ({
        ...tab,
        site: siteName(tab.homeUrl || tab.url),
        ...ctx.tabs.runtime(tab.id),
      })),
    })),
  });

  ctx.deleteBrand = async (brandId, { ask = true } = {}) => {
    const brand = findBrand(store.data, brandId);
    if (!brand) return false;
    if (ask) {
      const { response } = await dialog.showMessageBox(ctx.window, {
        type: 'warning',
        message: `Delete the brand "${brand.name}"?`,
        detail:
          'This signs it out of every site and forgets its tabs and posted marks. ' +
          'The files in its folder are not touched.',
        buttons: ['Delete brand', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
      });
      if (response !== 0) return false;
    }
    ctx.tabs.dropBrand(brandId);
    deleteBrand(store.data, brandId);
    posted.dropBrand(brandId);
    store.touch();
    ctx.tabs.refresh();
    await ctx.sessions.wipe(brandId);
    return true;
  };

  registerIpc(ctx);
  Menu.setApplicationMenu(buildAppMenu(ctx));

  app.on('second-instance', () => {
    if (ctx.window.isMinimized()) ctx.window.restore();
    ctx.window.focus();
  });
  ctx.window.webContents.on('did-finish-load', () => ctx.tabs.refresh());

  // Closing the window is the one way out. Electron's own quit is not used:
  // in Electron 45 it never finishes once certain sites have been open (a
  // bare Electron app that loads instagram.com and quits hangs the same way,
  // and so do app.exit and process.exit). So fanout saves everything itself
  // and then ends its own process, which cannot hang. See docs/gotchas.md.
  ctx.shutdown = async () => {
    ctx.tabs.dispose();
    ctx.watcher.closeAll();
    store.flush();
    posted.flush();
    await ctx.sessions.flushAll();
    process.kill(process.pid, 'SIGKILL');
  };
  ctx.window.on('closed', ctx.shutdown);
  app.on('before-quit', (event) => {
    // Quit from the menu, the dock or the system: turn it into closing the window.
    event.preventDefault();
    if (!ctx.window.isDestroyed()) ctx.window.close();
  });
  app.on('window-all-closed', () => {}); // shutdown is already on its way

  await ctx.window.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
  return ctx;
}

function createWindow(store) {
  const saved = visibleOnSomeDisplay(store.data.window) ? store.data.window : null;
  const window = new BrowserWindow({
    width: saved?.width ?? 1360,
    height: saved?.height ?? 860,
    x: saved?.x,
    y: saved?.y,
    minWidth: 940,
    minHeight: 560,
    show: false,
    title: 'fanout',
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#191613' : '#ede4d3',
    icon: path.join(ROOT, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(ROOT, 'src', 'preload', 'preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  if (saved?.maximized) window.maximize();
  window.once('ready-to-show', () => window.show());

  // The interface is one local page and never goes anywhere else.
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  let saveTimer = null;
  const remember = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (window.isDestroyed()) return;
      store.data.window = { ...window.getNormalBounds(), maximized: window.isMaximized() };
      store.touch();
    }, 500);
  };
  window.on('resize', remember);
  window.on('move', remember);
  window.on('close', () => {
    clearTimeout(saveTimer);
    store.data.window = { ...window.getNormalBounds(), maximized: window.isMaximized() };
  });
  return window;
}

/** A window saved on a monitor that has since been unplugged should not open off-screen. */
function visibleOnSomeDisplay(bounds) {
  if (!bounds || bounds.x === undefined || bounds.y === undefined) return Boolean(bounds);
  return screen.getAllDisplays().some(({ workArea: a }) =>
    bounds.x < a.x + a.width - 80 &&
    bounds.x + bounds.width > a.x + 80 &&
    bounds.y < a.y + a.height - 80 &&
    bounds.y + bounds.height > a.y);
}
