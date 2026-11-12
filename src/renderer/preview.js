// The text preview under the file tree. Click a .txt or .md file to read it;
// select any part of it and that part is on the clipboard, ready to paste
// into a caption box.
//
// Memory: the text lives only in the page (one text node), never in a
// variable here, and is released when the preview closes or the brand changes.

import { formatSize, h, icon } from './dom.js';

const $ = (id) => document.getElementById(id);

export class Preview {
  #api;
  #note;
  #brandId = null;
  #rel = null;
  #name = '';
  #body = null;
  #lastCopied = '';
  #request = 0;

  constructor({ api, note }) {
    this.#api = api;
    this.#note = note;
    // The selection is final when the mouse button or a key is released.
    const section = $('preview');
    section.addEventListener('mouseup', () => this.#copySelection());
    section.addEventListener('keyup', (e) => {
      if (e.shiftKey || e.key === 'Shift' || (e.key === 'a' && (e.ctrlKey || e.metaKey))) this.#copySelection();
    });
  }

  async show(brandId, rel, name) {
    const request = ++this.#request;
    this.#brandId = brandId;
    this.#rel = rel;
    this.#name = name;
    const result = await this.#api.readFile(brandId, rel);
    if (request !== this.#request) return; // another file was clicked meanwhile
    this.#render(result);
  }

  /** A watched folder changed: read the open file again if it lives there. */
  refreshIfIn(relDir) {
    if (this.#rel === null) return;
    const parent = this.#rel.includes('/') ? this.#rel.slice(0, this.#rel.lastIndexOf('/')) : '';
    if (parent === relDir) this.show(this.#brandId, this.#rel, this.#name);
  }

  close() {
    this.#request += 1;
    this.#rel = null;
    this.#body = null;
    this.#lastCopied = '';
    $('preview').replaceChildren();
    $('preview').hidden = true;
    $('preview-splitter').hidden = true;
  }

  #render(result) {
    const section = $('preview');
    const scrolled = this.#body?.scrollTop ?? 0;
    const sameFile = section.dataset.rel === this.#rel;
    section.dataset.rel = this.#rel;

    let body;
    let about = '';
    if (result.error) {
      body = h('p', { class: 'preview-note' }, 'This file could not be read. It may have been moved or deleted.');
    } else if (result.binary) {
      body = h('p', { class: 'preview-note' }, 'This file is not text, so there is nothing to read here.');
    } else if (!result.text) {
      body = h('p', { class: 'preview-note' }, 'This file is empty.');
    } else {
      body = h('pre', { class: 'preview-text', tabIndex: 0 }, result.text);
      about = result.truncated
        ? `First ${formatSize(result.text.length)} of ${formatSize(result.size)}`
        : formatSize(result.size);
    }
    this.#body = body;

    const copyAll = h('button', {
      class: 'tool',
      title: 'Copy the whole file',
      disabled: body.tagName !== 'PRE',
      onclick: () => this.#copy(body.textContent, 'the whole file'),
    }, icon('copy'));

    section.replaceChildren(
      h('header', { class: 'preview-head' },
        h('span', { class: 'preview-name', title: this.#rel }, this.#name),
        h('span', { class: 'preview-about' }, about),
        copyAll,
        h('button', { class: 'tool', title: 'Close', onclick: () => this.close() }, icon('close'))),
      body,
      body.tagName === 'PRE' ? h('p', { class: 'preview-hint' }, 'Select text to copy it.') : null,
    );
    section.hidden = false;
    $('preview-splitter').hidden = false;
    if (sameFile) body.scrollTop = scrolled;
  }

  #copySelection() {
    const selection = window.getSelection();
    if (!this.#body || selection.isCollapsed || !this.#body.contains(selection.anchorNode)) return;
    const text = selection.toString();
    if (!text.trim() || text === this.#lastCopied) return;
    this.#copy(text);
  }

  async #copy(text, what) {
    this.#lastCopied = text;
    await this.#api.copy(text);
    const count = [...text].length;
    this.#note(`Copied ${what ?? `${count.toLocaleString()} ${count === 1 ? 'character' : 'characters'}`}.`, { ms: 2500 });
  }
}
