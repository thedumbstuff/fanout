// The interface: brand rail, tab strip, toolbar, the area the page sits in,
// and the status bar. The main process owns all state and sends a fresh copy
// whenever it changes; this file only draws it and passes on what is clicked.

import { openBrandDialog, openSettingsDialog } from './dialogs.js';
import { h, icon, initials, inkOn, reconcile, tabLabel } from './dom.js';
import { FilePanel } from './files.js';

const api = window.fanout;
const $ = (id) => document.getElementById(id);

// Starting points only: any address works, and nothing in fanout treats
// these sites differently from any other.
export const PRESETS = [
  { name: 'YouTube', url: 'https://studio.youtube.com/' },
  { name: 'TikTok', url: 'https://www.tiktok.com/tiktokstudio/upload' },
  { name: 'Instagram', url: 'https://www.instagram.com/' },
  { name: 'Facebook', url: 'https://www.facebook.com/' },
  { name: 'LinkedIn', url: 'https://www.linkedin.com/feed/' },
  { name: 'X', url: 'https://x.com/compose/post' },
  { name: 'Threads', url: 'https://www.threads.net/' },
  { name: 'Pinterest', url: 'https://www.pinterest.com/pin-creation-tool/' },
];

let state = await api.getState();
let metrics = { totalMB: 0, tabs: {}, live: 0 };
let renamingTabId = null;
let shownTabId = null; // the tab whose address is in the address bar

const activeBrand = () => state.brands.find((brand) => brand.id === state.activeBrandId) ?? null;
const activeTab = () => {
  const brand = activeBrand();
  return brand?.tabs.find((tab) => tab.id === brand.activeTabId) ?? null;
};

// ------------------------------------------------------------------ status

let noteTimer = null;

/** Show a line in the status bar, optionally with one action button. */
export function note(text, { action, label, ms = 5000 } = {}) {
  clearTimeout(noteTimer);
  const el = $('note');
  el.replaceChildren(text);
  if (action) {
    el.append(h('button', { class: 'note-action', onclick: () => { note(''); action(); } }, label));
  }
  if (text) noteTimer = setTimeout(() => el.replaceChildren(), action ? 15000 : ms);
}

async function refreshMetrics() {
  if (document.hidden) return;
  metrics = await api.getMetrics();
  renderStatus();
  renderTabs();
}

function renderStatus() {
  const tabs = state.brands.flatMap((brand) => brand.tabs);
  const loaded = tabs.filter((tab) => tab.live).length;
  $('tab-count').textContent = tabs.length ? `${loaded} of ${tabs.length} tabs loaded` : '';
  $('memory').textContent = metrics.totalMB ? `${metrics.totalMB.toLocaleString()} MB` : '';
}

// -------------------------------------------------------------------- rail

function renderRail() {
  reconcile($('brands'), state.brands, {
    key: (brand) => brand.id,
    signature: (brand) => [brand.name, brand.color, brand.id === state.activeBrandId,
      brand.tabs.filter((tab) => tab.live).length].join('|'),
    create: (brand) => {
      const live = brand.tabs.filter((tab) => tab.live).length;
      return h('button', {
        class: `brand${brand.id === state.activeBrandId ? ' is-active' : ''}`,
        role: 'tab',
        'aria-selected': String(brand.id === state.activeBrandId),
        title: `${brand.name}\n${live} of ${brand.tabs.length} tabs loaded`,
        style: { '--brand': brand.color, '--brand-ink': inkOn(brand.color) },
        onclick: () => api.selectBrand(brand.id),
        ondblclick: () => editBrand(brand.id),
        oncontextmenu: () => api.brandMenu(brand.id),
      }, h('span', { class: 'brand-face' }, initials(brand.name)), live ? h('span', { class: 'brand-live' }, String(live)) : null);
    },
  });
}

async function addBrand() {
  const input = await openBrandDialog({ colors: state.colors, presets: PRESETS, api, used: state.brands.length });
  if (input) await api.createBrand(input);
}

async function editBrand(brandId) {
  const brand = state.brands.find((b) => b.id === brandId);
  if (!brand) return;
  const input = await openBrandDialog({ colors: state.colors, presets: PRESETS, api, brand });
  if (input) await api.updateBrand(brandId, input);
}

// -------------------------------------------------------------------- tabs

function renderTabs() {
  if (renamingTabId) return; // do not pull the text box out from under the person typing
  const brand = activeBrand();
  reconcile($('tabs'), brand?.tabs ?? [], {
    key: (tab) => tab.id,
    signature: (tab) => [tabLabel(tab), tab.favicon, tab.id === brand.activeTabId, tab.live, tab.loading,
      tab.audible, tab.keepAwake, tab.temp, tab.url, metrics.tabs[tab.id] ?? ''].join('|'),
    create: (tab) => tabElement(tab, tab.id === brand.activeTabId),
  });
  $('new-tab').disabled = !brand;
}

function tabElement(tab, selected) {
  const label = tabLabel(tab);
  const asleep = !tab.live && Boolean(tab.url);
  const memory = metrics.tabs[tab.id];
  const tip = [label, tab.url, asleep ? 'Asleep: uses no memory, loads when opened' : memory ? `${memory} MB` : '',
    tab.keepAwake ? 'Kept awake' : ''].filter(Boolean).join('\n');

  const face = tab.loading
    ? h('span', { class: 'spinner' })
    : tab.favicon
      ? h('img', { class: 'favicon', src: tab.favicon, alt: '', onerror: (e) => e.target.replaceWith(letter(label)) })
      : letter(label);

  return h('div', {
    class: `tab${selected ? ' is-active' : ''}${asleep ? ' is-asleep' : ''}${tab.temp ? ' is-temp' : ''}`,
    role: 'tab',
    'aria-selected': String(selected),
    title: tip,
    dataset: { id: tab.id },
    onclick: () => api.selectTab(tab.id),
    onauxclick: (e) => { if (e.button === 1) api.closeTab(tab.id); },
    ondblclick: () => renameTab(tab.id),
    oncontextmenu: () => api.tabMenu(tab.id),
  },
  face,
  h('span', { class: 'tab-label' }, label),
  tab.audible ? icon('sound') : null,
  asleep ? icon('moon') : null,
  h('button', {
    class: 'tab-close',
    title: 'Close tab (Ctrl+W)',
    'aria-label': `Close ${label}`,
    onclick: (e) => { e.stopPropagation(); api.closeTab(tab.id); },
  }, icon('close')));
}

const letter = (label) => h('span', { class: 'favicon favicon-letter' }, ([...label.trim()][0] ?? '?').toUpperCase());

function renameTab(tabId) {
  const tab = activeBrand()?.tabs.find((t) => t.id === tabId);
  const el = $('tabs').querySelector(`[data-id="${tabId}"] .tab-label`);
  if (!tab || !el) return;
  renamingTabId = tabId;
  const input = h('input', { class: 'tab-rename', type: 'text', value: tab.name || tabLabel(tab), maxLength: 40 });
  const finish = async (save) => {
    if (renamingTabId !== tabId) return;
    renamingTabId = null;
    if (save) await api.renameTab(tabId, input.value);
    renderTabs();
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('dblclick', (e) => e.stopPropagation());
  el.replaceChildren(input);
  input.select();
}

async function newTab() {
  const brand = activeBrand();
  if (!brand) return addBrand();
  await api.createTab(brand.id);
  $('address').focus();
}

// ----------------------------------------------------------------- toolbar

function renderToolbar() {
  const tab = activeTab();
  $('go-back').disabled = !tab?.canBack;
  $('go-forward').disabled = !tab?.canForward;
  $('reload').disabled = !tab?.url;
  $('go-home').disabled = !tab?.homeUrl || tab.homeUrl === tab.url;
  $('reload').replaceChildren(icon(tab?.loading ? 'stop' : 'reload'));
  $('reload').title = tab?.loading ? 'Stop loading' : 'Reload (Ctrl+R)';
  $('toggle-panel').classList.toggle('is-on', state.settings.panelOpen);

  const address = $('address');
  address.disabled = !activeBrand();
  const switched = shownTabId !== (tab?.id ?? null);
  shownTabId = tab?.id ?? null;
  if (switched || document.activeElement !== address) address.value = tab?.url ?? '';
}

async function go() {
  const address = $('address');
  const text = address.value.trim();
  const brand = activeBrand();
  if (!text || !brand) return;
  const tab = activeTab();
  const ok = tab ? await api.navigate(tab.id, text) : Boolean(await api.createTab(brand.id, text));
  if (ok) address.blur();
  else note('That address cannot be opened in a tab.');
}

function wireToolbar() {
  const act = (name) => () => { const tab = activeTab(); if (tab) api.tabAct(tab.id, name); };
  $('go-back').append(icon('back'));
  $('go-forward').append(icon('forward'));
  $('go-home').append(icon('home'));
  $('new-tab').append(icon('plus'));
  $('toggle-panel').append(icon('panel'));
  $('add-brand').append(icon('plus'));
  $('open-settings').append(icon('gear'));

  $('go-back').onclick = act('back');
  $('go-forward').onclick = act('forward');
  $('go-home').onclick = act('home');
  $('reload').onclick = () => act(activeTab()?.loading ? 'stop' : 'reload')();
  $('new-tab').onclick = newTab;
  $('add-brand').onclick = addBrand;
  $('open-settings').onclick = () => openSettingsDialog({ api, settings: state.settings, version: state.version });
  $('toggle-panel').onclick = togglePanel;

  const address = $('address');
  address.addEventListener('focus', () => address.select());
  address.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') go();
    if (e.key === 'Escape') {
      address.value = activeTab()?.url ?? '';
      address.blur();
    }
  });
}

// --------------------------------------------------------------- page area

// What is drawn where the page goes when there is no page to show. The real
// page is a separate layer the main process places exactly over this box.
let pageSignature = '';

function renderPage() {
  const brand = activeBrand();
  const tab = activeTab();
  const kind = !brand ? 'welcome'
    : !tab || !tab.url ? 'blank'
      : tab.crashed ? 'crashed'
        : tab.error ? 'error'
          : tab.parked ? 'asleep'
            : 'page';
  const signature = [kind, brand?.id, brand?.name, tab?.id, tab?.error?.description, tab?.error?.url].join('|');
  if (signature === pageSignature) return;
  pageSignature = signature;

  const page = $('page');
  const wake = () => api.tabAct(tab.id, 'wake');
  const reload = () => api.tabAct(tab.id, 'reload');
  const views = {
    page: () => [],
    welcome: () => [
      h('h1', {}, 'Every account of every brand, in one window.'),
      h('p', {}, 'A brand keeps its own sign-ins, its own tabs and its own folder of things to post. ' +
        'Drag a video from the folder onto the page and upload it the way you always do.'),
      h('button', { class: 'primary', onclick: addBrand }, 'Add your first brand'),
    ],
    blank: () => [
      h('h1', {}, `Where does ${brand.name} post?`),
      h('p', {}, 'Pick a place to start, or type any address in the bar above. Sign in once: this brand stays signed in.'),
      h('div', { class: 'presets' }, PRESETS.map((preset) =>
        h('button', { class: 'preset', onclick: () => openPreset(preset.url) }, preset.name))),
    ],
    asleep: () => [
      h('h1', {}, 'This tab is asleep.'),
      h('p', {}, 'It is using no memory. Waking it loads the page again.'),
      h('button', { class: 'primary', onclick: wake }, 'Wake tab'),
    ],
    crashed: () => [
      h('h1', {}, 'This page stopped working.'),
      h('p', {}, 'The page ran out of memory or crashed. Nothing else in fanout was affected.'),
      h('button', { class: 'primary', onclick: wake }, 'Load it again'),
    ],
    error: () => [
      h('h1', {}, 'This page did not load.'),
      h('p', {}, `${tab.error.url || tab.url}`),
      h('p', { class: 'quiet' }, friendlyError(tab.error)),
      h('button', { class: 'primary', onclick: reload }, 'Try again'),
    ],
  };
  page.className = `page-${kind}`;
  page.replaceChildren(h('div', { class: 'page-note' }, views[kind]()));
}

function friendlyError({ code, description }) {
  if ([-105, -137].includes(code)) return 'No site was found at that address. Check the spelling.';
  if ([-106, -109].includes(code)) return 'There is no internet connection.';
  if ([-102, -118, -7].includes(code)) return 'The site did not answer.';
  return description ? `The browser reported: ${description}` : 'The site could not be reached.';
}

async function openPreset(url) {
  const brand = activeBrand();
  const tab = activeTab();
  if (tab && !tab.url) await api.navigate(tab.id, url);
  else await api.createTab(brand.id, url);
}

// ------------------------------------------------------------------ layout

let boundsQueued = false;

/** Tell the main process where the page layer goes. At most once per frame. */
function reportBounds() {
  if (boundsQueued) return;
  boundsQueued = true;
  requestAnimationFrame(() => {
    boundsQueued = false;
    const { x, y, width, height } = $('page').getBoundingClientRect();
    api.setPageBounds({ x, y, width, height });
  });
}

function applyLayout() {
  const { panelOpen, panelWidth, previewHeight } = state.settings;
  document.body.classList.toggle('panel-closed', !panelOpen);
  document.body.style.setProperty('--panel-w', `${panelWidth}px`);
  document.body.style.setProperty('--preview-h', `${previewHeight}px`);
}

function togglePanel() {
  state.settings.panelOpen = !state.settings.panelOpen;
  applyLayout();
  renderToolbar();
  api.updateSettings({ panelOpen: state.settings.panelOpen });
}

/**
 * Make an element a drag handle. The pointer is captured, so the drag keeps
 * working while it passes over the page layer.
 */
function draggable(handle, { move, done }) {
  handle.addEventListener('pointerdown', (down) => {
    if (down.button !== 0) return;
    handle.setPointerCapture(down.pointerId);
    document.body.classList.add('is-resizing');
    const onMove = (e) => move(e);
    const onUp = () => {
      handle.removeEventListener('pointermove', onMove);
      document.body.classList.remove('is-resizing');
      done();
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp, { once: true });
    handle.addEventListener('pointercancel', onUp, { once: true });
  });
}

function wireLayout() {
  new ResizeObserver(reportBounds).observe($('page'));
  window.addEventListener('resize', reportBounds);

  draggable($('splitter'), {
    move: (e) => {
      const max = Math.min(720, window.innerWidth - 480);
      state.settings.panelWidth = Math.round(Math.max(240, Math.min(max, window.innerWidth - e.clientX)));
      applyLayout();
    },
    done: () => api.updateSettings({ panelWidth: state.settings.panelWidth }),
  });
  draggable($('preview-splitter'), {
    move: (e) => {
      const panel = $('panel').getBoundingClientRect();
      state.settings.previewHeight = Math.round(Math.max(100, Math.min(panel.height - 140, panel.bottom - e.clientY)));
      applyLayout();
    },
    done: () => api.updateSettings({ previewHeight: state.settings.previewHeight }),
  });

  // A file dropped on the interface itself must not replace it.
  for (const type of ['dragover', 'drop']) {
    window.addEventListener(type, (e) => e.preventDefault());
  }
}

// -------------------------------------------------------------------- main

const panel = new FilePanel({ api, note, activeTab });

function render() {
  applyLayout();
  renderRail();
  renderTabs();
  renderToolbar();
  renderPage();
  renderStatus();
  panel.update(state);
}

const COMMANDS = {
  'new-tab': newTab,
  'new-brand': addBrand,
  settings: () => $('open-settings').click(),
  'focus-address': () => $('address').focus(),
  'toggle-panel': togglePanel,
  'rename-tab': renameTab,
  'edit-brand': editBrand,
};

api.on('state', (next) => {
  if (document.body.classList.contains('is-resizing')) {
    // Mid-drag, the size on screen is newer than the one the main process knows.
    next.settings.panelWidth = state.settings.panelWidth;
    next.settings.previewHeight = state.settings.previewHeight;
  }
  state = next;
  render();
});
api.on('command', (name, arg) => COMMANDS[name]?.(arg));

wireToolbar();
wireLayout();
render();
reportBounds();
refreshMetrics();
setInterval(refreshMetrics, 5000);
document.addEventListener('visibilitychange', refreshMetrics);
