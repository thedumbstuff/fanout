// The file panel: the active brand's folder as a tree, the posted marks next
// to each file, and dragging files out onto a page. Clicking a file shows it
// under the tree: text in the preview, videos, pictures and sounds in the
// media viewer.
//
// Memory: a directory is read only when it is opened, at most ROWS_PER_FOLDER
// of its entries are put on screen at a time, and only open directories are
// watched for changes. Switching brand drops everything loaded for the last.

import { destinationLabel, formatSize, h, icon } from './dom.js';
import { Preview } from './preview.js';
import { MEDIA_KINDS } from './viewer.js';

const ROWS_PER_FOLDER = 300;
const MAX_MARKS_SHOWN = 6;
const $ = (id) => document.getElementById(id);
const parentOf = (rel) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');

const PROBLEMS = {
  missing: 'This folder is not there any more.',
  denied: 'fanout is not allowed to read this folder.',
  outside: 'That is outside the brand\'s folder.',
  failed: 'This folder could not be read.',
};

export class FilePanel {
  #api;
  #note;
  #activeTab;
  #preview;

  #brand = null; // the brand object from the last state
  #folder = '';
  #dirs = new Map(); // rel -> { entries, truncated, error, shown }
  #open = new Set(['']); // expanded directories; '' is the folder itself
  #openByBrand = new Map(); // remembered while the app runs
  #selected = new Set();
  #anchor = null;
  #order = []; // file rels in the order they are on screen
  #posted = {}; // rel -> { tabId: iso time }
  #destinations = [];
  #hidePosted = false;
  #signature = '';
  #token = 0; // increases on every brand switch; stale answers are dropped

  constructor({ api, note, activeTab }) {
    this.#api = api;
    this.#note = note;
    this.#activeTab = activeTab;
    this.#preview = new Preview({ api, note, nearby: (file, by) => this.#nearby(file, by) });

    const tree = $('tree');
    tree.addEventListener('click', (e) => this.#onClick(e));
    tree.addEventListener('dblclick', (e) => this.#onDoubleClick(e));
    tree.addEventListener('contextmenu', (e) => this.#onMenu(e));
    tree.addEventListener('dragstart', (e) => this.#onDragStart(e));

    api.on('files:changed', async (brandId, rel) => {
      if (brandId !== this.#brand?.id || !this.#open.has(rel)) return;
      await this.#load(rel);
      // After the new listing: the preview can tell whether its file is still there.
      if (brandId === this.#brand?.id) this.#preview.refreshIfIn(rel, this.#dirs.get(rel)?.entries ?? []);
    });
    api.on('posted:changed', (brandId, rel, marks) => {
      if (brandId !== this.#brand?.id) return;
      this.#setMarks(rel, marks);
    });
    api.on('files:dragged', (brandId, rels) => this.#afterDrag(brandId, rels));
  }

  /** Called with every new state. Reloads only when the brand or its folder changed. */
  update(state) {
    const brand = state.brands.find((b) => b.id === state.activeBrandId) ?? null;
    const destinations = (brand?.tabs ?? []).filter((tab) => !tab.temp && tab.homeUrl);
    const signature = [brand?.id, brand?.folder, state.settings.hidePosted,
      ...destinations.map((tab) => [tab.id, destinationLabel(tab), tab.favicon].join('~'))].join('|');
    const switched = brand?.id !== this.#brand?.id || (brand?.folder ?? '') !== this.#folder;

    if (this.#brand && switched) this.#openByBrand.set(this.#brand.id, this.#open);
    this.#brand = brand;
    this.#destinations = destinations;
    this.#hidePosted = state.settings.hidePosted;
    this.#preview.panelShown(state.settings.panelOpen);

    const redraw = signature !== this.#signature;
    this.#signature = signature;
    if (switched) return this.#switch(brand);
    if (redraw) {
      this.#renderHead();
      this.#renderTree();
    }
  }

  async #switch(brand) {
    const token = ++this.#token;
    this.#folder = brand?.folder ?? '';
    this.#dirs = new Map();
    this.#selected = new Set();
    this.#anchor = null;
    this.#posted = {};
    this.#open = (brand && this.#openByBrand.get(brand.id)) || new Set(['']);
    this.#preview.close();
    this.#renderHead();
    this.#renderTree();
    if (!brand?.folder) return this.#api.watchFolders(null, []);

    const posted = await this.#api.getPosted(brand.id);
    if (token !== this.#token) return;
    this.#posted = posted;
    await Promise.all([...this.#open].map((rel) => this.#load(rel)));
  }

  async #load(rel) {
    const token = this.#token;
    const brandId = this.#brand.id;
    const result = await this.#api.listFiles(brandId, rel);
    if (token !== this.#token) return;
    if (result.error) {
      // A subfolder that has gone simply closes; the root shows what is wrong.
      if (rel !== '') this.#open.delete(rel);
      this.#dirs.set(rel, { entries: [], truncated: false, error: result.error, shown: 0 });
    } else {
      const shown = Math.max(ROWS_PER_FOLDER, this.#dirs.get(rel)?.shown ?? 0);
      this.#dirs.set(rel, { ...result, error: null, shown });
    }
    this.#renderTree();
    this.#api.watchFolders(brandId, [...this.#open]);
  }

  // ---------------------------------------------------------------- drawing

  #renderHead() {
    const brand = this.#brand;
    const head = $('panel-head');
    if (!brand) return head.replaceChildren();
    const name = this.#folder ? this.#folder.split(/[\\/]/).filter(Boolean).pop() : 'No folder yet';
    head.replaceChildren(
      h('button', {
        class: 'folder-name',
        title: this.#folder ? `${this.#folder}\nClick to choose another folder` : 'Choose the folder this brand uploads from',
        onclick: () => this.#chooseFolder(),
      }, icon('folder'), h('span', {}, name)),
      h('button', {
        class: `tool${this.#hidePosted ? ' is-on' : ''}`,
        title: this.#hidePosted ? 'Showing only files still to post. Click to show all.' : 'Hide files already posted everywhere',
        'aria-pressed': String(this.#hidePosted),
        disabled: !this.#folder,
        onclick: () => this.#api.updateSettings({ hidePosted: !this.#hidePosted }),
      }, icon('eye')),
      h('button', {
        class: 'tool',
        title: 'Read the folder again',
        disabled: !this.#folder,
        onclick: () => [...this.#open].forEach((rel) => this.#load(rel)),
      }, icon('refresh')),
    );
  }

  async #chooseFolder() {
    const brand = this.#brand;
    const folder = await this.#api.chooseFolder(brand.folder);
    if (folder) await this.#api.updateBrand(brand.id, { folder });
  }

  #renderTree() {
    const tree = $('tree');
    const brand = this.#brand;
    this.#order = [];

    if (!brand) {
      return tree.replaceChildren(h('p', { class: 'tree-note' }, 'The files of the brand you are working on show up here.'));
    }
    if (!this.#folder) {
      return tree.replaceChildren(this.#message(
        'Choose the folder this brand posts from.',
        'Its videos, images and caption files show up here, ready to drag onto a page.',
        'Choose folder',
      ));
    }
    const root = this.#dirs.get('');
    if (!root) return tree.replaceChildren(h('p', { class: 'tree-note' }, 'Reading…'));
    if (root.error) {
      return tree.replaceChildren(this.#message(PROBLEMS[root.error], this.#folder, 'Choose another folder'));
    }

    const rows = [];
    this.#addRows(rows, '', 0);
    if (!rows.length) {
      rows.push(h('p', { class: 'tree-note' },
        root.entries.length ? 'Everything here is posted.' : 'This folder is empty.'));
    }
    tree.replaceChildren(...rows);
  }

  #message(title, detail, button) {
    return h('div', { class: 'tree-message' },
      h('p', { class: 'tree-message-title' }, title),
      h('p', { class: 'quiet' }, detail),
      h('button', { class: 'primary', onclick: () => this.#chooseFolder() }, button));
  }

  #addRows(rows, rel, depth) {
    const dir = this.#dirs.get(rel);
    if (!dir) return;
    let shown = 0;
    for (const entry of dir.entries) {
      if (shown >= dir.shown) break;
      if (!entry.dir && this.#hidePosted && this.#isDone(entry)) continue;
      shown += 1;
      rows.push(this.#row(entry, depth));
      if (entry.dir && this.#open.has(entry.rel)) this.#addRows(rows, entry.rel, depth + 1);
      else if (!entry.dir) this.#order.push(entry.rel);
    }
    const more = dir.entries.length - dir.shown;
    if (more > 0 || dir.truncated) {
      rows.push(h('button', {
        class: 'row row-more',
        style: { '--depth': String(depth) },
        dataset: { more: rel },
      }, more > 0 ? `Show ${Math.min(more, ROWS_PER_FOLDER)} more of ${more}` : 'Only the first 5,000 files are listed'));
    }
  }

  #postable(entry) {
    return !entry.dir && entry.kind !== 'text';
  }

  #isDone(entry) {
    if (!this.#postable(entry) || !this.#destinations.length) return false;
    const marks = this.#posted[entry.rel] ?? {};
    return this.#destinations.every((tab) => marks[tab.id]);
  }

  #row(entry, depth) {
    const open = entry.dir && this.#open.has(entry.rel);
    const classes = ['row', entry.dir ? 'row-dir' : 'row-file'];
    if (this.#selected.has(entry.rel)) classes.push('is-selected');
    if (open) classes.push('is-open');
    if (this.#isDone(entry)) classes.push('is-done');

    return h('div', {
      class: classes.join(' '),
      style: { '--depth': String(depth) },
      dataset: { rel: entry.rel, dir: entry.dir ? '1' : '', kind: entry.kind, name: entry.name },
      draggable: !entry.dir,
      title: entry.dir ? entry.name : `${entry.name}\n${formatSize(entry.size)}`,
    },
    icon(entry.dir ? 'chevron' : entry.kind),
    h('span', { class: 'row-name' }, h('span', {}, entry.name)),
    this.#postable(entry) ? this.#marks(entry) : null);
  }

  #marks(entry) {
    const marks = this.#posted[entry.rel] ?? {};
    const shown = this.#destinations.slice(0, MAX_MARKS_SHOWN);
    const hidden = this.#destinations.length - shown.length;
    return h('span', { class: 'marks' },
      shown.map((tab) => {
        const label = destinationLabel(tab);
        const at = marks[tab.id];
        return h('button', {
          class: `mark${at ? ' is-on' : ''}`,
          dataset: { tab: tab.id },
          title: at ? `Posted to ${label}, ${new Date(at).toLocaleString()}\nClick to clear` : `Mark as posted to ${label}`,
          'aria-pressed': String(Boolean(at)),
          'aria-label': `Posted to ${label}`,
        },
        tab.favicon
          ? h('img', { src: tab.favicon, alt: '', onerror: (e) => e.target.replaceWith(label[0].toUpperCase()) })
          : label[0].toUpperCase());
      }),
      hidden > 0 ? h('span', { class: 'marks-more', title: 'Right-click the file for every destination' }, `+${hidden}`) : null);
  }

  // ----------------------------------------------------------------- events

  #rowOf(event) {
    return event.target.closest('.row');
  }

  #onClick(event) {
    const row = this.#rowOf(event);
    if (!row) return;
    const { rel, more } = row.dataset;

    if (more !== undefined) {
      this.#dirs.get(more).shown += ROWS_PER_FOLDER;
      return this.#renderTree();
    }
    const mark = event.target.closest('.mark');
    if (mark) return this.#toggleMark(rel, mark.dataset.tab);

    if (row.dataset.dir) return this.#toggleDir(rel);

    if (event.shiftKey && this.#anchor) {
      const [a, b] = [this.#order.indexOf(this.#anchor), this.#order.indexOf(rel)].sort((x, y) => x - y);
      this.#selected = new Set(a === -1 ? [rel] : this.#order.slice(a, b + 1));
    } else if (event.ctrlKey || event.metaKey) {
      if (!this.#selected.delete(rel)) this.#selected.add(rel);
      this.#anchor = rel;
    } else {
      this.#selected = new Set([rel]);
      this.#anchor = rel;
      const { kind } = row.dataset;
      const entry = this.#entryOf(rel);
      if (kind === 'text') this.#preview.show(this.#brand.id, rel, row.dataset.name);
      else if (MEDIA_KINDS.has(kind) && entry) this.#preview.showMedia(this.#brand.id, entry);
    }
    this.#paintSelection();
  }

  /** A file's entry in the loaded listing of its folder. */
  #entryOf(rel) {
    return this.#dirs.get(parentOf(rel))?.entries.find((entry) => entry.rel === rel) ?? null;
  }

  /**
   * For the viewer's arrow keys: the media file `by` rows away from `file` in
   * the same folder, in the order the tree shows (files hidden as posted are
   * skipped). It becomes the selected row. Null at either end.
   */
  #nearby(file, by) {
    if (file.brandId !== this.#brand?.id) return null;
    const folder = parentOf(file.rel);
    const media = this.#order.filter((rel) => parentOf(rel) === folder && MEDIA_KINDS.has(this.#entryOf(rel)?.kind));
    const at = media.indexOf(file.rel);
    const rel = at === -1 ? null : media[at + by];
    if (!rel) return null;
    this.#selected = new Set([rel]);
    this.#anchor = rel;
    this.#paintSelection();
    $('tree').querySelector(`.row[data-rel="${CSS.escape(rel)}"]`)?.scrollIntoView({ block: 'nearest' });
    return { brandId: file.brandId, ...this.#entryOf(rel) };
  }

  /** Selection changes classes in place: rebuilding rows would cancel a drag that is starting. */
  #paintSelection() {
    for (const row of $('tree').querySelectorAll('.row-file')) {
      row.classList.toggle('is-selected', this.#selected.has(row.dataset.rel));
    }
  }

  #toggleDir(rel) {
    if (this.#open.delete(rel)) {
      // Closing a folder lets go of what was loaded beneath it.
      for (const key of [...this.#dirs.keys()]) {
        if (key === rel || key.startsWith(`${rel}/`)) {
          this.#dirs.delete(key);
          this.#open.delete(key);
        }
      }
      this.#renderTree();
      this.#api.watchFolders(this.#brand.id, [...this.#open]);
    } else {
      this.#open.add(rel);
      this.#load(rel);
    }
  }

  async #onDoubleClick(event) {
    const row = this.#rowOf(event);
    if (!row?.dataset.rel || row.dataset.dir || event.target.closest('.mark')) return;
    const result = await this.#api.openFile(this.#brand.id, row.dataset.rel);
    if (result.error) this.#note(`${row.dataset.name} could not be opened.`);
  }

  #onMenu(event) {
    const row = this.#rowOf(event);
    if (!row?.dataset.rel) return;
    if (!row.dataset.dir && !this.#selected.has(row.dataset.rel)) {
      this.#selected = new Set([row.dataset.rel]);
      this.#anchor = row.dataset.rel;
      this.#paintSelection();
    }
    this.#api.fileMenu(this.#brand.id, row.dataset.rel);
  }

  #onDragStart(event) {
    // The browser's own drag is replaced by a real file drag from the main process.
    event.preventDefault();
    const row = this.#rowOf(event);
    if (!row?.dataset.rel || row.dataset.dir) return;
    const rel = row.dataset.rel;
    if (!this.#selected.has(rel)) {
      this.#selected = new Set([rel]);
      this.#anchor = rel;
      this.#paintSelection();
    }
    this.#api.dragFiles(this.#brand.id, [...this.#selected]);
  }

  // ----------------------------------------------------------------- posted

  async #toggleMark(rel, tabId) {
    const brandId = this.#brand.id;
    const on = !this.#posted[rel]?.[tabId];
    const marks = await this.#api.setPosted(brandId, rel, tabId, on);
    if (brandId === this.#brand?.id) this.#setMarks(rel, marks);
  }

  #setMarks(rel, marks) {
    if (Object.keys(marks).length) this.#posted[rel] = marks;
    else delete this.#posted[rel];
    this.#renderTree();
  }

  /** After a drag: offer to mark the file as posted to the tab it was most likely dropped on. */
  #afterDrag(brandId, rels) {
    const tab = this.#activeTab();
    if (brandId !== this.#brand?.id || rels.length !== 1 || !tab) return;
    const [rel] = rels;
    const name = rel.split('/').pop();
    const isDestination = this.#destinations.some((d) => d.id === tab.id);
    const isText = $('tree').querySelector(`.row[data-rel="${CSS.escape(rel)}"]`)?.dataset.kind === 'text';
    if (!isDestination || isText || this.#posted[rel]?.[tab.id]) return;
    this.#note(`Did ${name} go to ${destinationLabel(tab)}?`, {
      label: 'Mark as posted',
      action: () => this.#toggleMark(rel, tab.id),
    });
  }
}
