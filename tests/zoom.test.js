import { test, describe } from 'bun:test';
import assert from 'node:assert/strict';
import { MAX_ZOOM, MIN_ZOOM, parseZoom, stepZoom } from '../src/ui/zoom.js';

describe('text size', () => {
  test('steps by 10%, without float noise, and stops at either end', () => {
    assert.equal(stepZoom(1, 1), 1.1);
    assert.equal(stepZoom(1.1, 1), 1.2);
    assert.equal(stepZoom(0.8, -1), 0.7);
    assert.equal(stepZoom(MIN_ZOOM, -1), MIN_ZOOM);
    assert.equal(stepZoom(MAX_ZOOM, 1), MAX_ZOOM);
  });

  test('a stored value is used only when it is a scale in range', () => {
    assert.equal(parseZoom('1.2'), 1.2);
    assert.equal(parseZoom(null), 1);
    assert.equal(parseZoom('huge'), 1);
    assert.equal(parseZoom('9'), 1);
    assert.equal(parseZoom(''), 1);
  });
});
