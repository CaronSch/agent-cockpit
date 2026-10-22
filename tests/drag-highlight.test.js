import { test, describe } from 'bun:test';
import assert from 'node:assert/strict';
import { lineBoxes } from '../src/omp/drag-highlight.js';

/** @param {number} left @param {number} top @param {number} right @param {number} bottom */
const box = (left, top, right, bottom) => ({ left, top, right, bottom });

describe('lineBoxes', () => {
  test('a line’s boxes (plain, bold, code) merge into one box spanning them', () => {
    assert.deepEqual(lineBoxes([box(10, 0, 40, 18), box(40, 1, 70, 17), box(70, -1, 95, 19)]), [box(10, -1, 95, 19)]);
  });

  test('boxes on different lines stay apart, top to bottom', () => {
    assert.deepEqual(lineBoxes([box(0, 20, 30, 38), box(5, 0, 50, 18), box(0, 40, 10, 58)]), [box(5, 0, 50, 18), box(0, 20, 30, 38), box(0, 40, 10, 58)]);
  });

  test('empty boxes (an element’s edge, a collapsed space) are dropped', () => {
    assert.deepEqual(lineBoxes([box(10, 0, 10, 18), box(0, 0, 30, 0.2), box(20, 0, 30, 18)]), [box(20, 0, 30, 18)]);
  });
});
