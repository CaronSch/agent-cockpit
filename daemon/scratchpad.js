/**
 * The shared scratchpad: one plain-text file the daemon keeps for every Scratchpad window.
 *
 * A version (`rev`) is a hash of the text, not a counter, so it survives daemon restarts and
 * notices edits made to the file outside the workbench (an editor, an agent) without
 * watching it. A write names the version it was edited from; if the file has moved on since,
 * the write is refused with what is there now, and the window decides. Writes are serialized,
 * so two saves cannot both pass the check before either lands.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
/** @import { Scratchpad } from './wire.js' */

/** @param {string} text */
export const revOf = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16);

/**
 * @param {{ file: string }} options
 */
export function createScratchpad({ file }) {
  /** @type {Set<(pad: Scratchpad) => void>} */
  const listeners = new Set();
  /** @type {Promise<unknown>} */
  let queue = Promise.resolve();
  let tmpSeq = 0;

  /** @returns {Promise<Scratchpad>} */
  async function read() {
    const text = await readFile(file, 'utf8').catch((/** @type {NodeJS.ErrnoException} */ err) => {
      if (err.code === 'ENOENT') return '';
      throw err;
    });
    return { text, rev: revOf(text) };
  }

  /**
   * @param {string} text @param {string} base the rev this text was edited from
   * @returns {Promise<{ ok: true, rev: string } | { ok: false, current: Scratchpad }>}
   */
  async function write(text, base) {
    const current = await read();
    if (current.rev !== base) return { ok: false, current };
    const rev = revOf(text);
    if (rev === current.rev) return { ok: true, rev };
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    // Write-then-rename: a crash mid-write leaves the old notes, never half of the new ones.
    const tmp = `${file}.${process.pid}.${++tmpSeq}.tmp`;
    await writeFile(tmp, text, { mode: 0o600 });
    await rename(tmp, file);
    for (const fn of listeners) fn({ text, rev });
    return { ok: true, rev };
  }

  return {
    file,
    read,
    /** @param {string} text @param {string} base */
    write(text, base) {
      const result = queue.then(() => write(text, base));
      queue = result.catch(() => {});
      return result;
    },
    /** Called after each change this daemon writes. @param {(pad: Scratchpad) => void} fn */
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
