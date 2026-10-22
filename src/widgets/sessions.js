/**
 * omp sessions in one list: the daemon's running ones on top, with how each is doing and
 * Stop, then past ones, searchable and sortable. A click shows a session in the omp window this screen used
 * last (or a new one); dragging it shows it in the omp window it is dropped on, or in a new
 * window where it is dropped.
 *
 * Running sessions are every one the daemon runs, whichever screen shows them, or none
 * (sessions/running.js). A past session is resumed when shown. One whose journal a running
 * session writes is listed only as running, so it is never resumed a second time.
 *
 * Search runs in the daemon (every word must match the title, directory or a prompt), running
 * sessions included through their journals; sorting runs here, and so does narrowing to one directory (running sessions too). The query,
 * directory and sort order are this window's own settings, so two Sessions windows can show
 * different slices.
 *
 * Archive moves a session out of omp's sessions into the daemon's archive (omp's own resume
 * no longer offers it); "Archived" switches the window to the archived sessions, each with
 * Restore. A running session cannot be archived: omp is still writing its journal.
 *
 * A session with news its user has not read (daemon/unread.js) has a blue dot and a bold
 * title, running, past or archived alike, and the window's top bar counts those it lists.
 * Showing one from here reads it. Each row's menu (a right-click, the ContextMenu key,
 * Shift+F10, or its ⋯ button) marks it read or unread, beside the row's other actions.
 *
 * Running rows show where their sessions are on this screen (sessions/links.js): a bar at
 * the left edge for one shown in an omp window, brighter for the one in the omp window used
 * last (where a click shows sessions). Pointing at a row (hover, or keyboard focus: a click
 * also focuses a row, but that is not pointing at it once the pointer moves on) outlines its
 * windows, and pointing at an omp window lights its session's row.
 */
import { button, el } from '../ui/dom.js';
import { errorMessage, tildeHome } from '../ui/format.js';
import { getDaemon } from '../daemon/client.js';
import { SORT_KEYS, directoryCounts, displayTitle, isSortKey, naturalDir, relativeTime, sortSessions } from '../sessions/order.js';
import { STATE_LABELS, follow, followedName, isRunning, noteEvent, runningSessions, runningState, showPast, showRunning } from '../sessions/running.js';
import { confirmBeside } from '../ui/confirm.js';
import { sessionLinks } from '../sessions/links.js';
import { openContextMenu, opensContextMenu } from '../ui/context-menu.js';
/** @import { WidgetContext } from './registry.js' */
/** @import { DaemonClient } from '../daemon/client.js' */
/** @import { PastSession, SessionMeta } from '../../daemon/wire.js' */
/** @import { Followed } from '../sessions/running.js' */
/** @import { SortDir, SortKey } from '../sessions/order.js' */

const SEARCH_DEBOUNCE_MS = 200;

export default {
  type: 'sessions',
  title: 'Sessions',
  glyph: '☰',
  description: 'Running and past omp sessions: click or drag one to show it in an omp window',

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
  const runningList = el('ul', 'sessions-running');
  runningList.setAttribute('aria-label', 'Running sessions');
  const list = el('ul', 'sessions-list');
  list.setAttribute('aria-label', 'Past sessions');
  // Both lists scroll as one, so running sessions get all the room they need.
  const lists = el('div', 'sessions-lists');
  lists.append(runningList, list);
  root.append(bar, status, lists);

  /** @type {PastSession[]} */
  let sessions = [];
  /** @type {Map<string, PastSession>} */
  let byFile = new Map();
  /** @type {string | null} */
  let error = null;
  /** Why the last row action (Archive, Restore, Stop, a mark) failed, until the next one. @type {string | null} */
  let moveError = null;
  let loading = false;
  let loaded = false;
  let requestSeq = 0;
  /** @type {string | null} */
  let home = null;
  /** @type {Map<string, { signature: string, node: HTMLElement }>} */
  const rows = new Map();
  /** Running rows, by session id. @type {Map<string, { signature: string, node: HTMLElement }>} */
  const runningRows = new Map();
  /** Where running sessions are shown on this screen (see drawLinks). */
  let links = sessionLinks(ctx.screen.get());
  /** The running rows pointed at: under the pointer, and holding focus. @type {{ hovered: string | null, focused: string | null }} */
  const pointing = { hovered: null, focused: null };
  /** What this window follows of each running session, from its events. @type {Map<string, { followed: Followed, off: () => void }>} */
  const followed = new Map();
  let frame = 0;
  /** Redraws once per frame however many events arrive. */
  const scheduleDraw = () => {
    frame ||= requestAnimationFrame(() => {
      frame = 0;
      draw();
    });
  };

  daemon
    .config()
    .then((c) => {
      home = c.home;
      draw();
    })
    .catch(() => {});

  /** Journals the daemon's running sessions write. */
  const openFiles = () => new Set(daemon.sessions().flatMap((m) => (isRunning(m) && m.sessionFile ? [m.sessionFile] : [])));

  /** Follows every running session's events (to tell how it is doing), and lets go of stopped ones. */
  function syncFollowed() {
    const running = new Set(daemon.sessions().filter(isRunning).map((m) => m.id));
    for (const [id, entry] of followed) {
      if (running.has(id)) continue;
      entry.off();
      followed.delete(id);
    }
    for (const id of running) {
      if (followed.has(id)) continue;
      const entry = { followed: follow(), off: () => {} };
      followed.set(id, entry);
      entry.off = daemon.subscribe(id, (event) => {
        noteEvent(entry.followed, event);
        scheduleDraw();
      });
    }
  }

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

  /** @param {SessionMeta} meta */
  const runningName = (meta) => {
    const f = followed.get(meta.id)?.followed;
    return (f && followedName(f)) ?? null;
  };

  /**
   * The omp window settings that show the row's session, or null for an archived one (it
   * must be restored first).
   * @param {HTMLElement} row @returns {import('../layout/grid-model.js').LeafParams | null}
   */
  function paramsFor(row) {
    const meta = row.dataset.session ? daemon.meta(row.dataset.session) : null;
    if (meta) return isRunning(meta) ? showRunning(meta, runningName(meta)) : null;
    const s = byFile.get(row.dataset.file ?? '');
    return s && !showArchived() ? showPast(s) : null;
  }

  /** omp's id for the row's conversation (what its unread mark is kept under), if known. @param {HTMLElement} row */
  function ompIdOf(row) {
    if (row.dataset.session) return daemon.meta(row.dataset.session)?.ompId ?? null;
    return byFile.get(row.dataset.file ?? '')?.id ?? null;
  }

  /** Marks the row's conversation read or unread. @param {HTMLElement} row @param {boolean} unread */
  function mark(row, unread) {
    const id = ompIdOf(row);
    const since = daemon.unreadSince(id);
    if (id === null || unread === (since !== null)) return;
    (since === null ? daemon.markUnread(id) : daemon.markRead(id, since)).catch((err) => {
      moveError = `Could not mark it ${unread ? 'unread' : 'read'}: ${errorMessage(err)}`;
      draw();
    });
  }

  /** Shows the row's session in the omp window this screen used last; that reads it. @param {HTMLElement} row */
  function show(row) {
    const params = paramsFor(row);
    if (!params) return;
    ctx.showWidget('omp', params);
    mark(row, false);
  }

  /**
   * Opens the row's menu: show it, mark it read or unread, and its own last action.
   * @param {HTMLElement} row @param {HTMLElement} anchor @param {{ x: number, y: number }} [at]
   */
  function openRowMenu(row, anchor, at) {
    /** @type {import('../ui/context-menu.js').MenuItem[]} */
    const items = [];
    const meta = row.dataset.session ? daemon.meta(row.dataset.session) : null;
    const s = byFile.get(row.dataset.file ?? '');
    if (paramsFor(row)) items.push({ label: meta ? 'Show' : 'Resume', run: () => show(row) });
    const id = ompIdOf(row);
    if (id !== null) {
      const unread = daemon.unreadSince(id) !== null;
      items.push({ label: unread ? 'Mark as read' : 'Mark as unread', run: () => mark(row, !unread) });
    }
    /** The row's own button for an action, which shows that the action is under way. @param {string} kind */
    const control = (kind) => /** @type {HTMLButtonElement} */ (row.querySelector(`.sessions-${kind}`));
    if (meta) items.push({ label: 'Stop', run: () => stop(meta, control('stop')) });
    else if (s && showArchived()) items.push({ label: 'Restore', run: () => void move(s, control('restore')) });
    else if (s) items.push({ label: 'Archive', run: () => void move(s, control('archive')) });
    openContextMenu(anchor, items, at);
  }

  /** Stops a running session, asking first while it works on a turn. @param {SessionMeta} meta @param {HTMLButtonElement} control */
  function stop(meta, control) {
    const run = () => {
      control.disabled = true;
      daemon.closeSession(meta.id).catch((err) => {
        moveError = `Could not stop “${runningName(meta) ?? meta.cwd}”: ${errorMessage(err)}`;
        control.disabled = false;
        draw();
      });
    };
    if (followed.get(meta.id)?.followed.transcript.streaming) {
      confirmBeside(control, { message: 'The agent is working on a turn. Stop the session anyway?', action: 'Stop session', run });
    } else run();
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

  /**
   * A row's text: its title on one line, and a dimmer line of facts below it.
   * @param {string} title @param {string[]} facts
   */
  function rowText(title, facts) {
    const main = el('div', 'sessions-main');
    const meta = el('div', 'sessions-meta');
    // The spaces keep the facts separate words for copy and screen readers; flex layout ignores them.
    facts.forEach((fact, i) => meta.append(...(i ? [' '] : []), el('span', i === 0 ? 'sessions-dir' : '', fact)));
    main.append(el('div', 'sessions-title', title), meta);
    return main;
  }

  /** @param {SessionMeta} meta */
  const isUnread = (meta) => daemon.unreadSince(meta.ompId) !== null;

  /** @param {SessionMeta} meta */
  function stateOf(meta) {
    const f = followed.get(meta.id)?.followed;
    return f ? runningState(f, meta, isUnread(meta)) : 'starting';
  }

  /**
   * The dot before a row's title: how a running session is doing, and blue while unread (then
   * it says so to screen readers too).
   * @param {boolean} unread
   */
  function rowDot(unread) {
    const dot = el('span', 'sessions-dot');
    if (unread) {
      dot.setAttribute('role', 'img');
      dot.setAttribute('aria-label', 'Unread');
    } else dot.setAttribute('aria-hidden', 'true');
    return dot;
  }

  /** The row's ⋯ button, which opens its menu. */
  function moreButton() {
    const more = button('sessions-action sessions-more', '⋯');
    more.title = 'More: mark read or unread, and the rest (or right-click the row)';
    more.setAttribute('aria-label', 'More actions');
    more.setAttribute('aria-haspopup', 'menu');
    return more;
  }

  /** @param {SessionMeta} meta */
  function renderRunningRow(meta) {
    const state = stateOf(meta);
    const unread = isUnread(meta);
    const row = el('li', `sessions-item is-running is-${state}${unread ? ' is-unread' : ''}`);
    row.tabIndex = 0;
    row.dataset.session = meta.id;
    row.title = `${meta.cwd}\nStarted ${new Date(meta.startedAt).toLocaleString()}\nClick to show it in the last omp window used, or drag it onto one`;
    const word = el('span', 'sessions-state', STATE_LABELS[state]);
    const main = rowText(runningName(meta) ?? 'New session', [shortDir(meta.cwd)]);
    main.querySelector('.sessions-meta')?.append(' ', word);
    const actions = el('div', 'sessions-actions');
    const stopBtn = button('sessions-action sessions-stop', 'Stop');
    stopBtn.title = 'End this session';
    actions.append(stopBtn, moreButton());
    row.append(rowDot(unread), main, actions);
    return row;
  }

  /** @param {PastSession} s @param {number} now */
  function renderRow(s, now) {
    const archived = showArchived();
    const unread = daemon.unreadSince(s.id) !== null;
    const row = el('li', `sessions-item${archived ? ' is-archived' : ''}${unread ? ' is-unread' : ''}`);
    row.tabIndex = 0;
    row.dataset.file = s.file;
    const hint = archived ? 'Archived: Restore to resume it' : 'Click to resume it in the last omp window used, or drag it onto one';
    row.title = `${s.title && s.firstPrompt ? `${s.firstPrompt}\n` : ''}${s.file}\nLast active ${new Date(s.modifiedAt).toLocaleString()}\n${hint}`;
    const facts = [shortDir(s.cwd), relativeTime(s.modifiedAt, now), `${s.prompts} prompt${s.prompts === 1 ? '' : 's'}`];
    const main = rowText(displayTitle(s), facts);
    const actions = el('div', 'sessions-actions');
    if (archived) {
      actions.append(button('sessions-action sessions-restore', 'Restore'));
    } else {
      actions.append(button('sessions-action sessions-resume', 'Resume'), button('sessions-action sessions-archive', 'Archive'));
    }
    actions.append(moreButton());
    row.append(rowDot(unread), main, actions);
    return row;
  }

  /**
   * The past sessions this window lists: the daemon's answer, narrowed to the chosen directory,
   * without those a running session writes (they are listed as running).
   */
  const shownSessions = () => {
    const dir = directory();
    const open = openFiles();
    return sessions.filter((s) => (!dir || s.cwd === dir) && !open.has(s.file));
  };

  /**
   * The running sessions this window lists: none while it shows the archived ones, and while
   * searching, those whose journal the daemon's search matched.
   */
  const shownRunning = () => {
    if (showArchived()) return [];
    const running = runningSessions(daemon.sessions(), directory());
    return query() ? running.filter((m) => m.sessionFile !== null && byFile.has(m.sessionFile)) : running;
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
    const shown = shownRunning().length + shownSessions().length;
    const kind = showArchived() ? 'archived session' : 'session';
    status.classList.toggle('is-error', error !== null || moveError !== null);
    if (error) status.textContent = `Could not list sessions: ${error}`;
    else if (moveError) status.textContent = moveError;
    else if (!loaded) status.textContent = 'Loading sessions…';
    else if (shown === 0) status.textContent = query() || directory() ? 'No session matches.' : showArchived() ? 'No archived sessions.' : 'No sessions yet.';
    else status.textContent = `${shown} ${kind}${shown === 1 ? '' : 's'}${loading ? ' · refreshing…' : ''}`;
  }

  /**
   * Puts `items`' rows into `into` in order, building only those whose signature changed, so a
   * redraw does not steal focus from the row being used.
   * @template T
   * @param {HTMLElement} into @param {Map<string, { signature: string, node: HTMLElement }>} cache
   * @param {T[]} items @param {(item: T) => string} keyOf @param {(item: T) => string} signatureOf @param {(item: T) => HTMLElement} render
   */
  function syncRows(into, cache, items, keyOf, signatureOf, render) {
    const live = new Set();
    items.forEach((item, i) => {
      const key = keyOf(item);
      live.add(key);
      const signature = signatureOf(item);
      let entry = cache.get(key);
      if (!entry || entry.signature !== signature) {
        const node = render(item);
        if (entry) {
          const hadFocus = entry.node.contains(document.activeElement);
          entry.node.replaceWith(node);
          if (hadFocus) node.focus();
        }
        entry = { signature, node };
        cache.set(key, entry);
      }
      const at = into.children[i];
      if (at !== entry.node) into.insertBefore(entry.node, at ?? null);
    });
    for (const [key, entry] of cache) {
      if (!live.has(key)) {
        entry.node.remove();
        cache.delete(key);
      }
    }
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

    const running = shownRunning();
    runningList.hidden = running.length === 0;
    syncRows(
      runningList,
      runningRows,
      running,
      (m) => m.id,
      (m) => JSON.stringify([runningName(m), m.cwd, stateOf(m), isUnread(m), home]),
      renderRunningRow,
    );
    drawLinks();

    const now = Date.now();
    const past = sortSessions(shownSessions(), sortKey(), dir);
    const unreadPast = (/** @type {PastSession} */ s) => daemon.unreadSince(s.id) !== null;
    syncRows(
      list,
      rows,
      past,
      (s) => s.file,
      (s) => JSON.stringify([s.title, s.firstPrompt, s.cwd, s.prompts, relativeTime(s.modifiedAt, now), home, showArchived(), unreadPast(s)]),
      (s) => renderRow(s, now),
    );
    const unread = running.filter(isUnread).length + past.filter(unreadPast).length;
    ctx.setLabel(unread ? `${unread} unread` : null);
  }

  // ── interaction ──
  /** @param {EventTarget | null} target @returns {HTMLElement | null} */
  const rowAt = (target) => /** @type {HTMLElement | null} */ (/** @type {Element} */ (target)?.closest?.('.sessions-item'));

  // A row drags out from anywhere on it, its Resume button included; its other actions only act.
  root.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || /** @type {Element} */ (event.target).closest('.sessions-archive, .sessions-stop, .sessions-more')) return;
    const row = rowAt(event.target);
    const params = row && paramsFor(row);
    if (!row || !params) return;
    const label = row.querySelector('.sessions-title')?.textContent ?? 'omp';
    // Dropped, it shows in an omp window: that reads it, as a click does.
    ctx.dragWidget('omp', params, event, { label, into: true, onEnd: ({ dropped }) => dropped && mark(row, false) });
  });
  root.addEventListener('contextmenu', (event) => {
    const row = rowAt(event.target);
    if (!row) return;
    event.preventDefault();
    row.focus();
    openRowMenu(row, row, { x: event.clientX, y: event.clientY });
  });
  root.addEventListener('click', (event) => {
    const row = rowAt(event.target);
    if (!row) return;
    const control = /** @type {Element} */ (event.target).closest('button');
    const meta = row.dataset.session ? daemon.meta(row.dataset.session) : null;
    const s = byFile.get(row.dataset.file ?? '');
    if (!control || control.classList.contains('sessions-resume')) show(row);
    else if (control.classList.contains('sessions-more')) openRowMenu(row, /** @type {HTMLElement} */ (control));
    else if (control.classList.contains('sessions-stop') && meta) stop(meta, /** @type {HTMLButtonElement} */ (control));
    else if (s && (control.classList.contains('sessions-archive') || control.classList.contains('sessions-restore'))) void move(s, /** @type {HTMLButtonElement} */ (control));
  });
  root.addEventListener('keydown', (event) => {
    const row = /** @type {HTMLElement} */ (event.target);
    if (!row.classList?.contains('sessions-item')) return;
    if (opensContextMenu(event)) {
      event.preventDefault();
      openRowMenu(row, row);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      show(row);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const rowsShown = [...root.querySelectorAll('.sessions-item')];
      const next = rowsShown[rowsShown.indexOf(row) + (event.key === 'ArrowDown' ? 1 : -1)];
      /** @type {HTMLElement | undefined} */ (next)?.focus();
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

  const offUnread = daemon.onUnread(scheduleDraw);
  const offSessions = daemon.onSessions(() => {
    syncFollowed();
    scheduleDraw();
  });
  syncFollowed();
  const offStatus = daemon.onStatus((s) => {
    if (s === 'open') void load();
  });
  // The daemon says when a journal changes: omp wrote one, or a session was archived or restored.
  const offHistory = daemon.onHistory(() => void load());

  // ── links to this screen's omp windows ──
  /** Marks each running row by where its session is shown, and outlines the pointed row's windows. */
  function drawLinks() {
    for (const [id, { node }] of runningRows) {
      node.classList.toggle('is-shown', links.windows.has(id));
      node.classList.toggle('is-current', links.current === id);
      node.classList.toggle('is-pointed', links.pointed === id);
      if (links.current === id) node.setAttribute('aria-current', 'true');
      else node.removeAttribute('aria-current');
    }
    const session = pointing.hovered ?? pointing.focused;
    ctx.outline(session ? (links.windows.get(session) ?? []) : []);
  }
  const offScreen = ctx.screen.subscribe((screen) => {
    links = sessionLinks(screen);
    drawLinks();
  });
  /** @param {EventTarget | null} target */
  const runningAt = (target) => rowAt(target)?.dataset.session ?? null;
  root.addEventListener('pointerover', (event) => {
    const session = runningAt(event.target);
    if (session === pointing.hovered) return;
    pointing.hovered = session;
    drawLinks();
  });
  root.addEventListener('pointerleave', () => {
    pointing.hovered = null;
    drawLinks();
  });
  // Only keyboard focus points: a click focuses its row too, and that focus would otherwise
  // keep the row's windows outlined after the pointer has moved on.
  root.addEventListener('focusin', (event) => {
    const target = /** @type {Element} */ (event.target);
    pointing.focused = target.matches(':focus-visible') ? runningAt(target) : null;
    drawLinks();
  });
  root.addEventListener('focusout', (event) => {
    if (root.contains(/** @type {Node | null} */ (event.relatedTarget))) return; // focusin follows
    pointing.focused = null;
    drawLinks();
  });

  draw();
  void load();

  return {
    destroy() {
      offHistory();
      offScreen();
      ctx.outline([]);
      clearTimeout(searchTimer);
      requestSeq++; // drop any answer still on its way
      offSessions();
      offUnread();
      offStatus();
      for (const entry of followed.values()) entry.off();
      cancelAnimationFrame(frame);
      root.remove();
    },
  };
}
