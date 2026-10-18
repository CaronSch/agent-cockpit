/** Versioned, schema-validated layout storage in localStorage. */
import { isValidTree } from '../layout/grid-model.js';

/** @import { Tree } from '../layout/grid-model.js' */
/** The slice of `Storage` persistence uses. @typedef {Pick<Storage, 'getItem' | 'setItem'>} LayoutStorage */

const LAYOUT_KEY = 'cockpit.layout.v1';
const VERSION = 1;

/** @returns {LayoutStorage | null} */
const defaultStorage = () => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // access can throw in sandboxed/private contexts
  }
};

/** @param {string} key @param {LayoutStorage | null} storage @returns {any} parsed untrusted JSON */
function readJson(key, storage) {
  const raw = storage?.getItem(key);
  return raw ? JSON.parse(raw) : undefined;
}

/**
 * Returns the saved tree, or undefined when nothing valid is stored.
 * @param {LayoutStorage | null} [storage]
 * @returns {Tree | undefined}
 */
export function loadLayout(storage = defaultStorage()) {
  try {
    const data = readJson(LAYOUT_KEY, storage);
    if (data === undefined) return undefined;
    if (data?.version !== VERSION || !isValidTree(data.tree)) {
      console.warn('[persistence] ignoring invalid saved layout');
      return undefined;
    }
    return data.tree;
  } catch (err) {
    console.warn('[persistence] could not read saved layout', err);
    return undefined;
  }
}

/** @param {Tree} tree @param {LayoutStorage | null} [storage] @returns {boolean} */
export function saveLayout(tree, storage = defaultStorage()) {
  try {
    storage?.setItem(LAYOUT_KEY, JSON.stringify({ version: VERSION, savedAt: new Date().toISOString(), tree }));
    return true;
  } catch (err) {
    console.warn('[persistence] could not save layout', err);
    return false;
  }
}
