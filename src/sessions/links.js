/**
 * Which omp windows of this screen show which running sessions, so the Sessions window can
 * mark its rows and point at their windows. A window shows the session in its `session`
 * setting (src/sessions/running.js `showRunning`); one still starting a resume or a fork has
 * none yet, and shows nothing here.
 *
 * "Current" is the session in the omp window this screen used last: the one a click in
 * Sessions shows sessions in. That is not always the focused window (focus may be in
 * Sessions itself, or nowhere), and it is where a click lands, so it is the one marked.
 */
/** @import { Leaf } from '../layout/grid-model.js' */
/** @import { ScreenWindows } from '../widgets/registry.js' */

/**
 * @typedef {{
 *   windows: Map<string, string[]>,
 *   current: string | null,
 *   pointed: string | null,
 * }} SessionLinks `windows`: the ids of the omp windows showing each session, in screen
 * order; `current`: the session in the omp window used last; `pointed`: the session in the
 * omp window under the pointer, or focused
 */

/** The session an omp window shows, if it is one. @param {Leaf | undefined} leaf */
const sessionOf = (leaf) => (leaf?.widget === 'omp' && typeof leaf.params?.session === 'string' ? leaf.params.session : null);

/** @param {ScreenWindows} screen @returns {SessionLinks} */
export function sessionLinks(screen) {
  /** @type {Map<string, string[]>} */
  const windows = new Map();
  for (const leaf of screen.windows) {
    const session = sessionOf(leaf);
    if (session) windows.set(session, [...(windows.get(session) ?? []), leaf.id]);
  }
  /** @param {string | null | undefined} id */
  const shownIn = (id) => sessionOf(screen.windows.find((leaf) => leaf.id === id));
  return { windows, current: shownIn(screen.used.omp), pointed: shownIn(screen.pointed) };
}
