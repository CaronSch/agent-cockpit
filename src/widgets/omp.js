/**
 * The omp pane: starts an omp coding agent in a chosen directory through the daemon and
 * lets the user chat with it and set it up, rendered from omp's structured event stream.
 *
 * The window shows one session at a time; the session is the daemon's, not the window's. New
 * starts another one here and Sessions shows any other here, while the one shown before runs
 * on; closing the window leaves its session running too. Only End (or the Sessions window's
 * Stop) ends one.
 *
 * Params (persisted with the layout): `session` (daemon session id), `cwd`,
 * `sessionFile` (omp's transcript file, for resuming after the process is gone), `name` (the
 * conversation's title, shown in the window's top bar), `resume` or `fork` while the window is
 * starting from another journal, and `prompt` while a fork waits to send the message it was
 * dragged off another pane's Send with. What the pane shows follows the app's settings
 * (ui/settings.js), the same in every omp window.
 *
 * New, Stop and the More menu sit in the window's top bar, beside its close button.
 */
import { button, el } from '../ui/dom.js';
import { errorMessage, tildeHome } from '../ui/format.js';
import { getDaemon } from '../daemon/client.js';
import { addNote, applyEvent, conversationName, createTranscript, needsLogin } from '../omp/transcript.js';
import { renderItem } from '../omp/items-view.js';
import { renderDialog } from '../omp/dialogs-view.js';
import { createComposer } from '../omp/composer.js';
import { composeAsk, composeFollowUp, isCommand, shellCommand } from '../omp/message.js';
import { attachSelectionPopup } from '../omp/selection-popup.js';
import { attachDragHighlight } from '../omp/drag-highlight.js';
import { createSuggestions } from '../omp/suggestions.js';
import { createFileSuggest } from '../omp/file-suggest.js';
import { MENTIONS, PLAIN_PATH } from '../omp/file-mention.js';
import { awaitedAfter } from '../omp/activity.js';
import { promptsAndResponses } from '../omp/visibility.js';
import { turnProgress } from '../omp/todos.js';
import { createPromptHistory, sentPrompts } from '../omp/prompt-history.js';
import { branchEntry, rewindPoint } from '../omp/rewind.js';
import { confirmBeside } from '../ui/confirm.js';
import { focusOnClick } from '../ui/click-focus.js';
import { settings } from '../ui/settings.js';
/** @import { WidgetContext } from './registry.js' */
/** @import { RpcResponse, SessionEvent, SessionMeta } from '../../daemon/wire.js' */
/** @import { DaemonClient } from '../daemon/client.js' */
/** @import { SlashCommand } from '../omp/transcript.js' */

/**
 * `resume` is a journal to resume, `fork` one to fork into a new session, as soon as the
 * window is placed (set by whoever created it: the Sessions window, another pane's Fork);
 * either is cleared once the session is running, so a fork is never taken twice. `prompt` is
 * cleared as it is sent.
 * @typedef {{ session: string | null, cwd: string | null, sessionFile: string | null, name: string | null, resume: string | null, fork: string | null, prompt: string | null }} OmpParams
 */
/** @typedef {{ label: string, detail?: string, current?: boolean, pick: () => void }} MenuEntry */
const MAX_SUGGESTIONS = 8;
const BOTTOM_SLACK_PX = 24;
const REFUSED = 'The daemon refused this page.';
const FORK_TITLE = 'Fork: continue a copy of this conversation in a new window';
const NOTHING_TO_FORK = 'Nothing to fork yet: omp saves a conversation once the model has replied';
const SEND_TITLE = 'Drag onto the grid to send this in a fork of the conversation instead';

export default {
  type: 'omp',
  title: 'omp',
  glyph: 'π',
  description: 'Chat with an omp coding agent',

  /** @param {HTMLElement} body @param {WidgetContext} ctx */
  mount(body, ctx) {
    return createPane(body, ctx, getDaemon());
  },
};

/** @param {unknown} v @returns {string | null} */
const str = (v) => (typeof v === 'string' && v ? v : null);

/**
 * @param {HTMLElement} body @param {WidgetContext} ctx @param {DaemonClient} daemon
 */
function createPane(body, ctx, daemon) {
  const root = el('div', 'omp');
  body.append(root);

  /** @returns {OmpParams} */
  const params = () => ({
    session: str(ctx.params.session),
    cwd: str(ctx.params.cwd),
    sessionFile: str(ctx.params.sessionFile),
    name: str(ctx.params.name),
    resume: str(ctx.params.resume),
    fork: str(ctx.params.fork),
    prompt: str(ctx.params.prompt),
  });

  /** @type {string | null} */
  let mode = null;
  let frame = 0;
  let destroyed = false;
  /** @type {SessionView | null} */
  let view = null;
  /** @type {string | null} */
  let home = null;
  daemon
    .config()
    .then((c) => {
      home = c.home;
      schedule();
    })
    .catch(() => {});

  // Draw now, then on every status change: the connection may already be settled (open,
  // or refused for want of the token) when this window mounts, and then never changes.
  schedule();
  const offStatus = daemon.onStatus(() => schedule());
  const offSettings = settings.subscribe(() => schedule());
  const offReset = daemon.onReset(() => {
    // The daemon restarted: its sessions, and our view of them, are gone.
    view?.destroy();
    view = null;
    schedule();
  });

  // ── unread: a final response or question nobody has looked at (omp/activity.js) ──
  // Which conversations are unread is the daemon's (daemon/unread.js), so every window showing
  // the session, and the Sessions window, agree on it, across reloads and restarts.
  const offUnread = daemon.onUnread(() => schedule());
  let pointerInside = false;
  /** Looking at this window: the pointer is over it, in a page that has focus. */
  const reading = () => pointerInside && document.visibilityState === 'visible' && document.hasFocus();
  const markRead = () => view?.markRead();

  // Moving over the pane, scrolling it, clicking or typing in it: all count as reading it.
  body.addEventListener('pointerenter', () => {
    pointerInside = true;
  });
  body.addEventListener('pointerleave', () => {
    pointerInside = false;
  });
  for (const type of ['pointermove', 'pointerdown', 'wheel', 'keydown', 'focusin']) {
    body.addEventListener(type, markRead, { passive: true });
  }

  function schedule() {
    if (frame || destroyed) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (!destroyed) render();
    });
  }

  /** @param {string} next @param {() => HTMLElement[]} build */
  function show(next, build) {
    if (mode === next) return;
    mode = next;
    root.replaceChildren(...build());
  }

  function render() {
    const status = daemon.status();
    const p = params();
    ctx.setLabel(p.name);
    if (view && view.session !== p.session) {
      view.destroy();
      view = null;
      ctx.setUnread(false);
    }
    if (!view && status !== 'open') {
      mode = null; // the status text changes with the status: always redraw it
      return show('status', () => statusScreen(status));
    }
    if (!p.session) {
      const from = p.resume ?? p.fork;
      return from ? show(`from:${from}`, startFromScreen) : show('setup', setupScreen);
    }
    if (!view) {
      if (!daemon.meta(p.session)) return show('ended', endedScreen);
      mode = null;
      view = createSessionView(p.session);
    }
    show(`session:${view.session}`, () => [view?.root ?? el('div')]);
    view.update();
  }

  /** @param {string} status */
  function statusScreen(status) {
    const box = el('div', 'omp-center');
    if (status === 'unauthorized') {
      box.append(
        el('p', 'omp-error', REFUSED),
        el('p', 'omp-muted', 'Open the URL printed by `bun start` to authorise this browser.'),
      );
    } else if (status === 'down') {
      box.append(el('p', 'omp-error', 'Daemon not reachable.'), el('p', 'omp-muted', 'Start it with `bun start`; this pane reconnects by itself.'));
    } else {
      box.append(el('p', 'omp-muted', 'Connecting to the daemon…'));
    }
    return [box];
  }

  function setupScreen() {
    const form = el('form', 'omp-setup');
    const label = el('label', 'omp-label', 'Directory');
    const input = el('input', 'omp-field');
    input.type = 'text';
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.placeholder = '~/code/project';
    input.id = `omp-cwd-${Math.random().toString(36).slice(2)}`;
    label.htmlFor = input.id;
    // Folders are suggested as the path is typed, read as the daemon reads a new session's
    // directory (relative to home); an empty field lists home's own folders.
    const suggestions = createSuggestions();
    const folders = createFileSuggest({
      draft: input,
      syntax: PLAIN_PATH,
      foldersOnly: true,
      list: suggestions,
      listDir: (dir) => daemon.listFiles(null, dir),
      replace: (start, end, text) => input.setRangeText(text, start, end, 'end'),
    });
    input.addEventListener('focus', () => folders.update());
    input.addEventListener('input', () => folders.update());
    input.addEventListener('blur', () => folders.close());
    input.addEventListener('keydown', (e) => {
      if (e.isComposing) return;
      if (suggestions.key(e)) {
        // Enter takes the folder and closes the list, so the next Enter starts omp; Tab and a
        // click go on into the folder's own folders.
        if (e.key === 'Enter') folders.close();
      } else if (e.key === 'Escape' && suggestions.open) {
        e.preventDefault();
        folders.close();
      }
    });
    const cwd = params().cwd;
    if (cwd) input.value = cwd;
    else {
      // The default can arrive while the user is typing: never write over what they typed,
      // and select the default so that typing replaces it instead of appending to it.
      let typed = false;
      input.addEventListener('input', () => (typed = true), { once: true });
      daemon
        .config()
        .then((c) => {
          if (typed || input.value) return;
          input.value = c.defaultCwd;
          input.select(); // kept when the field is focused later
          folders.update();
        })
        .catch(() => {});
    }
    const start = el('button', 'btn btn-accent', 'Start omp');
    start.type = 'submit';
    const error = el('p', 'omp-error');
    error.hidden = true;
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const dir = input.value.trim();
      if (!dir) return;
      folders.close();
      start.disabled = true;
      error.hidden = true;
      daemon
        .createSession({ cwd: dir })
        .then((meta) => {
          ctx.setParams({ session: meta.id, cwd: meta.cwd, sessionFile: null });
          schedule();
        })
        .catch((err) => {
          error.textContent = errorMessage(err);
          error.hidden = false;
        })
        .finally(() => {
          start.disabled = false;
        });
    });
    // The list drops down over what is below the field, so nothing moves as it opens and closes.
    const field = el('div', 'omp-setup-field');
    field.append(input, suggestions.root);
    const row = el('div', 'omp-row');
    row.append(field, start);
    form.append(el('p', 'omp-setup-title', 'Start an omp agent'), label, row, error);
    queueMicrotask(() => input.focus());
    return [form];
  }

  function endedScreen() {
    const box = el('div', 'omp-center');
    box.append(el('p', '', 'This session ended when the daemon stopped.'));
    box.append(sessionActions(null));
    return [box];
  }

  /** Resumes `params.resume`, or forks `params.fork`, right away; on failure offers to retry or start fresh. */
  function startFromScreen() {
    const { resume, fork, cwd } = params();
    const [doing, failed] = resume ? ['Resuming session…', 'Could not resume'] : ['Forking session…', 'Could not fork'];
    const box = el('div', 'omp-center');
    const status = el('p', 'omp-muted', doing);
    box.append(status);
    const from = resume ? { resume } : fork ? { fork } : null;
    if (!from) return [box];
    const actions = el('div', 'omp-row');
    actions.hidden = true;
    const attempt = () => {
      status.className = 'omp-muted';
      status.textContent = doing;
      actions.hidden = true;
      daemon
        .createSession({ cwd: cwd ?? '~', ...from })
        .then((meta) => {
          // A fork's own journal is not known until omp reports it; update() saves it then.
          ctx.setParams({ session: meta.id, cwd: meta.cwd, sessionFile: meta.sessionFile, resume: null, fork: null });
          schedule();
        })
        .catch((err) => {
          status.className = 'omp-error';
          status.textContent = `${failed}: ${errorMessage(err)}`;
          actions.hidden = false;
        });
    };
    const retry = button('btn btn-accent', 'Try again', attempt);
    const fresh = button('btn', 'New session', () => {
      ctx.setParams({ resume: null, fork: null });
      schedule();
    });
    actions.append(retry, fresh);
    box.append(actions);
    attempt();
    return [box];
  }

  /**
   * Resume / New session buttons. Resume goes through `startFromScreen`.
   * @param {SessionMeta | null} meta
   */
  function sessionActions(meta) {
    const row = el('div', 'omp-row');
    const { sessionFile, cwd } = params();
    if (sessionFile) {
      row.append(
        button('btn btn-accent', 'Resume', () => {
          ctx.setParams({ session: null, cwd: cwd ?? meta?.cwd ?? null, resume: sessionFile });
          schedule();
        }),
      );
    }
    row.append(
      button('btn', 'New session', () => {
        ctx.setParams({ session: null, sessionFile: null, name: null });
        schedule();
      }),
    );
    return row;
  }

  /** @param {string} cwd */
  function shortCwd(cwd) {
    const display = tildeHome(cwd, home);
    const parts = display.split('/').filter(Boolean);
    return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : display;
  }

  /**
   * @typedef {{ session: string, root: HTMLElement, update(): void, markRead(): void, destroy(): void }} SessionView
   * @param {string} session
   * @returns {SessionView}
   */
  function createSessionView(session) {
    const state = createTranscript();
    /** When the session last waited on its user here (omp/activity.js), and the last mark this window read. */
    let awaitedAt = 0;
    let readSent = -Infinity;
    const subscription = daemon.subscribe(session, (event) => {
      applyEvent(state, event);
      awaitedAt = awaitedAfter(awaitedAt, event);
      schedule();
    });
    const ompId = () => daemon.meta(session)?.ompId ?? null;
    /** When the conversation became unread, unless this window has read that already. */
    const unreadSince = () => {
      const since = daemon.unreadSince(ompId());
      return since !== null && since > readSent ? since : null;
    };
    function markRead() {
      const id = ompId();
      const since = unreadSince();
      if (id === null || since === null) return;
      readSent = since;
      ctx.setUnread(false);
      daemon.markRead(id, since).catch(() => {});
    }
    // The subscription replayed history synchronously: requests in it are already handled.
    let editorSeen = state.editorText?.seq ?? 0;
    /** @type {Set<string>} */
    const openDetails = new Set();

    // ── skeleton ──
    const node = el('div', 'omp-session');
    const toolbar = el('div', 'omp-toolbar');
    const cwdEl = el('span', 'omp-cwd');
    const modelBtn = toolButton('model…', 'Choose model');
    modelBtn.classList.add('omp-model');
    const thinkingBtn = toolButton('think…', 'Choose thinking level');
    const activity = el('span', 'omp-activity');
    // How far through its todo list the agent is, while a turn runs (omp/todos.js).
    const progressEl = el('span', 'omp-progress');
    const progressBar = el('progress');
    progressBar.setAttribute('aria-label', 'Tasks done');
    const progressCount = el('span', 'omp-progress-count');
    progressEl.append(progressBar, progressCount);
    progressEl.hidden = true;
    const contextEl = el('span', 'omp-meter');
    contextEl.title = 'Context window used';
    const costEl = el('span', 'omp-meter');
    costEl.title = 'Cost of this session';
    const errorBadge = el('span', 'omp-badge-error', 'error');
    const spacer = el('span', 'omp-spacer');
    const newBtn = toolButton('New', 'Start a new session in this window (this one keeps running: Sessions lists it)');
    const stopBtn = toolButton('Stop', 'Stop the agent and restore queued messages (Esc)');
    // Shown only while the session has to log in to talk to its model; More always has Login.
    const loginBtn = toolButton('Login', 'Log in to a model provider: this session’s model needs it');
    // The rest sits in one menu, so the toolbar keeps to one line at usual pane widths.
    const moreBtn = toolButton('⋯', 'More: Fork, Login, End');
    moreBtn.setAttribute('aria-label', 'More actions');
    const moreMenu = el('div', 'omp-menu omp-more');
    moreMenu.popover = 'auto';
    moreBtn.popoverTargetElement = moreMenu;
    const menuItem = (/** @type {string} */ label, /** @type {string} */ title) => {
      const b = button('omp-menu-item', label);
      b.title = title;
      return b;
    };
    const forkBtn = menuItem('Fork', FORK_TITLE);
    const loginItem = menuItem('Login', 'Log in to a model provider');
    const endBtn = menuItem('End', 'End this omp session (closing the window leaves it running)');
    moreMenu.append(forkBtn, loginItem, endBtn);
    toolbar.append(cwdEl, modelBtn, thinkingBtn, activity, progressEl, contextEl, costEl, errorBadge, spacer, loginBtn);
    // The session's own controls go in the window's top bar, for as long as it is shown.
    ctx.headActions.replaceChildren(newBtn, stopBtn, moreBtn, moreMenu);

    const strip = el('div', 'omp-strip');
    const loginStrip = el('div', 'omp-login');
    const banner = el('div', 'omp-banner');
    const transcript = el('div', 'omp-transcript');
    transcript.setAttribute('role', 'log');
    transcript.setAttribute('aria-live', 'polite');
    // Follow new output only while the reader is at the bottom; scrolling up stops it.
    let stickToBottom = true;
    transcript.addEventListener('scroll', () => {
      stickToBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < BOTTOM_SLACK_PX;
    });
    const pinToBottom = () => {
      if (stickToBottom) transcript.scrollTop = transcript.scrollHeight;
    };
    // Heights keep changing after a draw: the dialogs, queue and composer below resize the
    // transcript, and fonts or expanded blocks reflow items. Re-pin whenever either moves.
    const resizes = new ResizeObserver(pinToBottom);
    resizes.observe(transcript);
    const dialogs = el('div', 'omp-dialogs');
    const queue = el('div', 'omp-queue');
    const suggestions = createSuggestions();
    const composer = createComposer({
      pane: node,
      upload: (file, name) => daemon.uploadAttachment(file, name),
      onError: (text) => {
        addNote(state, 'error', 'attach', text);
        schedule();
      },
      shellDir: () => ({ label: tildeHome(cwd(), home), path: cwd() }),
    });
    const { draft, sendBtn } = composer;
    const selectionPopup = attachSelectionPopup({
      host: node,
      transcript,
      onComment: (quote, comment) => {
        composer.addComment(quote, comment);
        draft.focus();
      },
      // Side questions go to omp's `btw`: answered from the session's context, never added to it.
      ask: {
        async send(quote, question, topic) {
          if (!ready()) return { error: 'omp is not running.' };
          const command = topic === undefined ? { type: 'btw', question: composeAsk(quote, question) } : { type: 'btw', question: composeFollowUp(question), recordId: topic };
          try {
            const res = await daemon.rpc(session, command);
            const record = res.success ? res.data?.record : null;
            if (typeof record?.id !== 'string') return { error: res.error ?? 'omp did not take the question.' };
            // omp's record is the topic's first turn; the question just taken is its newest.
            return { id: record.id, turn: Array.isArray(record.followUps) ? record.followUps.length : 0 };
          } catch (err) {
            return { error: errorMessage(err) };
          }
        },
        answers: (id) => state.sideAnswers.get(id),
        cancel: (id) => void daemon.rpc(session, { type: 'btw_cancel', recordId: id }).catch(() => {}),
      },
    });
    node.append(toolbar, strip, loginStrip, banner, transcript, dialogs, queue, suggestions.root, composer.root);
    const highlight = attachDragHighlight({ host: node, transcript, enabled: () => settings.get().animatedSelection });
    const offHighlight = settings.subscribe(() => highlight.refresh());
    // A click on the pane that is not on a control, in a dialog omp asked for or in the
    // selection popup puts the caret in the message box, as in a terminal.
    focusOnClick(node, draft, '.omp-dialogs, .omp-quote-pop');

    const meta = () => state.meta ?? daemon.meta(session);
    const ready = () => meta()?.status === 'ready';
    /** The session's directory: where omp runs, and where `!` commands run. */
    const cwd = () => params().cwd ?? meta()?.cwd ?? '';
    /**
     * Whether omp has this conversation on disk, so it can be forked: a journal the session
     * started from exists already, and omp writes a new session's once the model has replied.
     */
    const saved = () => Boolean(meta()?.resume || meta()?.fork) || state.items.some((i) => i.kind === 'assistant' && i.ended);
    const forkable = () => Boolean(meta()?.sessionFile) && saved();

    // ── commands ──
    /**
     * Sends one omp command. Failed answers are surfaced by the transcript (they come back
     * through the stream); a transport failure becomes a note here.
     * @param {Record<string, unknown>} command @returns {Promise<RpcResponse | null>}
     */
    async function rpc(command) {
      try {
        return await daemon.rpc(session, command);
      } catch (err) {
        addNote(state, 'error', String(command.type), errorMessage(err));
        schedule();
        return null;
      }
    }

    // ── rewind ──
    // Rewind on one of the user's prompts puts it back in the box to reword, and marks what
    // sending would set aside; nothing reaches omp until then, so Undo (or Esc) only puts the
    // box back. Sending rewinds omp to just before the prompt (`branch`, which keeps the old
    // path in the journal) and sends the box as the prompt in its place.
    /** The prompt this window is rewinding to, and the box as it was before. @type {{ key: string, draft: string } | null} */
    let rewind = null;
    const rewindBar = el('div', 'omp-rewind-bar');
    rewindBar.setAttribute('role', 'status');
    const rewindText = el('span', 'omp-rewind-text');
    rewindBar.append(rewindText, button('btn omp-rewind-undo', 'Undo', () => undoRewind()));
    /** Sends waiting for the transcript to be replaced after a rewind (`state.rewinds` passing `after`). @type {Array<{ after: number, resolve: () => void }>} */
    let reseedWaiters = [];

    transcript.addEventListener('click', (e) => {
      const target = /** @type {Element} */ (e.target).closest?.('.omp-rewind-btn');
      const key = /** @type {HTMLElement | null} */ (target?.closest('.omp-user'))?.dataset.key;
      if (key) startRewind(key);
    });

    /** @param {string} key */
    function startRewind(key) {
      if (!ready() || state.streaming) return;
      const point = rewindPoint(state.items, key);
      if (!point) return;
      // Picking another prompt keeps the box as it was before the first.
      rewind = { key, draft: rewind?.draft ?? draft.value };
      composer.setText(point.text);
      hideSuggestions();
      draft.focus();
      schedule();
    }

    function undoRewind() {
      if (!rewind) return;
      composer.setText(rewind.draft);
      rewind = null;
      draft.focus();
      schedule();
    }

    /** Marks the prompt being rewound to and dims what sending would set aside. */
    function drawRewind() {
      for (const n of transcript.querySelectorAll('.is-set-aside')) n.classList.remove('is-set-aside');
      rewindBar.remove();
      const point = rewind && rewindPoint(state.items, rewind.key);
      // The prompt is gone (another window rewound): there is nothing left to rewind to here.
      if (rewind && !point) rewind = null;
      const at = rewind && drawn.get(rewind.key)?.node;
      if (!point || !at) return;
      rewindText.textContent = `Rewinding here: sending sets aside ${point.setAside} prompt${point.setAside === 1 ? '' : 's'} and what followed`;
      for (let n = /** @type {Element | null} */ (at); n; n = n.nextElementSibling) n.classList.add('is-set-aside');
      transcript.insertBefore(rewindBar, at);
    }

    /**
     * Rewinds omp to just before the prompt `key`, once omp's conversation is the one this
     * window shows; resolves once the transcript has been replaced, so the prompt sent next
     * lands after it. False, with a note why, when it did not rewind.
     * @param {string} key @returns {Promise<boolean>}
     */
    async function applyRewind(key) {
      const point = rewindPoint(state.items, key);
      const listed = point && (await rpc({ type: 'get_branch_messages' }));
      if (!point || !listed?.success) return false;
      const entryId = branchEntry(listed.data?.messages ?? [], point);
      if (!entryId) {
        addNote(state, 'error', 'rewind', 'Not rewound, and nothing sent: omp’s conversation no longer matches this window’s.');
        schedule();
        return false;
      }
      const after = state.rewinds;
      const res = await rpc({ type: 'branch', entryId });
      if (!res?.success) return false;
      rewind = null;
      if (state.rewinds === after) await new Promise((resolve) => reseedWaiters.push({ after, resolve: () => resolve(undefined) }));
      return true;
    }

    async function send() {
      if (!ready()) return;
      // `/command` and `!shell` go as typed; comments and attachments wait for the next prompt.
      const command = isCommand(draft.value);
      // A bare `!` names no command: leave it in the box rather than run nothing.
      if (shellCommand(draft.value) === '') return;
      // A file dropped a moment ago may still be on its way to the daemon: send it too.
      if (!command) await composer.settled();
      if (!ready()) return;
      const outgoing = composer.compose({ withCards: !command });
      const text = outgoing.message;
      if (!text) return;
      // A command runs as it would anyway; the rewind waits for a prompt.
      const rewindTo = command ? null : rewind?.key;
      if (rewindTo && state.streaming) {
        addNote(state, 'error', 'rewind', 'Not rewound, and nothing sent: the agent is working. Stop it first, or Undo.');
        return schedule();
      }
      const taken = outgoing.take();
      hideSuggestions();
      if (rewindTo && !(await applyRewind(rewindTo))) return taken.restore();
      const shell = shellCommand(text);
      /** @type {Record<string, unknown>} */
      const request =
        shell !== null
          ? { type: 'bash', command: shell }
          : state.streaming
            ? { type: 'prompt', message: text, streamingBehavior: 'steer' }
            : { type: 'prompt', message: text };
      void rpc(request).then((res) => {
        // Give it all back if omp refused it and nothing new has been written since.
        if (!res || !res.success) taken.restore();
      });
    }

    async function stop() {
      if (!ready()) return;
      const res = await rpc({ type: 'abort_and_restore_queue' });
      if (!res?.success) return;
      /** @type {Array<{ text?: unknown }>} */
      const restored = [...(res.data?.steering ?? []), ...(res.data?.followUp ?? [])];
      const texts = restored.map((m) => str(m?.text)).filter((t) => t !== null);
      if (texts.length) {
        composer.setText([...texts, draft.value].filter(Boolean).join('\n\n'));
        draft.focus();
      }
    }

    // ── menus (model, thinking, login) ──
    /**
     * Gives `anchor` a popover menu of what `load` lists, loaded afresh each time it opens.
     * @param {HTMLButtonElement} anchor @param {() => Promise<MenuEntry[]>} load @param {{ filter?: boolean }} [options]
     */
    function attachMenu(anchor, load, options = {}) {
      const menu = el('div', 'omp-menu');
      menu.popover = 'auto';
      anchor.popoverTargetElement = menu;
      const isOpen = () => menu.matches(':popover-open');
      menu.addEventListener('toggle', (event) => {
        if (/** @type {ToggleEvent} */ (event).newState !== 'open') return menu.replaceChildren();
        menu.replaceChildren(el('p', 'omp-muted', 'Loading…'));
        load()
          .then((entries) => {
            if (!isOpen()) return;
            const list = el('div', 'omp-menu-list');
            const filter = el('input', 'omp-field');
            const fill = () => {
              const q = filter.value.trim().toLowerCase();
              list.replaceChildren(
                ...entries
                  .filter((e) => !q || e.label.toLowerCase().includes(q) || e.detail?.toLowerCase().includes(q))
                  .map((entry) => {
                    const item = button(`omp-menu-item${entry.current ? ' is-current' : ''}`);
                    item.append(el('span', '', entry.label));
                    if (entry.detail) item.append(el('span', 'omp-muted', entry.detail));
                    item.addEventListener('click', () => {
                      menu.hidePopover();
                      entry.pick();
                    });
                    return item;
                  }),
              );
              if (!list.childElementCount) list.append(el('p', 'omp-muted', 'Nothing to choose.'));
            };
            menu.replaceChildren();
            if (options.filter) {
              filter.type = 'search';
              filter.placeholder = 'Filter';
              filter.addEventListener('input', fill);
              // Esc closes the menu at once, where a search field would first clear itself.
              filter.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') menu.hidePopover();
              });
              menu.append(filter);
              filter.focus();
            }
            fill();
            menu.append(list);
          })
          .catch((err) => {
            if (isOpen()) menu.replaceChildren(el('p', 'omp-error', errorMessage(err)));
          });
      });
      anchor.after(menu);
    }

    /** @param {Record<string, unknown>} command @param {string} key */
    async function listFrom(command, key) {
      const res = await rpc(command);
      if (!res) throw new Error('daemon not reachable');
      if (!res.success) throw new Error(res.error ?? `${command.type} failed`);
      const list = res.data?.[key];
      return Array.isArray(list) ? list : [];
    }

    attachMenu(
      modelBtn,
      async () =>
        (await listFrom({ type: 'get_available_models' }, 'models')).map((m) => ({
          label: String(m?.name ?? m?.id ?? '?'),
          detail: `${m?.provider}/${m?.id}`,
          current: m?.provider === state.session.model?.provider && m?.id === state.session.model?.id,
          pick: () => void rpc({ type: 'set_model', provider: m?.provider, modelId: m?.id }),
        })),
      { filter: true },
    );

    attachMenu(thinkingBtn, async () =>
      (await listFrom({ type: 'get_available_thinking_levels' }, 'levels')).map((level) => ({
        label: String(level),
        current: level === state.session.thinkingLevel,
        pick: () => void rpc({ type: 'set_thinking_level', level }),
      })),
    );

    const loginProviders = async () =>
      (await listFrom({ type: 'get_login_providers' }, 'providers'))
        .filter((p) => p?.available !== false)
        .map((p) => ({
          label: String(p?.name ?? p?.id),
          detail: p?.authenticated ? '✓ logged in' : undefined,
          current: Boolean(p?.authenticated),
          pick: () => void rpc({ type: 'login', providerId: p?.id }),
        }));
    for (const anchor of [loginBtn, loginItem]) attachMenu(anchor, loginProviders, { filter: true });

    stopBtn.addEventListener('click', () => void stop());
    // The copy is omp's own (`--fork`): a new session in a new window; this one carries on.
    forkBtn.addEventListener('click', () => {
      moreMenu.hidePopover();
      const m = meta();
      if (m?.sessionFile) ctx.addWidget('omp', { fork: m.sessionFile, cwd: m.cwd, session: null, sessionFile: null, name: params().name });
    });
    newBtn.addEventListener('click', () => {
      // The setup screen starts it, in this session's directory unless the user picks another.
      ctx.setParams({ session: null, cwd: cwd() || null, sessionFile: null, name: null, resume: null, fork: null, prompt: null });
      schedule();
    });
    function end() {
      endBtn.disabled = true;
      daemon
        .closeSession(session)
        .catch((err) => {
          addNote(state, 'error', 'end', errorMessage(err));
          schedule();
        })
        .finally(() => {
          endBtn.disabled = false;
        });
    }
    endBtn.addEventListener('click', () => {
      moreMenu.hidePopover();
      if (!state.streaming) return end();
      confirmBeside(moreBtn, { message: 'The agent is working on a turn. End the session anyway?', action: 'End session', run: end });
    });

    // ── composer: `/` commands and `@` files suggested as they are typed ──
    const files = createFileSuggest({
      draft,
      syntax: MENTIONS,
      list: suggestions,
      listDir: (dir) => daemon.listFiles(session, dir),
      replace: (start, end, text) => composer.replace(start, end, text),
    });

    function hideSuggestions() {
      files.close();
      suggestions.hide();
    }

    /** Suggests what the draft is starting to name: a slash command, or a file after `@`. */
    function updateSuggestions() {
      const match = /^\/(\S*)$/.exec(draft.value);
      if (!match) {
        if (!files.update()) suggestions.hide();
        return;
      }
      files.close();
      const q = match[1].toLowerCase();
      const starts = (/** @type {SlashCommand} */ c) => [c.name, ...c.aliases].some((n) => n.toLowerCase().startsWith(q));
      const contains = (/** @type {SlashCommand} */ c) => [c.name, ...c.aliases].some((n) => n.toLowerCase().includes(q));
      const commands = [...state.commands.filter(starts), ...state.commands.filter((c) => !starts(c) && contains(c))].slice(0, MAX_SUGGESTIONS);
      suggestions.show(
        commands.map((c) => {
          const cells = [el('span', 'omp-suggestion-name', `/${c.name}`)];
          if (c.aliases.length) cells.push(el('span', 'omp-muted', c.aliases.map((a) => `/${a}`).join(' ')));
          if (c.hint) cells.push(el('span', 'omp-suggestion-hint', c.hint));
          if (c.description) cells.push(el('span', 'omp-suggestion-desc', c.description));
          return { cells, pick: () => complete(c) };
        }),
      );
    }

    /** @param {SlashCommand} command */
    function complete(command) {
      composer.setText(`/${command.name} `);
      hideSuggestions();
      draft.focus();
    }

    const history = createPromptHistory(() => sentPrompts(state.items));
    draft.addEventListener('input', updateSuggestions);
    draft.addEventListener('keydown', (e) => {
      // An open suggestion list takes the arrows, Tab and Enter first; closed, Up and Down
      // step through what was sent, as in omp's own editor (omp/prompt-history.js).
      if (e.isComposing || suggestions.key(e)) return;
      const plain = !(e.shiftKey || e.altKey || e.metaKey || e.ctrlKey);
      if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && plain && draft.selectionStart === draft.selectionEnd) {
        const older = e.key === 'ArrowUp';
        const text = history.step(older ? 'older' : 'newer', draft.value, draft.selectionStart);
        if (text !== null) {
          e.preventDefault();
          composer.setText(text);
          // Up opens an entry at its top and Down at its bottom, so one press steps one entry.
          const at = older ? 0 : text.length;
          draft.setSelectionRange(at, at);
        }
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void send();
      } else if (e.key === 'Escape') {
        if (suggestions.open) hideSuggestions();
        else if (rewind) undoRewind();
        else if (state.streaming) void stop();
      }
    });
    sendBtn.addEventListener('click', () => void send());
    // Dragging Send sends the message in a fork instead: a new window, placed where it is
    // dropped, continuing a copy of this conversation. This box lets go of it once it is placed.
    sendBtn.addEventListener('pointerdown', (e) => {
      const m = meta();
      if (e.button !== 0 || sendBtn.disabled || !m?.sessionFile || !forkable()) return;
      const outgoing = composer.compose({ withCards: !isCommand(draft.value) });
      const line = outgoing.message.replace(/\s+/g, ' ').trim();
      ctx.dragWidget('omp', { fork: m.sessionFile, cwd: m.cwd, session: null, sessionFile: null, name: params().name, prompt: outgoing.message || null }, e, {
        label: line ? `Fork: ${line.length > 40 ? `${line.slice(0, 39)}…` : line}` : 'Fork',
        onEnd: ({ dropped }) => {
          if (!dropped) return;
          outgoing.take();
          hideSuggestions();
        },
      });
    });

    // ── drawing ──
    /** @type {Map<string, { rev: number, node: HTMLElement }>} */
    const drawn = new Map();
    /** @type {Map<string, HTMLElement>} */
    const dialogNodes = new Map();
    let queueKey = '';
    let stripKey = '';
    let bannerKey = '';
    let loginKey = '';
    /** Which view `drawn` holds: an item draws differently when only responses show. */
    let drawnOnlyResponses = false;
    /** Stands in for the hidden work of a running turn when only responses show. */
    const workingEl = el('div', 'omp-working');
    workingEl.setAttribute('role', 'status');

    function drawTranscript() {
      rewindBar.remove(); // items are placed by index; drawRewind puts it back
      const { onlyResponses } = settings.get();
      if (onlyResponses !== drawnOnlyResponses) {
        drawnOnlyResponses = onlyResponses;
        for (const entry of drawn.values()) {
          resizes.unobserve(entry.node);
          entry.node.remove();
        }
        drawn.clear();
      }
      const shown = onlyResponses ? promptsAndResponses(state.items, state.streaming) : { items: state.items, working: null };
      const live = new Set();
      const itemCtx = { tools: state.tools, open: openDetails };
      shown.items.forEach((item, i) => {
        live.add(item.key);
        let entry = drawn.get(item.key);
        if (!entry || entry.rev !== item.rev) {
          const fresh = renderItem(item, itemCtx);
          if (entry) {
            resizes.unobserve(entry.node);
            entry.node.replaceWith(fresh);
          }
          resizes.observe(fresh);
          entry = { rev: item.rev, node: fresh };
          drawn.set(item.key, entry);
        }
        const at = transcript.children[i];
        if (at !== entry.node) transcript.insertBefore(entry.node, at ?? null);
      });
      for (const [key, entry] of drawn) {
        if (!live.has(key)) {
          resizes.unobserve(entry.node);
          entry.node.remove();
          drawn.delete(key);
        }
      }
      if (shown.working) {
        const { steps } = shown.working;
        workingEl.textContent = steps ? `Working… ${steps} step${steps === 1 ? '' : 's'}` : 'Working…';
        if (transcript.lastElementChild !== workingEl) transcript.append(workingEl);
      } else {
        workingEl.remove();
      }
      transcript.classList.toggle('is-streaming', state.streaming);
      drawRewind();
      pinToBottom();
    }

    function drawDialogs() {
      const ids = new Set(state.dialogs.map((d) => d.id));
      for (const [id, n] of dialogNodes) {
        if (!ids.has(id)) {
          n.remove();
          dialogNodes.delete(id);
        }
      }
      for (const dialog of state.dialogs) {
        if (dialogNodes.has(dialog.id)) continue;
        // The daemon reports the answer as `sent` before it replies, which removes the dialog.
        const n = renderDialog(dialog, (payload) => {
          daemon.respondUi(session, { type: 'extension_ui_response', id: dialog.id, ...payload }).catch((err) => {
            addNote(state, 'error', 'dialog', errorMessage(err));
            schedule();
          });
        });
        dialogNodes.set(dialog.id, n);
        dialogs.append(n);
      }
      dialogs.hidden = state.dialogs.length === 0;
    }

    function drawQueue() {
      const key = JSON.stringify(state.queue);
      if (key === queueKey) return;
      queueKey = key;
      /** @param {string} text @param {'steering' | 'followUp'} which */
      const chip = (text, which) => {
        const c = el('span', `omp-chip is-${which}`);
        c.append(el('span', 'omp-chip-kind', which === 'steering' ? 'steer' : 'next'), el('span', 'omp-chip-text', text));
        const remove = button('omp-chip-remove', '×');
        remove.setAttribute('aria-label', `Remove queued message: ${text}`);
        remove.addEventListener('click', () => void rpc({ type: 'remove_queued_message', message: text, queue: which }));
        c.append(remove);
        return c;
      };
      queue.replaceChildren(...state.queue.steering.map((t) => chip(t, 'steering')), ...state.queue.followUp.map((t) => chip(t, 'followUp')));
      queue.hidden = queue.childElementCount === 0;
    }

    function drawStrips() {
      const key = JSON.stringify([state.title, state.statuses, state.widgets]);
      if (key !== stripKey) {
        stripKey = key;
        const parts = [];
        if (state.title) parts.push(el('span', 'omp-strip-title', state.title));
        for (const text of Object.values(state.statuses)) parts.push(el('span', 'omp-strip-status', text));
        for (const lines of Object.values(state.widgets)) parts.push(el('pre', 'omp-strip-widget', lines.join('\n')));
        strip.replaceChildren(...parts);
        strip.hidden = parts.length === 0;
      }
      const login = state.openUrl;
      const lkey = JSON.stringify(login);
      if (lkey !== loginKey) {
        loginKey = lkey;
        loginStrip.replaceChildren();
        if (login) {
          const target = login.launchUrl ?? login.url;
          const link = el('a', 'omp-login-link', login.url);
          // Only http(s) targets are clickable; anything else is shown, not linked.
          if (/^https?:\/\//i.test(target)) link.href = target;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          loginStrip.append(el('span', 'omp-label', 'Sign in:'), link);
          if (login.instructions) loginStrip.append(el('p', 'omp-muted', login.instructions));
        }
        loginStrip.hidden = !login;
      }
    }

    function drawBanner() {
      const m = meta();
      const connection = daemon.status();
      const key = JSON.stringify([m?.status, m?.exitCode, m?.error, connection, params().sessionFile]);
      if (key === bannerKey) return;
      bannerKey = key;
      banner.replaceChildren();
      banner.className = 'omp-banner';
      if (connection !== 'open') {
        banner.append(el('span', 'omp-error', connection === 'unauthorized' ? REFUSED : 'Daemon not reachable; reconnecting…'));
      } else if (!m || m.status === 'starting') {
        banner.append(el('span', 'omp-muted', 'starting omp…'));
      } else if (m.status === 'exited' || m.status === 'failed') {
        banner.classList.add('is-ended');
        const text = m.status === 'failed' ? `omp failed${m.error ? `: ${m.error}` : ''}` : `omp exited${m.exitCode !== null ? ` (code ${m.exitCode})` : ''}${m.error ? `: ${m.error}` : ''}`;
        banner.append(el('span', m.status === 'failed' || (m.exitCode ?? 0) !== 0 ? 'omp-error' : 'omp-muted', text));
        banner.append(sessionActions(m));
      }
      banner.hidden = banner.childElementCount === 0;
    }

    function drawToolbar() {
      const m = meta();
      cwdEl.textContent = shortCwd(cwd());
      cwdEl.title = cwd();
      const s = state.session;
      modelBtn.textContent = s.model ? s.model.name || s.model.id : 'model…';
      modelBtn.title = s.model ? `${s.model.provider}/${s.model.id}` : 'Choose model';
      thinkingBtn.textContent = s.thinkingLevel ? `think: ${s.thinkingLevel}` : 'think…';
      activity.textContent = state.streaming ? 'working' : 'idle';
      activity.classList.toggle('is-streaming', state.streaming);
      const progress = turnProgress(state);
      progressEl.hidden = !progress;
      if (progress) {
        progressBar.max = progress.total;
        progressBar.value = progress.done;
        progressCount.textContent = `${progress.done}/${progress.total}`;
        progressEl.title = `${progress.done} of ${progress.total} tasks done${progress.current ? `\nNow: ${progress.current}` : ''}`;
      }
      contextEl.textContent = s.contextPercent !== null ? `ctx ${s.contextPercent.toFixed(1)}%` : '';
      costEl.textContent = state.cost > 0 ? `$${state.cost < 1 ? state.cost.toFixed(3) : state.cost.toFixed(2)}` : '';
      errorBadge.hidden = !state.lastError;
      errorBadge.title = state.lastError ?? '';
      const live = ready();
      for (const b of [modelBtn, thinkingBtn, loginBtn, loginItem]) b.disabled = !live;
      loginBtn.hidden = !needsLogin(state);
      stopBtn.disabled = !live || !state.streaming;
      endBtn.hidden = !live && m?.status !== 'starting';
      forkBtn.disabled = !forkable();
      forkBtn.title = forkable() ? FORK_TITLE : NOTHING_TO_FORK;
    }

    function drawComposer() {
      const live = ready();
      draft.disabled = !live;
      sendBtn.disabled = !live;
      sendBtn.title = live && forkable() ? SEND_TITLE : '';
      draft.placeholder = !live
        ? 'omp is not running'
        : state.streaming
          ? 'Steer the agent… (Esc stops)'
          : 'Message omp… (@ files, / commands, ! shell)';
      if (state.editorText && state.editorText.seq > editorSeen) {
        editorSeen = state.editorText.seq;
        composer.setText(state.editorText.text);
        updateSuggestions();
        draft.focus();
      }
    }

    /**
     * Sends the message this window was forked with (dragged off another pane's Send), once:
     * the param is cleared as it goes. A session that is not that fork after all (the fork
     * failed and a fresh one was started) gets it in the box, unsent.
     */
    function sendCarried() {
      const { prompt } = params();
      if (!prompt) return;
      ctx.setParams({ prompt: null });
      composer.setText(prompt);
      if (meta()?.fork) void send();
    }

    function update() {
      // A rewind's prompt goes once the transcript holds the rewound conversation, or once
      // there is no session left to send it to.
      const waiting = reseedWaiters;
      reseedWaiters = waiting.filter((w) => ready() && state.rewinds === w.after);
      for (const w of waiting) if (!reseedWaiters.includes(w)) w.resolve();
      // A ready session holds its earlier history already (the daemon fetched it first).
      if (ready()) sendCarried();
      // The journal and the conversation's name are saved with the window for when omp is
      // gone: the journal to resume, the name to label the window.
      const file = meta()?.sessionFile;
      if (file && file !== params().sessionFile) ctx.setParams({ sessionFile: file });
      const name = conversationName(state);
      if (name && name !== params().name) {
        ctx.setParams({ name });
        schedule(); // the next draw labels the window with it
      }
      drawToolbar();
      drawStrips();
      drawBanner();
      drawTranscript();
      drawDialogs();
      drawQueue();
      drawComposer();
      selectionPopup.refresh();
      // News that lands under the reader's eyes is read as it comes. A mark the user made
      // themselves (newer than any news here) waits for them to come back to the window.
      const since = unreadSince();
      if (since !== null && since <= awaitedAt && reading()) markRead();
      ctx.setUnread(unreadSince() !== null);
    }

    return {
      session,
      root: node,
      update,
      markRead,
      destroy() {
        subscription();
        ctx.headActions.replaceChildren();
        resizes.disconnect();
        composer.destroy();
        selectionPopup.destroy();
        offHighlight();
        highlight.destroy();
      },
    };
  }

  /** @param {string} label @param {string} title */
  function toolButton(label, title) {
    const b = button('omp-tool-btn', label);
    b.title = title;
    return b;
  }

  return {
    // Sessions or a drop switched this window to another session: show it.
    paramsChanged: schedule,
    destroy() {
      destroyed = true;
      if (frame) cancelAnimationFrame(frame);
      offStatus();
      offSettings();
      offReset();
      offUnread();
      // The session runs on: the daemon's, not this window's.
      view?.destroy();
      view = null;
      root.remove();
    },
  };
}
