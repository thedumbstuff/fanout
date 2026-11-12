// Small helpers the interface is built from. No framework: the screen is a
// few lists, and each is redrawn only where its data changed.

/**
 * Create an element. `props` sets properties; `class`, `dataset`, `style`
 * (an object of CSS properties) and `on<event>` are handled specially.
 */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key === 'style') for (const [k, v] of Object.entries(value)) el.style.setProperty(k, v);
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key in el) el[key] = value;
    else el.setAttribute(key, value);
  }
  el.append(...children.flat().filter((child) => child !== null && child !== undefined && child !== false));
  return el;
}

// Stroke icons on a 16px grid. Paths only: no icon font, no image requests.
const ICONS = {
  back: 'M9.5 3.5 5 8l4.5 4.5',
  forward: 'M6.5 3.5 11 8l-4.5 4.5',
  reload: 'M12.5 8a4.5 4.5 0 1 1-1.4-3.3M12.6 2.6v2.6H10',
  stop: 'M4.5 4.5l7 7M11.5 4.5l-7 7',
  home: 'M2.8 7.6 8 3l5.2 4.6M4.2 6.8v6h7.6v-6',
  plus: 'M8 3.2v9.6M3.2 8h9.6',
  close: 'M4.6 4.6l6.8 6.8M11.4 4.6l-6.8 6.8',
  panel: 'M2.5 3.5h11v9h-11zM9.8 3.5v9',
  layout1: 'M2.5 3.5h11v9h-11z',
  layout2: 'M2.5 3.5h11v9h-11zM8 3.5v9',
  layout3: 'M2.5 3.5h11v9h-11zM8 3.5v9M8 8h5.5',
  layout4: 'M2.5 3.5h11v9h-11zM8 3.5v9M2.5 8h11',
  gear: 'M2.5 5h5.4M11.1 5h2.4M2.5 11h2.4M8.1 11h5.4M9.5 3.4a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 0 0 0-3.2zM6.5 9.4a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 0 0 0-3.2z',
  moon: 'M12.6 9.6A5 5 0 0 1 6.4 3.4a5 5 0 1 0 6.2 6.2z',
  sound: 'M2.8 6.4v3.2h2.4L8.4 12V4L5.2 6.4zM10.6 6a2.8 2.8 0 0 1 0 4',
  chevron: 'M6 4.2 9.8 8 6 11.8',
  folder: 'M2.2 4.4h4l1.3 1.5h6.3v6.6H2.2z',
  refresh: 'M12.5 8a4.5 4.5 0 1 1-1.4-3.3M12.6 2.6v2.6H10',
  copy: 'M5.6 5.6h7v7.6h-7zM3.4 10.4V2.8h6.8',
  check: 'M3.4 8.4l3 3 6.2-6.6',
  eye: 'M1.8 8S4.2 4 8 4s6.2 4 6.2 4-2.4 4-6.2 4S1.8 8 1.8 8zM8 9.6a1.6 1.6 0 1 0 0-3.2 1.6 1.6 0 0 0 0 3.2z',
  text: 'M4 2.5h5.5L12.5 5.5v8H4zM9.3 2.7v3h3M6 8.4h4.4M6 10.6h4.4',
  video: 'M2.5 4h8v8h-8zM10.5 7l3-1.8v5.6l-3-1.8',
  image: 'M2.5 3.5h11v9h-11zM2.8 10.6l3-3 2.4 2.4 1.8-1.8 3.2 3.2M10.4 6.2h.01',
  audio: 'M6.4 11.6V4l6-1.2v7.4M6.4 11.6a1.7 1.7 0 1 1-3.4 0 1.7 1.7 0 0 1 3.4 0zM12.4 10.2a1.7 1.7 0 1 1-3.4 0 1.7 1.7 0 0 1 3.4 0z',
  other: 'M4 2.5h5.5L12.5 5.5v8H4zM9.3 2.7v3h3',
};

const SVG = 'http://www.w3.org/2000/svg';

export function icon(name) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('class', `icon icon-${name}`);
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG, 'path');
  path.setAttribute('d', ICONS[name] ?? ICONS.other);
  svg.append(path);
  return svg;
}

/**
 * Keep a container's children in step with a list. Each item has a key and a
 * signature; an element is rebuilt only when its signature changed, and the
 * container is reordered only when the order did.
 */
export function reconcile(container, items, { key, signature, create }) {
  const cache = (container.__items ??= new Map());
  const next = new Map();
  const wanted = [];
  for (const item of items) {
    const id = key(item);
    const sig = signature(item);
    let entry = cache.get(id);
    if (!entry || entry.sig !== sig) {
      const el = create(item);
      if (entry) entry.el.replaceWith(el);
      entry = { el, sig };
    }
    next.set(id, entry);
    wanted.push(entry.el);
  }
  for (const [id, entry] of cache) {
    if (!next.has(id)) entry.el.remove();
  }
  container.__items = next;
  const inOrder = wanted.length === container.children.length &&
    wanted.every((el, i) => container.children[i] === el);
  if (!inOrder) container.append(...wanted);
}

export function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** "Acme Foods" -> "AF", "nike" -> "NI". */
export function initials(name) {
  const words = String(name).trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  const letters = words.length === 1 ? [...words[0]].slice(0, 2) : [[...words[0]][0], [...words[1]][0]];
  return letters.join('').toUpperCase();
}

/** Readable text colour (ink or paper) for a background colour. */
export function inkOn(hex) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255];
  return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? '#070705' : '#f7f1e4';
}

/**
 * What a tab's rename box sends when it closes: null when the text is still
 * what the box opened with (nothing to save), else the new text, where ''
 * clears the tab's name. Only a change the person made can become a name; the
 * main process decides the rest (nameFor in main/model.js). A tab's label
 * itself comes from the main process, as `tab.label`.
 */
export function renameText(before, typed) {
  const text = String(typed ?? '').trim();
  return text === String(before ?? '').trim() ? null : text;
}

/** The short name of a posting destination. */
export function destinationLabel(tab) {
  return tab.name || tab.site || 'tab';
}
