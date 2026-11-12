// The application menu (which also carries every keyboard shortcut, so they
// work while a page has the keyboard) and the right-click menus of the
// interface. Native menus are used because they draw above the page.

import { Menu, clipboard, shell } from 'electron';
import path from 'node:path';
import { destinations, findBrand, findTab } from './model.js';
import { resolveInside } from './pathjail.js';

/** @param {import('./main.js').Context} ctx */
export function buildAppMenu(ctx) {
  const { tabs, store } = ctx;
  const mac = process.platform === 'darwin';
  const command = (name) => () => ctx.send('command', name);
  const onTab = (fn) => () => {
    const tabId = tabs.activeTabId();
    if (tabId) fn(tabId);
  };
  const onPage = (fn) => () => {
    const contents = tabs.activeContents();
    if (contents) fn(contents);
  };
  const zoom = (step) => onPage((c) => c.setZoomLevel(step === 0 ? 0 : c.getZoomLevel() + step));
  const step = (direction) => () => {
    const brand = findBrand(store.data, store.data.activeBrandId);
    if (!brand || brand.tabs.length < 2) return;
    const at = brand.tabs.findIndex((tab) => tab.id === brand.activeTabId);
    const next = brand.tabs[(at + direction + brand.tabs.length) % brand.tabs.length];
    tabs.select(next.id);
  };

  return Menu.buildFromTemplate([
    ...(mac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New tab', accelerator: 'CmdOrCtrl+T', click: command('new-tab') },
        { label: 'New brand…', accelerator: 'CmdOrCtrl+Shift+N', click: command('new-brand') },
        { type: 'separator' },
        { label: 'Close tab', accelerator: 'CmdOrCtrl+W', click: onTab((id) => tabs.close(id)) },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: command('settings') },
        { label: 'Check for updates', click: async () => ctx.send('command', 'update-result', await ctx.updates.check()) },
        ...(mac ? [] : [{ type: 'separator' }, { role: 'quit' }]),
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Reload page', accelerator: 'CmdOrCtrl+R', click: onTab((id) => tabs.act(id, 'reload')) },
        { label: 'Back', accelerator: mac ? 'Cmd+[' : 'Alt+Left', click: onTab((id) => tabs.act(id, 'back')) },
        { label: 'Forward', accelerator: mac ? 'Cmd+]' : 'Alt+Right', click: onTab((id) => tabs.act(id, 'forward')) },
        { label: 'Home page of this tab', accelerator: 'Alt+Home', click: onTab((id) => tabs.act(id, 'home')) },
        { type: 'separator' },
        { label: 'Go to address bar', accelerator: 'CmdOrCtrl+L', click: command('focus-address') },
        { label: 'Next tab', accelerator: 'Ctrl+Tab', click: step(1) },
        { label: 'Previous tab', accelerator: 'Ctrl+Shift+Tab', click: step(-1) },
        { label: 'Show or hide files', accelerator: 'CmdOrCtrl+B', click: command('toggle-panel') },
        { type: 'separator' },
        { label: 'Zoom page in', accelerator: 'CmdOrCtrl+=', click: zoom(0.5) },
        { label: 'Zoom page out', accelerator: 'CmdOrCtrl+-', click: zoom(-0.5) },
        { label: 'Actual size', accelerator: 'CmdOrCtrl+0', click: zoom(0) },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { label: 'Inspect page', accelerator: 'F12', click: onPage((c) => c.toggleDevTools()) },
      ],
    },
    {
      label: 'Memory',
      submenu: [
        { label: 'Put this tab to sleep', click: onTab((id) => tabs.sleep(id)) },
        { label: 'Put other tabs to sleep', click: () => tabs.sleepOthers() },
        { type: 'separator' },
        { label: 'Keep this tab awake', click: onTab((id) => tabs.act(id, 'keep-awake')) },
      ],
    },
    { role: 'windowMenu' },
  ]);
}

/** @param {import('./main.js').Context} ctx */
export function popupTabMenu(ctx, tabId) {
  const { tabs, store } = ctx;
  const found = findTab(store.data, tabId);
  if (!found) return;
  const { tab } = found;
  const state = tabs.runtime(tabId);
  const act = (name) => () => tabs.act(tabId, name);

  popup(ctx, [
    { label: 'Reload', enabled: Boolean(tab.url), click: act('reload') },
    { label: 'Go to its home page', enabled: Boolean(tab.homeUrl) && tab.homeUrl !== tab.url, click: act('home') },
    { label: 'Use this page as its home page', enabled: Boolean(tab.url) && tab.homeUrl !== tab.url, click: act('set-home') },
    { type: 'separator' },
    { label: 'Rename…', click: () => ctx.send('command', 'rename-tab', tabId) },
    ...(tab.temp ? [{ label: 'Keep this tab', click: act('keep') }] : []),
    { type: 'separator' },
    { label: 'Keep awake', type: 'checkbox', checked: tab.keepAwake, click: act('keep-awake') },
    { label: 'Put to sleep', enabled: state.live, click: () => tabs.sleep(tabId) },
    { label: 'Put other tabs to sleep', click: () => tabs.sleepOthers() },
    { type: 'separator' },
    { label: 'Close tab', click: () => tabs.close(tabId) },
  ]);
}

/** @param {import('./main.js').Context} ctx */
export function popupBrandMenu(ctx, brandId) {
  const brand = findBrand(ctx.store.data, brandId);
  if (!brand) return;
  popup(ctx, [
    { label: 'Edit brand…', click: () => ctx.send('command', 'edit-brand', brandId) },
    { label: 'Open its folder', enabled: Boolean(brand.folder), click: () => shell.openPath(brand.folder) },
    { type: 'separator' },
    {
      label: 'Put its tabs to sleep',
      click: () => brand.tabs.forEach((tab) => ctx.tabs.sleep(tab.id)),
    },
    { type: 'separator' },
    { label: 'Delete brand…', click: () => ctx.deleteBrand(brandId) },
  ]);
}

/** @param {import('./main.js').Context} ctx */
export function popupFileMenu(ctx, brandId, rel) {
  const brand = findBrand(ctx.store.data, brandId);
  if (!brand?.folder) return;
  let abs;
  try {
    abs = resolveInside(brand.folder, rel);
  } catch {
    return;
  }
  const targets = destinations(brand).map((tab) => tab.id);
  const mark = (on) => () => {
    const marks = ctx.posted.setMany(brandId, rel, on ? targets : Object.keys(ctx.posted.forBrand(brandId)[rel] ?? {}), on);
    ctx.send('posted:changed', brandId, rel, marks);
  };

  popup(ctx, [
    { label: 'Open', click: () => shell.openPath(abs) },
    { label: process.platform === 'darwin' ? 'Show in Finder' : 'Show in folder', click: () => shell.showItemInFolder(abs) },
    { type: 'separator' },
    { label: 'Copy name', click: () => clipboard.writeText(path.basename(abs)) },
    { label: 'Copy full path', click: () => clipboard.writeText(abs) },
    { type: 'separator' },
    { label: 'Mark as posted everywhere', enabled: targets.length > 0, click: mark(true) },
    { label: 'Clear posted marks', click: mark(false) },
  ]);
}

function popup(ctx, template) {
  if (ctx.window.isDestroyed()) return;
  Menu.buildFromTemplate(template).popup({ window: ctx.window });
}
