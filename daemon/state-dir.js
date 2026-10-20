/**
 * Moves the state folder from its pre-rename home (`~/.agent-cockpit`) to `~/.cockpit`.
 *
 * The project was called agent-cockpit until 2026-10-20. Remove this once no
 * install can still have the old folder.
 */
import { rename, stat } from 'node:fs/promises';

/**
 * Renames `legacyDir` to `dir` when only the legacy folder exists. Never merges or
 * overwrites: if both exist, both are left alone and `dir` is used.
 * @param {string} legacyDir @param {string} dir
 * @returns {Promise<boolean>} whether the folder was moved
 */
export async function adoptLegacyStateDir(legacyDir, dir) {
  const [from, to] = await Promise.all([stat(legacyDir).catch(() => null), stat(dir).catch(() => null)]);
  if (!from?.isDirectory() || to) return false;
  await rename(legacyDir, dir);
  return true;
}
