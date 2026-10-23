/**
 * When the daemon puts a session to sleep: ends its omp process, as nobody needs it running.
 * The conversation stays in its journal, every window keeps showing it, and the next message
 * wakes it (`omp --resume`), so asleep or awake is the daemon's business, not the user's.
 *
 * A session sleeps once it has been idle and unused for a while: no turn running, nothing
 * asked of its user, nothing queued, no background job running (ending omp would end it),
 * and no event or use (a window being read, see `POST /api/sessions/:id/seen`) for `after`
 * milliseconds. How it is doing is read from its events as every window reads them
 * (omp/transcript.js).
 */
/** @import { SessionMeta } from './wire.js' */
/** @import { Transcript } from '../src/omp/transcript.js' */

/** How long a session stays awake with nothing happening and nobody using it. */
export const SLEEP_AFTER_MS = 30 * 60_000;

/**
 * Whether a session goes to sleep now.
 * @param {{ meta: SessionMeta, transcript: Transcript, usedAt: number }} session `usedAt`: its
 *   newest event or use, in daemon time
 * @param {number} now @param {number} after
 */
export function sleepsNow({ meta, transcript, usedAt }, now, after) {
  if (meta.status !== 'ready') return false;
  const { streaming, dialogs, queue, jobs } = transcript;
  if (streaming || dialogs.length > 0 || jobs.size > 0 || queue.steering.length + queue.followUp.length > 0) return false;
  return now - usedAt >= after;
}
