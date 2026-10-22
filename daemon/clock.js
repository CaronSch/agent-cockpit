/**
 * The daemon's clock for the times it stamps on events and unread marks: Date.now, but never
 * the same value twice and never earlier than the last, so any two stamps are ordered, even
 * within one millisecond. Without that, a "mark as unread" stamped in the millisecond of the
 * news a window last saw would read as that news, and a read of it would clear the mark.
 * Bursts of events can run it a few milliseconds ahead of the wall clock; it waits for the
 * wall clock to catch up rather than going back.
 */
let last = 0;

/** @returns {number} */
export function daemonNow() {
  last = Math.max(Date.now(), last + 1);
  return last;
}
