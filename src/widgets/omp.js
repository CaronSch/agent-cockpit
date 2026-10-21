/**
 * The omp pane: starts an omp coding agent in a chosen directory through the daemon and
 * lets the user chat with it and set it up, rendered from omp's structured event stream.
 *
 * Its start screen lists the typed directory's past sessions, and `/resume` lists the running
 * session's (sessions/list-view.js): either way the one picked is resumed in this window.
 *
 * Params (persisted with the layout): `session` (daemon session id), `cwd`,
 * `sessionFile` (omp's transcript file, for resuming after the process is gone), `resume`
 * or `fork` while the window is starting from another journal, and the pane's settings
 * from its Config panel (`SETTINGS`).
 */
import { button, el } from '../ui/dom.js';
import { errorMessage, tildeHome } from '../ui/format.js';
import { getDaemon } from '../daemon/client.js';
import { addNote, applyEvent, createTranscript, removeDialog } from '../omp/transcript.js';
import { renderItem } from '../omp/items-view.js';
import { renderDialog } from '../omp/dialogs-view.js';
import { createComposer } from '../omp/composer.js';
import { composeAsk, isCommand, shellCommand } from '../omp/message.js';
import { attachSelectionPopup } from '../omp/selection-popup.js';
import { awaitsUser } from '../omp/activity.js';
import { promptsAndResponses } from '../omp/visibility.js';
import { paneCommand, withPaneCommands } from '../omp/pane-commands.js';
import { createSessionPicker, resumeParams } from '../sessions/list-view.js';
import { displayTitle } from '../sessions/order.js';
/** @import { WidgetContext } from './registry.js' */
/** @import { LeafParams } from '../layout/grid-model.js' */
/** @import { PastSession, RpcResponse, SessionEvent, SessionMeta } from '../../daemon/wire.js' */
/** @import { DaemonClient } from '../daemon/client.js' */
/** @import { SlashCommand } from '../omp/transcript.js' */

/**
 * `resume` is a journal to resume, `fork` one to fork into a new session, as soon as the
 * window is placed (set by whoever created it: the Sessions window, another pane's Fork);
 * either is cleared once the session is running, so a fork is never taken twice.
 * @typedef {{ session: string | null, cwd: string | null, sessionFile: string | null, resume: string | null, fork: string | null, onlyResponses: boolean }} OmpParams
 */
/** @typedef {{ label: string, detail?: string, current?: boolean, pick: () => void }} MenuEntry */
/**
 * A switch in the pane's Config panel, saved with the window under `key`; off unless set.
 * @typedef {{ key: 'onlyResponses', label: string, detail: string }} PaneSetting
 */

/** The pane's settings, in the order the Config panel lists them. @type {readonly PaneSetting[]} */
const SETTINGS = [
  {
    key: 'onlyResponses',
    label: 'Only prompts and responses',
    detail: 'Hide thinking, tool calls and the messages in between',
  },
];

const MAX_SUGGESTIONS = 8;
/** The start screen lists the typed directory's sessions once typing pauses this long. */
const DIR_DEBOUNCE_MS = 250;
const BOTTOM_SLACK_PX = 24;
/** Seen-up-to is saved this long after it last moved, not on every streamed token. */
const READ_SAVE_MS = 1000;
const REFUSED = 'The daemon refused this page.';
const FORK_TITLE = 'Fork: continue a copy of this conversation in a new window';
const NOTHING_TO_FORK = 'Nothing to fork yet: omp saves a conversation once the model has replied';

export default {
  type: 'omp',
  title: 'omp',
  glyph: 'π',
  description: 'Chat with an omp coding agent',

  /** @param {HTMLElement} body @param {WidgetContext} ctx */
  mount(body, ctx) {
    const pane = createPane(body, ctx, getDaemon());
    return { destroy: pane.destroy };
  },

  /** @param {LeafParams} params */
  close(params) {
    const session = str(params.session);
    if (session) endSession(getDaemon(), session);
  },
};

/** @param {unknown} v @returns {string | null} */
const str = (v) => (typeof v === 'string' && v ? v : null);

/**
 * Closing the window ends its agent, as closing a terminal pane does; otherwise omp keeps
 * working with nothing left that can reach it.
 * @param {DaemonClient} daemon @param {string} session
 */
function endSession(daemon, session) {
  const status = daemon.meta(session)?.status;
  if (status === 'starting' || status === 'ready') daemon.closeSession(session).catch(() => {});
}

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
    resume: str(ctx.params.resume),
    fork: str(ctx.params.fork),
    onlyResponses: ctx.params.onlyResponses === true,
  });

  /** @type {string | null} */
  let mode = null;
  /** Undoes what the view on show set up (timers, subscriptions); a view that needs it sets it. */
  let leaveMode = () => {};
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
  const offReset = daemon.onReset(() => {
    // The daemon restarted: its sessions, and our view of them, are gone.
    view?.destroy();
    view = null;
    schedule();
  });

  // ── unread: a final response or question the user has not looked at (omp/activity.js) ──
  /** The newest of those the user has seen, in daemon time; saved with the window. */
  let readAt = typeof ctx.params.readAt === 'number' ? ctx.params.readAt : Date.now();
  let latest = readAt;
  let unread = false;
  let pointerInside = false;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let readSave;
  /** Looking at this window: the pointer is over it, in a page that has focus. */
  const reading = () => pointerInside && document.visibilityState === 'visible' && document.hasFocus();

  /**
   * Saves `readAt` with the window: `soon` while output streams in under the reader's eyes
   * (every token moves it), at once when something unread has just been read.
   * @param {{ soon?: boolean }} [options]
   */
  function saveReadAt({ soon = false } = {}) {
    clearTimeout(readSave);
    const save = () => {
      if (!destroyed && ctx.params.readAt !== readAt) ctx.setParams({ readAt });
    };
    // Never during mount: a commit while the grid is still drawing this window would re-enter it.
    if (soon) readSave = setTimeout(save, READ_SAVE_MS);
    else queueMicrotask(save);
  }

  function markRead() {
    if (latest <= readAt && !unread) return;
    readAt = Math.max(readAt, latest);
    saveReadAt({ soon: !unread });
    if (unread) {
      unread = false;
      ctx.setUnread(false);
    }
  }

  /** @param {SessionEvent} event */
  function noteActivity(event) {
    if (!awaitsUser(event) || event.at <= readAt) return;
    latest = Math.max(latest, event.at);
    if (reading()) return markRead();
    if (!unread) {
      unread = true;
      ctx.setUnread(true);
    }
  }

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
  if (typeof ctx.params.readAt !== 'number') saveReadAt();

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
    leaveMode();
    leaveMode = () => {};
    root.replaceChildren(...build());
  }

  function render() {
    const status = daemon.status();
    const p = params();
    if (view && view.session !== p.session) {
      view.destroy();
      view = null;
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
    input.placeholder = '~/code/project';
    input.id = `omp-cwd-${Math.random().toString(36).slice(2)}`;
    label.htmlFor = input.id;
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
          if (document.activeElement === input) input.select();
          listSessions();
        })
        .catch(() => {});
    }
    // The directory's past sessions, below the field: pick one to resume it here instead.
    const picker = createSessionPicker({
      daemon,
      label: 'Resume a session here',
      onPick: (s) => {
        ctx.setParams(resumeParams(s));
        schedule();
      },
    });
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let listTimer;
    const listSessions = () => void picker.show({ cwd: input.value });
    input.addEventListener('input', () => {
      clearTimeout(listTimer);
      listTimer = setTimeout(listSessions, DIR_DEBOUNCE_MS);
    });
    leaveMode = () => {
      clearTimeout(listTimer);
      picker.destroy();
    };
    const start = el('button', 'btn btn-accent', 'Start omp');
    start.type = 'submit';
    const error = el('p', 'omp-error');
    error.hidden = true;
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const dir = input.value.trim();
      if (!dir) return;
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
    const row = el('div', 'omp-row');
    row.append(input, start);
    form.append(el('p', 'omp-setup-title', 'Start an omp agent'), label, row, error, picker.root);
    if (cwd) listSessions();
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
          // A fork's own journal is not known until omp reports it (refreshState).
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
        ctx.setParams({ session: null, sessionFile: null });
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
   * @typedef {{ session: string, root: HTMLElement, update(): void, destroy(): void }} SessionView
   * @param {string} session
   * @returns {SessionView}
   */
  function createSessionView(session) {
    const state = createTranscript();
    const subscription = daemon.subscribe(session, (event) => {
      applyEvent(state, event);
      noteActivity(event);
      schedule();
    });
    // The subscription replayed history synchronously: requests in it are already handled.
    let editorSeen = state.editorText?.seq ?? 0;
    let refreshSeen = state.refreshSeq;
    let readyHandled = false;
    let messagesRequested = false;
    let refreshing = false;
    let refreshAgain = false;
    /** @type {Set<string>} */
    const openDetails = new Set();

    // ── skeleton ──
    const node = el('div', 'omp-session');
    const toolbar = el('div', 'omp-toolbar');
    const cwdEl = el('span', 'omp-cwd');
    const modelBtn = toolButton('model…', 'Choose model');
    const thinkingBtn = toolButton('thinking…', 'Choose thinking level');
    const activity = el('span', 'omp-activity');
    const contextEl = el('span', 'omp-meter');
    contextEl.title = 'Context window used';
    const costEl = el('span', 'omp-meter');
    costEl.title = 'Cost of this session';
    const errorBadge = el('span', 'omp-badge-error', 'error');
    const spacer = el('span', 'omp-spacer');
    const forkBtn = toolButton('Fork', FORK_TITLE);
    const configBtn = toolButton('Config', 'Settings for this pane');
    const loginBtn = toolButton('Login', 'Log in to a model provider');
    const stopBtn = toolButton('Stop', 'Stop the agent and restore queued messages (Esc)');
    const closeBtn = toolButton('Close', 'End this omp session');
    toolbar.append(cwdEl, modelBtn, thinkingBtn, activity, contextEl, costEl, errorBadge, spacer, forkBtn, configBtn, loginBtn, stopBtn, closeBtn);

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
    const suggest = el('div', 'omp-suggest');
    suggest.setAttribute('role', 'listbox');
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
          // A follow-up goes as written: omp replays its topic's earlier turns, quote included.
          const command = topic === undefined ? { type: 'btw', question: composeAsk(quote, question) } : { type: 'btw', question, recordId: topic };
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
    // ── /resume: another of this directory's sessions, in this pane (omp/pane-commands.js) ──
    const resumeBox = el('div', 'omp-resume');
    resumeBox.hidden = true;
    const resumeNote = el('div', 'omp-row omp-resume-note');
    const picker = createSessionPicker({
      daemon,
      label: 'Resume a session in this directory',
      empty: 'No other sessions in this directory.',
      onPick: pickResume,
    });
    resumeBox.append(picker.root, resumeNote);
    node.append(toolbar, strip, loginStrip, banner, transcript, dialogs, resumeBox, queue, suggest, composer.root);

    const meta = () => state.meta ?? daemon.meta(session);
    const ready = () => meta()?.status === 'ready';
    /** The session's directory: where omp runs, and where `!` commands run. */
    const cwd = () => params().cwd ?? meta()?.cwd ?? '';
    /**
     * Whether omp has this conversation on disk, so it can be forked: a journal the session
     * started from exists already, and omp writes a new session's once the model has replied.
     */
    const saved = () => Boolean(meta()?.resume || meta()?.fork) || state.items.some((i) => i.kind === 'assistant' && i.ended);

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

    async function refreshState() {
      if (refreshing) {
        refreshAgain = true;
        return;
      }
      refreshing = true;
      try {
        const res = await rpc({ type: 'get_state' });
        const file = str(res?.success ? res.data?.sessionFile : null);
        if (file && file !== params().sessionFile && params().session === session) ctx.setParams({ sessionFile: file });
      } finally {
        refreshing = false;
        if (refreshAgain) {
          refreshAgain = false;
          void refreshState();
        }
      }
    }

    async function send() {
      if (!ready()) return;
      // The pane's own commands never reach omp.
      const own = paneCommand(draft.value);
      if (own) {
        composer.setText('');
        hideSuggestions();
        return openResume(own.arg);
      }
      // `/command` and `!shell` go as typed; comments and attachments wait for the next prompt.
      const command = isCommand(draft.value);
      // A bare `!` names no command: leave it in the box rather than run nothing.
      if (shellCommand(draft.value) === '') return;
      // A file dropped a moment ago may still be on its way to the daemon: send it too.
      if (!command) await composer.settled();
      if (!ready()) return;
      const taken = composer.take({ withCards: !command });
      const text = taken.message;
      if (!text) return;
      hideSuggestions();
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

    /** A click anywhere but the picker closes it. @param {PointerEvent} event */
    const outsideResume = (event) => {
      if (!resumeBox.contains(/** @type {Node} */ (event.target))) closeResume({ refocus: false });
    };

    /** @param {string} query narrows the list, as the Sessions window's search does */
    function openResume(query) {
      resumeNote.replaceChildren();
      resumeNote.hidden = true;
      resumeBox.hidden = false;
      document.addEventListener('pointerdown', outsideResume, true);
      void picker.show({ cwd: cwd(), query }).then(() => {
        if (!resumeBox.hidden) picker.focus();
      });
    }

    /** @param {{ refocus?: boolean }} [options] back to the message box, unless the user clicked elsewhere */
    function closeResume({ refocus = true } = {}) {
      if (resumeBox.hidden) return;
      resumeBox.hidden = true;
      document.removeEventListener('pointerdown', outsideResume, true);
      if (refocus) draft.focus();
    }

    /** Resumes `s` here, after a confirmation when that would cut a running turn short. @param {PastSession} s */
    function pickResume(s) {
      if (!state.streaming) return void switchTo(s);
      const go = button('btn btn-accent', 'Stop and resume', () => void switchTo(s));
      resumeNote.replaceChildren(el('span', '', `A turn is running. Stop it and resume “${displayTitle(s)}”?`), go, button('btn', 'Cancel', () => closeResume()));
      resumeNote.hidden = false;
      go.focus();
    }

    /** Ends this pane's omp (omp keeps its journal) and resumes `s` in its place. @param {PastSession} s */
    async function switchTo(s) {
      resumeNote.replaceChildren(el('span', 'omp-muted', 'Stopping this session…'));
      resumeNote.hidden = false;
      try {
        await daemon.closeSession(session);
      } catch (err) {
        resumeNote.replaceChildren(el('span', 'omp-error', `Could not stop this session: ${errorMessage(err)}`));
        return;
      }
      document.removeEventListener('pointerdown', outsideResume, true);
      ctx.setParams(resumeParams(s));
      schedule();
    }

    resumeBox.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      closeResume();
    });

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

    attachMenu(
      loginBtn,
      async () =>
        (await listFrom({ type: 'get_login_providers' }, 'providers'))
          .filter((p) => p?.available !== false)
          .map((p) => ({
            label: String(p?.name ?? p?.id),
            detail: p?.authenticated ? '✓ logged in' : undefined,
            current: Boolean(p?.authenticated),
            pick: () => {
              addNote(state, 'muted', 'login', `Logging in to ${p?.name ?? p?.id}…`);
              schedule();
              void rpc({ type: 'login', providerId: p?.id });
            },
          })),
      { filter: true },
    );

    // ── Config: this window's own settings (`SETTINGS`), saved with it ──
    const settingsPanel = el('div', 'omp-menu omp-settings');
    settingsPanel.popover = 'auto';
    configBtn.popoverTargetElement = settingsPanel;
    settingsPanel.addEventListener('toggle', (event) => {
      if (/** @type {ToggleEvent} */ (event).newState !== 'open') return;
      settingsPanel.replaceChildren(
        el('p', 'omp-label', 'This pane'),
        ...SETTINGS.map((setting) => {
          const row = el('label', 'omp-setting');
          const box = el('input');
          box.type = 'checkbox';
          box.checked = params()[setting.key];
          box.addEventListener('change', () => {
            ctx.setParams({ [setting.key]: box.checked });
            schedule();
          });
          row.append(box, el('span', '', setting.label), el('span', 'omp-muted', setting.detail));
          return row;
        }),
      );
    });
    configBtn.after(settingsPanel);

    stopBtn.addEventListener('click', () => void stop());
    // The copy is omp's own (`--fork`): a new session in a new window; this one carries on.
    forkBtn.addEventListener('click', () => {
      const m = meta();
      if (m?.sessionFile) ctx.addWidget('omp', { fork: m.sessionFile, cwd: m.cwd, session: null, sessionFile: null });
    });
    closeBtn.addEventListener('click', () => {
      closeBtn.disabled = true;
      daemon
        .closeSession(session)
        .catch((err) => {
          addNote(state, 'error', 'close', errorMessage(err));
          schedule();
        })
        .finally(() => {
          closeBtn.disabled = false;
        });
    });

    // ── composer ──
    /** @type {SlashCommand[]} */
    let suggestions = [];
    let selected = 0;

    function hideSuggestions() {
      suggestions = [];
      suggest.replaceChildren();
      suggest.hidden = true;
    }

    function updateSuggestions() {
      const match = /^\/(\S*)$/.exec(draft.value);
      if (!match) return hideSuggestions();
      const q = match[1].toLowerCase();
      const starts = (/** @type {SlashCommand} */ c) => [c.name, ...c.aliases].some((n) => n.toLowerCase().startsWith(q));
      const contains = (/** @type {SlashCommand} */ c) => [c.name, ...c.aliases].some((n) => n.toLowerCase().includes(q));
      const commands = withPaneCommands(state.commands);
      suggestions = [...commands.filter(starts), ...commands.filter((c) => !starts(c) && contains(c))].slice(0, MAX_SUGGESTIONS);
      selected = Math.min(selected, Math.max(0, suggestions.length - 1));
      if (!suggestions.length) return hideSuggestions();
      suggest.hidden = false;
      suggest.replaceChildren(
        ...suggestions.map((c, i) => {
          const row = button(`omp-suggestion${i === selected ? ' is-selected' : ''}`);
          row.setAttribute('role', 'option');
          row.setAttribute('aria-selected', String(i === selected));
          row.append(el('span', 'omp-suggestion-name', `/${c.name}`));
          if (c.aliases.length) row.append(el('span', 'omp-muted', c.aliases.map((a) => `/${a}`).join(' ')));
          if (c.hint) row.append(el('span', 'omp-suggestion-hint', c.hint));
          if (c.description) row.append(el('span', 'omp-suggestion-desc', c.description));
          row.addEventListener('pointerdown', (e) => e.preventDefault()); // keep focus in the draft
          row.addEventListener('click', () => complete(c));
          return row;
        }),
      );
    }

    /** @param {SlashCommand} command */
    function complete(command) {
      composer.setText(`/${command.name} `);
      hideSuggestions();
      draft.focus();
    }

    draft.addEventListener('input', () => {
      selected = 0;
      updateSuggestions();
    });
    draft.addEventListener('keydown', (e) => {
      if (e.isComposing) return;
      if (suggestions.length) {
        if (e.key === 'Tab') {
          e.preventDefault();
          return complete(suggestions[selected]);
        }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          selected = (selected + (e.key === 'ArrowDown' ? 1 : suggestions.length - 1)) % suggestions.length;
          return updateSuggestions();
        }
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void send();
      } else if (e.key === 'Escape') {
        if (!resumeBox.hidden) closeResume();
        else if (suggestions.length) hideSuggestions();
        else if (state.streaming) void stop();
      }
    });
    sendBtn.addEventListener('click', () => void send());

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
      const { onlyResponses } = params();
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
        const n = renderDialog(dialog, (payload) => {
          daemon
            .respondUi(session, { type: 'extension_ui_response', id: dialog.id, ...payload })
            .then(() => {
              removeDialog(state, dialog.id);
              schedule();
            })
            .catch((err) => {
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
      thinkingBtn.textContent = s.thinkingLevel ? `thinking: ${s.thinkingLevel}` : 'thinking…';
      activity.textContent = state.streaming ? 'working' : 'idle';
      activity.classList.toggle('is-streaming', state.streaming);
      contextEl.textContent = s.contextPercent !== null ? `ctx ${s.contextPercent.toFixed(1)}%` : '';
      costEl.textContent = state.cost > 0 ? `$${state.cost < 1 ? state.cost.toFixed(3) : state.cost.toFixed(2)}` : '';
      errorBadge.hidden = !state.lastError;
      errorBadge.title = state.lastError ?? '';
      const live = ready();
      for (const b of [modelBtn, thinkingBtn, loginBtn]) b.disabled = !live;
      stopBtn.disabled = !live || !state.streaming;
      closeBtn.hidden = !live && m?.status !== 'starting';
      const forkable = Boolean(m?.sessionFile) && saved();
      forkBtn.disabled = !forkable;
      forkBtn.title = forkable ? FORK_TITLE : NOTHING_TO_FORK;
    }

    function drawComposer() {
      const live = ready();
      draft.disabled = !live;
      sendBtn.disabled = !live;
      draft.placeholder = !live
        ? 'omp is not running'
        : state.streaming
          ? 'Steer the agent… (Enter sends, Esc stops)'
          : 'Message omp… (Enter sends, Shift+Enter newline, !cmd runs a shell command, / for commands)';
      if (state.editorText && state.editorText.seq > editorSeen) {
        editorSeen = state.editorText.seq;
        composer.setText(state.editorText.text);
        updateSuggestions();
        draft.focus();
      }
    }

    function update() {
      if (ready()) {
        if (!readyHandled) {
          readyHandled = true;
          refreshSeen = state.refreshSeq;
          void refreshState();
          // A process started from a journal streams none of its earlier history: fetch it once.
          if ((meta()?.resume || meta()?.fork) && !state.seeded && !messagesRequested) {
            messagesRequested = true;
            void rpc({ type: 'get_messages' });
          }
        } else if (state.refreshSeq !== refreshSeen) {
          refreshSeen = state.refreshSeq;
          void refreshState();
        }
      }
      drawToolbar();
      drawStrips();
      drawBanner();
      drawTranscript();
      drawDialogs();
      drawQueue();
      drawComposer();
      selectionPopup.refresh();
    }

    hideSuggestions();
    return {
      session,
      root: node,
      update,
      destroy() {
        subscription();
        document.removeEventListener('pointerdown', outsideResume, true);
        picker.destroy();
        resizes.disconnect();
        composer.destroy();
        selectionPopup.destroy();
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
    destroy() {
      destroyed = true;
      if (frame) cancelAnimationFrame(frame);
      clearTimeout(readSave);
      offStatus();
      offReset();
      leaveMode();
      // A page reload never gets here, so its agents keep running.
      if (view) endSession(daemon, view.session);
      view?.destroy();
      view = null;
      root.remove();
    },
  };
}
