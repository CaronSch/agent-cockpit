import { test, describe } from 'bun:test';
import assert from 'node:assert/strict';
import { alertFor, alertText, watching } from '../src/sessions/notify.js';
/** @import { SessionEvent } from '../daemon/wire.js' */

/** @param {Record<string, unknown>} frame @returns {SessionEvent} */
const event = (frame) => ({ kind: 'frame', frame: /** @type {any} */ (frame), seq: 1, at: 0, session: 's1' });

const handedBack = event({ type: 'agent_end', messages: [], isTerminal: true, yielded: true });
const asked = event({
  type: 'extension_ui_request',
  id: 'ui-1',
  method: 'ask',
  questions: [{ id: 'db', question: 'Which database?', options: [{ label: 'Postgres' }] }],
});

describe('when an agent notifies its user', () => {
  test('when it hands the turn back, or stops to ask something', () => {
    assert.deepEqual(alertFor(handedBack, false), { kind: 'done', question: null });
    assert.deepEqual(alertFor(asked, false), { kind: 'asking', question: 'Which database?' });
    assert.deepEqual(alertFor(event({ type: 'extension_ui_request', id: 'ui-2', method: 'confirm', title: 'Run rm -rf build?' }), false), {
      kind: 'asking',
      question: 'Run rm -rf build?',
    });
  });

  test('never for the work in between, a passing notice, or the session starting', () => {
    for (const frame of [
      { type: 'agent_start' },
      { type: 'message_end', message: { role: 'assistant', content: [] } },
      { type: 'tool_execution_end', toolCallId: 't1' },
      { type: 'extension_ui_request', id: 'ui-3', method: 'notify', message: 'Saved' },
    ]) {
      assert.equal(alertFor(event(frame), false), null, String(frame.type));
    }
    assert.equal(alertFor({ kind: 'session', meta: /** @type {any} */ ({}), seq: 1, at: 0, session: 's1' }, false), null);
  });

  test('never for events the daemon replays on (re)connecting: they happened before the page heard of them', () => {
    assert.equal(alertFor(handedBack, true), null);
    assert.equal(alertFor(asked, true), null);
  });

  test('says what happened, with the question when there is one', () => {
    assert.equal(alertText({ kind: 'done', question: null }), 'Finished');
    assert.equal(alertText({ kind: 'asking', question: 'Which database?' }), 'Needs your input: Which database?');
    assert.equal(alertText({ kind: 'asking', question: null }), 'Needs your input');
  });

  test('not while the user looks at the session: this tab in front and focused, with a window showing it', () => {
    const shown = new Set(['s1']);
    assert.equal(watching({ visible: true, focused: true, shown }, 's1'), true);
    assert.equal(watching({ visible: true, focused: true, shown }, 's2'), false, 'another session in this tab');
    assert.equal(watching({ visible: false, focused: false, shown }, 's1'), false, 'a background tab');
    assert.equal(watching({ visible: true, focused: false, shown }, 's1'), false, 'another app in front');
  });
});
