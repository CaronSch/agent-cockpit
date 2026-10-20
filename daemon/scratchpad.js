/**
 * Scratchpads: plain Markdown files the daemon keeps, one per pad, with pasted screenshots and
 * files stored beside them.
 *
 * Layout under `dir`: `<id>.md` holds a pad's text; `<id>.assets/<name>` holds the files it
 * shows, referenced from the text as ordinary Markdown (`![name](<id>.assets/<name>)`), so a
 * pad opened in any editor still makes sense. A pad's title is its first line of text.
 *
 * A version (`rev`) is a hash of the text, not a counter, so it survives daemon restarts and
 * notices edits made to the file outside the workbench (an editor, an agent) without
 * watching it. A write names the version it was edited from; if the file has moved on since,
 * the write is refused with what is there now, and the window decides. Writes are serialized,
 * so two saves cannot both pass the check before either lands.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
// Pure and shared with the browser, so a pad has one title, and one set of ids and file rules, wherever it is used.
import { ASSET_NAME, IMAGE_TYPES, LEGACY_PAD, PAD_ID, titleOf } from '../src/scratchpad/blocks.js';
/** @import { Scratchpad, ScratchpadSummary } from './wire.js' */


/** @param {string} text */
export const revOf = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16);

/** A file name safe to store, kept recognisable. @param {string} name */
export function safeAssetName(name) {
  const base = name.split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(-100);
  return `${Date.now().toString(36)}${randomBytes(2).toString('hex')}-${cleaned || 'file'}`;
}

/**
 * Moves the single `scratchpad.md` of earlier versions into `dir` as pad `scratchpad`, which
 * windows from before multiple pads existed still show.
 * @param {string} legacyFile @param {string} dir
 */
export async function adoptLegacyScratchpad(legacyFile, dir) {
  const target = join(dir, `${LEGACY_PAD}.md`);
  if (!(await Bun.file(legacyFile).exists()) || (await Bun.file(target).exists())) return false;
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await rename(legacyFile, target);
  return true;
}

/** @param {{ dir: string }} options */
export function createScratchpads({ dir }) {
  /** @type {Set<(id: string, pad: Scratchpad) => void>} */
  const listeners = new Set();
  /** @type {Promise<unknown>} */
  let queue = Promise.resolve();
  let tmpSeq = 0;

  /** @param {string} id */
  const fileOf = (id) => {
    if (!PAD_ID.test(id)) throw new RangeError(`not a scratchpad id: ${id}`);
    return join(dir, `${id}.md`);
  };
  /** @param {string} id */
  const assetsOf = (id) => join(dir, `${id}.assets`);

  /** Runs `fn` after every earlier change has landed. @template T @param {() => Promise<T>} fn */
  function serialized(fn) {
    const result = queue.then(fn);
    queue = result.catch(() => {});
    return result;
  }

  /** @param {string} id @param {Scratchpad} pad */
  const announce = (id, pad) => {
    for (const fn of listeners) fn(id, pad);
  };

  /** @param {string} id @returns {Promise<Scratchpad>} */
  async function read(id) {
    const file = Bun.file(fileOf(id));
    const text = (await file.exists()) ? await file.text() : '';
    return { text, rev: revOf(text) };
  }

  /**
   * @param {string} id @param {string} text @param {string} base the rev this text was edited from
   * @returns {Promise<{ ok: true, rev: string } | { ok: false, current: Scratchpad }>}
   */
  async function write(id, text, base) {
    const file = fileOf(id);
    const current = await read(id);
    if (current.rev !== base) return { ok: false, current };
    const rev = revOf(text);
    if (rev === current.rev) return { ok: true, rev };
    await mkdir(dir, { recursive: true, mode: 0o700 });
    // Write-then-rename: a crash mid-write leaves the old notes, never half of the new ones.
    const tmp = `${file}.${process.pid}.${++tmpSeq}.tmp`;
    await writeFile(tmp, text, { mode: 0o600 });
    await rename(tmp, file);
    announce(id, { text, rev });
    return { ok: true, rev };
  }

  return {
    read,
    /** @param {string} id @param {string} text @param {string} base */
    write: (id, text, base) => serialized(() => write(id, text, base)),

    /** Every pad that has been written to, most recently changed first. @returns {Promise<ScratchpadSummary[]>} */
    async list() {
      const names = await readdir(dir).catch(() => /** @type {string[]} */ ([]));
      const pads = await Promise.all(
        names
          .filter((name) => name.endsWith('.md') && PAD_ID.test(name.slice(0, -3)))
          .map(async (name) => {
            const id = name.slice(0, -3);
            const file = Bun.file(join(dir, name));
            return { id, title: titleOf(await file.text()), modifiedAt: file.lastModified, size: file.size };
          }),
      );
      return pads.sort((a, b) => b.modifiedAt - a.modifiedAt);
    },

    /** Deletes a pad and its files; open windows see it emptied. @param {string} id */
    remove: (id) =>
      serialized(async () => {
        await rm(fileOf(id), { force: true });
        await rm(assetsOf(id), { recursive: true, force: true });
        announce(id, { text: '', rev: revOf('') });
      }),

    /**
     * Stores a file for pad `id` and returns the path its Markdown should use.
     * @param {string} id @param {string} name @param {Uint8Array} bytes
     */
    async saveAsset(id, name, bytes) {
      fileOf(id);
      const stored = safeAssetName(name);
      await mkdir(assetsOf(id), { recursive: true, mode: 0o700 });
      await writeFile(join(assetsOf(id), stored), bytes, { mode: 0o600, flag: 'wx' });
      return `${id}.assets/${stored}`;
    },

    /**
     * Where an asset lives and how to serve it, or null if the name is not one of ours.
     * @param {string} id @param {string} name
     * @returns {{ path: string, type: string, inline: boolean } | null}
     */
    asset(id, name) {
      if (!PAD_ID.test(id) || !ASSET_NAME.test(name)) return null;
      const type = IMAGE_TYPES[extname(name).toLowerCase()];
      return { path: join(assetsOf(id), name), type: type ?? 'application/octet-stream', inline: Boolean(type) };
    },

    /** Called after each change this daemon makes. @param {(id: string, pad: Scratchpad) => void} fn */
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
