/**
 * Per-browser preferences in localStorage. Storage can be missing or refuse (a private window,
 * blocked site data), so a read falls back to null and a write that fails is dropped: the
 * choice then lasts until the page reloads.
 */

/** The value kept under `key`, or null. @param {string} key */
export function readPref(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Keeps `value` under `key`; null removes it. @param {string} key @param {string | null} value */
export function writePref(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Not kept: see above.
  }
}
