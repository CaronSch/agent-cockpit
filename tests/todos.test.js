import { test, describe } from 'bun:test';
import assert from 'node:assert/strict';
import { applyEvent, createTranscript } from '../src/omp/transcript.js';
import { todoPhases, todoProgress, turnProgress } from '../src/omp/todos.js';
/** @import { SessionEvent } from '../daemon/wire.js' */

let seq = 0;
/** @param {Record<string, any>} frame @returns {SessionEvent} */
const frame = (frame) => ({ kind: 'frame', frame, seq: ++seq, at: 0, session: 's1' });

/** @param {string} content @param {string} status */
const task = (content, status) => ({ content, status });

/**
 * The frames of one `todo` call's result, as omp sends it: the whole list in `details.phases`.
 * @param {any[]} tasks @param {{ op?: string, isError?: boolean }} [options]
 */
function todoResult(tasks, { op = 'done', isError = false } = {}) {
  const message = {
    role: 'toolResult',
    toolCallId: `t${++seq}`,
    toolName: 'todo',
    content: [{ type: 'text', text: 'ok' }],
    details: { op, phases: [{ name: 'Work', tasks }] },
    isError,
    timestamp: seq,
  };
  return [frame({ type: 'message_start', message, messageId: `m${seq}` }), frame({ type: 'message_end', message, messageId: `m${seq}` })];
}

/** @param {SessionEvent[]} events */
function run(events) {
  const state = createTranscript();
  for (const event of events) applyEvent(state, event);
  return state;
}

describe('progress from the agent’s todo list', () => {
  test('counts done tasks out of those still meant to be done, and names the one in progress', () => {
    const progress = todoProgress([
      { name: 'A', tasks: [task('read', 'completed'), task('plan', 'abandoned'), task('edit', 'in_progress')] },
      { name: 'B', tasks: [task('test', 'pending'), task('ship', 'blocked'), task('later', 'some-new-status')] },
    ]);
    assert.deepEqual(progress, { done: 1, total: 5, current: 'edit' });
    assert.equal(todoProgress([{ name: 'A', tasks: [task('x', 'abandoned')] }]), null, 'nothing left to do is no progress');
  });

  test('a list that is not one is ignored rather than half read', () => {
    assert.equal(todoPhases([{ name: 'A', tasks: [{ content: 1, status: 'pending' }] }]), null);
    assert.equal(todoPhases({ phases: [] }), null);
    assert.deepEqual(todoPhases([{ name: 'A', tasks: [{ content: 'x', status: 'pending', notes: ['n'] }] }]), [{ name: 'A', tasks: [task('x', 'pending')] }]);
  });

  test('a todo result during a turn shows its progress; a view or a failed call leaves it as it was', () => {
    const state = run([frame({ type: 'agent_start' }), ...todoResult([task('a', 'completed'), task('b', 'in_progress'), task('c', 'pending')])]);
    assert.deepEqual(turnProgress(state), { done: 1, total: 3, current: 'b' });
    for (const event of todoResult([task('a', 'pending')], { op: 'view' })) applyEvent(state, event);
    for (const event of todoResult([task('a', 'pending')], { isError: true })) applyEvent(state, event);
    assert.deepEqual(turnProgress(state), { done: 1, total: 3, current: 'b' });
    // Finding more work drops the share done.
    for (const event of todoResult([task('a', 'completed'), task('b', 'completed'), task('c', 'in_progress'), task('d', 'pending'), task('e', 'pending')])) applyEvent(state, event);
    assert.deepEqual(turnProgress(state), { done: 2, total: 5, current: 'c' });
    applyEvent(state, frame({ type: 'agent_end', messages: [], yielded: true }));
    assert.equal(turnProgress(state), null, 'no turn, no progress');
  });

  test('a list finished in an earlier turn shows nothing in the next one until the agent updates it', () => {
    const done = [task('a', 'completed'), task('b', 'completed')];
    const state = run([frame({ type: 'agent_start' }), ...todoResult(done)]);
    assert.deepEqual(turnProgress(state), { done: 2, total: 2, current: null }, 'finishing it in this turn shows it full');
    applyEvent(state, frame({ type: 'agent_end', messages: [], yielded: true }));
    applyEvent(state, frame({ type: 'agent_start' }));
    assert.equal(turnProgress(state), null);
    for (const event of todoResult([task('c', 'in_progress')], { op: 'init' })) applyEvent(state, event);
    assert.deepEqual(turnProgress(state), { done: 0, total: 1, current: 'c' });
  });

  test('a list left unfinished carries into the next turn', () => {
    const state = run([frame({ type: 'agent_start' }), ...todoResult([task('a', 'completed'), task('b', 'pending')])]);
    applyEvent(state, frame({ type: 'agent_end', messages: [], yielded: true }));
    applyEvent(state, frame({ type: 'agent_start' }));
    assert.deepEqual(turnProgress(state), { done: 1, total: 2, current: null });
  });

  test('get_state’s list fills in a resumed session’s, and omp clearing it asks for get_state again', () => {
    const state = run([
      frame({ type: 'response', id: 'r1', command: 'get_state', success: true, data: { todoPhases: [{ name: 'W', tasks: [task('a', 'in_progress')] }] } }),
      frame({ type: 'agent_start' }),
    ]);
    assert.deepEqual(turnProgress(state), { done: 0, total: 1, current: 'a' });
    const before = state.refreshSeq;
    applyEvent(state, frame({ type: 'todo_auto_clear' }));
    assert.equal(state.refreshSeq, before + 1);
    assert.equal(state.items.length, 0, 'not an unrecognised frame');
  });
});
