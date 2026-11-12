// Tabs and their memory.
//
// A tab is a saved address. Only a "live" tab has a page (a WebContentsView
// with its own process). Tabs are loaded the first time they are selected,
// only the selected one is attached to the window, and background tabs are
// put to sleep (page destroyed, address kept) by the policy in sleeper.js.
//
// Putting a tab to sleep asks the page first, the same way closing a browser
// tab does (beforeunload). A page holding unsaved work says no, and is then
// left alone until its owner has looked at it again.

import { WebContentsView, app, dialog } from 'electron';
import { addTab, findBrand, findTab, removeTab } from './model.js';
import { pickTabsToSleep } from './sleeper.js';
import { isWebUrl, toUrl } from './urls.js';

const SWEEP_MS = 30_000;
const FORCE_CLOSE_MS = 4000; // a page that hangs on close is closed anyway
const ABORTED = -3; // Chromium's code for a load the user or page cancelled

export class TabManager {
  #window;
  #store;
  #sessions;
  #uploads;
  #changed;

  /** tabId -> { view, contents, contentsId, lastActive, intent, hold, loading, error, forceTimer } */
  #live = new Map();
  #tabByContents = new Map(); // webContents id -> tabId
  #parked = new Set(); // tabs asleep on purpose: selected, but not to be loaded
  #crashed = new Set();
  #shown = null; // tabId of the view attached to the window
  #bounds = { x: 0, y: 0, width: 0, height: 0 };
  #covered = false; // a dialog of the interface is open over the page
  #sweeper;
  #disposed = false;

  /**
   * @param {object} deps
   * @param {import('electron').BrowserWindow} deps.window
   * @param {import('./store.js').JsonStore} deps.store
   * @param {import('./sessions.js').BrandSessions} deps.sessions
   * @param {import('./sleeper.js').UploadActivity} deps.uploads
   * @param {() => void} deps.changed  called whenever what the interface shows may differ
   */
  constructor({ window, store, sessions, uploads, changed }) {
    this.#window = window;
    this.#store = store;
    this.#sessions = sessions;
    this.#uploads = uploads;
    this.#changed = changed;
    this.#sweeper = setInterval(() => this.sweep(), SWEEP_MS);
    this.#sweeper.unref();
  }

  // ---------------------------------------------------------------- layout

  /** Where the page goes inside the window, in the interface's own pixels. */
  setBounds(rect) {
    const zoom = this.#window.webContents.getZoomFactor();
    const px = (n) => Math.max(0, Math.round(Number(n) * zoom) || 0);
    this.#bounds = { x: px(rect.x), y: px(rect.y), width: px(rect.width), height: px(rect.height) };
    this.#live.get(this.#shown)?.view.setBounds(this.#bounds);
  }

  /** A dialog is open (true) or closed again: pages are drawn above the interface, so hide. */
  setCovered(covered) {
    if (this.#covered === covered) return;
    this.#covered = covered;
    this.#present();
  }

  // --------------------------------------------------------------- actions

  selectBrand(brandId) {
    const data = this.#store.data;
    if (!findBrand(data, brandId) || data.activeBrandId === brandId) return;
    data.activeBrandId = brandId;
    this.#store.touch();
    this.#present({ focus: true });
    this.sweep();
  }

  select(tabId) {
    const found = findTab(this.#store.data, tabId);
    if (!found) return;
    found.brand.activeTabId = tabId;
    this.#store.data.activeBrandId = found.brand.id;
    this.#parked.delete(tabId);
    this.#crashed.delete(tabId);
    this.#store.touch();
    this.#present({ focus: true });
    this.sweep();
  }

  /** Add a tab to a brand. A background tab is not loaded until it is selected. */
  open(brandId, { url = '', temp = false, afterId = null, background = false } = {}) {
    const brand = findBrand(this.#store.data, brandId);
    if (!brand) return null;
    const tab = addTab(brand, { url, temp, afterId });
    this.#store.touch();
    if (background) this.#changed();
    else this.select(tab.id);
    return tab;
  }

  /** A page asked for a new tab (a link with target=_blank, or the menu). */
  openFromPage(opener, url, background) {
    const brandId = this.#sessions.brandOf(opener.session);
    if (!brandId || !isWebUrl(url)) return;
    this.open(brandId, { url, temp: true, afterId: this.#tabByContents.get(opener.id), background });
  }

  /** Load what was typed in the address bar. False if it is not something a tab may open. */
  navigate(tabId, input) {
    const found = findTab(this.#store.data, tabId);
    const url = toUrl(input);
    if (!found || !url) return false;
    const { tab } = found;
    tab.url = url;
    if (!tab.homeUrl) tab.homeUrl = url;
    this.#parked.delete(tabId);
    this.#crashed.delete(tabId);
    this.#store.touch();

    const live = this.#live.get(tabId);
    if (live) {
      live.error = null;
      this.#load(live, url);
    }
    this.#present({ focus: true });
    return true;
  }

  /** @param {'back'|'forward'|'reload'|'stop'|'home'|'wake'|'set-home'|'keep-awake'|'keep'} name */
  act(tabId, name) {
    const found = findTab(this.#store.data, tabId);
    if (!found) return;
    const { tab } = found;
    const live = this.#live.get(tabId);
    const history = live?.contents.navigationHistory;

    switch (name) {
      case 'back':
        if (history?.canGoBack()) history.goBack();
        break;
      case 'forward':
        if (history?.canGoForward()) history.goForward();
        break;
      case 'stop':
        live?.contents.stop();
        break;
      case 'reload':
        if (live) {
          live.error = null;
          live.contents.reload();
          this.#present();
        } else {
          this.select(tabId);
        }
        break;
      case 'wake':
        this.select(tabId);
        break;
      case 'home':
        if (tab.homeUrl) this.navigate(tabId, tab.homeUrl);
        break;
      case 'set-home':
        if (isWebUrl(tab.url)) tab.homeUrl = tab.url;
        break;
      case 'keep-awake':
        tab.keepAwake = !tab.keepAwake;
        break;
      case 'keep':
        tab.temp = false;
        if (!tab.homeUrl) tab.homeUrl = tab.url;
        break;
      default:
        return;
    }
    this.#store.touch();
    this.#changed();
  }

  rename(tabId, name) {
    const found = findTab(this.#store.data, tabId);
    if (!found) return;
    found.tab.name = String(name ?? '').trim().slice(0, 40);
    this.#store.touch();
    this.#changed();
  }

  close(tabId) {
    const live = this.#live.get(tabId);
    if (!live) return this.#forget(tabId);
    this.#retire(live, 'close');
  }

  /**
   * Put a tab to sleep. `auto` is the memory policy asking: the page may
   * refuse (unsaved work) and nothing is forced. Otherwise the owner asked,
   * and is shown a question if the page objects.
   */
  sleep(tabId, { auto = false } = {}) {
    const live = this.#live.get(tabId);
    if (live) this.#retire(live, auto ? 'auto' : 'sleep');
  }

  sleepOthers() {
    for (const tabId of [...this.#live.keys()]) {
      if (tabId !== this.#activeTabId()) this.sleep(tabId);
    }
  }

  /** Destroy every page of a brand at once, without asking them. For deleting the brand. */
  dropBrand(brandId) {
    const brand = findBrand(this.#store.data, brandId);
    for (const tab of brand?.tabs ?? []) {
      this.#parked.delete(tab.id);
      this.#crashed.delete(tab.id);
      const live = this.#live.get(tab.id);
      if (!live) continue;
      live.intent = 'drop';
      live.contents.close();
    }
  }

  /** Run the memory policy now (it also runs every 30 seconds). */
  sweep() {
    if (this.#disposed) return;
    const { sleepAfterMinutes, maxLiveTabs } = this.#store.data.settings;
    const now = Date.now();
    const active = this.#activeTabId();
    const vitals = [];
    for (const [id, live] of this.#live) {
      if (live.intent) continue; // already on its way out
      vitals.push({
        id,
        live: true,
        visible: id === active,
        busy: this.#isBusy(live, now),
        keepAwake: findTab(this.#store.data, id)?.tab.keepAwake === true,
        lastActive: live.lastActive,
      });
    }
    const picked = pickTabsToSleep(vitals, {
      now,
      sleepAfterMs: sleepAfterMinutes * 60_000,
      maxLive: maxLiveTabs,
    });
    for (const id of picked) this.sleep(id, { auto: true });
  }

  // ------------------------------------------------------------- reporting

  /** What the interface needs to know about a tab beyond its saved fields. */
  runtime(tabId) {
    const live = this.#live.get(tabId);
    const history = live?.contents.navigationHistory;
    return {
      live: Boolean(live),
      loading: live?.loading ?? false,
      canBack: history?.canGoBack() ?? false,
      canForward: history?.canGoForward() ?? false,
      audible: live?.contents.isCurrentlyAudible() ?? false,
      holding: live?.hold ?? false,
      error: live?.error ?? null,
      crashed: this.#crashed.has(tabId),
      parked: this.#parked.has(tabId),
    };
  }

  /** Memory in MB: the whole app, and each live tab's own process. */
  metrics() {
    const kbByPid = new Map();
    let totalKb = 0;
    for (const metric of app.getAppMetrics()) {
      kbByPid.set(metric.pid, metric.memory.workingSetSize);
      totalKb += metric.memory.workingSetSize;
    }
    const tabs = {};
    for (const [tabId, live] of this.#live) {
      const kb = kbByPid.get(live.contents.getOSProcessId());
      if (kb) tabs[tabId] = Math.round(kb / 1024);
    }
    return { totalMB: Math.round(totalKb / 1024), tabs, live: this.#live.size };
  }

  /** The page on screen, for menu commands such as zoom. */
  activeContents() {
    return this.#live.get(this.#activeTabId())?.contents ?? null;
  }

  activeTabId() {
    return this.#activeTabId();
  }

  /** Bring the window in line with the saved data after it changed elsewhere. */
  refresh({ focus = false } = {}) {
    this.#present({ focus });
  }

  dispose() {
    this.#disposed = true;
    clearInterval(this.#sweeper);
    for (const live of this.#live.values()) clearTimeout(live.forceTimer);
  }

  // --------------------------------------------------------------- private

  #activeTabId() {
    const data = this.#store.data;
    return findBrand(data, data.activeBrandId)?.activeTabId ?? null;
  }

  #isBusy(live, now) {
    return (
      live.hold ||
      live.loading ||
      live.contents.isCurrentlyAudible() ||
      live.contents.isDevToolsOpened() ||
      this.#uploads.isBusy(live.contentsId, now)
    );
  }

  /**
   * Make the window show the selected tab of the selected brand: load it if
   * needed, attach its view, detach whichever view was there before.
   */
  #present({ focus = false } = {}) {
    if (this.#disposed) return;
    const tabId = this.#activeTabId();
    const found = tabId ? findTab(this.#store.data, tabId) : null;
    let show = null;

    if (found?.tab.url && !this.#parked.has(tabId)) {
      const live = this.#live.get(tabId) ?? this.#wake(found.brand, found.tab);
      live.lastActive = Date.now();
      live.hold = false;
      if (!this.#covered && !live.error) show = tabId;
    }

    if (this.#shown !== show) {
      const previous = this.#live.get(this.#shown);
      if (previous) {
        previous.lastActive = Date.now();
        this.#window.contentView.removeChildView(previous.view);
      }
      this.#shown = show;
      if (show) this.#window.contentView.addChildView(this.#live.get(show).view);
    }
    if (show) {
      const { view, contents } = this.#live.get(show);
      view.setBounds(this.#bounds);
      if (focus) contents.focus();
    }
    this.#changed();
  }

  #wake(brand, tab) {
    const view = new WebContentsView({
      webPreferences: {
        session: this.#sessions.for(brand.id),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
      },
    });
    const contents = view.webContents;
    const live = {
      view,
      contents,
      contentsId: contents.id,
      lastActive: Date.now(),
      intent: null, // 'auto' | 'sleep' | 'close' | 'drop' while being closed
      hold: false, // refused to sleep because of unsaved work
      loading: false,
      error: null,
      forceTimer: null,
    };
    this.#live.set(tab.id, live);
    this.#tabByContents.set(contents.id, tab.id);
    this.#crashed.delete(tab.id);
    this.#listen(tab.id, live);
    this.#load(live, tab.url);
    return live;
  }

  #load(live, url) {
    // A failed load is reported through 'did-fail-load'; the promise only repeats it.
    live.contents.loadURL(url).catch(() => {});
  }

  #listen(tabId, live) {
    const { contents } = live;
    const tab = () => findTab(this.#store.data, tabId)?.tab;
    const update = (apply) => {
      const current = tab();
      if (!current) return;
      apply(current);
      this.#store.touch();
      this.#changed();
    };

    contents.on('page-title-updated', (_e, title) => update((t) => { t.title = title.slice(0, 200); }));
    contents.on('page-favicon-updated', (_e, icons) => {
      const icon = icons.find(isWebUrl);
      if (icon) update((t) => { t.favicon = icon; });
    });
    contents.on('did-navigate', (_e, url) => {
      if (isWebUrl(url)) update((t) => { t.url = url; });
    });
    contents.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (isMainFrame && isWebUrl(url)) update((t) => { t.url = url; });
    });

    contents.on('did-start-loading', () => { live.loading = true; this.#changed(); });
    contents.on('did-stop-loading', () => { live.loading = false; this.#changed(); });
    contents.on('audio-state-changed', () => this.#changed());

    contents.on('did-finish-load', () => {
      if (!live.error) return;
      live.error = null;
      this.#present();
    });
    contents.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
      if (!isMainFrame || code === ABORTED) return;
      live.error = { code, description, url };
      this.#present();
    });

    contents.on('render-process-gone', (_e, details) => {
      if (details.reason === 'clean-exit') return;
      this.#crashed.add(tabId);
      live.intent ??= 'sleep';
      contents.close();
    });

    contents.on('will-prevent-unload', (event) => {
      // The page says it holds unsaved work.
      if (live.intent === 'auto') {
        live.intent = null;
        live.hold = true; // not asked again until its owner has seen it
        this.#changed();
        return;
      }
      const leave = dialog.showMessageBoxSync(this.#window, {
        type: 'question',
        message: 'This page has work that is not saved',
        detail: `${tab()?.title || tab()?.url || 'The page'}\n\nLeaving it now loses that work.`,
        buttons: ['Leave page', 'Stay'],
        defaultId: 1,
        cancelId: 1,
      }) === 0;
      if (leave) {
        event.preventDefault(); // overrides the page's refusal
      } else {
        clearTimeout(live.forceTimer);
        live.intent = null;
      }
    });

    contents.once('destroyed', () => this.#gone(tabId, live));
  }

  /** Ask a live page to close, for one of the reasons in `intent`. */
  #retire(live, intent) {
    if (live.intent) return;
    live.intent = intent;
    if (intent !== 'auto') {
      live.forceTimer = setTimeout(() => {
        if (live.intent && !live.contents.isDestroyed()) live.contents.close();
      }, FORCE_CLOSE_MS);
    }
    live.contents.close({ waitForBeforeUnload: true });
  }

  /** A page has been destroyed: release everything kept for it. */
  #gone(tabId, live) {
    clearTimeout(live.forceTimer);
    this.#uploads.forget(live.contentsId);
    this.#tabByContents.delete(live.contentsId);
    this.#live.delete(tabId);
    if (this.#shown === tabId) {
      this.#shown = null;
      try {
        this.#window.contentView.removeChildView(live.view);
      } catch { /* the window is closing too */ }
    }
    if (this.#disposed || live.intent === 'drop') return;

    const found = findTab(this.#store.data, tabId);
    // A page that closed itself (window.close) takes its tab along if the tab
    // was one it opened; a kept tab just goes to sleep.
    const closing = live.intent === 'close' || (live.intent === null && found?.tab.temp);
    if (closing) return this.#forget(tabId);

    if (live.intent !== 'auto') this.#parked.add(tabId);
    this.#present();
  }

  /** Remove a tab that has no page (any more) from its brand. */
  #forget(tabId) {
    const found = findTab(this.#store.data, tabId);
    this.#parked.delete(tabId);
    this.#crashed.delete(tabId);
    if (!found) return;
    removeTab(found.brand, tabId);
    this.#store.touch();
    this.#present({ focus: true });
  }
}
