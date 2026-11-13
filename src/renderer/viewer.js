// The media viewer: a video, picture or sound from the brand's folder, shown
// under the file tree where text files are read, and larger over the page
// area on request.
//
// Files arrive over the fanout-media: address (main/media.js): streamed from
// disk in byte ranges, only from the brand's folder, only media kinds, and
// only for this interface; pages in tabs cannot reach it.
//
// Memory: at most one media element exists. A video loads its metadata and
// first picture, nothing more, until play is pressed. Closing the viewer,
// choosing another file, switching brand or the file disappearing pauses it,
// drops its source and removes it: the decoder goes, and the main process
// closes the file as soon as the player stops reading.
//
// No browser controls: their fullscreen button would put the video under the
// pages (they are drawn above the interface), and their menu offers download
// and picture-in-picture. The controls here are plain buttons and sliders.

import { cover, formatSize, h, icon } from './dom.js';

export const MEDIA_SCHEME = 'fanout-media';
export const MEDIA_KINDS = new Set(['video', 'image', 'audio']);

/** The address of a file in a brand's folder; the path is one encoded segment (main/media.js reads it). */
export function mediaUrl(brandId, rel) {
  return `${MEDIA_SCHEME}://file/${encodeURIComponent(brandId)}/${encodeURIComponent(rel)}`;
}

// Shapes the platforms ask for, named when a picture is within 1% of one.
const RATIOS = [[9, 16], [16, 9], [4, 5], [5, 4], [3, 4], [4, 3], [2, 3], [3, 2], [21, 9], [1.91, 1]];

/** How a picture of this size sits: "vertical 9:16", "horizontal", "square"; '' when unknown. */
export function shapeOf(width, height) {
  if (!(width > 0 && height > 0)) return '';
  if (width === height) return 'square';
  const ratio = width / height;
  const known = RATIOS.find(([a, b]) => Math.abs(ratio / (a / b) - 1) < 0.01);
  return `${width > height ? 'horizontal' : 'vertical'}${known ? ` ${known[0]}:${known[1]}` : ''}`;
}

/** 7 -> "0:07", 3723 -> "1:02:03"; with tenths 42.34 -> "0:42.3"; '' when unknown. */
export function formatDuration(seconds, { tenths = false } = {}) {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  const total = tenths ? Math.round(seconds * 10) / 10 : Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  const secs = tenths ? rest.toFixed(1).padStart(4, '0') : String(Math.floor(rest)).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${secs}` : `${minutes}:${secs}`;
}

/** What matters for posting: "1080 × 1920, vertical 9:16 · 0:42.3 · 38.2 MB". */
export function mediaFacts({ width, height, duration, size }) {
  const shape = shapeOf(width, height);
  return [
    shape ? `${width} × ${height}, ${shape}` : '',
    formatDuration(duration, { tenths: true }),
    Number.isFinite(size) ? formatSize(size) : '',
  ].filter(Boolean).join(' · ');
}

const CANNOT = {
  video: 'This video cannot be played here.',
  audio: 'This sound cannot be played here.',
  image: 'This picture cannot be shown here.',
};
const WHY = {
  video: 'fanout plays what its built-in browser plays: MP4, MOV, M4V, WebM and MKV in the usual formats. This file uses another one, or it is damaged.',
  audio: 'fanout plays MP3, WAV, M4A, AAC, FLAC, Ogg and Opus. This file uses another format, or it is damaged.',
  image: 'fanout shows JPEG, PNG, GIF, WebP, AVIF, BMP and SVG. HEIC and TIFF pictures, or a damaged file, open only in another app.',
};

// Volume and mute last while the app runs, from one file to the next.
let volume = 1;
let muted = false;

export class MediaViewer {
  #api;
  #note;
  #section;
  #nearby;
  #onClose;

  #file = null; // { brandId, rel, name, kind, size, mtime } on screen, or null
  #el = null; // the one media element, or null
  #large = false;
  #returnFocus = null;
  #parts = null; // the pieces of the view on screen that change while it plays
  #dragging = false; // the position slider is held

  /**
   * @param {object} deps
   * @param {HTMLElement} deps.section  where it is drawn (the preview area)
   * @param {(file: object, by: number) => object | null} deps.nearby  the media file `by` rows away in the same folder
   * @param {() => void} deps.onClose   the close button
   */
  constructor({ api, note, section, nearby, onClose }) {
    this.#api = api;
    this.#note = note;
    this.#section = section;
    this.#nearby = nearby;
    this.#onClose = onClose;
    document.addEventListener('keydown', (e) => this.#onKey(e));
  }

  /** The file on screen, or null. */
  get file() {
    return this.#file;
  }

  /**
   * Show a media file (an entry of the file listing, with its brand), in the
   * view that is open: stepping through a folder stays in the large view.
   * The same file again changes nothing.
   */
  show({ brandId, rel, name, kind, size, mtime }) {
    const shown = this.#file;
    if (this.#el && shown && shown.brandId === brandId && shown.rel === rel && shown.size === size && shown.mtime === mtime) return;
    this.#drop();
    this.#file = { brandId, rel, name, kind, size, mtime };
    this.#render();
  }

  /** Stop and let go of everything: the element, its decoder and its stream. Leaves the large view. */
  release() {
    this.#drop();
    this.#file = null;
    this.#parts = null;
    this.setLarge(false);
  }

  /** Over the page area (true) or back in the panel. */
  setLarge(on) {
    const large = Boolean(on) && this.#file !== null;
    if (large === this.#large) return;
    this.#large = large;
    if (large) this.#returnFocus = document.activeElement;
    this.#section.classList.toggle('is-large', large);
    cover(this.#api, this, large);
    if (this.#file && this.#parts) {
      const head = this.#head();
      this.#parts.head.replaceWith(head);
      this.#parts.head = head;
    }
    if (large) this.#parts?.stage.focus();
    else if (this.#returnFocus?.isConnected) this.#returnFocus.focus();
  }

  // ---------------------------------------------------------------- drawing

  #render() {
    const file = this.#file;
    const section = this.#section;
    section.dataset.rel = file.rel;
    section.dataset.view = file.kind;
    section.classList.add('is-media');

    const el = this.#create(file);
    this.#el = el;
    const stage = h('div', {
      class: `media-stage is-${file.kind}`,
      tabIndex: 0,
      title: file.kind === 'image' ? 'Double-click for the larger view' : 'Click to play or pause. Double-click for the larger view.',
      onclick: () => this.#toggle(),
      ondblclick: () => this.setLarge(!this.#large),
      ondragstart: (e) => e.preventDefault(), // the picture is not something to drag out
    }, file.kind === 'audio' ? icon('audio') : null, el);
    this.#parts = { stage, facts: h('p', { class: 'media-facts' }, formatSize(file.size)) };
    this.#parts.head = this.#head();
    section.replaceChildren(this.#parts.head, this.#parts.facts, stage, file.kind === 'image' ? null : this.#controls());
    section.hidden = false;
    if (this.#large) stage.focus();
  }

  #head() {
    const large = this.#large;
    return h('header', { class: 'preview-head' },
      h('span', { class: 'preview-name', title: this.#file.rel }, this.#file.name),
      h('span', { class: 'grow' }),
      large ? h('span', { class: 'media-keys' }, '← → other files in this folder') : null,
      large
        ? h('button', { class: 'media-back', dataset: { act: 'small' }, title: 'Back to the pages (Esc)', onclick: () => this.setLarge(false) },
          'Back to the pages')
        : this.#el // nothing to enlarge once a file has failed
          ? h('button', { class: 'tool', dataset: { act: 'large' }, title: 'Larger view, over the pages', 'aria-label': 'Larger view',
            onclick: () => this.setLarge(true) }, icon('expand'))
          : null,
      h('button', { class: 'tool', dataset: { act: 'close' }, title: 'Close', 'aria-label': 'Close', onclick: () => this.#onClose() },
        icon('close')));
  }

  /** The one media element. Listeners come before the address, so no event is missed. */
  #create(file) {
    const src = mediaUrl(file.brandId, file.rel);
    if (file.kind === 'image') {
      return h('img', {
        class: 'media-picture',
        alt: file.name,
        decoding: 'async', // decoded off the main thread, at the size it is drawn where the format allows
        onload: (e) => this.#loaded(e.target),
        onerror: (e) => this.#failed(e.target),
        src,
      });
    }
    const on = (fn) => (e) => { if (e.target === this.#el) fn(e.target); };
    return h(file.kind, {
      class: 'media-picture',
      preload: 'metadata', // the first picture and the facts; the rest only once play is pressed
      ...(file.kind === 'video' ? { disablePictureInPicture: true, disableRemotePlayback: true } : {}),
      volume,
      muted,
      onloadedmetadata: on((el) => this.#loaded(el)),
      ondurationchange: on(() => this.#showTime()),
      ontimeupdate: on(() => this.#showTime()),
      onplay: on(() => this.#showPlaying()),
      onpause: on(() => this.#showPlaying()),
      onvolumechange: on((el) => this.#showVolume(el)),
      onerror: on((el) => this.#failed(el)),
      src,
    });
  }

  #controls() {
    const play = h('button', { class: 'tool', dataset: { act: 'play' }, onclick: () => this.#toggle() });
    const time = h('span', { class: 'media-time' });
    const seek = h('input', {
      type: 'range',
      class: 'media-seek',
      min: 0,
      max: 0,
      step: 'any',
      disabled: true,
      'aria-label': 'Position',
      oninput: (e) => { if (this.#el) this.#el.currentTime = Number(e.target.value); },
      onpointerdown: () => { this.#dragging = true; },
      onpointerup: () => { this.#dragging = false; },
      onpointercancel: () => { this.#dragging = false; },
    });
    const mute = h('button', {
      class: 'tool',
      dataset: { act: 'mute' },
      onclick: () => { if (this.#el) this.#el.muted = !this.#el.muted; },
    });
    const level = h('input', {
      type: 'range',
      class: 'media-volume',
      min: 0,
      max: 1,
      step: 0.05,
      'aria-label': 'Volume',
      oninput: (e) => {
        if (!this.#el) return;
        this.#el.volume = Number(e.target.value);
        this.#el.muted = this.#el.volume === 0;
      },
    });
    Object.assign(this.#parts, { play, time, seek, mute, level });
    this.#showPlaying();
    this.#showTime();
    this.#showVolume(this.#el);
    return h('div', { class: 'media-controls' }, play, time, seek, mute, level);
  }

  // ------------------------------------------------------- what it reports

  #loaded(el) {
    if (el !== this.#el) return;
    const file = this.#file;
    const video = file.kind === 'video';
    // A video whose picture cannot be decoded can still have a sound track
    // that can: it would play as an empty box. Say so instead.
    if (video && !el.videoWidth) return this.#failed(el, 'Its picture is in a format fanout cannot show.');
    this.#parts.facts.textContent = mediaFacts({
      width: file.kind === 'image' ? el.naturalWidth : el.videoWidth,
      height: file.kind === 'image' ? el.naturalHeight : el.videoHeight,
      duration: file.kind === 'image' ? NaN : el.duration,
      size: file.size,
    });
    this.#section.dataset.ready = '1';
    this.#showTime();
  }

  /** The file cannot be shown: say so in words, offer the default app, and let go of the element. */
  #failed(el, why) {
    if (el !== this.#el) return;
    const file = this.#file;
    this.#drop();
    const stage = h('div', { class: 'media-stage is-problem' },
      h('div', { class: 'media-problem', role: 'status' },
        h('p', { class: 'media-problem-title' }, CANNOT[file.kind]),
        h('p', { class: 'quiet' }, why ?? WHY[file.kind]),
        h('button', { class: 'primary', dataset: { act: 'open' }, onclick: () => this.#openOutside() }, 'Open in the default app')));
    this.#section.querySelector('.media-controls')?.remove();
    this.#parts.stage.replaceWith(stage);
    const head = this.#head();
    this.#parts.head.replaceWith(head);
    this.#parts = { head, facts: this.#parts.facts, stage };
    this.#parts.facts.textContent = formatSize(file.size);
    this.#section.dataset.ready = 'failed';
  }

  async #openOutside() {
    const file = this.#file;
    if (!file) return;
    const result = await this.#api.openFile(file.brandId, file.rel);
    if (result?.error) this.#note(`${file.name} could not be opened.`);
  }

  #showPlaying() {
    const { play } = this.#parts ?? {};
    if (!play) return;
    const playing = Boolean(this.#el) && !this.#el.paused && !this.#el.ended;
    play.replaceChildren(icon(playing ? 'pause' : 'play'));
    play.title = playing ? 'Pause (Space)' : 'Play (Space)';
    play.ariaLabel = playing ? 'Pause' : 'Play';
  }

  #showTime() {
    const { time, seek } = this.#parts ?? {};
    const el = this.#el;
    if (!time || !el) return;
    const length = Number.isFinite(el.duration) ? el.duration : 0;
    time.textContent = `${formatDuration(el.currentTime) || '0:00'} / ${formatDuration(length) || '0:00'}`;
    seek.max = String(length);
    seek.disabled = !length;
    if (!this.#dragging) seek.value = String(el.currentTime);
  }

  #showVolume(el) {
    const { mute, level } = this.#parts ?? {};
    if (!mute || !el) return;
    volume = el.volume;
    muted = el.muted;
    mute.replaceChildren(icon(muted || volume === 0 ? 'muted' : 'sound'));
    mute.title = muted ? 'Turn the sound on' : 'Mute';
    mute.ariaLabel = mute.title;
    mute.setAttribute('aria-pressed', String(muted));
    level.value = String(muted ? 0 : volume);
  }

  // ---------------------------------------------------------------- actions

  #toggle() {
    const el = this.#el;
    if (!el || this.#file.kind === 'image') return;
    if (el.paused || el.ended) el.play().catch(() => {}); // a failure arrives as an error event
    else el.pause();
  }

  /** Let go of the element: stop it, drop its source so the decoder and the stream end, take it out. */
  #drop() {
    const el = this.#el;
    this.#el = null;
    this.#dragging = false;
    delete this.#section.dataset.ready;
    if (!el) return;
    if (el.tagName !== 'IMG') {
      el.pause();
      el.removeAttribute('src');
      el.load();
    } else {
      el.removeAttribute('src');
    }
    el.remove();
  }

  #step(by) {
    const next = this.#file && this.#nearby(this.#file, by);
    if (next) this.show(next);
  }

  // Space plays and pauses wherever the viewer has the keyboard. In the large
  // view Esc goes back and the arrow keys step through the folder's media.
  #onKey(e) {
    if (!this.#file || e.defaultPrevented || e.ctrlKey || e.altKey || e.metaKey) return;
    if (!this.#large && !this.#section.contains(e.target)) return;
    if (document.querySelector('dialog[open]')) return; // a dialog takes its own keys
    const target = e.target instanceof Element ? e.target : null;
    if (target?.closest('textarea, [contenteditable], input:not([type="range"])')) return;
    const control = target?.closest('button, input'); // keeps its own Space and arrow keys
    if (e.key === 'Escape' && this.#large) {
      e.preventDefault();
      this.setLarge(false);
    } else if (e.key === ' ' && !control) {
      e.preventDefault();
      this.#toggle();
    } else if (this.#large && !control && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      this.#step(e.key === 'ArrowLeft' ? -1 : 1);
    }
  }
}
