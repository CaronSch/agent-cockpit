/**
 * Tiny observable cell: get/set/subscribe.
 * Subscribers bind values straight to DOM nodes, so a change touches only the
 * elements that read it — no tree re-render.
 */

/**
 * Writable state cell (what `createAtom` returns).
 * @template T
 * @typedef {{
 *   get: () => T,
 *   set: (next: T) => void,
 *   subscribe: (fn: (value: T) => void) => () => void,
 * }} Atom
 */

/**
 * @template T
 * @param {T} initial
 * @returns {Atom<T>}
 */
export function createAtom(initial) {
  let value = initial;
  /** @type {Set<(value: T) => void>} */
  const listeners = new Set();

  return {
    get: () => value,
    set(next) {
      if (Object.is(next, value)) return;
      value = next;
      for (const fn of [...listeners]) {
        try {
          fn(next);
        } catch (err) {
          console.error('[atom] subscriber failed', err);
        }
      }
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}
