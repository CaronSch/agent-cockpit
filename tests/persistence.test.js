import { test, describe } from 'bun:test';
import assert from 'node:assert/strict';
import { loadLayout, saveLayout } from '../src/state/persistence.js';
import { leaf, branch } from '../src/layout/grid-model.js';

const memoryStorage = () => {
  /** @type {Map<string, string>} */
  const data = new Map();
  return {
    /** @param {string} k */
    getItem: (k) => data.get(k) ?? null,
    /** @param {string} k @param {string} v */
    setItem: (k, v) => {
      data.set(k, String(v));
    },
    data,
  };
};

/** @template T @param {() => T} fn @returns {T} */
const quiet = (fn) => {
  const original = console.warn;
  console.warn = () => {};
  try {
    return fn();
  } finally {
    console.warn = original;
  }
};

describe('layout persistence', () => {
  test('round-trips a valid tree with version and ISO timestamp', () => {
    const storage = memoryStorage();
    const tree = branch('row', [leaf('a', 'pane'), leaf('b', 'pane')]);
    assert.equal(saveLayout(tree, storage), true);
    const raw = storage.data.get('cockpit.layout.v1');
    assert.ok(raw !== undefined);
    const saved = JSON.parse(raw);
    assert.equal(saved.version, 1);
    assert.match(saved.savedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(loadLayout(storage), tree);
  });

  test('returns undefined for missing, corrupt, or invalid data', () => {
    const storage = memoryStorage();
    assert.equal(loadLayout(storage), undefined);
    storage.setItem('cockpit.layout.v1', '{not json');
    assert.equal(quiet(() => loadLayout(storage)), undefined);
    storage.setItem('cockpit.layout.v1', JSON.stringify({ version: 1, tree: { kind: 'leaf', id: 7 } }));
    assert.equal(quiet(() => loadLayout(storage)), undefined);
  });

  test('reports failure when storage throws (quota, private mode)', () => {
    const storage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    assert.equal(quiet(() => saveLayout(leaf('a', 'x'), storage)), false);
  });
});
