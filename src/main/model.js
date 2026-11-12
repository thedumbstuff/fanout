// The saved shape of the app: brands, each with a folder and its tabs, plus
// settings. Everything here works on plain data so it can be tested without
// Electron. main.js owns the one live copy and saves it through store.js.

import { randomBytes } from 'node:crypto';
import { isWebUrl } from './urls.js';

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
  for (const key of ['panelOpen', 'hidePosted']) {
    if (typeof input[key] === 'boolean') out[key] = input[key];
  }
  return out;
}

const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const webUrl = (value) => (isWebUrl(value) ? value : '');

function cleanTab(raw) {
  if (!raw || typeof raw !== 'object' || !TAB_ID.test(raw.id) || raw.temp) return null;
  const url = webUrl(raw.url);
  return {
    id: raw.id,
    name: text(raw.name, 40),
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
  const tabs = (Array.isArray(raw.tabs) ? raw.tabs : [])
    .map(cleanTab)
    .filter((tab) => tab && !seen.has(tab.id) && seen.add(tab.id));
  // Panes: each holds one tab or nothing, and a tab is in at most one pane.
  const placed = new Set();
  let panes = (Array.isArray(raw.panes) ? raw.panes : []).slice(0, MAX_PANES).map((id) =>
    (seen.has(id) && !placed.has(id) && placed.add(id) ? id : null));
  if (!panes.length) panes = [seen.has(raw.activeTabId) ? raw.activeTabId : (tabs[0]?.id ?? null)];
  const focus = Number.isInteger(raw.focus) && raw.focus >= 0 && raw.focus < panes.length ? raw.focus : 0;

  return {
    id: raw.id,
    name: text(raw.name, 60) || 'Brand',
    color: HEX.test(raw.color) ? raw.color.toLowerCase() : BRAND_COLORS[index % BRAND_COLORS.length],
    folder: typeof raw.folder === 'string' ? raw.folder : '',
    panes,
    focus,
    splitX: ratio(raw.splitX),
    splitY: ratio(raw.splitY),
    activeTabId: panes[focus],
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
// `splitX` and `splitY` are where the two dividers sit. `focus` is the pane
// the address bar and the tab strip act on; `activeTabId` is always the tab
// in that pane (or null) and is kept only so callers need not look it up.

/** Show a tab: if a pane already has it, focus that pane; else put it in the focused one. */
export function showTab(brand, tabId) {
  const at = brand.panes.indexOf(tabId);
  if (at !== -1) brand.focus = at;
  else brand.panes[brand.focus] = tabId;
  brand.activeTabId = tabId;
}

export function focusPane(brand, index) {
  if (!Number.isInteger(index) || index < 0 || index >= brand.panes.length) return;
  brand.focus = index;
  brand.activeTabId = brand.panes[index];
}

/**
 * Change how many panes a brand shows. New panes take the tabs that are not
 * on screen yet, in tab order. When panes are removed the focused tab stays.
 */
export function setPaneCount(brand, count) {
  const wanted = Math.min(MAX_PANES, Math.max(1, Math.round(Number(count)) || 1));
  const focused = brand.panes[brand.focus];
  const panes = brand.panes.slice(0, wanted);
  if (focused && !panes.includes(focused)) panes[wanted - 1] = focused;
  const spare = brand.tabs.map((tab) => tab.id).filter((id) => !panes.includes(id));
  while (panes.length < wanted) panes.push(spare.shift() ?? null);
  brand.panes = panes;
  brand.focus = focused ? panes.indexOf(focused) : Math.min(brand.focus, wanted - 1);
  brand.activeTabId = panes[brand.focus];
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
 * Remove a tab. If it was on screen, its pane takes the nearest tab that is
 * not on screen already (right-hand neighbour first), or stays empty.
 */
export function removeTab(brand, tabId) {
  const index = brand.tabs.findIndex((tab) => tab.id === tabId);
  if (index === -1) return null;
  const [tab] = brand.tabs.splice(index, 1);
  const pane = brand.panes.indexOf(tabId);
  if (pane !== -1) {
    const candidates = [brand.tabs[index], brand.tabs[index - 1], ...brand.tabs];
    brand.panes[pane] = candidates.find((t) => t && !brand.panes.includes(t.id))?.id ?? null;
  }
  brand.activeTabId = brand.panes[brand.focus];
  return tab;
}

/** The tabs a file can be marked as posted to: kept tabs that have an address. */
export function destinations(brand) {
  return brand.tabs.filter((tab) => !tab.temp && tab.homeUrl);
}
