/**
 * DOM for lists of past omp sessions: the row both the Sessions window and the omp pane draw
 * for a session, and the session picker the omp pane shows on its start screen and for `/resume`.
 *
 * The picker lists one directory's sessions, newest first: a few at once, the rest a click
 * away. A session already open in a window is marked and cannot be picked (`openJournals`).
 */
import { button, el } from '../ui/dom.js';
import { errorMessage } from '../ui/format.js';
import { displayTitle, openJournals, relativeTime, sortSessions } from './order.js';
/** @import { DaemonClient } from '../daemon/client.js' */
/** @import { PastSession } from '../../daemon/wire.js' */

/** Sessions the picker shows before "Show more". */
const PICKER_ROWS = 5;

/**
 * The omp pane params that resume `s` in a window (see widgets/omp.js, `OmpParams`).
 * @param {PastSession} s
 */
export const resumeParams = (s) => ({ resume: s.file, cwd: s.cwd, session: null, sessionFile: null });

/**
 * One session as a focusable list row: its title, the first prompt when the title is not it,
 * then where (`dir`, when given), when, how many prompts, and whether it is open already.
 * @param {PastSession} s
 * @param {{ open: boolean, now: number, dir?: string | null, hint: string }} options `hint` says how to resume it
 */
export function sessionRow(s, { open, now, dir = null, hint }) {
  const row = el('li', `sessions-item${open ? ' is-open' : ''}`);
  row.tabIndex = 0;
  row.dataset.file = s.file;
  row.title = `${s.file}\nLast active ${new Date(s.modifiedAt).toLocaleString()}\n${open ? 'Open in a window' : hint}`;
  const main = el('div', 'sessions-main');
  main.append(el('div', 'sessions-title', displayTitle(s)));
  if (s.title && s.firstPrompt) main.append(el('div', 'sessions-preview', s.firstPrompt));
  const meta = el('div', 'sessions-meta');
  // The spaces keep the parts separate words for copy and screen readers; flex layout ignores them.
  if (dir !== null) meta.append(el('span', 'sessions-dir', dir), ' ');
  meta.append(el('span', '', relativeTime(s.modifiedAt, now)), ' ', el('span', '', `${s.prompts} prompt${s.prompts === 1 ? '' : 's'}`));
  if (open) meta.append(' ', el('span', 'sessions-badge', 'open'));
  main.append(meta);
  row.append(main);
  return row;
}

/**
 * @typedef {{
 *   root: HTMLElement,
 *   show(filter: { cwd: string, query?: string }): Promise<void>,
 *   focus(): void,
 *   destroy(): void,
 * }} SessionPicker
 */

/**
 * A directory's past sessions to pick one from. With `empty` unset the picker stays hidden
 * while it has nothing to show; with it, it says so.
 * @param {{
 *   daemon: DaemonClient,
 *   label: string,
 *   empty?: string,
 *   onPick: (s: PastSession) => void,
 * }} options
 * @returns {SessionPicker}
 */
export function createSessionPicker({ daemon, label, empty, onPick }) {
  const root = el('div', 'session-picker');
  const heading = el('p', 'session-picker-label', label);
  const status = el('p', 'sessions-status');
  status.setAttribute('aria-live', 'polite');
  const list = el('ul', 'sessions-list session-picker-list');
  list.setAttribute('aria-label', label);
  const more = button('session-picker-more', '', () => {
    expanded = true;
    draw();
  });
  root.append(heading, status, list, more);

  /** @type {PastSession[]} */
  let sessions = [];
  /** @type {string | null} */
  let error = null;
  let loaded = false;
  let expanded = false;
  let requestSeq = 0;

  async function show(/** @type {{ cwd: string, query?: string }} */ { cwd, query = '' }) {
    const seq = ++requestSeq;
    expanded = false;
    if (!cwd.trim()) {
      sessions = [];
      error = null;
      loaded = true;
      return draw();
    }
    try {
      const next = await daemon.history({ cwd, query });
      if (seq !== requestSeq) return;
      sessions = sortSessions(next, 'active', 'desc');
      error = null;
    } catch (err) {
      if (seq !== requestSeq) return;
      error = errorMessage(err);
    }
    loaded = true;
    draw();
  }

  function draw() {
    const open = openJournals(daemon.sessions());
    const now = Date.now();
    const shown = expanded ? sessions : sessions.slice(0, PICKER_ROWS);
    const focused = /** @type {HTMLElement | null} */ (list.querySelector(':focus'))?.dataset.file;
    list.replaceChildren(...shown.map((s) => sessionRow(s, { open: open.has(s.file), now, hint: 'Click to resume in this window' })));
    if (focused) /** @type {HTMLElement | null} */ (list.querySelector(`[data-file="${CSS.escape(focused)}"]`))?.focus();
    list.classList.toggle('is-expanded', expanded);
    const hidden = sessions.length - shown.length;
    more.hidden = hidden === 0;
    more.textContent = `Show ${hidden} more`;
    status.classList.toggle('is-error', error !== null);
    status.textContent = error ? `Could not list sessions: ${error}` : !loaded ? 'Loading sessions…' : sessions.length ? '' : (empty ?? '');
    status.hidden = !status.textContent;
    root.hidden = empty === undefined && error === null && sessions.length === 0;
  }

  /** @param {EventTarget | null} target @returns {PastSession | null} */
  const sessionAt = (target) => {
    const row = /** @type {HTMLElement | null} */ (/** @type {Element} */ (target)?.closest?.('.sessions-item'));
    return row ? (sessions.find((s) => s.file === row.dataset.file) ?? null) : null;
  };
  /** @param {PastSession | null} s */
  const pick = (s) => {
    if (s && !openJournals(daemon.sessions()).has(s.file)) onPick(s);
  };

  list.addEventListener('click', (event) => pick(sessionAt(event.target)));
  list.addEventListener('keydown', (event) => {
    const row = /** @type {HTMLElement} */ (event.target);
    if (!row.classList?.contains('sessions-item')) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      pick(sessionAt(row));
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next = event.key === 'ArrowDown' ? (row.nextElementSibling ?? (more.hidden ? null : more)) : row.previousElementSibling;
      /** @type {HTMLElement | null} */ (next)?.focus();
    }
  });

  const offSessions = daemon.onSessions(draw);
  draw();

  return {
    root,
    show,
    /** Puts the keyboard on the first session that can be picked, else the first one. */
    focus() {
      const rows = [...list.querySelectorAll('.sessions-item')];
      /** @type {HTMLElement | undefined} */ (rows.find((r) => !r.classList.contains('is-open')) ?? rows[0])?.focus();
    },
    destroy() {
      requestSeq++; // drop any answer still on its way
      offSessions();
      root.remove();
    },
  };
}
