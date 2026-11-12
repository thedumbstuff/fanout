// The text preview under the file tree. Click a text file to read it; select
// any part of it and that part is on the clipboard, ready to paste into a
// caption box. A Markdown file is shown formatted (markdown.js reads it, this
// file draws it with h(): text stays text, nothing becomes HTML); "Source"
// shows it as it is written.
//
// Memory: the text lives only in the page (one text node, or the formatted
// elements), never in a variable here, and is released when the preview
// closes or the brand changes. Switching between the two views reads the
// file again rather than keeping a copy.

import { formatSize, h, icon } from './dom.js';
import { isMarkdownFile, parseMarkdown, plainText } from './markdown.js';

const $ = (id) => document.getElementById(id);
const MAX_NESTING = 32; // formatting nested deeper than this is drawn as plain text

export class Preview {
  #api;
  #note;
  #brandId = null;
  #rel = null;
  #name = '';
  #body = null;
  #lastCopied = '';
  #request = 0;
  #source = false; // Markdown shown as written; remembered while the app runs

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
    const markdown = isMarkdownFile(this.#name);
    const view = markdown && !this.#source ? 'formatted' : 'text';
    const scrolled = this.#body?.scrollTop ?? 0;
    const sameView = section.dataset.rel === this.#rel && section.dataset.view === view;
    section.dataset.rel = this.#rel;
    section.dataset.view = view;

    let body;
    let about = '';
    if (result.error) {
      body = h('p', { class: 'preview-note' }, 'This file could not be read. It may have been moved or deleted.');
    } else if (result.binary) {
      body = h('p', { class: 'preview-note' }, 'This file is not text, so there is nothing to read here.');
    } else if (!result.text) {
      body = h('p', { class: 'preview-note' }, 'This file is empty.');
    } else {
      body = view === 'formatted'
        ? h('article', { class: 'preview-md', tabIndex: 0 }, this.#blocks(parseMarkdown(result.text).children))
        : h('pre', { class: 'preview-text', tabIndex: 0 }, result.text);
      about = result.truncated
        ? `First ${formatSize(result.text.length)} of ${formatSize(result.size)}`
        : formatSize(result.size);
    }
    this.#body = body;
    const readable = !body.classList.contains('preview-note');

    // In the formatted view the whole file is copied as it reads (innerText:
    // no Markdown signs, line breaks as shown); in Source, exactly as written.
    const copyAll = h('button', {
      class: 'tool',
      dataset: { act: 'copy-all' },
      title: !markdown ? 'Copy the whole file'
        : view === 'formatted' ? 'Copy the whole file as it reads here, without the Markdown signs'
          : 'Copy the whole file as it is written, Markdown signs and all',
      disabled: !readable,
      onclick: () => this.#copy(view === 'formatted' ? body.innerText : body.textContent, 'the whole file'),
    }, icon('copy'));

    const source = markdown && readable ? h('button', {
      class: `preview-toggle${this.#source ? ' is-on' : ''}`,
      dataset: { act: 'source' },
      'aria-pressed': String(this.#source),
      title: this.#source ? 'Showing the text as it is written. Click to show it formatted.' : 'Show the text as it is written',
      onclick: () => this.#toggleSource(),
    }, 'Source') : null;

    section.replaceChildren(
      h('header', { class: 'preview-head' },
        h('span', { class: 'preview-name', title: this.#rel }, this.#name),
        h('span', { class: 'preview-about' }, about),
        source,
        copyAll,
        h('button', { class: 'tool', title: 'Close', onclick: () => this.close() }, icon('close'))),
      body,
      readable ? h('p', { class: 'preview-hint' }, 'Select text to copy it.') : null,
    );
    section.hidden = false;
    $('preview-splitter').hidden = false;
    if (sameView) body.scrollTop = scrolled;
  }

  #toggleSource() {
    this.#source = !this.#source;
    if (this.#rel !== null) this.show(this.#brandId, this.#rel, this.#name);
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

  // ------------------------------------------------------- formatted view
  //
  // Elements for the tree from markdown.js. Every piece of the file arrives
  // here as text and is put on the page as text (h() appends text nodes).
  // Pictures are never loaded (a file must not make the app fetch anything),
  // and a link is not followed inside the interface: a web link opens as a new
  // tab of this brand, any other link is plain text.

  #blocks(blocks) {
    return blocks.map((block) => this.#block(block));
  }

  #block(block) {
    switch (block.type) {
      case 'heading':
        return h(`h${block.level}`, {}, this.#inline(block.children, 0));
      case 'paragraph':
        return h('p', {}, this.#inline(block.children, 0));
      case 'code':
        return h('pre', {}, h('code', {}, block.text));
      case 'quote':
        return h('blockquote', {}, this.#blocks(block.children));
      case 'hr':
        return h('hr');
      case 'list':
        return h(block.ordered ? 'ol' : 'ul', { start: block.ordered && block.start !== 1 ? block.start : undefined },
          block.items.map((item) => this.#item(item, block.tight)));
      case 'table':
        return this.#table(block);
      default:
        return null;
    }
  }

  #item(item, tight) {
    const box = item.task === null ? null : h('span', {
      class: `md-task${item.task ? ' is-done' : ''}`,
      role: 'img',
      'aria-label': item.task ? 'Done' : 'Not done',
    });
    // In a tight list (no blank lines) an item's paragraph is just its text.
    const content = item.children.flatMap((block) =>
      (tight && block.type === 'paragraph' ? this.#inline(block.children, 0) : [this.#block(block)]));
    return h('li', { class: box ? 'md-task-item' : undefined }, box, content);
  }

  /** A table scrolls sideways inside its own box: the preview is narrow. */
  #table(block) {
    const cell = (tag, nodes, column) =>
      h(tag, { class: block.align[column] ? `is-${block.align[column]}` : undefined }, this.#inline(nodes, 0));
    return h('div', { class: 'md-table' }, h('table', {},
      h('thead', {}, h('tr', {}, block.head.map((nodes, column) => cell('th', nodes, column)))),
      block.rows.length
        ? h('tbody', {}, block.rows.map((row) => h('tr', {}, row.map((nodes, column) => cell('td', nodes, column)))))
        : null));
  }

  #inline(nodes, depth) {
    if (depth > MAX_NESTING) return [plainText(nodes)];
    return nodes.map((node) => {
      switch (node.type) {
        case 'text':
          return node.text;
        case 'break':
          return h('br');
        case 'codespan':
          return h('code', {}, node.text);
        case 'strong':
        case 'em':
        case 'del':
          return h(node.type, {}, this.#inline(node.children, depth + 1));
        case 'link':
          return this.#link(node, depth);
        case 'image':
          return h('span', {
            class: 'md-picture',
            title: `A picture, not loaded${node.target ? `: ${node.target}` : ''}`,
          }, node.alt || 'picture');
        default:
          return null;
      }
    });
  }

  #link(node, depth) {
    const children = this.#inline(node.children, depth + 1);
    if (!node.href) {
      return h('span', {
        class: 'md-link-off',
        title: `${node.target || 'No address'}\nOnly web addresses (http and https) open, as a new tab.`,
      }, children);
    }
    const open = () => {
      // Selecting part of a link to copy it is not a click on it.
      if (!window.getSelection().isCollapsed) return;
      this.#api.createTab(this.#brandId, node.href);
      this.#note('The link opened in a new tab.', { ms: 2500 });
    };
    return h('a', {
      class: 'md-link',
      role: 'link',
      tabIndex: 0,
      title: `${node.href}\nOpens in a new tab of this brand`,
      onclick: open,
      onkeydown: (e) => { if (e.key === 'Enter') open(); },
    }, children);
  }
}
