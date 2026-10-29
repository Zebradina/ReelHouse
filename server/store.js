'use strict';

const fs = require('fs');
const path = require('path');

/**
 * A tiny JSON document store. Writes are atomic (temp file + rename) so a
 * crash mid-write cannot leave a truncated library behind.
 */
class Store {
  constructor(file, fallback = {}) {
    this.file = file;
    this.fallback = fallback;
    this.data = this.#read();
    this._timer = null;
  }

  #read() {
    try {
      if (fs.existsSync(this.file)) {
        return JSON.parse(fs.readFileSync(this.file, 'utf8'));
      }
    } catch (err) {
      console.error(`[store] could not read ${path.basename(this.file)}:`, err.message);
      try {
        fs.renameSync(this.file, `${this.file}.corrupt-${Date.now()}`);
      } catch {
        /* ignore */
      }
    }
    return structuredClone(this.fallback);
  }

  write() {
    const tmp = `${this.file}.tmp`;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file);
    return this;
  }

  /** Coalesce rapid writes (e.g. playback progress) into one disk write. */
  save(delay = 400) {
    if (this._timer) return this;
    this._timer = setTimeout(() => {
      this._timer = null;
      try {
        this.write();
      } catch (err) {
        console.error('[store] write failed:', err.message);
      }
    }, delay);
    if (this._timer.unref) this._timer.unref();
    return this;
  }

  flush() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    this.write();
  }
}

module.exports = { Store };
