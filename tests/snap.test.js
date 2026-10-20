import { test, describe } from 'bun:test';
import assert from 'node:assert/strict';
import { snapToCandidates, resolveSashPosition, sizesFromSash, sashCandidates } from '../src/layout/snap.js';

/** @import { SashGeometry } from '../src/layout/snap.js' */
/** @import { Sash } from '../src/layout/compute-layout.js' */

describe('sashCandidates', () => {
  test('combines aligned same-axis sashes with thirds and half of the pair', () => {
    /** @type {SashGeometry} */
    const sash = { axis: 'row', start: 0, end: 608, w: 8, h: 400, pos: 300 };
    /** @type {Pick<Sash, 'axis' | 'pos'>[]} */
    const others = [sash, { axis: 'row', pos: 450 }, { axis: 'col', pos: 200 }];
    assert.deepEqual(sashCandidates(sash, others), [450, 200, 300, 400]);
  });
});

describe('snapToCandidates', () => {
  test('snaps to the nearest candidate inside the threshold', () => {
    assert.deepEqual(snapToCandidates(103, [50, 100, 110], 8), { value: 100, snapped: 100 });
  });

  test('leaves the value alone when nothing is close', () => {
    assert.deepEqual(snapToCandidates(130, [100, 160], 8), { value: 130, snapped: null });
  });
});

describe('resolveSashPosition', () => {
  const base = { start: 0, end: 1000, gap: 8, minBefore: 100, minAfter: 100, threshold: 8 };

  test('magnetically snaps to candidates', () => {
    const r = resolveSashPosition({ ...base, proposed: 498, candidates: [496] });
    assert.deepEqual(r, { pos: 496, snapped: 496 });
  });

  test('clamps to minimum sizes on both sides', () => {
    assert.equal(resolveSashPosition({ ...base, proposed: 20, candidates: [] }).pos, 100);
    assert.equal(resolveSashPosition({ ...base, proposed: 990, candidates: [] }).pos, 1000 - 8 - 100);
  });

  test('ignores snap candidates that would violate minimums', () => {
    const r = resolveSashPosition({ ...base, proposed: 104, candidates: [98] });
    assert.deepEqual(r, { pos: 104, snapped: null });
  });
});

describe('sizesFromSash', () => {
  test('redistributes only the pair around the sash, preserving their total', () => {
    const next = sizesFromSash({ sizes: [0.2, 0.4, 0.4], index: 1, pos: 700, pairStart: 200, pairEnd: 1000, gap: 0 });
    assert.ok(Math.abs(next[0] - 0.2) < 1e-9);
    assert.ok(Math.abs(next[1] - 0.5) < 1e-9);
    assert.ok(Math.abs(next[2] - 0.3) < 1e-9);
  });

  test('accounts for the gap between the pair', () => {
    const next = sizesFromSash({ sizes: [0.5, 0.5], index: 0, pos: 246, pairStart: 0, pairEnd: 500, gap: 8 });
    assert.ok(Math.abs(next[0] - 0.5) < 1e-9);
  });
});
