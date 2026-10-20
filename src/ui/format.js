/** Text formatters shared across the UI: error messages, home-relative paths and JSON dumps, with no DOM. */

/** @param {unknown} err */
export function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

/**
 * `path` with the home directory written as `~`, when it is inside it.
 * @param {string} path @param {string | null} home
 */
export function tildeHome(path, home) {
  return home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path;
}

/** Indented JSON for display, or `String(value)` when it cannot be serialised. @param {unknown} value */
export function json(value) {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}
