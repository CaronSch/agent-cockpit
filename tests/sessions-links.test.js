import { test, describe } from 'bun:test';
import assert from 'node:assert/strict';
import { sessionLinks } from '../src/sessions/links.js';
/** @import { Leaf, LeafParams } from '../src/layout/grid-model.js' */

/** @param {string} id @param {string} widget @param {LeafParams} [params] @returns {Leaf} */
const win = (id, widget, params) => ({ kind: 'leaf', id, widget, params });

describe('session links', () => {
  const windows = [win('w1', 'omp', { session: 's_a' }), win('w2', 'sessions'), win('w3', 'omp', { session: 's_b' }), win('w4', 'omp', { session: 's_a' })];

  test('lists the omp windows showing each session, in screen order', () => {
    const links = sessionLinks({ windows, used: {}, pointed: null });
    assert.deepEqual([...links.windows], [['s_a', ['w1', 'w4']], ['s_b', ['w3']]]);
  });

  test('the current session is the one in the omp window used last; the pointed one, in the window pointed at', () => {
    const links = sessionLinks({ windows, used: { omp: 'w3', sessions: 'w2' }, pointed: 'w4' });
    assert.equal(links.current, 's_b');
    assert.equal(links.pointed, 's_a');
  });

  test('a window that is not an omp window, or shows no session yet, links nothing', () => {
    const starting = [win('w1', 'omp', { session: null, resume: '/j.jsonl' }), win('w2', 'scratchpad', { session: 's_a' })];
    const links = sessionLinks({ windows: starting, used: { omp: 'w1' }, pointed: 'w2' });
    assert.equal(links.windows.size, 0);
    assert.equal(links.current, null);
    assert.equal(links.pointed, null);
  });
});
