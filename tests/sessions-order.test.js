import { test, describe } from 'bun:test';
import assert from 'node:assert/strict';
import { naturalDir, openJournals, relativeTime, sortSessions } from '../src/sessions/order.js';
/** @import { PastSession, SessionMeta } from '../daemon/wire.js' */

/** @param {Partial<PastSession> & { id: string }} s @returns {PastSession} */
const session = (s) => ({
  file: `/s/${s.id}.jsonl`,
  title: null,
  cwd: null,
  createdAt: null,
  modifiedAt: 0,
  prompts: 1,
  firstPrompt: null,
  ...s,
});

const ids = (/** @type {PastSession[]} */ list) => list.map((s) => s.id);

describe('session ordering', () => {
  const list = [
    session({ id: 'a', cwd: '/w/beta', prompts: 3, modifiedAt: 100, createdAt: 10, title: 'item 10' }),
    session({ id: 'b', cwd: '/w/alpha', prompts: 3, modifiedAt: 300, createdAt: 30, firstPrompt: 'item 9' }),
    session({ id: 'c', cwd: '/w/alpha', prompts: 1, modifiedAt: 200, createdAt: 20, title: 'Item 2' }),
  ];

  test('each key sorts by what it names, in its natural direction', () => {
    assert.deepEqual(ids(sortSessions(list, 'active', naturalDir('active'))), ['b', 'c', 'a']);
    assert.deepEqual(ids(sortSessions(list, 'created', naturalDir('created'))), ['b', 'c', 'a']);
    // Untitled sessions sort by their first prompt; numbers compare as numbers, case is ignored.
    assert.deepEqual(ids(sortSessions(list, 'title', naturalDir('title'))), ['c', 'b', 'a']);
  });

  test('ties stay most-recently-active first whichever way the main key runs', () => {
    assert.deepEqual(ids(sortSessions(list, 'directory', 'asc')), ['b', 'c', 'a']);
    assert.deepEqual(ids(sortSessions(list, 'directory', 'desc')), ['a', 'b', 'c']);
    assert.deepEqual(ids(sortSessions(list, 'prompts', 'desc')), ['b', 'a', 'c']);
    assert.deepEqual(ids(sortSessions(list, 'prompts', 'asc')), ['c', 'b', 'a']);
  });

  test('a session without a creation time sorts by when it was last active', () => {
    const undated = session({ id: 'u', modifiedAt: 250 });
    assert.deepEqual(ids(sortSessions([...list, undated], 'created', 'desc')), ['u', 'b', 'c', 'a']);
  });

  test('sorting leaves the caller’s list alone', () => {
    const before = ids(list);
    sortSessions(list, 'title', 'asc');
    assert.deepEqual(ids(list), before);
  });

  test('relative times step from minutes to a date', () => {
    const now = Date.UTC(2026, 9, 10, 12);
    assert.equal(relativeTime(now - 20_000, now), 'just now');
    assert.equal(relativeTime(now - 5 * 60_000, now), '5m ago');
    assert.equal(relativeTime(now - 3 * 3_600_000, now), '3h ago');
    assert.equal(relativeTime(now - 2 * 86_400_000, now), '2d ago');
    assert.match(relativeTime(now - 30 * 86_400_000, now), /2026/);
    assert.equal(relativeTime(now + 5000, now), 'just now', 'clock skew is not "in the future"');
  });

  test('the journals of starting and running sessions are open; ended ones and unsaved ones are not', () => {
    /** @param {string} id @param {SessionMeta['status']} status @param {string | null} sessionFile @returns {SessionMeta} */
    const meta = (id, status, sessionFile) => ({ id, cwd: '/p', resume: null, fork: null, sessionFile, status, pid: null, exitCode: null, error: null, startedAt: 0 });
    const open = openJournals([meta('a', 'ready', '/s/a.jsonl'), meta('b', 'starting', '/s/b.jsonl'), meta('c', 'exited', '/s/c.jsonl'), meta('d', 'failed', '/s/d.jsonl'), meta('e', 'ready', null)]);
    assert.deepEqual([...open].sort(), ['/s/a.jsonl', '/s/b.jsonl']);
  });
});
