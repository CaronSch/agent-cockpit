import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { computeDropZone, detectEdgeZone } from '../src/layout/drop-zone.js';

const rect = { x: 100, y: 100, w: 200, h: 100 };

describe('computeDropZone', () => {
  test('picks the nearest edge in normalized space', () => {
    assert.equal(computeDropZone(110, 150, rect), 'left');
    assert.equal(computeDropZone(290, 150, rect), 'right');
    assert.equal(computeDropZone(200, 105, rect), 'up');
    assert.equal(computeDropZone(200, 195, rect), 'down');
  });

  test('returns center inside the middle band', () => {
    assert.equal(computeDropZone(200, 150, rect), 'center');
  });

  test('never returns center when center drops are disallowed', () => {
    assert.equal(computeDropZone(200, 150, rect, { allowCenter: false }) !== 'center', true);
    assert.equal(computeDropZone(170, 150, rect, { allowCenter: false }), 'left');
  });
});

describe('detectEdgeZone', () => {
  const bounds = { x: 0, y: 0, w: 1000, h: 600 };

  test('detects root edges within the threshold', () => {
    assert.equal(detectEdgeZone(4, 300, bounds, 20), 'left');
    assert.equal(detectEdgeZone(996, 300, bounds, 20), 'right');
    assert.equal(detectEdgeZone(500, 2, bounds, 20), 'up');
    assert.equal(detectEdgeZone(500, 590, bounds, 20), 'down');
  });

  test('returns null away from edges or outside the grid', () => {
    assert.equal(detectEdgeZone(500, 300, bounds, 20), null);
    assert.equal(detectEdgeZone(-50, 300, bounds, 20), null);
  });
});
