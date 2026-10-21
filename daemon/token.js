/**
 * The daemon's access token: random, created once, kept owner-only in the state directory
 * so a browser stays signed in across daemon restarts.
 */
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

/** @param {string} stateDir @returns {Promise<string>} */
export async function loadToken(stateDir) {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const file = join(stateDir, 'token');
  const existing = await Bun.file(file).text().then((s) => s.trim(), () => '');
  if (TOKEN_PATTERN.test(existing)) {
    await chmod(file, 0o600);
    return existing;
  }
  const token = randomBytes(32).toString('hex');
  // A file's mode is set only when it is created, so the token goes into a new file that
  // replaces any unusable one (whatever that one's mode). writeFile, since Bun.write
  // ignores `mode`.
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${token}\n`, { mode: 0o600 });
  await rename(tmp, file);
  return token;
}
