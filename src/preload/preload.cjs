// The only bridge between the interface and the main process. It exposes a
// fixed list of calls; the interface has no Node and no direct IPC access.
// (CommonJS because a sandboxed preload script cannot be an ES module.)

const { contextBridge, ipcRenderer } = require('electron');

const call = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);
const tell = (channel) => (...args) => ipcRenderer.send(channel, ...args);

const EVENTS = new Set(['state', 'command', 'files:changed', 'files:dragged', 'posted:changed']);

contextBridge.exposeInMainWorld('fanout', {
  getState: call('state:get'),
  getMetrics: call('metrics:get'),
  updateSettings: call('settings:update'),
  setPageBounds: tell('layout:bounds'),
  setCovered: tell('layout:covered'),
  copy: call('clipboard:write'),

  checkForUpdates: call('update:check'),
  installUpdate: call('update:install'),
  dismissNews: call('update:dismiss-news'),

  createBrand: call('brand:create'),
  updateBrand: call('brand:update'),
  deleteBrand: call('brand:delete'),
  selectBrand: call('brand:select'),
  brandMenu: call('brand:menu'),
  setLayout: call('brand:layout'),
  focusPane: call('pane:focus'),
  chooseFolder: call('brand:choose-folder'),

  createTab: call('tab:create'),
  selectTab: call('tab:select'),
  closeTab: call('tab:close'),
  navigate: call('tab:navigate'),
  tabAct: call('tab:act'),
  renameTab: call('tab:rename'),
  tabMenu: call('tab:menu'),

  listFiles: call('files:list'),
  readFile: call('files:read'),
  watchFolders: call('files:watch'),
  openFile: call('files:open'),
  fileMenu: call('files:menu'),
  dragFiles: tell('files:drag'),

  getPosted: call('posted:get'),
  setPosted: call('posted:set'),

  /** Listen for a message from the main process; returns a function that stops listening. */
  on(channel, listener) {
    if (!EVENTS.has(channel)) throw new Error(`unknown event: ${channel}`);
    const wrapped = (_event, ...args) => listener(...args);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
});
