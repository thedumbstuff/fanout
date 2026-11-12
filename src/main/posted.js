// The posted tracker: for each brand, which file has gone to which tab.
// A mark is something the owner sets by hand; fanout never reads a page to
// find out whether an upload happened.
//
// Shape on disk:  { [brandId]: { [relativePath]: { [tabId]: "ISO time" } } }
// Paths are relative to the brand's folder with forward slashes, so the marks
// survive moving the whole folder but not renaming a file inside it.

import { JsonStore } from './store.js';

function sanitize(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [brandId, files] of Object.entries(raw)) {
    if (!files || typeof files !== 'object') continue;
    const cleanFiles = {};
    for (const [rel, marks] of Object.entries(files)) {
      if (!marks || typeof marks !== 'object') continue;
      const cleanMarks = {};
      for (const [tabId, at] of Object.entries(marks)) {
        if (typeof at === 'string') cleanMarks[tabId] = at;
      }
      if (Object.keys(cleanMarks).length) cleanFiles[rel] = cleanMarks;
    }
    out[brandId] = cleanFiles;
  }
  return out;
}

export class PostedStore {
  #store;

  constructor(file, options = {}) {
    this.#store = new JsonStore(file, { sanitize, ...options });
  }

  /** Every mark of one brand: { [rel]: { [tabId]: iso } }. */
  forBrand(brandId) {
    return this.#store.data[brandId] ?? {};
  }

  /** Set or clear one mark; returns that file's marks afterwards. */
  set(brandId, rel, tabId, on, now = new Date()) {
    const files = (this.#store.data[brandId] ??= {});
    const marks = (files[rel] ??= {});
    if (on) marks[tabId] = now.toISOString();
    else delete marks[tabId];
    if (!Object.keys(marks).length) delete files[rel];
    this.#store.touch();
    return files[rel] ?? {};
  }

  /** Set or clear the marks of one file for several tabs at once. */
  setMany(brandId, rel, tabIds, on, now = new Date()) {
    for (const tabId of tabIds) this.set(brandId, rel, tabId, on, now);
    return this.forBrand(brandId)[rel] ?? {};
  }

  dropBrand(brandId) {
    if (!(brandId in this.#store.data)) return;
    delete this.#store.data[brandId];
    this.#store.touch();
  }

  flush() {
    this.#store.flush();
  }
}
