/**
 * Which omp events mean the agent produced something for the user to read, or needs them:
 * what turns an omp window "unread".
 *
 * Counts: assistant and tool output (messages, tool progress), the agent handing control
 * back, dialogs and notifications, command output, warnings and errors. Does not count: the
 * echo of the user's own prompt, omp's own system messages (`custom` role), info notices
 * (omp mounts tools with those on every start), and bookkeeping (responses, state, queues).
 */
/** @import { SessionEvent } from '../../daemon/wire.js' */

const OUTPUT_ROLES = new Set(['assistant', 'toolResult']);
const TOOL_FRAMES = new Set(['tool_execution_start', 'tool_execution_update', 'tool_stream_update', 'tool_execution_end']);
const MESSAGE_FRAMES = new Set(['message_start', 'message_update', 'message_end']);
const ASKING = new Set(['select', 'confirm', 'input', 'editor', 'ask', 'notify']);

/** @param {SessionEvent} event */
export function isAgentActivity(event) {
  if (event.kind !== 'frame') return false;
  const frame = /** @type {Record<string, any>} */ (event.frame);
  if (MESSAGE_FRAMES.has(frame.type)) return OUTPUT_ROLES.has(frame.message?.role);
  if (TOOL_FRAMES.has(frame.type)) return true;
  switch (frame.type) {
    case 'agent_end':
    case 'command_output':
      return true;
    case 'extension_ui_request':
      return ASKING.has(frame.method);
    case 'notice':
      return frame.level !== 'info';
    default:
      return false;
  }
}
