// Memory policy. A tab that is "asleep" has no page process at all: only its
// address, title and icon are kept, and it loads again when it is selected.
// This file decides which tabs go to sleep; tabs.js carries it out.
// Pure: no Electron, time is passed in.

/**
 * @typedef {object} TabVitals
 * @property {string}  id
 * @property {boolean} live        has a page process
 * @property {boolean} visible     the tab on screen right now
 * @property {boolean} busy        loading, playing sound, uploading, or holding unsaved work
 * @property {boolean} keepAwake   the owner said never to sleep it
 * @property {number}  lastActive  ms timestamp it was last on screen
 */

/**
 * Pick the tabs to put to sleep, oldest first.
 *  1. Any background tab left alone for `sleepAfterMs` (0 = never).
 *  2. If more than `maxLive` tabs are still live (0 = no limit), the least
 *     recently used background tabs until the count fits.
 * A visible, busy or keep-awake tab is never picked, so the live count can
 * stay above the limit when every candidate is doing something.
 *
 * @param {TabVitals[]} tabs
 * @param {{now: number, sleepAfterMs: number, maxLive: number}} policy
 * @returns {string[]} tab ids
 */
export function pickTabsToSleep(tabs, { now, sleepAfterMs, maxLive }) {
  const live = tabs.filter((t) => t.live);
  const candidates = live
    .filter((t) => !t.visible && !t.busy && !t.keepAwake)
    .sort((a, b) => a.lastActive - b.lastActive);

  const picked = [];
  const rest = [];
  for (const tab of candidates) {
    if (sleepAfterMs > 0 && now - tab.lastActive >= sleepAfterMs) picked.push(tab.id);
    else rest.push(tab);
  }

  if (maxLive > 0) {
    let over = live.length - picked.length - maxLive;
    for (const tab of rest) {
      if (over <= 0) break;
      picked.push(tab.id);
      over -= 1;
    }
  }
  return picked;
}

const READ_ONLY = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Notices uploads without looking at any page or request body.
 *
 * It only sees when a request that sends data (POST, PUT, PATCH ...) starts
 * and ends. One that stays open for `longMs` is taken for an upload; the page
 * then counts as busy until `lingerMs` after the last such request, which
 * covers the gaps between the chunks of a large video. A page that keeps a
 * long POST open for other reasons is simply never put to sleep: the mistake
 * is always on the side of leaving a tab alone.
 */
export class UploadActivity {
  #inflight = new Map(); // request id -> { page, start }
  #lastLong = new Map(); // page id -> ms timestamp
  #longMs;
  #lingerMs;

  constructor({ longMs = 3000, lingerMs = 120_000 } = {}) {
    this.#longMs = longMs;
    this.#lingerMs = lingerMs;
  }

  begin(requestId, page, method, now) {
    if (page == null || READ_ONLY.has(method)) return;
    this.#inflight.set(requestId, { page, start: now });
  }

  end(requestId, now) {
    const request = this.#inflight.get(requestId);
    if (!request) return;
    this.#inflight.delete(requestId);
    if (now - request.start >= this.#longMs) this.#lastLong.set(request.page, now);
  }

  isBusy(page, now) {
    const last = this.#lastLong.get(page);
    if (last !== undefined && now - last < this.#lingerMs) return true;
    for (const request of this.#inflight.values()) {
      if (request.page === page && now - request.start >= this.#longMs) return true;
    }
    return false;
  }

  /** Drop everything remembered about a page that no longer exists. */
  forget(page) {
    this.#lastLong.delete(page);
    for (const [id, request] of this.#inflight) {
      if (request.page === page) this.#inflight.delete(id);
    }
  }

  get pending() {
    return this.#inflight.size;
  }
}
