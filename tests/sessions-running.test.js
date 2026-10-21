import { test, describe } from 'bun:test';
import assert from 'node:assert/strict';
import { STATE_LABELS, follow, followedName, isRunning, noteEvent, runningSessions, runningState, showPast, showRunning } from '../src/sessions/running.js';
/** @import { SessionEvent, SessionMeta } from '../daemon/wire.js' */

/** @param {Partial<SessionMeta> & { id: string }} m @returns {SessionMeta} */
const meta = (m) => ({ cwd: '/p', resume: null, fork: null, sessionFile: null, status: 'ready', pid: 1, exitCode: null, error: null, startedAt: 0, ompId: 'o', ...m });

let seq = 0;
/** @param {Record<string, unknown>} frame @param {number} at @returns {SessionEvent} */
const frame = (frame, at) => ({ kind: 'frame', frame, seq: ++seq, at, session: 's' });

describe('running sessions', () => {
  test('are the starting and ready ones, newest first, narrowed to a directory when asked', () => {
    const metas = [
      meta({ id: 'old', startedAt: 1 }),
      meta({ id: 'gone', status: 'exited', startedAt: 9 }),
      meta({ id: 'new', startedAt: 5, status: 'starting', cwd: '/q' }),
      meta({ id: 'failed', status: 'failed', startedAt: 7 }),
    ];
    assert.deepEqual(runningSessions(metas, null).map((m) => m.id), ['new', 'old']);
    assert.deepEqual(runningSessions(metas, '/p').map((m) => m.id), ['old']);
    assert.equal(isRunning(meta({ id: 'x', status: 'exited' })), false);
  });

  test('are working during a turn, done once it ends unread, and idle once read', () => {
    const followed = follow();
    assert.equal(runningState(followed, meta({ id: 's', status: 'starting' }), false), 'starting');
    noteEvent(followed, frame({ type: 'agent_start' }, 10));
    assert.equal(runningState(followed, meta({ id: 's' }), false), 'working');
    assert.equal(runningState(followed, meta({ id: 's' }), true), 'working', 'marked unread mid-turn: still working');
    noteEvent(followed, frame({ type: 'agent_end', messages: [], isTerminal: true, yielded: true }, 20));
    assert.equal(runningState(followed, meta({ id: 's' }), true), 'done');
    assert.equal(STATE_LABELS.done, 'done');
    assert.equal(runningState(followed, meta({ id: 's' }), false), 'idle', 'read in some window');
  });

  test('a question asked mid-turn needs the user while the turn runs, read or not, until it is answered', () => {
    const followed = follow();
    noteEvent(followed, frame({ type: 'agent_start' }, 10));
    noteEvent(followed, frame({ type: 'extension_ui_request', id: 'u', method: 'ask', title: 'Which?' }, 12));
    assert.equal(runningState(followed, meta({ id: 's' }), true), 'asking');
    assert.equal(runningState(followed, meta({ id: 's' }), false), 'asking');
    assert.equal(STATE_LABELS.asking, 'needs you');
    noteEvent(followed, { kind: 'sent', command: { type: 'extension_ui_response', id: 'u', value: 'a' }, seq: ++seq, at: 13, session: 's' });
    assert.equal(runningState(followed, meta({ id: 's' }), false), 'working');
  });

  test('are named as an omp window names them: the first prompt until omp has a title', () => {
    const followed = follow();
    assert.equal(followedName(followed), null);
    noteEvent(followed, frame({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: 'fix the login bug' }] } }, 1));
    assert.equal(followedName(followed), 'fix the login bug');
  });

  test('are shown in an omp window by session, dropping whatever it was starting from', () => {
    assert.deepEqual(showRunning(meta({ id: 's1', sessionFile: '/j.jsonl' }), 'Login'), {
      session: 's1', cwd: '/p', sessionFile: '/j.jsonl', name: 'Login', resume: null, fork: null, prompt: null,
    });
  });
});

test('a past session is shown by resuming its journal', () => {
  const past = { file: '/j.jsonl', id: 'j', title: 'Login', cwd: '/p', createdAt: null, modifiedAt: 0, prompts: 1, firstPrompt: null };
  assert.deepEqual(showPast(past), { session: null, cwd: '/p', sessionFile: null, name: 'Login', resume: '/j.jsonl', fork: null, prompt: null });
});
