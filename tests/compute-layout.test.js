import { test, describe } from 'bun:test';
import assert from 'node:assert/strict';
import { leaf, branch } from '../src/layout/grid-model.js';
import { computeLayout, minSize } from '../src/layout/compute-layout.js';

const MINS = { minWidth: 100, minHeight: 60 };
const bounds = { x: 0, y: 0, w: 1000, h: 600 };

describe('computeLayout', () => {
  test('a single leaf fills the bounds', () => {
    const { leaves, sashes } = computeLayout(leaf('a', 'x'), bounds, { gap: 8, ...MINS });
    assert.deepEqual(leaves.get('a'), { x: 0, y: 0, w: 1000, h: 600 });
    assert.equal(sashes.length, 0);
  });

  test('row children share space after subtracting gaps, with integer edges', () => {
    const tree = branch('row', [leaf('a', 'x'), leaf('b', 'x'), leaf('c', 'x')]);
    const { leaves } = computeLayout(tree, bounds, { gap: 8, ...MINS });
    const a = leaves.get('a');
    const b = leaves.get('b');
    const c = leaves.get('c');
    assert.ok(a && b && c, 'every leaf has a rect');
    assert.equal(a.x, 0);
    assert.equal(b.x, a.x + a.w + 8);
    assert.equal(c.x + c.w, 1000, 'last child reaches the far edge exactly');
    for (const r of [a, b, c]) assert.ok(Number.isInteger(r.x) && Number.isInteger(r.w));
  });

  test('emits one sash per gap with pair bounds and minimums', () => {
    const tree = branch('col', [leaf('a', 'x'), leaf('b', 'x')]);
    const { sashes } = computeLayout(tree, bounds, { gap: 10, ...MINS });
    assert.equal(sashes.length, 1);
    const [s] = sashes;
    assert.equal(s.axis, 'col');
    assert.deepEqual(s.path, []);
    assert.equal(s.index, 0);
    assert.equal(s.start, 0);
    assert.equal(s.end, 600);
    assert.equal(s.pos, 295);
    assert.equal(s.minBefore, 60);
    assert.equal(s.minAfter, 60);
    assert.deepEqual({ x: s.x, y: s.y, w: s.w, h: s.h }, { x: 0, y: 295, w: 1000, h: 10 });
  });

  test('nested sashes carry their branch path', () => {
    const tree = branch('row', [leaf('a', 'x'), branch('col', [leaf('b', 'x'), leaf('c', 'x')])]);
    const { sashes } = computeLayout(tree, bounds, { gap: 8, ...MINS });
    assert.equal(sashes.length, 2);
    assert.deepEqual(sashes[1].path, [1]);
    assert.equal(sashes[1].axis, 'col');
  });

  test('returns empty results for an empty tree', () => {
    const { leaves, sashes } = computeLayout(null, bounds, { gap: 8, ...MINS });
    assert.equal(leaves.size, 0);
    assert.equal(sashes.length, 0);
  });
});

describe('minSize', () => {
  test('sums minimums along the branch axis and takes the max across it', () => {
    const tree = branch('row', [leaf('a', 'x'), branch('col', [leaf('b', 'x'), leaf('c', 'x')])]);
    assert.equal(minSize(tree, 'row', { gap: 8, ...MINS }), 100 + 8 + 100);
    assert.equal(minSize(tree, 'col', { gap: 8, ...MINS }), 60 + 8 + 60);
  });
});
