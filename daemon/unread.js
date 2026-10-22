/**
 * Which omp conversations have news their user has not read: kept in one small file in the
 * state directory, so a mark outlives windows, browsers, daemon restarts and the session
 * itself (a stopped session is a past one, still unread).
 *
 * A conversation is named by omp's id for it (the journal header's `id`: PastSession `id`,
 * SessionMeta `ompId`), which archiving and resuming keep. Each unread one maps to the daemon
 * time it became unread: when its agent last waited on the user (`awaited`, see
 * src/omp/activity.js), or when the user marked it unread. Reading it up to a time (`read`)
 * clears the mark unless it became unread after that time, so a read sent from a window that
 * had not heard of newer news never clears it. Only unread conversations are stored.
 *
 * `<file>`: `{ version: 1, unread: { [id]: since } }`, written whole after every change
 * (write-then-rename, one write at a time). A file that cannot be read as one stops the
 * daemon from starting, naming the file, rather than being replaced.
 */
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { daemonNow } from './clock.js';

const VERSION = 1;

/** omp's conversation ids: uuids (fixtures use plain words); nothing that could be a path. */
export const OMP_ID = /^[\w.-]{1,128}$/;

/** When each unread conversation became unread, by omp id. @typedef {Readonly<Record<string, number>>} Unread */

/**
 * The mark after the agent waited on its user, or the user marked it, at `at`: unread since
 * the latest of those.
 * @param {Unread} unread @param {string} id @param {number} at @returns {Unread}
 */
export const markUnread = (unread, id, at) => ((unread[id] ?? -Infinity) >= at ? unread : { ...unread, [id]: at });

/**
 * The marks after the user read conversation `id` as it was at `at`: cleared, unless it
 * became unread after that.
 * @param {Unread} unread @param {string} id @param {number} at @returns {Unread}
 */
export function markRead(unread, id, at) {
  if (!(id in unread) || unread[id] > at) return unread;
  const rest = { ...unread };
  delete rest[id];
  return rest;
}

/** @param {any} data parsed untrusted JSON @returns {data is { version: 1, unread: Record<string, number> }} */
const isUnreadFile = (data) =>
  data?.version === VERSION &&
  data.unread !== null &&
  typeof data.unread === 'object' &&
  !Array.isArray(data.unread) &&
  Object.entries(data.unread).every(([id, at]) => OMP_ID.test(id) && Number.isFinite(at));

/**
 * Loads the marks kept in `file` (none if it does not exist yet).
 * @param {{ file: string, now?: () => number }} options
 */
export async function loadUnread({ file, now = daemonNow }) {
  /** @type {Unread} */
  let unread = {};
  const stored = Bun.file(file);
  if (await stored.exists()) {
    /** @type {any} */
    let data;
    try {
      data = JSON.parse(await stored.text());
    } catch {}
    if (!isUnreadFile(data)) throw new Error(`${file} is not an unread file this daemon can read; fix it or move it away`);
    unread = data.unread;
  }
  /** @type {Set<(unread: Unread) => void>} */
  const listeners = new Set();
  /** @type {Promise<unknown>} */
  let queue = Promise.resolve();
  let tmpSeq = 0;

  async function store() {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    // Write-then-rename: a crash mid-write leaves the old marks, never half of the new ones.
    const tmp = `${file}.${process.pid}.${++tmpSeq}.tmp`;
    await writeFile(tmp, `${JSON.stringify({ version: VERSION, unread }, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, file);
  }

  /** @param {Unread} next */
  function set(next) {
    if (next === unread) return queue;
    unread = next;
    for (const fn of listeners) fn(unread);
    // Each write stores the marks as they are when it runs, so the last one leaves the newest.
    queue = queue.then(store).catch((err) => console.error(`[daemon] could not save ${file}:`, err));
    return queue;
  }

  return {
    /** @returns {Unread} */
    all: () => unread,
    /** The agent of conversation `id` waited on its user at `at` (daemon time). @param {string} id @param {number} at */
    awaited: (id, at) => set(markUnread(unread, id, at)),
    /** The user marked conversation `id` unread, now. @param {string} id */
    unread: (id) => set(markUnread(unread, id, now())),
    /** The user read conversation `id` as it was at `at`. @param {string} id @param {number} at */
    read: (id, at) => set(markRead(unread, id, at)),
    /** Hears every change, with all the marks. @param {(unread: Unread) => void} fn */
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

/** @typedef {Awaited<ReturnType<typeof loadUnread>>} UnreadStore */
