// Everything the interface can ask the main process to do. The interface is
// the only caller: pages in tabs have no preload script and so no way to send
// these messages, and each handler still checks who is asking.

import { clipboard, dialog, ipcMain, shell } from 'electron';
import fs from 'node:fs';
import { listDir, readText } from './files.js';
import { popupBrandMenu, popupFileMenu, popupTabMenu } from './menus.js';
import { cleanSettings, createBrand, findBrand, updateBrand } from './model.js';
import { resolveInside } from './pathjail.js';
import { toUrl } from './urls.js';

const TAB_ACTIONS = new Set(['back', 'forward', 'reload', 'stop', 'home', 'wake']);
const MAX_COPY = 2_000_000;

/** Why a file request failed, in a word the interface can turn into a sentence. */
function reasonOf(error) {
  if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return 'missing';
  if (error.code === 'EACCES' || error.code === 'EPERM') return 'denied';
  if (error.code === 'EOUTSIDE') return 'outside';
  return 'failed';
}

/** @param {import('./main.js').Context} ctx */
export function registerIpc(ctx) {
  const { store, tabs, posted, watcher } = ctx;
  const fromInterface = (event) => event.sender === ctx.window.webContents;

  const handle = (channel, fn) =>
    ipcMain.handle(channel, (event, ...args) => {
      if (!fromInterface(event)) throw new Error('not allowed');
      return fn(...args);
    });
  const on = (channel, fn) =>
    ipcMain.on(channel, (event, ...args) => {
      if (fromInterface(event)) fn(...args);
    });

  const folderOf = (brandId) => {
    const folder = findBrand(store.data, brandId)?.folder;
    if (!folder) throw Object.assign(new Error('no folder'), { code: 'ENOENT' });
    return folder;
  };
  const files = async (work) => {
    try {
      return await work();
    } catch (error) {
      return { error: reasonOf(error) };
    }
  };

  // ------------------------------------------------------------------ state
  handle('state:get', () => ctx.snapshot());
  handle('metrics:get', () => tabs.metrics());
  handle('settings:update', (patch) => {
    store.data.settings = cleanSettings(patch, store.data.settings);
    store.touch();
    ctx.changed();
    tabs.sweep();
  });
  on('layout:bounds', (rects) => {
    if (Array.isArray(rects)) tabs.setBounds(rects);
  });
  on('layout:covered', (covered) => tabs.setCovered(covered === true));
  handle('clipboard:write', (text) => clipboard.writeText(String(text ?? '').slice(0, MAX_COPY)));

  // ---------------------------------------------------------------- updates
  handle('update:check', () => ctx.updates.check());
  handle('update:install', () => ctx.updates.install());
  handle('update:dismiss-news', () => ctx.updates.dismissNews());

  // ----------------------------------------------------------------- brands
  handle('brand:create', (input = {}) => {
    const urls = (Array.isArray(input.urls) ? input.urls : []).slice(0, 12).map(toUrl).filter(Boolean);
    const brand = createBrand(store.data, { ...input, urls });
    store.touch();
    tabs.refresh({ focus: true });
    return brand.id;
  });
  handle('brand:update', (brandId, patch = {}) => {
    const brand = findBrand(store.data, brandId);
    if (!brand) return;
    updateBrand(brand, patch);
    store.touch();
    ctx.changed();
  });
  handle('brand:delete', (brandId) => ctx.deleteBrand(brandId));
  handle('brand:select', (brandId) => tabs.selectBrand(brandId));
  handle('brand:menu', (brandId) => popupBrandMenu(ctx, brandId));
  handle('brand:layout', (brandId, layout) => {
    if (layout && typeof layout === 'object') tabs.setLayout(brandId, layout);
  });
  handle('pane:focus', (brandId, index) => tabs.focusPane(brandId, index));
  handle('brand:choose-folder', async (current) => {
    const { canceled, filePaths } = await dialog.showOpenDialog(ctx.window, {
      title: 'Folder this brand uploads from',
      defaultPath: typeof current === 'string' && current ? current : undefined,
      properties: ['openDirectory', 'createDirectory'],
    });
    return canceled ? null : filePaths[0];
  });

  // ------------------------------------------------------------------- tabs
  handle('tab:create', (brandId, input) => {
    const url = input ? toUrl(input) : '';
    return tabs.open(brandId, { url: url ?? '' })?.id ?? null;
  });
  handle('tab:select', (tabId) => tabs.select(tabId));
  handle('tab:close', (tabId) => tabs.close(tabId));
  handle('tab:navigate', (tabId, input) => tabs.navigate(tabId, input));
  handle('tab:act', (tabId, name) => {
    if (TAB_ACTIONS.has(name)) tabs.act(tabId, name);
  });
  handle('tab:rename', (tabId, name) => tabs.rename(tabId, name));
  handle('tab:menu', (tabId) => popupTabMenu(ctx, tabId));

  // ------------------------------------------------------------------ files
  handle('files:list', (brandId, rel = '') => files(() => listDir(folderOf(brandId), String(rel))));
  handle('files:read', (brandId, rel) => files(() => readText(folderOf(brandId), String(rel))));
  handle('files:watch', (brandId, rels) => {
    const folder = findBrand(store.data, brandId)?.folder;
    if (!folder || !Array.isArray(rels)) return watcher.closeAll();
    watcher.set(brandId, folder, rels.filter((rel) => typeof rel === 'string'));
  });
  handle('files:open', (brandId, rel) => files(async () => {
    const problem = await shell.openPath(resolveInside(folderOf(brandId), String(rel)));
    return problem ? { error: 'failed' } : {};
  }));
  handle('files:menu', (brandId, rel) => popupFileMenu(ctx, brandId, String(rel)));

  // Dragging out of the file panel hands real files to the operating system,
  // exactly as dragging from Explorer or Finder would. Where they are dropped
  // is between the person and the page.
  on('files:drag', (brandId, rels) => {
    const folder = findBrand(store.data, brandId)?.folder;
    if (!folder || !Array.isArray(rels)) return;
    const paths = [];
    for (const rel of rels.slice(0, 50)) {
      try {
        const abs = resolveInside(folder, String(rel));
        if (fs.statSync(abs).isFile()) paths.push(abs);
      } catch { /* gone or not allowed: left out */ }
    }
    if (!paths.length) return;
    try {
      ctx.window.webContents.startDrag({ file: paths[0], files: paths, icon: ctx.dragIcon });
    } finally {
      ctx.send('files:dragged', brandId, rels);
    }
  });

  // ----------------------------------------------------------------- posted
  handle('posted:get', (brandId) => posted.forBrand(brandId));
  handle('posted:set', (brandId, rel, tabId, isPosted) =>
    posted.set(String(brandId), String(rel), String(tabId), isPosted === true));
}
