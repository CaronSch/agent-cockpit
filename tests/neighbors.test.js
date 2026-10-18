import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { findNeighbor } from '../src/layout/neighbors.js';

// a | c
//   | d  (d is taller, so a's center sits within d's band)
const rects = new Map([
  ['a', { x: 0, y: 0, w: 100, h: 300 }],
  ['c', { x: 108, y: 0, w: 100, h: 96 }],
  ['d', { x: 108, y: 104, w: 100, h: 196 }],
]);

describe('findNeighbor', () => {
  test('prefers the candidate aligned with the source center', () => {
    assert.equal(findNeighbor(rects, 'a', 'right'), 'd');
  });

  test('finds vertical neighbours', () => {
    assert.equal(findNeighbor(rects, 'd', 'up'), 'c');
    assert.equal(findNeighbor(rects, 'c', 'down'), 'd');
  });

  test('finds the leaf to the left', () => {
    assert.equal(findNeighbor(rects, 'c', 'left'), 'a');
  });

  test('returns null at the grid boundary or for unknown ids', () => {
    assert.equal(findNeighbor(rects, 'a', 'left'), null);
    assert.equal(findNeighbor(rects, 'zzz', 'left'), null);
  });
});
