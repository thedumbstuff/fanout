// The saved shape of the app: brands, each with a folder and its tabs, plus
// settings. Everything here works on plain data so it can be tested without
// Electron. main.js owns the one live copy and saves it through store.js.

import { randomBytes } from 'node:crypto';
import { isWebUrl, siteName } from './urls.js';

export const BRAND_COLORS = [
  '#fb5f89', '#f7d31c', '#2f6fed', '#18a36b', '#f2792b', '#8a4fff', '#12a5b8', '#b99468',
];

export const DEFAULT_SETTINGS = Object.freeze({
  sleepAfterMinutes: 20, // background tabs sleep after this long; 0 = never
  maxLiveTabs: 6, // most tabs kept loaded at once; 0 = no limit
  panelOpen: true,
  panelWidth: 340,
  previewHeight: 240,
  hidePosted: false,
  autoUpdate: true, // look for new versions and download them
});

const LIMITS = {
  sleepAfterMinutes: [0, 600],
  maxLiveTabs: [0, 50],
  panelWidth: [240, 720],
  previewHeight: [100, 800],
};

export const MAX_PANES = 4;
const MIN_SPLIT = 0.2;
const MAX_SPLIT = 0.8;

const BRAND_ID = /^b_[a-f0-9]{8,}$/;
const TAB_ID = /^t_[a-f0-9]{8,}$/;
const HEX = /^#[0-9a-f]{6}$/i;

export function newId(prefix) {
  return `${prefix}_${randomBytes(5).toString('hex')}`;
}

export function defaults() {
  return {
    version: 1,
    settings: { ...DEFAULT_SETTINGS },
    window: null,
    activeBrandId: null,
    brands: [],
    permissions: {},
    lastVersion: '', // the version that ran last, to notice an update
    releaseNotes: null, // { version, text } of the update downloaded last
  };
}

/** Keep only known settings, with numbers held inside their limits. */
export function cleanSettings(input, base = DEFAULT_SETTINGS) {
  const out = { ...base };
  if (!input || typeof input !== 'object') return out;
  for (const [key, [min, max]] of Object.entries(LIMITS)) {
    const value = Number(input[key]);
    if (input[key] !== undefined && Number.isFinite(value)) {
      out[key] = Math.min(max, Math.max(min, Math.round(value)));
    }
  }
  for (const key of ['panelOpen', 'hidePosted', 'autoUpdate']) {
    if (typeof input[key] === 'boolean') out[key] = input[key];
  }
  return out;
}

const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const webUrl = (value) => (isWebUrl(value) ? value : '');

// ------------------------------------------------------------- tab names
//
// A tab goes by its own name if it has one, else its page's title, else its
// site, else UNNAMED_TAB. A name of its own is the exception: it is kept only
// when the person typed something the tab would not show anyway, so that an
// unnamed tab goes on following its page.

/** What a tab with no name, no title and no address is called. Never saved as a name. */
export const UNNAMED_TAB = 'New tab';
const MAX_TAB_NAME = 40;

/** What a tab shows when it has no name of its own. */
export function autoLabel(tab) {
  return tab.title || siteName(tab.homeUrl || tab.url) || UNNAMED_TAB;
}

/** The name a tab goes by, in the tab strip and over its pane. */
export function tabLabel(tab) {
  return tab.name || autoLabel(tab);
}

/**
 * The name to keep for what was typed in a tab's rename box. Empty text, the
 * placeholder, or exactly what the tab shows without a name all mean "no name
 * of its own" (''), so the tab goes back to following its page.
 */
export function nameFor(tab, typed) {
  const name = typeof typed === 'string' ? typed.trim() : '';
  return name === UNNAMED_TAB || name === autoLabel(tab) ? '' : text(name, MAX_TAB_NAME);
}

/** A tab that never got an address or a name: it holds nothing once it is in no pane. */
export function isBlank(tab) {
  return !tab.url && !tab.homeUrl && !tab.name;
}

function cleanTab(raw) {
  if (!raw || typeof raw !== 'object' || !TAB_ID.test(raw.id) || raw.temp) return null;
  const url = webUrl(raw.url);
  const name = text(raw.name, MAX_TAB_NAME);
  return {
    id: raw.id,
    // Earlier builds saved the placeholder as a name when a blank tab's rename
    // box was closed unchanged; that name then hid every title the tab got later.
    name: name === UNNAMED_TAB ? '' : name,
    homeUrl: webUrl(raw.homeUrl) || url,
    url,
    title: text(raw.title, 200),
    favicon: webUrl(raw.favicon),
    keepAwake: raw.keepAwake === true,
    temp: false,
  };
}

function cleanBrand(raw, index) {
  if (!raw || typeof raw !== 'object' || !BRAND_ID.test(raw.id)) return null;
  const seen = new Set();
  let tabs = (Array.isArray(raw.tabs) ? raw.tabs : [])
    .map(cleanTab)
    .filter((tab) => tab && !seen.has(tab.id) && seen.add(tab.id));
  // Panes: each holds one tab or nothing, and a tab is in at most one pane.
  const placed = new Set();
  let panes = (Array.isArray(raw.panes) ? raw.panes : []).slice(0, MAX_PANES).map((id) =>
    (seen.has(id) && !placed.has(id) && placed.add(id) ? id : null));
  if (!panes.length) panes = [seen.has(raw.activeTabId) ? raw.activeTabId : (tabs[0]?.id ?? null)];
  // The tab shown on its own in front of the group: only with a group, and
  // never a tab of the group. Files from before 0.2.0's group fix have none.
  const solo = panes.length > 1 && seen.has(raw.solo) && !panes.includes(raw.solo) ? raw.solo : null;
  // A blank tab off screen was left behind by an older version (see dropStrayBlanks).
  tabs = tabs.filter((tab) => !isBlank(tab) || panes.includes(tab.id) || tab.id === solo);
  const focus = Number.isInteger(raw.focus) && raw.focus >= 0 && raw.focus < panes.length ? raw.focus : 0;

  return {
    id: raw.id,
    name: text(raw.name, 60) || 'Brand',
    color: HEX.test(raw.color) ? raw.color.toLowerCase() : BRAND_COLORS[index % BRAND_COLORS.length],
    folder: typeof raw.folder === 'string' ? raw.folder : '',
    panes,
    focus,
    solo,
    splitX: ratio(raw.splitX),
    splitY: ratio(raw.splitY),
    activeTabId: solo ?? panes[focus],
    tabs,
  };
}

/** A divider position: a share of the width or height, kept away from the edges. */
function ratio(value) {
  return Number.isFinite(value) ? Math.min(MAX_SPLIT, Math.max(MIN_SPLIT, value)) : 0.5;
}

// ------------------------------------------------------------------ panes
//
// A brand shows one to four of its tabs side by side:
//
//   1        2          3            4
//   +---+    +---+---+  +---+---+    +---+---+
//   | 0 |    | 0 | 1 |  |   | 1 |    | 0 | 1 |
//   +---+    +---+---+  | 0 +---+    +---+---+
//                       |   | 2 |    | 2 | 3 |
//                       +---+---+    +---+---+
//
// `panes` holds one tab id (or null) per pane; a tab is in one pane at most.
// With two or more panes, the tabs in them are the brand's GROUP: pages the
// person arranged side by side, which other tabs never push out. Selecting a
// tab outside the group shows that tab on its own, over the whole page area
// (`solo`). The group waits behind it - panes, focus and dividers untouched -
// and comes back as it was when one of its tabs is selected:
//
//   the group on screen       a solo tab on screen
//   +-----+-----+             +-----------+
//   |  A  |  B  |  select X   |           |    tab strip:
//   +-----+-----+  -------->  |     X     |    [A B C D]  X
//   |  C  |  D  |  <--------  |           |    (outline dashed:
//   +-----+-----+  select C   +-----------+     the group waits)
//
// A tab joins the group or leaves it only when the person says so: placeTab
// (the tab menu, or a new tab opened in an empty pane), takeOutOfGroup, the
// layout buttons (setPaneCount). Closing a tab of the group leaves its pane
// empty. With one pane there is no group: selecting a tab puts it in that
// pane, as in a browser, and `solo` stays null.
//
// `splitX` and `splitY` are where the two dividers sit. `focus` is the pane
// the address bar acts on while the group is on screen, and is kept while a
// solo tab shows. `activeTabId` is the tab the address bar acts on: the solo
// tab, else the tab in the focused pane (or null); settle() keeps it so.
// onScreen() is what the page area shows, one entry per rectangle; the tab
// manager goes by it, and the interface gets it in the state message.
//
// A blank tab (isBlank) lives only on screen or in a pane: when another tab
// takes its place, its pane is taken away or it is taken out of the group, it
// is removed rather than left in the tab strip as a stray "New tab". It never
// has a page, so there is nothing to close.

/** What the page area shows, one entry per rectangle: tab ids, null for an empty pane. */
export function onScreen(brand) {
  return brand.solo ? [brand.solo] : [...brand.panes];
}

/** The tabs of the group in pane order (none with a single pane). */
export function groupOf(brand) {
  return brand.panes.length > 1 ? brand.panes.filter(Boolean) : [];
}

/** Every tab id in the order of the tab strip: the group first, then the rest in tab order. */
export function stripOrder(brand) {
  const group = groupOf(brand);
  return [...group, ...brand.tabs.map((tab) => tab.id).filter((id) => !group.includes(id))];
}

/** The tab Ctrl+Tab (1) or Ctrl+Shift+Tab (-1) goes to, round the tab strip; null if none. */
export function stepTab(brand, direction) {
  const order = stripOrder(brand);
  if (!order.length) return null;
  let at = order.indexOf(brand.activeTabId);
  if (at === -1) {
    // The focused pane is empty: count from where that pane sits in the group.
    const before = brand.panes.slice(0, brand.focus).filter(Boolean).length;
    at = direction > 0 ? before - 1 : before;
  }
  const next = order[(((at + direction) % order.length) + order.length) % order.length];
  return next === brand.activeTabId ? null : next;
}

/** Point activeTabId at the tab the address bar acts on. */
function settle(brand) {
  brand.activeTabId = brand.solo ?? brand.panes[brand.focus] ?? null;
}

/** Remove the given tabs that are blank and neither in a pane nor shown on their own. */
function dropStrayBlanks(brand, tabIds) {
  for (const id of tabIds) {
    if (!id || brand.panes.includes(id) || brand.solo === id) continue;
    const index = brand.tabs.findIndex((tab) => tab.id === id);
    if (index !== -1 && isBlank(brand.tabs[index])) brand.tabs.splice(index, 1);
  }
}

/** Stop showing a solo tab, so the group is on screen again. */
function endSolo(brand) {
  const solo = brand.solo;
  brand.solo = null;
  dropStrayBlanks(brand, [solo]);
}

const hasTab = (brand, tabId) => brand.tabs.some((tab) => tab.id === tabId);
const isPane = (brand, index) => Number.isInteger(index) && index >= 0 && index < brand.panes.length;

/**
 * Show a tab. A tab of the group brings the group back with its pane focused.
 * Any other tab is shown on its own in front of the group, which stays as it
 * is; with a single pane it simply takes that pane.
 */
export function showTab(brand, tabId) {
  if (!hasTab(brand, tabId)) return;
  const at = brand.panes.indexOf(tabId);
  if (at !== -1) {
    brand.focus = at;
    endSolo(brand);
  } else if (brand.panes.length > 1) {
    const before = brand.solo;
    brand.solo = tabId;
    dropStrayBlanks(brand, [before]);
  } else {
    const displaced = brand.panes[0];
    brand.panes[0] = tabId;
    brand.focus = 0;
    dropStrayBlanks(brand, [displaced]);
  }
  settle(brand);
}

/** Focus a pane of the group; the group comes back if a solo tab was in front of it. */
export function focusPane(brand, index) {
  if (!isPane(brand, index)) return;
  brand.focus = index;
  endSolo(brand);
  settle(brand);
}

/**
 * Change how many panes a brand shows. The panes that stay keep their tabs;
 * when panes are removed the focused tab stays. New panes take the solo tab
 * first (it is what the person is looking at, and it gets the focus), then
 * the tabs that are not on screen, in tab order.
 *
 * The layout buttons light the number of pages on screen, so while a solo tab
 * shows, "one page" is lit and choosing it changes nothing: the group behind
 * is kept (a stray click must not undo an arrangement). Choosing two to four
 * brings the group back at that size.
 */
export function setPaneCount(brand, count) {
  const wanted = Math.min(MAX_PANES, Math.max(1, Math.round(Number(count)) || 1));
  const { solo } = brand;
  if (solo && wanted === 1) return;
  const focused = brand.panes[brand.focus];
  const before = [...brand.panes, solo];
  const panes = brand.panes.slice(0, wanted);
  if (focused && !panes.includes(focused)) panes[wanted - 1] = focused;
  let focus = focused ? panes.indexOf(focused) : Math.min(brand.focus, wanted - 1);
  if (solo && panes.length < wanted) {
    focus = panes.length;
    panes.push(solo);
  }
  const spare = brand.tabs.map((tab) => tab.id).filter((id) => !panes.includes(id));
  while (panes.length < wanted) panes.push(spare.shift() ?? null);
  brand.panes = panes;
  brand.focus = focus;
  brand.solo = null;
  dropStrayBlanks(brand, before);
  settle(brand);
}

/** The pane "Put in the group" uses: an empty one (the focused pane first), else the focused one. */
export function groupSlot(brand) {
  if (!brand.panes[brand.focus]) return brand.focus;
  const empty = brand.panes.indexOf(null);
  return empty === -1 ? brand.focus : empty;
}

/**
 * Put a tab in a pane: the tab menu's "Put in the group", and a new tab opened
 * in an empty pane. What was in that pane becomes a tab outside the group (a
 * tab already in the group swaps places with it instead). The group is shown,
 * with that pane focused, so the person sees where the tab went. False if
 * there is no such tab or pane.
 */
export function placeTab(brand, tabId, index = groupSlot(brand)) {
  if (!hasTab(brand, tabId) || !isPane(brand, index)) return false;
  const displaced = brand.panes[index];
  const from = brand.panes.indexOf(tabId);
  if (from !== -1) brand.panes[from] = displaced;
  brand.panes[index] = tabId;
  brand.focus = index;
  const { solo } = brand;
  brand.solo = null;
  dropStrayBlanks(brand, [displaced, solo]);
  settle(brand);
  return true;
}

/** Take a tab out of the group: its pane is left empty and it stays a tab. False if it is not in the group. */
export function takeOutOfGroup(brand, tabId) {
  const at = brand.panes.indexOf(tabId);
  if (at === -1 || brand.panes.length < 2) return false;
  brand.panes[at] = null;
  dropStrayBlanks(brand, [tabId]);
  settle(brand);
  return true;
}

export function setSplit(brand, { x, y } = {}) {
  if (Number.isFinite(x)) brand.splitX = ratio(x);
  if (Number.isFinite(y)) brand.splitY = ratio(y);
}

function cleanWindow(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const n = (v) => (Number.isFinite(v) ? Math.round(v) : undefined);
  const width = n(raw.width);
  const height = n(raw.height);
  if (!width || !height) return null;
  return { width, height, x: n(raw.x), y: n(raw.y), maximized: raw.maximized === true };
}

/**
 * Make whatever was read from disk safe to use. Unknown or damaged parts are
 * dropped rather than trusted; tabs that pages opened themselves (temp) are
 * not carried across a restart.
 */
export function sanitize(raw) {
  const data = defaults();
  if (!raw || typeof raw !== 'object') return data;
  const seen = new Set();
  data.brands = (Array.isArray(raw.brands) ? raw.brands : [])
    .map(cleanBrand)
    .filter((brand) => brand && !seen.has(brand.id) && seen.add(brand.id));
  data.activeBrandId = data.brands.some((b) => b.id === raw.activeBrandId)
    ? raw.activeBrandId
    : (data.brands[0]?.id ?? null);
  data.settings = cleanSettings(raw.settings);
  data.window = cleanWindow(raw.window);
  if (typeof raw.lastVersion === 'string') data.lastVersion = raw.lastVersion.slice(0, 40);
  if (typeof raw.releaseNotes?.version === 'string' && typeof raw.releaseNotes.text === 'string') {
    data.releaseNotes = { version: raw.releaseNotes.version.slice(0, 40), text: raw.releaseNotes.text.slice(0, 20000) };
  }
  if (raw.permissions && typeof raw.permissions === 'object') {
    for (const [key, value] of Object.entries(raw.permissions)) {
      if (typeof value === 'boolean') data.permissions[key] = value;
    }
  }
  return data;
}

export function findBrand(data, brandId) {
  return data.brands.find((brand) => brand.id === brandId) ?? null;
}

/** Tab ids are unique across brands, so a tab id alone finds its brand. */
export function findTab(data, tabId) {
  for (const brand of data.brands) {
    const index = brand.tabs.findIndex((tab) => tab.id === tabId);
    if (index !== -1) return { brand, tab: brand.tabs[index], index };
  }
  return null;
}

export function createBrand(data, { name, color, folder, urls = [] }) {
  const brand = cleanBrand(
    { id: newId('b'), name, color, folder: typeof folder === 'string' ? folder : '', tabs: [] },
    data.brands.length,
  );
  for (const url of urls) addTab(brand, { url });
  brand.panes = [brand.tabs[0]?.id ?? null];
  brand.activeTabId = brand.panes[0];
  data.brands.push(brand);
  data.activeBrandId = brand.id;
  return brand;
}

export function updateBrand(brand, patch) {
  if (typeof patch.name === 'string' && patch.name.trim()) brand.name = text(patch.name, 60);
  if (HEX.test(patch.color ?? '')) brand.color = patch.color.toLowerCase();
  if (typeof patch.folder === 'string') brand.folder = patch.folder;
  return brand;
}

/** Remove a brand; returns it (or null). The next brand becomes active. */
export function deleteBrand(data, brandId) {
  const index = data.brands.findIndex((brand) => brand.id === brandId);
  if (index === -1) return null;
  const [brand] = data.brands.splice(index, 1);
  if (data.activeBrandId === brandId) {
    data.activeBrandId = (data.brands[index] ?? data.brands[index - 1])?.id ?? null;
  }
  return brand;
}

/**
 * Add a tab. `temp` marks one a page opened by itself: it is not a posting
 * destination and is not saved. `afterId` places it next to its opener.
 */
export function addTab(brand, { url = '', temp = false, afterId = null } = {}) {
  const address = webUrl(url);
  const tab = {
    id: newId('t'),
    name: '',
    homeUrl: address,
    url: address,
    title: '',
    favicon: '',
    keepAwake: false,
    temp: temp === true,
  };
  const at = afterId ? brand.tabs.findIndex((t) => t.id === afterId) : -1;
  if (at === -1) brand.tabs.push(tab);
  else brand.tabs.splice(at + 1, 0, tab);
  return tab;
}

/**
 * Remove a tab. A solo tab that goes takes nothing with it: the group comes
 * back. A tab of the group leaves its pane empty, because no tab joins the
 * group by itself. The one pane of a brand without a group takes the nearest
 * tab instead (right-hand neighbour first), as a browser does.
 */
export function removeTab(brand, tabId) {
  const index = brand.tabs.findIndex((tab) => tab.id === tabId);
  if (index === -1) return null;
  const [tab] = brand.tabs.splice(index, 1);
  if (brand.solo === tabId) brand.solo = null;
  const pane = brand.panes.indexOf(tabId);
  if (pane !== -1) {
    brand.panes[pane] = brand.panes.length > 1 ? null : ((brand.tabs[index] ?? brand.tabs[index - 1])?.id ?? null);
  }
  settle(brand);
  return tab;
}

/** The tabs a file can be marked as posted to: kept tabs that have an address. */
export function destinations(brand) {
  return brand.tabs.filter((tab) => !tab.temp && tab.homeUrl);
}
