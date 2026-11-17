// Dragging a tab in the tab strip: onto another tab to see the two side by
// side, onto the group to add it, inside the group to move it, out of the
// group to take it out, or onto an empty pane in the page area.
//
// This file only works out what the pointer is over (targetAt) and shows it.
// What a drop there does is the main process's answer (planDrop and dropTab
// in main/model.js): it is asked while the pointer moves, and it decides.
//
// Pointer events with pointer capture, never HTML drag and drop: an HTML drag
// is a real system drag, offered to the web pages under the pointer, and
// nothing about a tab drag may reach a page. The pages are native layers drawn
// above this HTML, so nothing drawn here shows over them: the label that
// follows the pointer stays in the toolbar's band under the strip, and the
// only target in the page area is an empty pane, which has no page over it.

import { h } from './dom.js';

const START_PX = 5; // a press that moves less than this is a click
const SNAP_PX = 3; // this close to a tab outside the group counts as on it
const EDGE_PX = 28; // this close to an end of a crowded strip scrolls it
const SHOWN = new Set(['pair', 'join', 'move']); // drops that put the tab at a place in the strip

/** What the label under the pointer says a drop here does. */
const SAYS = {
  pair: 'Side by side',
  join: 'Add to the group',
  move: 'Move here',
  leave: 'Take out of the group',
  pane: 'Show it in this pane',
  full: 'The group is full: four pages at most',
  blank: 'Give it an address before taking it out',
};

/**
 * What the pointer at (x, y) is over, from the geometry of the interface:
 *   strip  {left, right, bottom}           the tab strip; anything above its bottom edge counts
 *   group  {left, right} | null            the group's outline, if one is shown
 *   tabs   [{id, left, right, grouped}]    the tabs in sight, not the one dragged
 *   panes  [{index, empty, left, right, top, bottom}]  the boxes of the page area
 * Inside the group's outline, the nearest tab of the group, before or after
 * it by half (past its last tab: after it). Outside it, a tab within a few
 * pixels, else the strip itself. In the page area, an empty pane, else nothing.
 */
export function targetAt(view, x, y) {
  const { strip, group } = view;
  if (x >= strip.left && x < strip.right && y < strip.bottom) {
    const inGroup = Boolean(group) && x >= group.left && x < group.right;
    let near = null;
    let best = Infinity;
    for (const tab of view.tabs) {
      if (tab.grouped !== inGroup) continue;
      const distance = x < tab.left ? tab.left - x : x > tab.right ? x - tab.right : 0;
      if (distance < best) [near, best] = [tab, distance];
    }
    if (near && (inGroup || best <= SNAP_PX)) return { on: 'tab', tabId: near.id, after: x >= (near.left + near.right) / 2 };
    return { on: inGroup ? 'group' : 'strip' };
  }
  const pane = view.panes.find((p) => p.empty && x >= p.left && x < p.right && y >= p.top && y < p.bottom);
  return pane ? { on: 'pane', index: pane.index } : null;
}

const $ = (id) => document.getElementById(id);

export class TabDrag {
  #api;
  #brand;
  #note;
  #renaming;
  #pending = null; // a press on a tab that has not moved far enough to be a drag
  #drag = null; // { tabId, brandId, pointerId, x, y, target, key, shown, zone, asked, speed, cancelled }
  #ghost = null;
  #marker = null;
  #scroll = 0; // the frame request that scrolls a crowded strip
  #listening = null; // what was added for the drag, to take off again

  /**
   * @param {object} deps
   * @param {object} deps.api            the bridge (window.fanout)
   * @param {() => object|null} deps.brand  the brand on screen, as last drawn
   * @param {(text: string) => void} deps.note  a line in the status bar
   * @param {() => boolean} deps.renaming  a tab's rename box is open
   */
  constructor({ api, brand, note, renaming }) {
    this.#api = api;
    this.#brand = brand;
    this.#note = note;
    this.#renaming = renaming;
    $('tabs').addEventListener('pointerdown', (e) => this.#press(e));
    // A favicon is an image, and an image starts a system drag by default:
    // never from the tab strip or the page area.
    for (const id of ['tabstrip', 'page']) $(id).addEventListener('dragstart', (e) => e.preventDefault());
  }

  get active() {
    return this.#drag !== null;
  }

  // ------------------------------------------------------------- pressing

  #press(down) {
    this.#forgetPress();
    if (down.button !== 0 || this.#drag || this.#renaming()) return;
    const tab = down.target.closest?.('.tab');
    if (!tab || down.target.closest('.tab-close, .tab-rename')) return;
    const pending = { tabId: tab.dataset.id, pointerId: down.pointerId, x: down.clientX, y: down.clientY };
    // Until it moves a few pixels it may be a click, a double-click or the
    // start of a rename: those are left alone, and the press is not captured.
    const move = (e) => {
      if (e.pointerId !== pending.pointerId || Math.hypot(e.clientX - pending.x, e.clientY - pending.y) < START_PX) return;
      this.#forgetPress();
      this.#start(pending, e);
    };
    const end = (e) => { if (e.pointerId === pending.pointerId) this.#forgetPress(); };
    this.#pending = { move, end };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  }

  #forgetPress() {
    if (!this.#pending) return;
    const { move, end } = this.#pending;
    this.#pending = null;
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', end);
    window.removeEventListener('pointercancel', end);
  }

  // ------------------------------------------------------------- dragging

  #start(pending, e) {
    const brand = this.#brand();
    const tab = brand?.tabs.find((t) => t.id === pending.tabId);
    if (!tab || this.#renaming()) return;
    // Captured on the strip itself, which is never redrawn: the tab's own
    // element may be replaced at any moment (a title arrives, memory ticks).
    const strip = $('tabs');
    try {
      strip.setPointerCapture(pending.pointerId);
    } catch {
      return; // the button was let go in between
    }
    const drag = {
      tabId: tab.id, brandId: brand.id, pointerId: pending.pointerId,
      x: e.clientX, y: e.clientY, target: null, key: '', shown: null, zone: null, asked: 0, speed: 0, cancelled: false,
    };
    this.#drag = drag;
    const on = {
      pointermove: (ev) => { if (ev.pointerId === drag.pointerId && !drag.cancelled) this.#move(ev.clientX, ev.clientY); },
      pointerup: (ev) => { if (ev.pointerId === drag.pointerId) this.#finish(!drag.cancelled); },
      pointercancel: () => this.#finish(false),
      lostpointercapture: () => this.#finish(false),
    };
    // Escape: no drop. The pointer stays captured until the button is let
    // go, so that letting go over a tab is not taken for a click on it.
    const key = (ev) => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      ev.stopPropagation();
      drag.cancelled = true;
      drag.target = null;
      drag.shown = null;
      drag.speed = 0;
      this.paint();
    };
    for (const [type, fn] of Object.entries(on)) strip.addEventListener(type, fn);
    window.addEventListener('keydown', key, true);
    this.#listening = { on, key };

    document.body.classList.add('is-dragging-tab');
    this.#ghost = h('div', { class: 'tab-ghost', 'aria-hidden': 'true' },
      h('span', { class: 'tab-ghost-label' }, tab.label), h('span', { class: 'tab-ghost-does' }));
    this.#marker = h('div', { class: 'drop-marker', hidden: true });
    document.body.append(this.#ghost);
    $('tabstrip').append(this.#marker);

    // Whether the group takes this tab at all, to show on its outline the
    // whole time: a tab from outside is dropped there, a full group refuses it.
    this.#api.planDrop(tab.id, { on: 'group' }).then((does) => {
      if (this.#drag !== drag) return;
      drag.zone = does;
      this.paint();
    }, () => {});
    this.#move(e.clientX, e.clientY);
  }

  #move(x, y) {
    const drag = this.#drag;
    drag.x = x;
    drag.y = y;
    this.#retarget();
    this.#autoScroll();
  }

  /** Work out the target again (the pointer moved, or the strip under it scrolled) and ask what a drop there does. */
  #retarget() {
    const drag = this.#drag;
    const target = targetAt(this.#view(), drag.x, drag.y);
    const key = JSON.stringify(target);
    if (key !== drag.key) {
      drag.key = key;
      drag.target = target;
      // What a drop there does is shown once the main process has answered;
      // until then the last answer stays up, so nothing blinks between places.
      const asked = ++drag.asked; // also when there is nothing to ask: an answer still on its way is for elsewhere
      if (!target) drag.shown = null;
      else {
        this.#api.planDrop(drag.tabId, target).then((does) => {
          if (this.#drag !== drag || drag.asked !== asked || drag.cancelled) return; // a newer question is out
          drag.shown = { target, does };
          this.paint();
        }, () => {});
      }
    }
    this.paint();
  }

  /** The geometry targetAt needs, measured now. Tabs scrolled out of sight are left out. */
  #view() {
    const strip = $('tabstrip').getBoundingClientRect();
    const sight = $('tabs').getBoundingClientRect();
    const clip = (r) => ({ left: Math.max(r.left, sight.left), right: Math.min(r.right, sight.right) });
    const outline = $('tab-group');
    const group = outline.hidden ? null : clip(outline.getBoundingClientRect());
    const tabs = [...$('tabs').querySelectorAll('.tab')]
      .filter((el) => el.dataset.id !== this.#drag.tabId)
      .map((el) => ({ id: el.dataset.id, grouped: outline.contains(el), ...clip(el.getBoundingClientRect()) }))
      .filter((tab) => tab.right > tab.left);
    const panes = [...$('page').querySelectorAll('.pane')].map((el) => {
      const { left, right, top, bottom } = el.querySelector('.pane-body').getBoundingClientRect();
      return { index: Number(el.dataset.index), empty: !el.dataset.tab, left, right, top, bottom };
    });
    return { strip, group: group && group.right > group.left ? group : null, tabs, panes };
  }

  /** Near an end of a strip too crowded to show every tab, scroll it while the pointer stays there. */
  #autoScroll() {
    const drag = this.#drag;
    const tabs = $('tabs');
    const sight = tabs.getBoundingClientRect();
    const strip = $('tabstrip').getBoundingClientRect();
    let speed = 0;
    if (tabs.scrollWidth > tabs.clientWidth && drag.y < strip.bottom) {
      if (drag.x < sight.left + EDGE_PX) speed = -Math.ceil((sight.left + EDGE_PX - drag.x) / 4);
      else if (drag.x > sight.right - EDGE_PX) speed = Math.ceil((drag.x - (sight.right - EDGE_PX)) / 4);
    }
    drag.speed = Math.max(-8, Math.min(8, speed));
    if (!drag.speed || this.#scroll) return;
    const step = () => {
      this.#scroll = 0;
      if (this.#drag !== drag || !drag.speed) return;
      const before = tabs.scrollLeft;
      tabs.scrollLeft += drag.speed;
      if (tabs.scrollLeft === before) return; // at the end
      this.#retarget();
      this.#scroll = requestAnimationFrame(step);
    };
    this.#scroll = requestAnimationFrame(step);
  }

  /** Let go (drop) or stop (cancel: Escape, the pointer lost). Everything the drag added is taken off. */
  async #finish(drop) {
    const drag = this.#drag;
    if (!drag) return;
    this.#drag = null;
    cancelAnimationFrame(this.#scroll);
    this.#scroll = 0;
    const strip = $('tabs');
    const { on, key } = this.#listening;
    this.#listening = null;
    for (const [type, fn] of Object.entries(on)) strip.removeEventListener(type, fn);
    window.removeEventListener('keydown', key, true);
    if (strip.hasPointerCapture(drag.pointerId)) strip.releasePointerCapture(drag.pointerId);
    this.#ghost.remove();
    this.#marker.remove();
    this.#ghost = null;
    this.#marker = null;
    document.body.classList.remove('is-dragging-tab', 'is-drop-refused');
    this.paint();
    // A drag never ends in a click that selects the tab under the pointer.
    const swallow = (e) => {
      e.stopPropagation();
      e.preventDefault();
    };
    window.addEventListener('click', swallow, true);
    setTimeout(() => window.removeEventListener('click', swallow, true), 0);

    if (!drop || !drag.target || this.#brand()?.id !== drag.brandId) return;
    const does = await this.#api.dropTab(drag.tabId, drag.target).catch(() => null);
    if (does === 'full') this.#note('The group already shows four pages, the most it can. Drag one of them out first.');
    if (does === 'blank') this.#note('This tab has no page yet, so it stays in the group. Type an address in it first, or close it.');
  }

  // -------------------------------------------------------------- showing

  /**
   * Show the drag: the tab picked up, the group's outline as the place to
   * drop (or refusing), the tab or pane it would land on, a marker where it
   * goes, the label under the pointer. Called again after every redraw,
   * which may have replaced any of these elements.
   */
  paint() {
    for (const el of document.querySelectorAll('.is-lifted, .is-drop-target, .is-drop-zone, .is-refused')) {
      el.classList.remove('is-lifted', 'is-drop-target', 'is-drop-zone', 'is-refused');
    }
    const drag = this.#drag;
    if (!drag) return;
    const brand = this.#brand();
    if (brand?.id !== drag.brandId || !brand.tabs.some((tab) => tab.id === drag.tabId)) {
      this.#finish(false); // the brand changed, or the tab closed itself
      return;
    }
    if (drag.cancelled) {
      // Escape: nothing shows any more; letting go of the button ends it.
      document.body.classList.remove('is-dragging-tab', 'is-drop-refused');
      this.#ghost.hidden = true;
      this.#marker.hidden = true;
      return;
    }
    const strip = $('tabs');
    const outline = $('tab-group');
    const tabEl = (id) => strip.querySelector(`.tab[data-id="${CSS.escape(id)}"]`);
    tabEl(drag.tabId)?.classList.add('is-lifted');

    const target = drag.shown?.target;
    const does = drag.shown?.does ?? null;
    const refused = does === 'full' || does === 'blank';
    document.body.classList.toggle('is-drop-refused', refused);
    // The outline: where a tab from outside goes, the whole drag long.
    if (drag.zone === 'join') outline.classList.add('is-drop-zone');
    if (drag.zone === 'full') outline.classList.add('is-refused');
    if ((does === 'join' || does === 'move') && target.on !== 'pane') outline.classList.add('is-drop-target');
    if (does === 'full') outline.classList.add('is-refused');
    if (does === 'pair') tabEl(target.tabId)?.classList.add('is-drop-target');
    if (does === 'pane') $('page').querySelector(`.pane[data-index="${target.index}"]`)?.classList.add('is-drop-target');

    // The marker: a line where the tab will sit in the strip.
    let edge = null;
    if (SHOWN.has(does) && target.on === 'tab') {
      const r = tabEl(target.tabId)?.getBoundingClientRect();
      if (r) edge = { x: target.after ? r.right + 1 : r.left - 1, top: r.top, bottom: r.bottom };
    } else if (SHOWN.has(does) && target.on === 'group') {
      const last = [...outline.querySelectorAll('.tab')].pop()?.getBoundingClientRect();
      if (last) edge = { x: last.right + 1, top: last.top, bottom: last.bottom };
    }
    const sight = strip.getBoundingClientRect();
    const box = $('tabstrip').getBoundingClientRect();
    const marker = this.#marker;
    marker.hidden = !edge || edge.x < sight.left - 2 || edge.x > sight.right + 2;
    if (!marker.hidden) {
      marker.style.left = `${Math.round(edge.x - box.left - 1.5)}px`;
      marker.style.top = `${Math.round(edge.top - box.top)}px`;
      marker.style.height = `${Math.round(edge.bottom - edge.top)}px`;
    }

    // The label follows the pointer along the toolbar's band, just under the
    // strip: low enough not to hide the marker, never down over the pages.
    const ghost = this.#ghost;
    ghost.classList.toggle('is-refused', refused);
    ghost.lastChild.textContent = SAYS[does] ?? '';
    const main = $('main').getBoundingClientRect();
    const width = ghost.offsetWidth;
    ghost.style.left = `${Math.round(Math.max(main.left + 4, Math.min(main.right - width - 4, drag.x + 14)))}px`;
    ghost.style.top = `${Math.round($('toolbar').getBoundingClientRect().top + 6)}px`;
  }
}
