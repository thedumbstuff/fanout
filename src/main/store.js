// A small JSON file kept in memory and written back a moment after it changes.
// Writes go to a temporary file first and are renamed into place, so a crash
// or power cut mid-write cannot leave half a file behind.

import fs from 'node:fs';
import path from 'node:path';

export class JsonStore {
  #file;
  #timer = null;
  #delayMs;
  #writing = Promise.resolve();

  /**
   * @param {string} file absolute path of the JSON file
   * @param {{ sanitize?: (raw: unknown) => any, delayMs?: number }} options
   *   `sanitize` turns whatever was on disk (or undefined) into valid data.
   */
  constructor(file, { sanitize = (raw) => raw ?? {}, delayMs = 400 } = {}) {
    this.#file = file;
    this.#delayMs = delayMs;
    this.data = sanitize(this.#read());
  }

  #read() {
    let raw;
    try {
      raw = fs.readFileSync(this.#file, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') console.error(`fanout: cannot read ${this.#file}:`, error.message);
      return undefined;
    }
    try {
      return JSON.parse(raw);
    } catch {
      // Keep the unreadable file for the owner instead of overwriting it.
      const aside = `${this.#file}.damaged-${Date.now()}`;
      try {
        fs.renameSync(this.#file, aside);
        console.error(`fanout: ${this.#file} was not valid JSON; moved to ${aside}`);
      } catch { /* nothing more to do */ }
      return undefined;
    }
  }

  /** Call after changing `data`. Many calls in a row become one write. */
  touch() {
    if (this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#writing = this.#writing.then(() => this.#writeAsync()).catch((error) => {
        console.error(`fanout: cannot save ${this.#file}:`, error.message);
      });
    }, this.#delayMs);
    this.#timer.unref?.();
  }

  async #writeAsync() {
    const tmp = `${this.#file}.tmp`;
    await fs.promises.mkdir(path.dirname(this.#file), { recursive: true });
    await fs.promises.writeFile(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    await fs.promises.rename(tmp, this.#file);
  }

  /** Write now, synchronously. For app quit, when there is no later. */
  flush() {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    try {
      const tmp = `${this.#file}.tmp`;
      fs.mkdirSync(path.dirname(this.#file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmp, this.#file);
    } catch (error) {
      console.error(`fanout: cannot save ${this.#file}:`, error.message);
    }
  }

  /** Resolves when every write asked for so far has finished. */
  settled() {
    return this.#writing;
  }
}
