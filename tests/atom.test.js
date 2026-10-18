import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createAtom } from '../src/state/atom.js';

describe('createAtom', () => {
  test('get/set with value or updater', () => {
    const a = createAtom(1);
    a.set(2);
    a.set((v) => v + 1);
    assert.equal(a.get(), 3);
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

  test('lens reads and writes a key immutably', () => {
    const initial = { open: false, count: 0 };
    const a = createAtom(initial);
    const open = a.lens('open');
    /** @type {(boolean | undefined)[]} */
    const seen = [];
    open.subscribe((v) => seen.push(v));
    open.set(true);
    a.set((s) => ({ ...s, count: 1 }));
    assert.equal(open.get(), true);
    assert.deepEqual(initial, { open: false, count: 0 });
    assert.deepEqual(seen, [true], 'lens ignores unrelated key changes');
  });

  test('view derives values and skips duplicate emissions', () => {
    const a = createAtom(1);
    const parity = a.view((v) => (v % 2 === 0 ? 'even' : 'odd'));
    /** @type {string[]} */
    const seen = [];
    parity.subscribe((v) => seen.push(v));
    a.set(3);
    a.set(4);
    assert.equal(parity.get(), 'even');
    assert.deepEqual(seen, ['even']);
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
