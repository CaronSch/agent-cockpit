import { test, describe } from 'bun:test';
import assert from 'node:assert/strict';
import { sleepsNow } from '../daemon/sleep.js';
import { applyEvent, createTranscript } from '../src/omp/transcript.js';
/** @import { SessionMeta } from '../daemon/wire.js' */

/** @param {SessionMeta['status']} status @returns {SessionMeta} */
const meta = (status) => ({ id: 's', cwd: '/p', resume: null, fork: null, sessionFile: null, status, pid: 1, exitCode: null, error: null, startedAt: 0, ompId: null });

let seq = 0;
/** @param {ReturnType<typeof createTranscript>} transcript @param {Record<string, unknown>} frame */
const feed = (transcript, frame) => applyEvent(transcript, { kind: 'frame', frame, seq: ++seq, at: 0, session: 's' });

describe('a session goes to sleep', () => {
  test('once it has been idle and unused for the while given', () => {
    const transcript = createTranscript();
    assert.equal(sleepsNow({ meta: meta('ready'), transcript, usedAt: 100 }, 1099, 1000), false);
    assert.equal(sleepsNow({ meta: meta('ready'), transcript, usedAt: 100 }, 1100, 1000), true);
  });

  test('never while a turn runs, it asks its user something, messages wait or a job runs', () => {
    const working = createTranscript();
    feed(working, { type: 'agent_start' });
    assert.equal(sleepsNow({ meta: meta('ready'), transcript: working, usedAt: 0 }, 1e9, 1000), false);

    const asking = createTranscript();
    feed(asking, { type: 'extension_ui_request', id: 'u', method: 'ask', title: 'Which?' });
    assert.equal(sleepsNow({ meta: meta('ready'), transcript: asking, usedAt: 0 }, 1e9, 1000), false);

    const queued = createTranscript();
    feed(queued, { type: 'queue_update', steering: ['also this'], followUp: [] });
    assert.equal(queued.queue.steering.length, 1);
    assert.equal(sleepsNow({ meta: meta('ready'), transcript: queued, usedAt: 0 }, 1e9, 1000), false);

    const job = createTranscript();
    feed(job, { type: 'message_end', messageId: 'r', message: { role: 'toolResult', toolCallId: 'c', toolName: 'bash', content: [], details: { async: { state: 'running', jobId: 'bg_1', type: 'bash' } } } });
    assert.equal(sleepsNow({ meta: meta('ready'), transcript: job, usedAt: 0 }, 1e9, 1000), false, 'a background job runs');
  });

  test('only when it is up: one starting or already gone is left alone', () => {
    for (const status of /** @type {const} */ (['starting', 'exited', 'failed'])) {
      assert.equal(sleepsNow({ meta: meta(status), transcript: createTranscript(), usedAt: 0 }, 1e9, 1000), false);
    }
  });
});
