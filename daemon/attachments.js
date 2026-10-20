/**
 * Files attached to omp prompts: stored where omp can read them, one folder per day, so a
 * prompt can mention them as `@"<path>"` and omp attaches them itself (images to the model,
 * text inlined; see omp's file mentions).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { safeAssetName } from './scratchpad.js';

/** @param {{ dir: string, now?: () => Date }} options */
export function createAttachments({ dir, now = () => new Date() }) {
  return {
    /**
     * Stores `bytes` under a unique name that keeps `name` recognisable; returns its path.
     * @param {string} name @param {Uint8Array} bytes
     */
    async save(name, bytes) {
      const day = join(dir, now().toISOString().slice(0, 10));
      await mkdir(day, { recursive: true, mode: 0o700 });
      const path = join(day, safeAssetName(name));
      await writeFile(path, bytes, { mode: 0o600, flag: 'wx' });
      return path;
    },
  };
}
