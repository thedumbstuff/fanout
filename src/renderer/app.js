// The interface: brand rail, tab strip, toolbar, the area the page sits in,
// and the status bar. The main process owns all state and sends a fresh copy
// whenever it changes; this file only draws it and passes on what is clicked.

import { openBrandDialog, openNotesDialog, openSettingsDialog, updateMessage } from './dialogs.js';
import { h, icon, initials, inkOn, reconcile, renameText } from './dom.js';
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

let updateSignature = '';
let newsOffered = false;

/** The update corner of the status bar: progress, then one button. */
function renderUpdate() {
  const { status, version, percent, news } = state.update;
  const signature = [status, version, percent].join('|');
  if (signature !== updateSignature) {
    updateSignature = signature;
    const el = $('update');
    const action = (label) => h('button', { class: 'note-action', onclick: () => api.installUpdate() }, label);
    const parts = {
      downloading: [`Downloading fanout ${version}, ${percent}%`],
      ready: [`fanout ${version} is ready`, action('Restart to update')],
      available: [`fanout ${version} is out`, action('Get it')],
    }[status];
    el.hidden = !parts;
    el.replaceChildren(...(parts ?? []));
  }
  if (news && !newsOffered) {
    newsOffered = true;
    note(`fanout was updated to ${news.version}.`, {
      label: 'See what is new',
      action: () => openNotesDialog({ api, ...news }),
    });
    api.dismissNews(); // offered once; not again on the next start
  }
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
  const tabs = brand?.tabs ?? [];
  const draw = {
    key: (tab) => tab.id,
    signature: (tab) => [tab.label, tab.favicon, tab.id === brand.activeTabId, brand.panes.includes(tab.id), tab.live, tab.loading,
      tab.audible, tab.keepAwake, tab.temp, tab.url, metrics.tabs[tab.id] ?? ''].join('|'),
    create: (tab) => tabElement(tab, tab.id === brand.activeTabId, brand.panes.includes(tab.id)),
  };

  // The tabs on screen together form one group, in the order of their panes
  // (left to right, top to bottom); the tabs waiting their turn follow it.
  const split = (brand?.panes.length ?? 1) > 1;
  const together = split ? brand.panes.map((id) => tabs.find((tab) => tab.id === id)).filter(Boolean) : [];
  const group = $('tab-group');
  group.hidden = !together.length;
  group.title = `These ${together.length} pages are on screen together`;
  if (brand) group.style.setProperty('--brand', brand.color);
  reconcile(group, together, draw);
  reconcile($('tab-rest'), tabs.filter((tab) => !together.includes(tab)), draw);
  $('new-tab').disabled = !brand;
}

function tabElement(tab, selected, onScreen) {
  const { label } = tab;
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
    class: `tab${selected ? ' is-active' : onScreen ? ' is-shown' : ''}${asleep ? ' is-asleep' : ''}${tab.temp ? ' is-temp' : ''}`,
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
  const before = tab.label;
  const input = h('input', { class: 'tab-rename', type: 'text', value: before, maxLength: 40 });
  const finish = async (save) => {
    if (renamingTabId !== tabId) return;
    renamingTabId = null;
    // Closing the box with its text unchanged, or with Escape, changes nothing.
    // (Saving what it opened with froze "New tab" or a page title as a name.)
    const typed = save ? renameText(before, input.value) : null;
    // A label goes back at once: when the name did not change, no new state
    // redraws this tab, and the text box would otherwise stay in it.
    el.replaceChildren(typed || before);
    if (typed !== null) await api.renameTab(tabId, typed);
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

  const names = ['One page', 'Two pages side by side', 'Three pages', 'Four pages'];
  $('layouts').append(...names.map((name, i) => h('button', {
    class: 'tool',
    title: name,
    'aria-label': name,
    dataset: { count: String(i + 1) },
    onclick: () => { const brand = activeBrand(); if (brand) api.setLayout(brand.id, { count: i + 1 }); },
  }, icon(`layout${i + 1}`))));

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

// ------------------------------------------------------------------- panes

// A brand shows one to four of its tabs side by side. Each pane is a box
// here; the real page is a separate layer the main process places exactly
// over the pane's body. What is drawn in the body shows only when there is no
// page to put there: no brand, an empty pane, a blank or sleeping tab.
let panesSignature = '';
let dragSplit = null; // divider positions while one is being dragged

const paneKind = (brand, tab) =>
  (!brand ? 'welcome'
    : !tab ? 'empty'
      : !tab.url ? 'blank'
        : tab.crashed ? 'crashed'
          : tab.error ? 'error'
            : tab.parked ? 'asleep'
              : 'page');

function renderPanes() {
  const brand = activeBrand();
  const tabs = (brand?.panes ?? [null]).map((id) => brand?.tabs.find((tab) => tab.id === id) ?? null);
  const page = $('page');
  page.dataset.count = String(tabs.length);
  page.style.setProperty('--sx', String(dragSplit?.x ?? brand?.splitX ?? 0.5));
  page.style.setProperty('--sy', String(dragSplit?.y ?? brand?.splitY ?? 0.5));

  const signature = JSON.stringify([brand?.id, brand?.name, brand?.focus, tabs.map((tab) =>
    [paneKind(brand, tab), tab?.id, tab?.label, tab?.favicon, tab?.error?.description, tab?.error?.url])]);
  if (signature !== panesSignature) {
    panesSignature = signature;
    // The two dividers stay in place so that a drag survives a redraw.
    for (const old of page.querySelectorAll('.pane')) old.remove();
    page.prepend(...tabs.map((tab, index) => paneElement(brand, tab, index, tabs.length)));
  }
  reportBounds();
}

function paneElement(brand, tab, index, count) {
  const kind = paneKind(brand, tab);
  const focused = Boolean(brand) && index === brand.focus;
  return h('section', {
    class: `pane${focused && count > 1 ? ' is-focused' : ''}`,
    dataset: { index: String(index) },
    onmousedown: () => { if (brand && !focused) api.focusPane(brand.id, index); },
  },
  count > 1 ? h('header', { class: 'pane-head', title: tab?.url || '' },
    tab?.favicon ? h('img', { class: 'favicon', src: tab.favicon, alt: '', onerror: (e) => e.target.remove() }) : null,
    h('span', { class: 'pane-title' }, tab ? tab.label : 'Empty')) : null,
  h('div', { class: 'pane-body' }, h('div', { class: 'page-note' }, paneNote(kind, brand, tab, index))));
}

/** What an empty pane body says, and the one thing to do about it. */
function paneNote(kind, brand, tab, index) {
  const button = (label, onclick) => h('button', { class: 'primary', onclick }, label);
  switch (kind) {
    case 'welcome':
      return [
        h('h1', {}, 'Every account of every brand, in one window.'),
        h('p', {}, 'A brand keeps its own sign-ins, its own tabs and its own folder of things to post. ' +
          'Drag a video from the folder onto the page and upload it the way you always do.'),
        button('Add your first brand', addBrand),
      ];
    case 'empty':
      return [
        h('h1', {}, 'Nothing here yet.'),
        h('p', {}, 'Click this pane, then pick a tab above to show it here.'),
        button('Open a new tab here', async () => {
          await api.focusPane(brand.id, index);
          newTab();
        }),
      ];
    case 'blank':
      return [
        h('h1', {}, `Where does ${brand.name} post?`),
        h('p', {}, 'Pick a place to start, or type any address in the bar above. Sign in once: this brand stays signed in.'),
        h('div', { class: 'presets' }, PRESETS.map((preset) =>
          h('button', { class: 'preset', onclick: () => api.navigate(tab.id, preset.url) }, preset.name))),
      ];
    case 'asleep':
      return [
        h('h1', {}, 'This tab is asleep.'),
        h('p', {}, 'It is using no memory. Waking it loads the page again.'),
        button('Wake tab', () => api.tabAct(tab.id, 'wake')),
      ];
    case 'crashed':
      return [
        h('h1', {}, 'This page stopped working.'),
        h('p', {}, 'The page ran out of memory or crashed. Nothing else in fanout was affected.'),
        button('Load it again', () => api.tabAct(tab.id, 'wake')),
      ];
    case 'error':
      return [
        h('h1', {}, 'This page did not load.'),
        h('p', {}, tab.error.url || tab.url),
        h('p', { class: 'quiet' }, friendlyError(tab.error)),
        button('Try again', () => api.tabAct(tab.id, 'reload')),
      ];
    default:
      return [];
  }
}

function friendlyError({ code, description }) {
  if ([-105, -137].includes(code)) return 'No site was found at that address. Check the spelling.';
  if ([-106, -109].includes(code)) return 'There is no internet connection.';
  if ([-102, -118, -7].includes(code)) return 'The site did not answer.';
  return description ? `The browser reported: ${description}` : 'The site could not be reached.';
}

function renderLayouts() {
  const brand = activeBrand();
  for (const button of $('layouts').children) {
    button.disabled = !brand;
    button.classList.toggle('is-on', Boolean(brand) && Number(button.dataset.count) === brand.panes.length);
  }
}
// ------------------------------------------------------------------ layout

let boundsQueued = false;

/** Tell the main process where each pane's page goes. At most once per frame. */
function reportBounds() {
  if (boundsQueued) return;
  boundsQueued = true;
  requestAnimationFrame(() => {
    boundsQueued = false;
    api.setPageBounds([...$('page').querySelectorAll('.pane-body')].map((body) => {
      const { x, y, width, height } = body.getBoundingClientRect();
      return { x, y, width, height };
    }));
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
    document.body.style.cursor = getComputedStyle(handle).cursor;
    const onMove = (e) => move(e);
    const onUp = () => {
      handle.removeEventListener('pointermove', onMove);
      document.body.classList.remove('is-resizing');
      document.body.style.cursor = '';
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

  // The dividers between panes. Positions are shares of the page area.
  const split = (axis) => ({
    move: (e) => {
      const brand = activeBrand();
      const area = $('page').getBoundingClientRect();
      const share = axis === 'x' ? (e.clientX - area.left) / area.width : (e.clientY - area.top) / area.height;
      dragSplit = { x: brand.splitX, y: brand.splitY, ...dragSplit, [axis]: Math.max(0.2, Math.min(0.8, share)) };
      renderPanes();
    },
    done: () => {
      const brand = activeBrand();
      if (!brand || !dragSplit) return;
      Object.assign(brand, { splitX: dragSplit.x, splitY: dragSplit.y });
      api.setLayout(brand.id, dragSplit);
      dragSplit = null;
    },
  });
  draggable($('split-x'), split('x'));
  draggable($('split-y'), split('y'));

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
  renderLayouts();
  renderPanes();
  renderStatus();
  renderUpdate();
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
  'update-result': (view) => note(updateMessage(view)),
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
