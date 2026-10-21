/**
 * Past omp sessions, searchable and sortable: drag one onto the grid, or press Resume, to
 * continue it in a new omp window.
 *
 * Search runs in the daemon (every word must match the title, directory or a prompt); sorting
 * runs here. The query and sort order are this window's own settings, so two Sessions windows
 * can show different slices. A session already open in a window is marked and cannot be
 * resumed a second time: omp would fork it rather than share it.
 */
import { button, el } from '../ui/dom.js';
import { errorMessage, tildeHome } from '../ui/format.js';
import { getDaemon } from '../daemon/client.js';
import { SORT_KEYS, displayTitle, isSortKey, naturalDir, openJournals, relativeTime, sortSessions } from '../sessions/order.js';
import { resumeParams, sessionRow } from '../sessions/list-view.js';
/** @import { WidgetContext } from './registry.js' */
/** @import { DaemonClient } from '../daemon/client.js' */
/** @import { PastSession } from '../../daemon/wire.js' */
/** @import { SortDir, SortKey } from '../sessions/order.js' */

const REFRESH_MS = 15_000;
const SEARCH_DEBOUNCE_MS = 200;

export default {
  type: 'sessions',
  title: 'Sessions',
  glyph: '☰',
  description: 'Past omp sessions: search, sort, drag one out to resume it',

  /** @param {HTMLElement} body @param {WidgetContext} ctx */
  mount(body, ctx) {
    return createSessionsWindow(body, ctx, getDaemon());
  },
};

/** @param {HTMLElement} body @param {WidgetContext} ctx @param {DaemonClient} daemon */
function createSessionsWindow(body, ctx, daemon) {
  const root = el('div', 'sessions');
  body.append(root);

  /** @returns {SortKey} */
  const sortKey = () => (isSortKey(ctx.params.sort) ? ctx.params.sort : 'active');
  /** @returns {SortDir} */
  const sortDir = () => (ctx.params.dir === 'asc' || ctx.params.dir === 'desc' ? ctx.params.dir : naturalDir(sortKey()));
  const query = () => (typeof ctx.params.query === 'string' ? ctx.params.query : '');

  // ── toolbar ──
  const bar = el('div', 'sessions-bar');
  const search = el('input', 'sessions-search');
  search.type = 'search';
  search.placeholder = 'Search title, directory, prompts…';
  search.setAttribute('aria-label', 'Search sessions');
  search.value = query();
  const sort = el('select', 'sessions-sort');
  sort.setAttribute('aria-label', 'Sort by');
  for (const { key, label } of SORT_KEYS) {
    const option = el('option', '', label);
    option.value = key;
    sort.append(option);
  }
  const direction = button('sessions-icon-btn');
  direction.setAttribute('aria-label', 'Reverse sort order');
  const refresh = button('sessions-icon-btn', '⟳');
  refresh.title = 'Refresh';
  refresh.setAttribute('aria-label', 'Refresh');
  bar.append(search, sort, direction, refresh);
  const status = el('p', 'sessions-status');
  status.setAttribute('aria-live', 'polite');
  const list = el('ul', 'sessions-list');
  list.setAttribute('aria-label', 'Past sessions');
  root.append(bar, status, list);

  /** @type {PastSession[]} */
  let sessions = [];
  /** @type {Map<string, PastSession>} */
  let byFile = new Map();
  /** @type {string | null} */
  let error = null;
  let loading = false;
  let loaded = false;
  let requestSeq = 0;
  /** @type {string | null} */
  let home = null;
  /** @type {Map<string, { signature: string, node: HTMLElement }>} */
  const rows = new Map();

  daemon
    .config()
    .then((c) => {
      home = c.home;
      draw();
    })
    .catch(() => {});

  const openFiles = () => openJournals(daemon.sessions());

  async function load() {
    const seq = ++requestSeq;
    loading = true;
    drawStatus();
    try {
      const next = await daemon.history({ query: query() });
      if (seq !== requestSeq) return;
      sessions = next;
      byFile = new Map(next.map((s) => [s.file, s]));
      error = null;
      loaded = true;
    } catch (err) {
      if (seq !== requestSeq) return;
      error = errorMessage(err);
    } finally {
      if (seq === requestSeq) {
        loading = false;
        draw();
      }
    }
  }

  /** @param {string | null} cwd */
  function shortDir(cwd) {
    if (!cwd) return 'unknown directory';
    return tildeHome(cwd, home);
  }

  /** @param {PastSession} s */
  function resume(s) {
    if (openFiles().has(s.file)) return;
    ctx.addWidget('omp', resumeParams(s));
  }

  /** @param {PastSession} s @param {boolean} open @param {number} now */
  function renderRow(s, open, now) {
    const row = sessionRow(s, { open, now, dir: shortDir(s.cwd), hint: 'Drag onto the grid to resume' });
    if (!open) row.append(button('btn sessions-resume', 'Resume'));
    return row;
  }

  function drawStatus() {
    const shown = sessions.length;
    status.classList.toggle('is-error', error !== null);
    if (error) status.textContent = `Could not list sessions: ${error}`;
    else if (!loaded) status.textContent = 'Loading sessions…';
    else if (shown === 0) status.textContent = query() ? 'No session matches.' : 'No past sessions yet.';
    else status.textContent = `${shown} session${shown === 1 ? '' : 's'}${loading ? ' · refreshing…' : ''}`;
  }

  function draw() {
    sort.value = sortKey();
    const dir = sortDir();
    direction.textContent = dir === 'asc' ? '↑' : '↓';
    direction.title = `${dir === 'asc' ? 'Ascending' : 'Descending'}: click to reverse`;
    drawStatus();

    const open = openFiles();
    const now = Date.now();
    const ordered = sortSessions(sessions, sortKey(), dir);
    const live = new Set();
    ordered.forEach((s, i) => {
      live.add(s.file);
      const isOpen = open.has(s.file);
      // Rows are kept by file so a refresh does not steal focus from the one being used.
      const signature = JSON.stringify([s.title, s.firstPrompt, s.cwd, s.prompts, relativeTime(s.modifiedAt, now), isOpen, home]);
      let entry = rows.get(s.file);
      if (!entry || entry.signature !== signature) {
        const node = renderRow(s, isOpen, now);
        if (entry) {
          const hadFocus = entry.node.contains(document.activeElement);
          entry.node.replaceWith(node);
          if (hadFocus) node.focus();
        }
        entry = { signature, node };
        rows.set(s.file, entry);
      }
      const at = list.children[i];
      if (at !== entry.node) list.insertBefore(entry.node, at ?? null);
    });
    for (const [file, entry] of rows) {
      if (!live.has(file)) {
        entry.node.remove();
        rows.delete(file);
      }
    }
  }

  // ── interaction ──
  /** @param {EventTarget | null} target @returns {PastSession | null} */
  const sessionAt = (target) => {
    const row = /** @type {HTMLElement | null} */ (/** @type {Element} */ (target)?.closest?.('.sessions-item'));
    return row ? (byFile.get(row.dataset.file ?? '') ?? null) : null;
  };

  list.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || /** @type {Element} */ (event.target).closest('button')) return;
    const s = sessionAt(event.target);
    if (!s || openFiles().has(s.file)) return;
    ctx.dragWidget('omp', resumeParams(s), event, { label: displayTitle(s) });
  });
  list.addEventListener('click', (event) => {
    if (!(/** @type {Element} */ (event.target).closest('.sessions-resume'))) return;
    const s = sessionAt(event.target);
    if (s) resume(s);
  });
  list.addEventListener('dblclick', (event) => {
    const s = sessionAt(event.target);
    if (s) resume(s);
  });
  list.addEventListener('keydown', (event) => {
    const row = /** @type {HTMLElement} */ (event.target);
    if (!row.classList?.contains('sessions-item')) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      const s = sessionAt(row);
      if (s) resume(s);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next = event.key === 'ArrowDown' ? row.nextElementSibling : row.previousElementSibling;
      /** @type {HTMLElement | null} */ (next)?.focus();
    }
  });

  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let searchTimer;
  search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      ctx.setParams({ query: search.value.trim() });
      void load();
    }, SEARCH_DEBOUNCE_MS);
  });
  sort.addEventListener('change', () => {
    const key = isSortKey(sort.value) ? sort.value : 'active';
    ctx.setParams({ sort: key, dir: naturalDir(key) });
    draw();
  });
  direction.addEventListener('click', () => {
    ctx.setParams({ dir: sortDir() === 'asc' ? 'desc' : 'asc' });
    draw();
  });
  refresh.addEventListener('click', () => void load());

  const offSessions = daemon.onSessions(draw);
  const offStatus = daemon.onStatus((s) => {
    if (s === 'open') void load();
  });
  const timer = setInterval(() => {
    if (document.visibilityState === 'visible') void load();
  }, REFRESH_MS);

  draw();
  void load();

  return {
    destroy() {
      clearInterval(timer);
      clearTimeout(searchTimer);
      requestSeq++; // drop any answer still on its way
      offSessions();
      offStatus();
      root.remove();
    },
  };
}
