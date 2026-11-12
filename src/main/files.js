// The file panel's view of a brand's folder: list one directory at a time,
// read the start of a text file, and watch only the directories that are open
// on screen. Nothing here loads a whole tree or a whole large file.

import fs from 'node:fs';
import path from 'node:path';
import { resolveInside, isInside, OutsideFolderError } from './pathjail.js';

export const MAX_ENTRIES = 5000; // per directory
export const MAX_TEXT_BYTES = 512 * 1024; // of a text file shown in the preview
const MAX_WATCHED = 64;
const STAT_BATCH = 32;

const SYSTEM_FILES = new Set(['desktop.ini', 'thumbs.db', '$recycle.bin', 'system volume information']);

const KINDS = {
  text: ['txt', 'md', 'markdown', 'text', 'csv', 'tsv', 'json', 'srt', 'vtt', 'log', 'yml', 'yaml', 'xml', 'html', 'htm', 'ini'],
  video: ['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi', 'wmv', 'mpg', 'mpeg', '3gp'],
  image: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'bmp', 'tif', 'tiff', 'svg', 'avif'],
  audio: ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus'],
};
const KIND_BY_EXT = new Map(
  Object.entries(KINDS).flatMap(([kind, exts]) => exts.map((ext) => [ext, kind])),
);

/** 'text' | 'video' | 'image' | 'audio' | 'other', from the file name alone. */
export function fileKind(name) {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return 'other';
  return KIND_BY_EXT.get(name.slice(dot + 1).toLowerCase()) ?? 'other';
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/**
 * Like resolveInside, and also follows links on disk: a shortcut inside the
 * folder that points outside it is refused.
 */
export async function realInside(root, rel) {
  const abs = resolveInside(root, rel);
  const [realRoot, realAbs] = await Promise.all([
    fs.promises.realpath(root),
    fs.promises.realpath(abs),
  ]);
  if (!isInside(realRoot, realAbs)) throw new OutsideFolderError(rel);
  return abs;
}

/**
 * The entries of one directory, folders first, names in natural order.
 * @returns {Promise<{entries: Array<{name: string, rel: string, dir: boolean,
 *   size: number, mtime: number, kind: string}>, truncated: boolean}>}
 */
export async function listDir(root, rel = '') {
  const abs = await realInside(root, rel);
  const found = [];
  let truncated = false;

  for await (const entry of await fs.promises.opendir(abs)) {
    if (entry.name.startsWith('.') || SYSTEM_FILES.has(entry.name.toLowerCase())) continue;
    if (!entry.isDirectory() && !entry.isFile() && !entry.isSymbolicLink()) continue;
    if (found.length >= MAX_ENTRIES) {
      truncated = true;
      break; // leaving the loop closes the directory handle
    }
    found.push(entry.name);
  }

  const entries = [];
  for (let i = 0; i < found.length; i += STAT_BATCH) {
    const batch = found.slice(i, i + STAT_BATCH);
    const stats = await Promise.all(
      batch.map((name) => fs.promises.stat(path.join(abs, name)).catch(() => null)),
    );
    stats.forEach((stat, j) => {
      if (!stat) return; // vanished, or a link to nowhere
      const name = batch[j];
      const dir = stat.isDirectory();
      entries.push({
        name,
        rel: rel ? `${rel}/${name}` : name,
        dir,
        size: dir ? 0 : stat.size,
        mtime: stat.mtimeMs,
        kind: dir ? 'dir' : fileKind(name),
      });
    });
  }

  entries.sort((a, b) => (a.dir === b.dir ? collator.compare(a.name, b.name) : a.dir ? -1 : 1));
  return { entries, truncated };
}

/**
 * The text of a file for the preview, at most MAX_TEXT_BYTES of it.
 * @returns {Promise<{text: string, size: number, truncated: boolean, binary: boolean}>}
 */
export async function readText(root, rel) {
  const abs = await realInside(root, rel);
  const handle = await fs.promises.open(abs, 'r');
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, MAX_TEXT_BYTES);
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return { size, truncated: size > bytesRead, ...decode(buffer.subarray(0, bytesRead)) };
  } finally {
    await handle.close();
  }
}

/** Bytes -> text. Handles UTF-8 (with or without BOM) and Notepad's UTF-16. */
export function decode(bytes) {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), binary: false };
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: new TextDecoder('utf-16be').decode(bytes.subarray(2)), binary: false };
  }
  if (bytes.subarray(0, 8192).includes(0)) return { text: '', binary: true };
  // A cut in the middle of a character leaves one replacement mark at the end.
  const text = new TextDecoder('utf-8').decode(bytes).replace(/�+$/, '');
  return { text, binary: false };
}

/**
 * Watches the directories that are expanded in the file panel, and only
 * those. Each watcher is one OS handle; a change is reported once things have
 * been quiet for a moment, because copying a video fires hundreds of events.
 */
export class FolderWatcher {
  #watchers = new Map(); // absolute dir -> { watcher, timer }
  #onChange;
  #quietMs;

  /** @param {(brandId: string, rel: string) => void} onChange */
  constructor(onChange, { quietMs = 300 } = {}) {
    this.#onChange = onChange;
    this.#quietMs = quietMs;
  }

  /** Replace the watched set with these directories of one brand. */
  set(brandId, root, rels) {
    const wanted = new Map();
    for (const rel of rels.slice(0, MAX_WATCHED)) {
      try {
        wanted.set(resolveInside(root, rel), rel);
      } catch { /* not inside the folder: not watched */ }
    }
    for (const [abs, entry] of this.#watchers) {
      if (!wanted.has(abs)) this.#close(abs, entry);
    }
    for (const [abs, rel] of wanted) {
      if (!this.#watchers.has(abs)) this.#open(abs, brandId, rel);
    }
  }

  #open(abs, brandId, rel) {
    const entry = { watcher: null, timer: null };
    try {
      entry.watcher = fs.watch(abs, { persistent: false }, () => {
        clearTimeout(entry.timer);
        entry.timer = setTimeout(() => this.#onChange(brandId, rel), this.#quietMs);
      });
    } catch {
      return; // the directory is gone or unreadable
    }
    entry.watcher.on('error', () => this.#close(abs, entry));
    this.#watchers.set(abs, entry);
  }

  #close(abs, entry) {
    clearTimeout(entry.timer);
    try {
      entry.watcher.close();
    } catch { /* already closed */ }
    this.#watchers.delete(abs);
  }

  closeAll() {
    for (const [abs, entry] of this.#watchers) this.#close(abs, entry);
  }

  get size() {
    return this.#watchers.size;
  }
}
