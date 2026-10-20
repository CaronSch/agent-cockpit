/**
 * The daemon's access token: random, created once, kept owner-only in the state directory
 * so a browser stays signed in across daemon restarts.
 */
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
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
  await writeFile(file, `${token}\n`, { mode: 0o600 }); // not Bun.write: it ignores `mode`
  return token;
}
