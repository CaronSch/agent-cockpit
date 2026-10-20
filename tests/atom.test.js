import { test, describe } from 'bun:test';
import assert from 'node:assert/strict';
import { createAtom } from '../src/state/atom.js';

describe('createAtom', () => {
  test('get/set', () => {
    const a = createAtom(1);
    a.set(2);
    assert.equal(a.get(), 2);
  });

  test('notifies subscribers only on real changes and supports unsubscribe', () => {
    const a = createAtom('x');
    /** @type {string[]} */
    const seen = [];
    const off = a.subscribe((v) => seen.push(v));
    a.set('x');
    a.set('y');
    off();
    a.set('z');
    assert.deepEqual(seen, ['y']);
  });

  test('a throwing subscriber does not block other subscribers', () => {
    const a = createAtom(0);
    /** @type {number[]} */
    const seen = [];
    const originalError = console.error;
    console.error = () => {};
    try {
      a.subscribe(() => {
        throw new Error('boom');
      });
      a.subscribe((v) => seen.push(v));
      a.set(1);
    } finally {
      console.error = originalError;
    }
    assert.deepEqual(seen, [1]);
  });
});
