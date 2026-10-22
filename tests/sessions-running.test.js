import { test, describe } from 'bun:test';
import assert from 'node:assert/strict';
import { STATE_LABELS, conversationKey, follow, followedName, isRunning, listConversations, noteEvent, runningState, showConversation } from '../src/sessions/running.js';
/** @import { SessionEvent, SessionMeta } from '../daemon/wire.js' */

/** @param {Partial<SessionMeta> & { id: string }} m @returns {SessionMeta} */
const meta = (m) => ({ cwd: '/p', resume: null, fork: null, sessionFile: null, status: 'ready', pid: 1, exitCode: null, error: null, startedAt: 0, ompId: 'o', ...m });

let seq = 0;
/** @param {Record<string, unknown>} frame @param {number} at @returns {SessionEvent} */
const frame = (frame, at) => ({ kind: 'frame', frame, seq: ++seq, at, session: 's' });

/** @param {string} file @param {string} cwd @returns {import('../daemon/wire.js').PastSession} */
const journal = (file, cwd = '/p') => ({ file, id: file, title: null, cwd, createdAt: null, modifiedAt: 5, prompts: 1, firstPrompt: 'hi' });

describe('conversations', () => {
  test('are every journal, each with the awake session holding it, and the awake ones not written yet', () => {
    const metas = [
      meta({ id: 'holds', sessionFile: '/a.jsonl' }),
      meta({ id: 'asleep', status: 'exited', sessionFile: '/b.jsonl' }),
      meta({ id: 'new', status: 'starting', sessionFile: '/new.jsonl', cwd: '/q', startedAt: 9 }),
      meta({ id: 'failed', status: 'failed' }),
    ];
    const listed = listConversations([journal('/a.jsonl'), journal('/b.jsonl')], metas, { searching: false, directory: null });
    assert.deepEqual(
      listed.map((c) => [c.key, c.meta?.id ?? null]),
      [
        ['/a.jsonl', 'holds'],
        ['/b.jsonl', null],
        ['/new.jsonl', 'new'],
      ],
    );
    assert.equal(listed[2].modifiedAt, 9, 'a new one is as recent as its start');
    assert.equal(isRunning(meta({ id: 'x', status: 'exited' })), false);
  });

  test('searching lists only the journals that matched; a directory narrows them all', () => {
    const metas = [meta({ id: 'new', sessionFile: null, cwd: '/q' })];
    const past = [journal('/a.jsonl', '/p'), journal('/c.jsonl', '/q')];
    assert.deepEqual(listConversations(past, metas, { searching: true, directory: null }).map((c) => c.key), ['/a.jsonl', '/c.jsonl']);
    assert.deepEqual(listConversations(past, metas, { searching: false, directory: '/q' }).map((c) => c.key), ['/c.jsonl', 'new']);
  });

  test('are named by their journal, else a new one by its session', () => {
    assert.equal(conversationKey({ sessionFile: '/a.jsonl', session: 's' }), '/a.jsonl');
    assert.equal(conversationKey({ sessionFile: null, session: 's' }), 's');
  });

  test('awake, are working during a turn, done once it ends unread, and idle once read', () => {
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

  test('are shown in an omp window by journal, with the session holding it, dropping whatever it was starting from', () => {
    assert.deepEqual(showConversation({ file: '/j.jsonl', meta: meta({ id: 's1', sessionFile: '/j.jsonl' }), cwd: '/p', name: 'Login' }), {
      session: 's1', cwd: '/p', sessionFile: '/j.jsonl', name: 'Login', fork: null, prompt: null,
    });
    assert.deepEqual(showConversation({ file: '/j.jsonl', meta: null, cwd: '/p', name: null }), {
      session: null, cwd: '/p', sessionFile: '/j.jsonl', name: null, fork: null, prompt: null,
    });
  });
});
