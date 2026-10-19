import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isAgentActivity } from '../src/omp/activity.js';
/** @import { SessionEvent } from '../daemon/wire.js' */

/** @param {Record<string, unknown>} frame @returns {SessionEvent} */
const frame = (frame) => ({ kind: 'frame', frame, seq: 1, at: 1, session: 's' });

describe('what makes an omp window unread', () => {
  test('the agent writing, using tools, finishing, or asking something', () => {
    for (const f of [
      { type: 'message_update', message: { role: 'assistant' }, assistantMessageEvent: { type: 'text_delta' } },
      { type: 'message_end', message: { role: 'toolResult' } },
      { type: 'tool_execution_update', toolCallId: 't' },
      { type: 'agent_end', messages: [] },
      { type: 'extension_ui_request', id: 'u', method: 'ask' },
      { type: 'extension_ui_request', id: 'u', method: 'notify' },
      { type: 'command_output', text: 'done' },
      { type: 'notice', level: 'warning', message: 'rate limited' },
    ]) {
      assert.equal(isAgentActivity(frame(f)), true, f.type);
    }
  });

  test('not the user’s own prompt, omp’s system messages, info notices, or bookkeeping', () => {
    for (const f of [
      { type: 'message_start', message: { role: 'user' } },
      { type: 'message_end', message: { role: 'custom', customType: 'xdev-mount-notice' } },
      { type: 'notice', level: 'info', message: 'mounted tools' },
      { type: 'response', command: 'get_state', success: true },
      { type: 'queue_update' },
      { type: 'extension_ui_request', id: 'u', method: 'setStatus' },
      { type: 'agent_start' },
    ]) {
      assert.equal(isAgentActivity(frame(f)), false, f.type);
    }
    assert.equal(isAgentActivity({ kind: 'stderr', line: 'boom', seq: 1, at: 1, session: 's' }), false);
  });
});
