import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  leaf,
  branch,
  listLeaves,
  findLeaf,
  insertBeside,
  insertAtEdge,
  removeLeaf,
  moveLeaf,
  swapLeaves,
  applyDrop,
  setSizes,
  normalize,
  isValidTree,
  setLeafParams,
} from '../src/layout/grid-model.js';

/** @import { Tree, GridNode, Branch, Leaf } from '../src/layout/grid-model.js' */

/** Narrow to a branch, failing the test otherwise. @param {Tree | undefined} node @returns {Branch} */
const asBranch = (node) => {
  assert.ok(node?.kind === 'branch', 'expected a branch');
  return node;
};
/** Narrow to a leaf, failing the test otherwise. @param {GridNode | undefined} node @returns {Leaf} */
const asLeaf = (node) => {
  assert.ok(node?.kind === 'leaf', 'expected a leaf');
  return node;
};
/** @param {Tree} tree */
const ids = (tree) => listLeaves(tree).map((l) => l.id);
/** @param {number[]} xs */
const sum = (xs) => xs.reduce((a, b) => a + b, 0);

describe('insertBeside', () => {
  test('splits a lone leaf into a row when dropping right', () => {
    const tree = leaf('a', 'log');
    const next = asBranch(insertBeside(tree, 'a', 'right', leaf('b', 'clock')));
    assert.equal(next.kind, 'branch');
    assert.equal(next.axis, 'row');
    assert.deepEqual(ids(next), ['a', 'b']);
    assert.deepEqual(next.sizes, [0.5, 0.5]);
  });

  test('places the new leaf before the target for left/up', () => {
    const next = asBranch(insertBeside(leaf('a', 'log'), 'a', 'up', leaf('b', 'clock')));
    assert.equal(next.axis, 'col');
    assert.deepEqual(ids(next), ['b', 'a']);
  });

  test('splices into an existing same-axis branch, halving only the target', () => {
    const tree = branch('row', [leaf('a', 'x'), leaf('b', 'x')], [0.6, 0.4]);
    const next = asBranch(insertBeside(tree, 'b', 'right', leaf('c', 'x')));
    assert.deepEqual(ids(next), ['a', 'b', 'c']);
    assert.deepEqual(next.sizes, [0.6, 0.2, 0.2]);
  });

  test('nests a cross-axis branch in place of the target', () => {
    const tree = branch('row', [leaf('a', 'x'), leaf('b', 'x')], [0.5, 0.5]);
    const next = asBranch(insertBeside(tree, 'b', 'down', leaf('c', 'x')));
    assert.equal(next.children[1].kind, 'branch');
    assert.equal(asBranch(next.children[1]).axis, 'col');
    assert.deepEqual(ids(next), ['a', 'b', 'c']);
    assert.deepEqual(next.sizes, [0.5, 0.5]);
  });

  test('does not mutate the input tree', () => {
    const tree = branch('row', [leaf('a', 'x'), leaf('b', 'x')], [0.5, 0.5]);
    const snapshot = structuredClone(tree);
    insertBeside(tree, 'a', 'left', leaf('c', 'x'));
    assert.deepEqual(tree, snapshot);
  });

  test('returns a single leaf when the tree is empty', () => {
    assert.deepEqual(insertBeside(null, 'nope', 'left', leaf('a', 'x')), leaf('a', 'x'));
  });
});

describe('insertAtEdge', () => {
  test('wraps a cross-axis root so the new leaf spans the full edge', () => {
    const tree = branch('row', [leaf('a', 'x'), leaf('b', 'x')], [0.5, 0.5]);
    const next = asBranch(insertAtEdge(tree, 'down', leaf('c', 'x')));
    assert.equal(next.axis, 'col');
    assert.equal(asLeaf(next.children[1]).id, 'c');
    assert.ok(Math.abs(sum(next.sizes) - 1) < 1e-9);
  });

  test('appends to a same-axis root and scales siblings proportionally', () => {
    const tree = branch('row', [leaf('a', 'x'), leaf('b', 'x')], [0.5, 0.5]);
    const next = asBranch(insertAtEdge(tree, 'left', leaf('c', 'x')));
    assert.deepEqual(ids(next), ['c', 'a', 'b']);
    assert.ok(Math.abs(sum(next.sizes) - 1) < 1e-9);
    assert.ok(Math.abs(next.sizes[1] - next.sizes[2]) < 1e-9);
  });
});

describe('removeLeaf', () => {
  test('collapses a two-child branch to the survivor', () => {
    const tree = branch('row', [leaf('a', 'x'), leaf('b', 'x')], [0.5, 0.5]);
    assert.deepEqual(removeLeaf(tree, 'a'), leaf('b', 'x'));
  });

  test('gives freed space to the adjacent sibling so others stay put', () => {
    const tree = branch('row', [leaf('a', 'x'), leaf('b', 'x'), leaf('c', 'x')], [0.2, 0.3, 0.5]);
    const next = asBranch(removeLeaf(tree, 'b'));
    assert.deepEqual(ids(next), ['a', 'c']);
    assert.deepEqual(next.sizes, [0.5, 0.5]);
  });

  test('flattens a nested branch that ends up with the parent axis', () => {
    const inner = branch('col', [leaf('b', 'x'), branch('row', [leaf('c', 'x'), leaf('d', 'x')])]);
    const tree = branch('row', [leaf('a', 'x'), inner], [0.5, 0.5]);
    const next = asBranch(removeLeaf(tree, 'b'));
    assert.equal(next.axis, 'row');
    assert.deepEqual(ids(next), ['a', 'c', 'd']);
    assert.deepEqual(next.sizes, [0.5, 0.25, 0.25]);
  });

  test('returns null when the last leaf is removed', () => {
    assert.equal(removeLeaf(leaf('a', 'x'), 'a'), null);
  });
});

describe('moveLeaf / swapLeaves', () => {
  test('moves a leaf beside another target', () => {
    const tree = branch('row', [leaf('a', 'x'), leaf('b', 'x'), leaf('c', 'x')]);
    const next = moveLeaf(tree, 'a', 'c', 'right');
    assert.deepEqual(ids(next), ['b', 'c', 'a']);
  });

  test('is a no-op when dropping a leaf onto itself', () => {
    const tree = branch('row', [leaf('a', 'x'), leaf('b', 'x')]);
    assert.equal(moveLeaf(tree, 'a', 'a', 'left'), tree);
  });

  test('center drop swaps widgets without changing geometry', () => {
    const tree = branch('row', [leaf('a', 'log'), leaf('b', 'clock')], [0.7, 0.3]);
    const next = asBranch(moveLeaf(tree, 'a', 'b', 'center'));
    assert.deepEqual(ids(next), ['b', 'a']);
    assert.deepEqual(next.sizes, [0.7, 0.3]);
    assert.deepEqual(swapLeaves(tree, 'a', 'b'), next);
  });
});

describe('applyDrop', () => {
  const tree = branch('row', [leaf('a', 'x'), leaf('b', 'x')]);

  test('handles new widgets dropped on a leaf', () => {
    const next = applyDrop(tree, {
      source: { kind: 'new', leaf: leaf('n', 'clock') },
      target: { kind: 'leaf', id: 'a' },
      dir: 'down',
    });
    assert.ok(findLeaf(next, 'n'));
  });

  test('handles moves to the grid edge', () => {
    const next = asBranch(applyDrop(tree, {
      source: { kind: 'move', id: 'a' },
      target: { kind: 'edge' },
      dir: 'down',
    }));
    assert.equal(next.axis, 'col');
    assert.equal(asLeaf(next.children[1]).id, 'a');
  });

  test('handles a drop into an empty grid', () => {
    const next = applyDrop(null, {
      source: { kind: 'new', leaf: leaf('n', 'clock') },
      target: { kind: 'empty' },
      dir: 'center',
    });
    assert.deepEqual(next, leaf('n', 'clock'));
  });
});

describe('setSizes / normalize / isValidTree', () => {
  test('setSizes replaces sizes at a path immutably', () => {
    const inner = branch('col', [leaf('b', 'x'), leaf('c', 'x')]);
    const tree = branch('row', [leaf('a', 'x'), inner]);
    const next = asBranch(setSizes(tree, [1], [0.25, 0.75]));
    assert.deepEqual(asBranch(next.children[1]).sizes, [0.25, 0.75]);
    assert.deepEqual(inner.sizes, [0.5, 0.5]);
  });

  test('normalize repairs sizes that do not sum to 1', () => {
    const next = asBranch(normalize(branch('row', [leaf('a', 'x'), leaf('b', 'x')], [2, 2])));
    assert.deepEqual(next.sizes, [0.5, 0.5]);
  });

  test('isValidTree accepts real trees and rejects junk', () => {
    assert.equal(isValidTree(branch('row', [leaf('a', 'x'), leaf('b', 'x')])), true);
    assert.equal(isValidTree(null), true);
    assert.equal(isValidTree({ kind: 'branch', axis: 'diag', children: [], sizes: [] }), false);
    assert.equal(isValidTree({ kind: 'leaf', id: 42 }), false);
    assert.equal(isValidTree(branch('row', [leaf('a', 'x'), leaf('a', 'x')])), false, 'duplicate ids');
  });
});

describe('leaf params', () => {
  test('setLeafParams merges into one leaf and leaves the others alone', () => {
    const tree = branch('row', [{ ...leaf('a', 'x'), params: { session: 's1', cwd: '/p' } }, leaf('b', 'x')]);
    const next = setLeafParams(tree, 'a', { session: 's2' });
    assert.deepEqual(findLeaf(next, 'a')?.params, { session: 's2', cwd: '/p' });
    assert.equal(findLeaf(next, 'b')?.params, undefined);
    assert.equal(setLeafParams(tree, 'missing', { session: 's3' }), tree);
  });

  test('params travel with their window through moves and swaps', () => {
    const bound = { ...leaf('a', 'omp'), params: { session: 's1' } };
    const tree = branch('row', [bound, leaf('b', 'x'), leaf('c', 'x')]);
    assert.deepEqual(findLeaf(moveLeaf(tree, 'a', 'c', 'down'), 'a')?.params, { session: 's1' });
    assert.deepEqual(findLeaf(swapLeaves(tree, 'a', 'b'), 'a')?.params, { session: 's1' });
  });

  test('isValidTree accepts flat JSON params and rejects anything else', () => {
    const withParams = (/** @type {unknown} */ params) => ({ kind: 'leaf', id: 'a', widget: 'x', params });
    assert.equal(isValidTree(withParams({ session: 's', n: 1, on: true, none: null })), true);
    assert.equal(isValidTree(withParams({ nested: { a: 1 } })), false);
    assert.equal(isValidTree(withParams(['s'])), false);
    assert.equal(isValidTree(withParams(null)), false);
    assert.equal(isValidTree(withParams({ n: Number.NaN })), false);
  });
});
