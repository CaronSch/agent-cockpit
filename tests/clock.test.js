import { test, describe } from 'bun:test';
import assert from 'node:assert/strict';
import { daemonNow } from '../daemon/clock.js';

describe('daemon clock', () => {
  test('stamps never repeat or go back, even many within one millisecond', () => {
    const stamps = Array.from({ length: 1000 }, daemonNow);
    assert.ok(stamps.every((t, i) => i === 0 || t > stamps[i - 1]));
    assert.ok(stamps[0] >= Date.now() - 1000, 'it follows the wall clock');
  });
});
