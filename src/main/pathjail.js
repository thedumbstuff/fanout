// Every file request from the interface names a brand and a path relative to
// that brand's folder. Nothing outside the folder may be reached, however the
// relative path is spelled.

import nodePath from 'node:path';

export class OutsideFolderError extends Error {
  constructor(rel) {
    super(`"${rel}" is outside the brand's folder`);
    this.name = 'OutsideFolderError';
    this.code = 'EOUTSIDE';
  }
}

/**
 * Resolve `rel` under `root` and return the absolute path, or throw
 * OutsideFolderError. `rel` uses forward slashes; '' is the root itself.
 * `p` is injectable so both path flavours can be tested on one machine.
 */
export function resolveInside(root, rel, p = nodePath) {
  if (typeof root !== 'string' || !root || !p.isAbsolute(root)) {
    throw new OutsideFolderError(String(rel));
  }
  if (typeof rel !== 'string' || rel.includes('\0')) {
    throw new OutsideFolderError(String(rel));
  }
  const base = p.resolve(root);
  const abs = p.resolve(base, rel);
  if (!isInside(base, abs, p)) throw new OutsideFolderError(rel);
  return abs;
}

/** True when `abs` is `base` or lies beneath it. Both must be absolute. */
export function isInside(base, abs, p = nodePath) {
  const back = p.relative(base, abs);
  if (back === '') return true;
  if (p.isAbsolute(back)) return false; // another drive on Windows
  return back !== '..' && !back.startsWith('..' + p.sep);
}

/** Absolute path -> the forward-slash relative path the interface uses. */
export function toRel(root, abs, p = nodePath) {
  return p.relative(p.resolve(root), abs).split(p.sep).join('/');
}
