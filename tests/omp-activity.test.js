import { test, describe } from 'bun:test';
import assert from 'node:assert/strict';
import { awaitedAfter, awaitsUser } from '../src/omp/activity.js';
/** @import { SessionEvent } from '../daemon/wire.js' */

/** @param {Record<string, unknown>} frame @returns {SessionEvent} */
const frame = (frame) => ({ kind: 'frame', frame, seq: 1, at: 1, session: 's' });

describe('what makes an agent window unread', () => {
  test('the agent handing the turn back, or stopping to ask something', () => {
    for (const f of [
      { type: 'agent_end', messages: [], isTerminal: true, yielded: true },
      { type: 'agent_end', messages: [], isTerminal: true }, // older omp: no `yielded`
      { type: 'extension_ui_request', id: 'u', method: 'ask' },
      { type: 'extension_ui_request', id: 'u', method: 'confirm' },
    ]) {
      assert.equal(awaitsUser(frame(f)), true, JSON.stringify(f));
    }
  });

  test('nothing from the middle of a turn: thinking, intermediate replies, tools, notices, output', () => {
    for (const f of [
      { type: 'message_update', message: { role: 'assistant' }, assistantMessageEvent: { type: 'thinking_delta' } },
      { type: 'message_end', message: { role: 'assistant', stopReason: 'toolUse' } },
      { type: 'tool_execution_update', toolCallId: 't' },
      { type: 'message_end', message: { role: 'toolResult' } },
      { type: 'agent_end', messages: [], isTerminal: false, yielded: false }, // the agent carries on
      { type: 'extension_ui_request', id: 'u', method: 'notify' },
      { type: 'notice', level: 'warning', message: 'rate limited' },
      { type: 'command_output', text: 'Session renamed to Fix the login flow.' },
      { type: 'message_start', message: { role: 'user' } },
    ]) {
      assert.equal(awaitsUser(frame(f)), false, JSON.stringify(f));
    }
    assert.equal(awaitsUser({ kind: 'stderr', line: 'boom', seq: 1, at: 1, session: 's' }), false);
  });
});

describe('when a session last waited on its user', () => {
  test('moves to the newest event that awaits the user, in daemon time, and nothing else moves it', () => {
    const end = { type: 'agent_end', messages: [], isTerminal: true, yielded: true };
    const at = (/** @type {Record<string, unknown>} */ f, /** @type {number} */ t) => ({ ...frame(f), at: t });
    let awaited = 0;
    awaited = awaitedAfter(awaited, at({ type: 'agent_start' }, 5));
    assert.equal(awaited, 0);
    awaited = awaitedAfter(awaited, at(end, 10));
    assert.equal(awaited, 10);
    awaited = awaitedAfter(awaited, at({ type: 'message_update' }, 20));
    assert.equal(awaited, 10);
    awaited = awaitedAfter(awaited, at({ type: 'extension_ui_request', id: 'u', method: 'ask' }, 30));
    assert.equal(awaited, 30);
  });
});
