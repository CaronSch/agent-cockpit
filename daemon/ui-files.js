/**
 * The files that make up the browser UI: which ones the daemon serves, and a version that
 * changes whenever any of them does, so an open page can tell it is running older code.
 *
 * The daemon reads these files from disk on every request, so they change under a running
 * daemon (a `git pull`) as well as across restarts; the version is computed when asked.
 */
import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';

/** Directories served under their own name, besides `index.html`. */
export const STATIC_DIRS = ['src', 'styles'];
export const INDEX_FILE = 'index.html';
/** The file types served, and so the only ones a version counts. */
export const CONTENT_TYPES = /** @type {Record<string, string>} */ ({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
});

/** @param {string} root @returns {Promise<string[]>} every served file, as absolute paths */
async function servedFiles(root) {
  const files = [join(root, INDEX_FILE)];
  for (const dir of STATIC_DIRS) {
    const entries = await readdir(join(root, dir), { recursive: true, withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isFile() && CONTENT_TYPES[extname(entry.name)]) files.push(join(entry.parentPath, entry.name));
    }
  }
  return files.sort();
}

/**
 * The UI version for the files under `root`: a hash of every served file's path and bytes.
 * Contents are re-read only when a file's size or modification time has changed.
 * @param {string} root
 */
export function createUiVersion(root) {
  let signature = '';
  let version = '';
  return {
    async current() {
      const files = await servedFiles(root);
      const stats = await Promise.all(files.map((file) => stat(file).catch(() => null)));
      const next = files.map((file, i) => `${file}\0${stats[i]?.size}\0${stats[i]?.mtimeMs}`).join('\n');
      if (next === signature) return version;
      const hash = createHash('sha256');
      for (const file of files) {
        const bytes = await readFile(file).catch(() => null);
        if (bytes) hash.update(`${relative(root, file)}\0${bytes.length}\0`).update(bytes);
      }
      signature = next;
      version = hash.digest('hex').slice(0, 16);
      return version;
    },
  };
}
