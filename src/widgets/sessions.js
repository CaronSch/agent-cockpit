/**
 * Past omp sessions, searchable and sortable: drag one onto the grid, or press Resume, to
 * continue it in a new omp window.
 *
 * Search runs in the daemon (every word must match the title, directory or a prompt); sorting
 * runs here. The query and sort order are this window's own settings, so two Sessions windows
 * can show different slices. A session already open in a window is marked and cannot be
 * resumed a second time: omp would fork it rather than share it.
 */
import { el } from '../ui/dom.js';
import { getDaemon } from '../daemon/client.js';
import { SORT_KEYS, displayTitle, isSortKey, naturalDir, relativeTime, sortSessions } from '../sessions/order.js';
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

/** @param {unknown} err */
const message = (err) => (err instanceof Error ? err.message : String(err));

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
  const direction = el('button', 'sessions-icon-btn');
  direction.type = 'button';
  direction.setAttribute('aria-label', 'Reverse sort order');
  const refresh = el('button', 'sessions-icon-btn', '⟳');
  refresh.type = 'button';
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

  /** Journals the daemon's running sessions write. */
  const openFiles = () =>
    new Set(
      daemon
        .sessions()
        .filter((m) => m.status === 'starting' || m.status === 'ready')
        .flatMap((m) => (m.sessionFile ? [m.sessionFile] : [])),
    );

  async function load() {
    const seq = ++requestSeq;
    loading = true;
    drawStatus();
    try {
      const next = await daemon.history(query());
      if (seq !== requestSeq) return;
      sessions = next;
      byFile = new Map(next.map((s) => [s.file, s]));
      error = null;
      loaded = true;
    } catch (err) {
      if (seq !== requestSeq) return;
      error = message(err);
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
    return home && (cwd === home || cwd.startsWith(`${home}/`)) ? `~${cwd.slice(home.length)}` : cwd;
  }

  /** @param {PastSession} s */
  const paneParams = (s) => ({ resume: s.file, cwd: s.cwd, session: null, sessionFile: null });

  /** @param {PastSession} s */
  function resume(s) {
    if (openFiles().has(s.file)) return;
    ctx.addWidget('omp', paneParams(s));
  }

  /** @param {PastSession} s @param {boolean} open @param {number} now */
  function renderRow(s, open, now) {
    const row = el('li', `sessions-item${open ? ' is-open' : ''}`);
    row.tabIndex = 0;
    row.dataset.file = s.file;
    row.title = `${s.file}\nLast active ${new Date(s.modifiedAt).toLocaleString()}${open ? '\nOpen in a window' : '\nDrag onto the grid to resume'}`;
    const main = el('div', 'sessions-main');
    main.append(el('div', 'sessions-title', displayTitle(s)));
    if (s.title && s.firstPrompt) main.append(el('div', 'sessions-preview', s.firstPrompt));
    const meta = el('div', 'sessions-meta');
    // The spaces keep the parts separate words for copy and screen readers; flex layout ignores them.
    meta.append(
      el('span', 'sessions-dir', shortDir(s.cwd)),
      ' ',
      el('span', '', relativeTime(s.modifiedAt, now)),
      ' ',
      el('span', '', `${s.prompts} prompt${s.prompts === 1 ? '' : 's'}`),
    );
    if (open) meta.append(' ', el('span', 'sessions-badge', 'open'));
    main.append(meta);
    row.append(main);
    if (!open) {
      const button = el('button', 'btn sessions-resume', 'Resume');
      button.type = 'button';
      row.append(button);
    }
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
    ctx.dragWidget('omp', paneParams(s), event, { label: displayTitle(s) });
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
