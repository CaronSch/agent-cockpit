/**
 * Folder listings for the omp pane's `@` file mentions: each entry's name and whether it is a
 * folder (a link to one counts), capped so a huge folder cannot flood the page.
 */
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
/** @import { DirListing } from './wire.js' */

/** Past this many entries a listing is cut short (by name), and says so. */
export const MAX_ENTRIES = 5000;

/**
 * The entries of folder `dir`; throws when it is not a folder that can be read.
 * @param {string} dir @param {number} [max] @returns {Promise<Omit<DirListing, 'dir'>>}
 */
export async function listDirectory(dir, max = MAX_ENTRIES) {
  const all = await readdir(dir, { withFileTypes: true });
  all.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const entries = await Promise.all(
    all.slice(0, max).map(async (d) => ({
      name: d.name,
      isDir: d.isDirectory() || (d.isSymbolicLink() && Boolean((await stat(join(dir, d.name)).catch(() => null))?.isDirectory())),
    })),
  );
  return { entries, truncated: all.length > max };
}
