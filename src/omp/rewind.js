/**
 * Rewinding an omp conversation to one of the user's prompts, as omp's `/branch` does: what
 * the rewind sets aside, and which of omp's entries the prompt is.
 *
 * The transcript keys messages by the ids omp's frames carry (`msg-N`), which are not the
 * entry ids `branch` takes; `get_branch_messages` lists the user messages of the conversation
 * with theirs, oldest first. A prompt is matched to its entry by its place among the user
 * messages counted from the end, and only if the texts agree: when they do not, this window
 * no longer shows the conversation omp has, and rewinding would cut it somewhere else.
 */
/** @import { Item } from './transcript.js' */

/**
 * Where rewinding to a prompt leaves the conversation: the prompt's text, its place among
 * the user messages counted from the end (0 for the last), and how many of the user's own
 * prompts the rewind sets aside, this one included.
 * @typedef {{ text: string, fromEnd: number, setAside: number }} RewindPoint
 */

/**
 * The rewind to the user's prompt `key`, or null when `key` is not one of the user's own
 * prompts (another agent's cannot be reworded from here).
 * @param {readonly Item[]} items @param {string} key @returns {RewindPoint | null}
 */
export function rewindPoint(items, key) {
  const users = items.filter((i) => i.kind === 'user');
  const at = users.findIndex((i) => i.key === key);
  const item = users[at];
  if (!item || item.byAgent) return null;
  return { text: item.text, fromEnd: users.length - 1 - at, setAside: users.slice(at).filter((i) => !i.byAgent).length };
}

/**
 * The key of the prompt `point` was taken from, in `items` as they are now: the transcript can
 * be replaced under a pending rewind (the conversation woke, or was rewound elsewhere), and the
 * prompt is found again by its place and text, or not at all.
 * @param {readonly Item[]} items @param {RewindPoint} point @returns {string | null}
 */
export function pointKey(items, point) {
  const users = items.filter((i) => i.kind === 'user');
  const item = users[users.length - 1 - point.fromEnd];
  return item?.kind === 'user' && !item.byAgent && item.text.trim() === point.text.trim() ? item.key : null;
}

/**
 * omp's entry id for `point` among the user messages omp lists, or null when its
 * conversation does not end the way the transcript's does.
 * @param {ReadonlyArray<{ entryId: string, text: string }>} listed @param {RewindPoint} point
 * @returns {string | null}
 */
export function branchEntry(listed, point) {
  const entry = listed[listed.length - 1 - point.fromEnd];
  return entry && entry.text.trim() === point.text.trim() ? entry.entryId : null;
}
