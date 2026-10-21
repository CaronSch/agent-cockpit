/**
 * Past omp sessions, searchable and sortable: drag one (or its Resume button) onto the grid to
 * continue it in a new omp window there, or press Resume to open it beside the list.
 *
 * Search runs in the daemon (every word must match the title, directory or a prompt); sorting
 * runs here, and so does narrowing to one directory. The query, directory and sort order are
 * this window's own settings, so two Sessions windows can show different slices. A session
 * already open in a window is marked and cannot be resumed a second time: omp would fork it
 * rather than share it.
 *
 * Archive moves a session out of omp's sessions into the daemon's archive (omp's own resume
 * no longer offers it); "Archived" switches the window to the archived sessions, each with
 * Restore. An open session cannot be archived: omp is still writing its journal.
 */
import { button, el } from '../ui/dom.js';
import { errorMessage, tildeHome } from '../ui/format.js';
import { getDaemon } from '../daemon/client.js';
import { SORT_KEYS, directoryCounts, displayTitle, isSortKey, naturalDir, relativeTime, sortSessions } from '../sessions/order.js';
/** @import { WidgetContext } from './registry.js' */
/** @import { DaemonClient } from '../daemon/client.js' */
/** @import { PastSession } from '../../daemon/wire.js' */
/** @import { SortDir, SortKey } from '../sessions/order.js' */

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
  const showArchived = () => ctx.params.archived === true;
  /** The one directory this window shows, or null for all. */
  const directory = () => (typeof ctx.params.directory === 'string' && ctx.params.directory ? ctx.params.directory : null);

  // ── toolbar ──
  const bar = el('div', 'sessions-bar');
  const search = el('input', 'sessions-search');
  search.type = 'search';
  search.placeholder = 'Search title, directory, prompts…';
  search.setAttribute('aria-label', 'Search sessions');
  search.value = query();
  const directories = el('select', 'sessions-sort sessions-directory');
  directories.setAttribute('aria-label', 'Directory');
  /** What the directory options were last built from, so an open menu is not rebuilt for nothing. */
  let directoriesSignature = '';
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
  const archivedToggle = button('sessions-toggle', 'Archived');
  archivedToggle.title = 'Show archived sessions instead';
  bar.append(search, directories, sort, direction, archivedToggle, refresh);
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
  /** Why the last Archive or Restore failed, until the next one. @type {string | null} */
  let moveError = null;
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
      const next = await daemon.history(query(), { archived: showArchived() });
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
  const paneParams = (s) => ({ resume: s.file, cwd: s.cwd, session: null, sessionFile: null, name: s.title });

  /** @param {PastSession} s */
  function resume(s) {
    if (showArchived() || openFiles().has(s.file)) return;
    ctx.addWidget('omp', paneParams(s));
  }

  /**
   * Archives or restores `s`, then lists again: the row moves to the other list.
   * @param {PastSession} s @param {HTMLButtonElement} control
   */
  async function move(s, control) {
    control.disabled = true;
    moveError = null;
    try {
      await (showArchived() ? daemon.restorePastSession(s.file) : daemon.archivePastSession(s.file));
    } catch (err) {
      moveError = `Could not ${showArchived() ? 'restore' : 'archive'} “${displayTitle(s)}”: ${errorMessage(err)}`;
      control.disabled = false;
    }
    await load();
  }

  /** @param {PastSession} s @param {boolean} open @param {number} now */
  function renderRow(s, open, now) {
    const archived = showArchived();
    const row = el('li', `sessions-item${open ? ' is-open' : ''}${archived ? ' is-archived' : ''}`);
    row.tabIndex = 0;
    row.dataset.file = s.file;
    const hint = archived ? 'Archived: Restore to resume it' : open ? 'Open in a window' : 'Drag onto the grid to resume';
    row.title = `${s.file}\nLast active ${new Date(s.modifiedAt).toLocaleString()}\n${hint}`;
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
    if (archived) {
      row.append(button('btn sessions-restore', 'Restore'));
    } else {
      if (!open) row.append(button('btn sessions-resume', 'Resume'));
      const archive = button('btn sessions-archive', 'Archive');
      if (open) {
        archive.disabled = true;
        archive.title = 'Open in a window: close it to archive it';
      }
      row.append(archive);
    }
    return row;
  }

  /** The sessions this window shows: the daemon's answer, narrowed to the chosen directory. */
  const shownSessions = () => {
    const dir = directory();
    return dir ? sessions.filter((s) => s.cwd === dir) : sessions;
  };

  function drawDirectories() {
    const options = directoryCounts(sessions, directory()).map((d) => ({ value: d.cwd, text: `${shortDir(d.cwd)} (${d.count})` }));
    const signature = JSON.stringify(options);
    if (signature !== directoriesSignature) {
      directoriesSignature = signature;
      const all = el('option', '', 'All directories');
      all.value = '';
      directories.replaceChildren(
        all,
        ...options.map((o) => {
          const option = el('option', '', o.text);
          option.value = o.value;
          return option;
        }),
      );
    }
    directories.value = directory() ?? '';
  }

  function drawStatus() {
    const shown = shownSessions().length;
    const kind = showArchived() ? 'archived session' : 'session';
    status.classList.toggle('is-error', error !== null || moveError !== null);
    if (error) status.textContent = `Could not list sessions: ${error}`;
    else if (moveError) status.textContent = moveError;
    else if (!loaded) status.textContent = 'Loading sessions…';
    else if (shown === 0) status.textContent = query() || directory() ? 'No session matches.' : showArchived() ? 'No archived sessions.' : 'No past sessions yet.';
    else status.textContent = `${shown} ${kind}${shown === 1 ? '' : 's'}${loading ? ' · refreshing…' : ''}`;
  }

  function draw() {
    sort.value = sortKey();
    const dir = sortDir();
    direction.textContent = dir === 'asc' ? '↑' : '↓';
    direction.title = `${dir === 'asc' ? 'Ascending' : 'Descending'}: click to reverse`;
    archivedToggle.setAttribute('aria-pressed', String(showArchived()));
    list.setAttribute('aria-label', showArchived() ? 'Archived sessions' : 'Past sessions');
    drawDirectories();
    drawStatus();

    const open = openFiles();
    const now = Date.now();
    const ordered = sortSessions(shownSessions(), sortKey(), dir);
    const live = new Set();
    ordered.forEach((s, i) => {
      live.add(s.file);
      const isOpen = open.has(s.file);
      // Rows are kept by file so a refresh does not steal focus from the one being used.
      const signature = JSON.stringify([s.title, s.firstPrompt, s.cwd, s.prompts, relativeTime(s.modifiedAt, now), isOpen, home, showArchived()]);
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

  // A row drags out from anywhere on it, its Resume button included (a click on Resume opens it
  // beside the list); Archive only archives.
  list.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || /** @type {Element} */ (event.target).closest('.sessions-archive')) return;
    const s = sessionAt(event.target);
    if (!s || showArchived() || openFiles().has(s.file)) return;
    ctx.dragWidget('omp', paneParams(s), event, { label: displayTitle(s) });
  });
  list.addEventListener('click', (event) => {
    const control = /** @type {Element} */ (event.target).closest('button');
    const s = sessionAt(event.target);
    if (!control || !s) return;
    if (control.classList.contains('sessions-resume')) resume(s);
    else if (control.classList.contains('sessions-archive') || control.classList.contains('sessions-restore')) void move(s, control);
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
  directories.addEventListener('change', () => {
    ctx.setParams({ directory: directories.value || null });
    draw();
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
  archivedToggle.addEventListener('click', () => {
    ctx.setParams({ archived: !showArchived() });
    // The other list's rows are not these; show none until it arrives.
    sessions = [];
    byFile = new Map();
    loaded = false;
    moveError = null;
    draw();
    void load();
  });

  const offSessions = daemon.onSessions(draw);
  const offStatus = daemon.onStatus((s) => {
    if (s === 'open') void load();
  });
  // The daemon says when a journal changes: omp wrote one, or a session was archived or restored.
  const offHistory = daemon.onHistory(() => void load());

  draw();
  void load();

  return {
    destroy() {
      offHistory();
      clearTimeout(searchTimer);
      requestSeq++; // drop any answer still on its way
      offSessions();
      offStatus();
      root.remove();
    },
  };
}
