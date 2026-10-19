/**
 * Which omp events turn an omp window "unread": the agent's final response, when it hands
 * the turn back to the user, or a question it stops to ask them.
 *
 * Nothing in between counts (thinking, intermediate replies, tool runs, notices, command
 * output): the user only needs to come back when the agent is done or waiting on them.
 */
import { handsTurnBack } from './transcript.js';
/** @import { SessionEvent } from '../../daemon/wire.js' */

/** Dialogs that hold the agent until the user answers (not `notify`, a passing toast). */
const ASKING = new Set(['select', 'confirm', 'input', 'editor', 'ask']);

/** @param {SessionEvent} event */
export function awaitsUser(event) {
  if (event.kind !== 'frame') return false;
  const frame = /** @type {Record<string, any>} */ (event.frame);
  if (frame.type === 'agent_end') return handsTurnBack(frame);
  return frame.type === 'extension_ui_request' && ASKING.has(frame.method);
}
