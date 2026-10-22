import { test, describe } from 'bun:test';
import assert from 'node:assert/strict';
import { conversationOf } from '../daemon/conversation.js';

/** @param {Record<string, unknown>[]} entries */
const journal = (entries) => entries.map((e) => JSON.stringify(e)).join('\n');
const header = { type: 'session', version: 3, id: 'conv', timestamp: '2026-10-01T10:00:00.000Z', cwd: '/p' };
/** @param {string} id @param {string | null} parentId @param {string} role @param {string} text */
const message = (id, parentId, role, text) => ({ type: 'message', id, parentId, message: { role, content: [{ type: 'text', text }] } });
/** @param {ReturnType<typeof conversationOf>} c */
const texts = (c) => c?.messages.map((m) => `${m.role}: ${m.content?.[0]?.text ?? m.content}`);

describe('a conversation read from its journal', () => {
  test('is the path ending at the newest entry: a rewind leaves the old path out', () => {
    const c = conversationOf(
      '/j.jsonl',
      journal([
        { type: 'title', v: 1, title: '\u{F0001} Login fix' },
        header,
        { type: 'model_change', id: 'm', parentId: null, model: 'anthropic/claude-opus-5-5' },
        { type: 'thinking_level_change', id: 't', parentId: 'm', thinkingLevel: 'high' },
        message('u1', 't', 'user', 'fix the login bug'),
        message('a1', 'u1', 'assistant', 'fixed'),
        message('u2', 'a1', 'user', 'now add tests'),
        message('a2', 'u2', 'assistant', 'added'),
        // Rewound to before "now add tests", and asked again.
        message('u3', 'a1', 'user', 'now add docs'),
        { type: 'custom', id: 'x', parentId: 'u3', customType: 'session_exit' },
      ]),
    );
    assert.deepEqual(texts(c), ['user: fix the login bug', 'assistant: fixed', 'user: now add docs']);
    assert.deepEqual(
      { id: c?.id, cwd: c?.cwd, title: c?.title, model: c?.model, thinkingLevel: c?.thinkingLevel },
      { id: 'conv', cwd: '/p', title: 'Login fix', model: 'anthropic/claude-opus-5-5', thinkingLevel: 'high' },
    );
  });

  test('turns entries into messages as omp does: custom messages, summaries, and no useless tool results', () => {
    const c = conversationOf(
      '/j.jsonl',
      journal([
        header,
        message('u1', null, 'user', 'go'),
        { type: 'message', id: 'r1', parentId: 'u1', message: { role: 'toolResult', useless: true, content: [] } },
        { type: 'message', id: 'r2', parentId: 'r1', message: { role: 'toolResult', useless: true, isError: true, content: [{ type: 'text', text: 'boom' }] } },
        { type: 'custom_message', id: 'c1', parentId: 'r2', customType: 'async-result', content: 'done', display: true, timestamp: '2026-10-01T10:00:01.000Z' },
        { type: 'compaction', id: 'k1', parentId: 'c1', summary: 'so far', tokensBefore: 9, timestamp: '2026-10-01T10:00:02.000Z' },
      ]),
    );
    assert.deepEqual(texts(c), ['user: go', 'toolResult: boom', 'custom: done', 'compactionSummary: undefined']);
    assert.deepEqual(c?.messages[2], { role: 'custom', customType: 'async-result', content: 'done', display: true, details: undefined, attribution: undefined, timestamp: Date.parse('2026-10-01T10:00:01.000Z') });
    assert.equal(c?.messages[3].summary, 'so far');
  });

  test('a journal whose entries carry no ids is one path, in order; a torn last line is skipped', () => {
    const text = `${journal([header, { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }])}\n{"type":"mess`;
    assert.deepEqual(texts(conversationOf('/j.jsonl', text)), ['user: hi']);
  });

  test('without a session header there is no conversation', () => {
    assert.equal(conversationOf('/j.jsonl', journal([message('u1', null, 'user', 'hi')])), null);
  });
});
