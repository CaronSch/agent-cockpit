/**
 * Tiny Focal-style atom: get/set/subscribe plus `lens(key)` and `view(fn)`.
 * Subscribers bind values straight to DOM nodes, so a change touches only the
 * elements that read it — no tree re-render.
 *
 * Note: `set(fn)` treats functions as updaters; do not store functions in atoms.
 */

/**
 * @template T
 * @typedef {T | ((prev: T) => T)} Update
 */
/**
 * @template T
 * @typedef {{ get: () => T, subscribe: (fn: (value: T) => void) => () => void, set?: (next: Update<T>) => void }} Source
 */
/**
 * Read-only view of state (what `view(fn)` returns).
 * @template T
 * @typedef {{
 *   get: () => T,
 *   subscribe: (fn: (value: T) => void) => () => void,
 *   view: <U>(select: (value: T) => U) => ReadonlyAtom<U>,
 *   lens: <K extends keyof NonNullable<T>>(key: K) => ReadonlyAtom<NonNullable<T>[K] | undefined>,
 * }} ReadonlyAtom
 */
/**
 * Writable state cell (what `createAtom` and `atom.lens(key)` return).
 * @template T
 * @typedef {Omit<ReadonlyAtom<T>, 'lens'> & {
 *   set: (next: Update<T>) => void,
 *   lens: <K extends keyof NonNullable<T>>(key: K) => Atom<NonNullable<T>[K] | undefined>,
 * }} Atom
 */

/**
 * @template T
 * @param {Source<T>} source
 * @returns {ReadonlyAtom<T> & { set?: (next: Update<T>) => void }}
 */
function withCombinators(source) {
  /** @template U @param {(value: T) => U} select */
  const view = (select) => derive(source, select);

  /** @param {keyof NonNullable<T>} key */
  const lens = (key) => {
    const derived = derive(source, (s) => (s == null ? undefined : s[/** @type {keyof T} */ (key)]));
    if (!source.set) return derived;
    return withCombinators({
      get: derived.get,
      subscribe: derived.subscribe,
      /** @param {Update<unknown>} next */
      set(next) {
        /** @type {(next: Update<T>) => void} */ (source.set)((s) => {
          const current = s == null ? undefined : s[/** @type {keyof T} */ (key)];
          const value = typeof next === 'function' ? next(current) : next;
          return Object.is(value, current) ? s : /** @type {T} */ ({ ...s, [key]: value });
        });
      },
    });
  };

  return /** @type {ReadonlyAtom<T> & { set?: (next: Update<T>) => void }} */ ({ ...source, lens, view });
}

/**
 * @template T, U
 * @param {Source<T>} source @param {(value: T) => U} select
 * @returns {ReadonlyAtom<U>}
 */
function derive(source, select) {
  return withCombinators({
    get: () => select(source.get()),
    /** @param {(value: U) => void} fn */
    subscribe(fn) {
      let previous = select(source.get());
      return source.subscribe((value) => {
        const next = select(value);
        if (Object.is(next, previous)) return;
        previous = next;
        fn(next);
      });
    },
  });
}

/**
 * @template T
 * @param {T} initial
 * @returns {Atom<T>}
 */
export function createAtom(initial) {
  let value = initial;
  /** @type {Set<(value: T) => void>} */
  const listeners = new Set();

  /** @param {T} v */
  const emit = (v) => {
    for (const fn of [...listeners]) {
      try {
        fn(v);
      } catch (err) {
        console.error('[atom] subscriber failed', err);
      }
    }
  };

  const atom = withCombinators({
    get: () => value,
    /** @param {Update<T>} next */
    set(next) {
      const resolved = typeof next === 'function' ? /** @type {(prev: T) => T} */ (next)(value) : next;
      if (Object.is(resolved, value)) return;
      value = resolved;
      emit(resolved);
    },
    /** @param {(value: T) => void} fn */
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  });
  return /** @type {Atom<T>} */ (atom); // `set` was supplied above
}
