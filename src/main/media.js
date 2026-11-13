// The media viewer's files: videos, pictures and sounds from a brand's folder,
// served to the interface at fanout-media://file/<brand id>/<relative path>.
//
// A video can be gigabytes, so nothing is read whole: each request is answered
// from an open file handle, a chunk at a time as the player pulls, and a byte
// range when the player asks for one (seeking). The same jail as the rest of
// the file panel applies (resolveInside plus the real-path check), only regular
// files of the media kinds are served, and text keeps going through the IPC
// call it always used. This is not a general file server.
//
// No Electron here, so `npm test` can call the handler with Node's own
// Request and Response. mediaprotocol.js connects it to the interface's session.

import fs from 'node:fs';
import { fileKind, realInside } from './files.js';

export const MEDIA_SCHEME = 'fanout-media';
const HOST = 'file';
const CHUNK = 64 * 1024; // bytes read from disk per pull
const MAX_RANGE_HEADER = 200; // a longer Range header is not one a player sends
export const MAX_OPEN = 32; // file handles open for responses at once; more is a runaway, not a viewer

/** Pages are never asked; only the interface (a file:// page) may load these. */
const INTERFACE_ORIGIN = 'file://';

const TYPES = {
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska',
  avi: 'video/x-msvideo', wmv: 'video/x-ms-wmv', mpg: 'video/mpeg', mpeg: 'video/mpeg', '3gp': 'video/3gpp',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', ogg: 'audio/ogg', opus: 'audio/ogg',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
  bmp: 'image/bmp', svg: 'image/svg+xml', heic: 'image/heic', heif: 'image/heif', tif: 'image/tiff', tiff: 'image/tiff',
};
const MEDIA_KINDS = new Set(['video', 'image', 'audio']);

/** The content type to serve a file with, or null when it is not a media file (text, folders, anything else). */
export function mediaType(name) {
  const base = String(name).split(/[\\/]/).pop();
  if (!MEDIA_KINDS.has(fileKind(base))) return null;
  return TYPES[base.slice(base.lastIndexOf('.') + 1).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * fanout-media://file/<brand id>/<relative path> -> { brandId, rel }, or null.
 * The interface writes the path as one encoded segment (src/renderer/viewer.js,
 * mediaUrl); segments are decoded one by one and joined, so it reads the same
 * if a URL parser split it. Whatever comes out still has to pass the jail.
 */
export function parseMediaUrl(address) {
  let url;
  try {
    url = new URL(address);
  } catch {
    return null;
  }
  if (url.protocol !== `${MEDIA_SCHEME}:` || url.host !== HOST) return null;
  const segments = url.pathname.split('/').slice(1); // the path starts with '/'
  if (segments.length < 2) return null;
  try {
    const [brandId, ...rest] = segments.map(decodeURIComponent);
    const rel = rest.join('/');
    if (!brandId || !rel || brandId.includes('/')) return null;
    return { brandId, rel };
  } catch {
    return null; // a broken %-escape
  }
}

/**
 * Which bytes of a file of `size` bytes to send for a Range header.
 * Returns { start, end, partial } (end inclusive), or null when the range
 * cannot be satisfied (answered 416). One range of bytes is understood; a
 * header that is missing, malformed, multi-part or too long is ignored and the
 * whole file is sent, which RFC 9110 allows and which is still streamed.
 */
export function parseRange(header, size) {
  const whole = { start: 0, end: size - 1, partial: false };
  if (typeof header !== 'string' || header.length > MAX_RANGE_HEADER) return whole;
  // The grammar has no spaces inside; with none allowed the match is linear.
  const match = /^bytes=([0-9]*)-([0-9]*)$/i.exec(header.trim());
  if (!match || (match[1] === '' && match[2] === '')) return whole;
  const [first, last] = [match[1], match[2]];

  if (first === '') {
    // "bytes=-N": the last N bytes (all of them when N is larger than the file).
    const count = Number(last);
    if (count === 0 || size === 0) return null;
    return { start: Number.isSafeInteger(count) ? Math.max(0, size - count) : 0, end: size - 1, partial: true };
  }
  const start = Number(first);
  if (!Number.isSafeInteger(start) || start >= size) return null;
  if (last === '') return { start, end: size - 1, partial: true };
  const end = Number(last);
  if (end < start) return whole; // not a valid range: ignored
  return { start, end: Math.min(end, size - 1), partial: true };
}

const answer = (status) => new Response(null, { status });

/**
 * Answers fanout-media requests. `folderOf(brandId)` gives a brand's folder, or
 * null. `openStreams` counts file handles held for responses still being read:
 * it goes back to 0 when the player is gone (the viewer test checks it).
 */
export class MediaServer {
  #folderOf;
  #open = new Set();
  /** Tests set an array here to see every request: { rel, range, status, start, end, bytes, closed }. */
  trace = null;

  /** @param {{ folderOf: (brandId: string) => string | null }} deps */
  constructor({ folderOf }) {
    this.#folderOf = folderOf;
  }

  get openStreams() {
    return this.#open.size;
  }

  /** @param {Request & { initiatorOrigin?: string }} request @returns {Promise<Response>} */
  async handle(request) {
    const entry = this.#note(request);
    const refuse = (status) => {
      if (entry) entry.status = status;
      return new Response(null, { status });
    };
    if (request.method !== 'GET' && request.method !== 'HEAD') return refuse(405);
    // Electron names the page that asked. Only the interface's session has this
    // handler at all; this keeps it so if something else ever shares that session.
    if (request.initiatorOrigin !== undefined && request.initiatorOrigin !== INTERFACE_ORIGIN) return refuse(403);
    const address = parseMediaUrl(request.url);
    if (!address) return refuse(400);
    if (entry) entry.rel = address.rel;
    const type = mediaType(address.rel);
    if (!type) return refuse(403);
    const folder = this.#folderOf(address.brandId);
    if (!folder) return refuse(404);
    if (this.#open.size >= MAX_OPEN) return refuse(503);

    let handle;
    let size;
    try {
      handle = await fs.promises.open(await realInside(folder, address.rel), 'r');
      const stat = await handle.stat();
      if (!stat.isFile()) throw Object.assign(new Error('not a file'), { code: 'EOUTSIDE' });
      size = stat.size;
    } catch (error) {
      await handle?.close().catch(() => {});
      // Outside the folder, or not a regular file (Windows refuses to open a folder: EISDIR).
      return refuse(error.code === 'EOUTSIDE' || error.code === 'EISDIR' ? 403 : 404);
    }

    const range = parseRange(request.headers.get('range'), size);
    if (!range) {
      await handle.close();
      if (entry) entry.status = 416;
      return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } });
    }
    const status = range.partial ? 206 : 200;
    if (entry) Object.assign(entry, { status, start: range.start, end: range.end });
    const headers = {
      'content-type': type,
      'content-length': String(range.end - range.start + 1),
      'accept-ranges': 'bytes',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    };
    if (range.partial) headers['content-range'] = `bytes ${range.start}-${range.end}/${size}`;
    if (request.method === 'HEAD' || range.end < range.start) {
      await handle.close();
      return new Response(null, { status, headers });
    }
    return new Response(this.#stream(handle, range, entry), { status, headers });
  }

  /**
   * The bytes start..end of an open file, read as the player pulls them. The
   * handle is closed when the last byte is sent, on a read error, and when the
   * player stops reading (Electron cancels the stream when the request is
   * dropped: the player was removed, or it seeks elsewhere).
   */
  #stream(handle, { start, end }, entry) {
    this.#open.add(handle);
    let position = start;
    let done = false;
    const finish = (why) => {
      if (done) return;
      done = true;
      this.#open.delete(handle);
      if (entry) entry.closed = why;
      handle.close().catch(() => {}); // waits for a read still under way
    };
    return new ReadableStream({
      pull: async (controller) => {
        const length = Math.min(CHUNK, end + 1 - position);
        if (length <= 0) {
          finish('end');
          return controller.close();
        }
        let bytesRead;
        const buffer = Buffer.allocUnsafe(length);
        try {
          ({ bytesRead } = await handle.read(buffer, 0, length, position));
        } catch (error) {
          if (done) return; // cancelled while reading
          finish('error');
          return controller.error(error);
        }
        if (done) return;
        if (bytesRead === 0) {
          // The file got shorter while it was being read.
          finish('end');
          return controller.close();
        }
        position += bytesRead;
        if (entry) entry.bytes += bytesRead;
        controller.enqueue(new Uint8Array(buffer.buffer, buffer.byteOffset, bytesRead));
      },
      cancel: () => finish('cancel'),
    });
  }

  #note(request) {
    if (!Array.isArray(this.trace)) return null;
    const entry = { url: request.url, rel: null, origin: request.initiatorOrigin, range: request.headers.get('range'),
      status: null, start: null, end: null, bytes: 0, closed: null };
    this.trace.push(entry);
    return entry;
  }
}
