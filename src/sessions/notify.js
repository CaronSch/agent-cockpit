/**
 * Desktop notifications when an agent is done or needs its user, so a session can be left
 * running while the user is elsewhere: the moments that mark a conversation unread
 * (omp/activity.js), as they happen.
 *
 * Every running session the daemon runs is followed, as the Sessions window follows them. A
 * notification waits a moment after the event, and is shown only if the conversation is
 * still unread then and the user is not looking at it: an omp window the user is reading
 * reads it at once (wherever that window is, in this tab or another), which clears the mark.
 * Events the daemon replays on (re)connecting happened before this page heard of them, so
 * they never notify. A notification closes once its conversation is read; clicking it shows
 * the session as a click in Sessions does, which reads it.
 *
 * Every open tab notifies, each under the session's id as its tag: the system keeps one
 * notification per tag, so tabs replace each other's (silently) rather than stack them.
 *
 * It is off until the user turns it on with the top bar's Notify button, which asks for the
 * browser's permission then (only from a click: never on load); the choice is kept per
 * browser.
 */
import { button } from '../ui/dom.js';
import { readPref, writePref } from '../ui/prefs.js';
import { tildeHome } from '../ui/format.js';
import { awaitsUser } from '../omp/activity.js';
import { follow, followedName, isRunning, noteEvent, showRunning } from './running.js';
/** @import { SessionEvent } from '../../daemon/wire.js' */
/** @import { DaemonClient } from '../daemon/client.js' */
/** @import { LeafParams } from '../layout/grid-model.js' */
/** @import { Followed } from './running.js' */

/** What a notification says: the agent is done, or asks something (the question, if it gave one). @typedef {{ kind: 'done' | 'asking', question: string | null }} Alert */

/** Where the choice is kept, per browser. */
const NOTIFY_KEY = 'cockpit.notify';
/** How long after the event a notification waits, so a window being read can read it first. */
const SETTLE_MS = 1000;

/**
 * What `event` calls for: nothing, unless it happens now (not replayed) and its agent hands
 * the turn back or stops to ask its user something.
 * @param {SessionEvent} event @param {boolean} replayed @returns {Alert | null}
 */
export function alertFor(event, replayed) {
  if (replayed || event.kind !== 'frame' || !awaitsUser(event)) return null;
  const frame = /** @type {Record<string, any>} */ (event.frame);
  if (frame.type === 'agent_end') return { kind: 'done', question: null };
  const question = frame.method === 'ask' ? frame.questions?.[0]?.question : frame.title;
  return { kind: 'asking', question: typeof question === 'string' && question.trim() ? question.trim() : null };
}

/** The notification's text under the session's name. @param {Alert} alert */
export const alertText = (alert) => (alert.kind === 'done' ? 'Finished' : alert.question ? `Needs your input: ${alert.question}` : 'Needs your input');

/**
 * Whether the user is looking at session `session` here: this tab is in front and focused,
 * and one of its omp windows shows it.
 * @param {{ visible: boolean, focused: boolean, shown: ReadonlySet<string> }} page @param {string} session
 */
export const watching = (page, session) => page.visible && page.focused && page.shown.has(session);

/**
 * @param {{
 *   daemon: DaemonClient,
 *   shown: () => ReadonlySet<string>,
 *   show: (params: LeafParams) => void,
 * }} options `shown` lists the sessions this tab's omp windows show; `show` shows one in the
 * omp window used last.
 */
export function createNotifier({ daemon, shown, show }) {
  const supported = typeof Notification === 'function';
  let on = supported && readPref(NOTIFY_KEY) === 'on';
  /** @type {string | null} */
  let home = null;
  daemon
    .config()
    .then((c) => (home = c.home))
    .catch(() => {});

  /** Each running session followed, with its notification while one is up. @type {Map<string, { followed: Followed, off: () => void, note: Notification | null, timer: ReturnType<typeof setTimeout> | null }>} */
  const sessions = new Map();

  const root = button('notify-toggle', 'Notify', () => void toggle());
  /** The button says whether notifications are on, and why they cannot be. */
  function draw() {
    const permission = supported ? Notification.permission : 'denied';
    const active = on && permission === 'granted';
    root.setAttribute('aria-pressed', String(active));
    root.disabled = !supported || permission === 'denied';
    root.textContent = !supported || permission !== 'denied' ? 'Notify' : 'Notify: blocked';
    root.title = !supported
      ? 'This browser cannot show notifications for this page (they need https or localhost)'
      : permission === 'denied'
        ? 'Notifications are blocked for this site: allow them in the browser’s site settings'
        : active
          ? 'Notifying when an agent finishes or needs you: click to stop'
          : 'Notify me when an agent finishes or needs me';
  }

  async function toggle() {
    if (on && Notification.permission === 'granted') on = false;
    else on = (Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission()) === 'granted';
    writePref(NOTIFY_KEY, on ? 'on' : null);
    draw();
  }

  /** @param {string} id */
  function forget(id) {
    const entry = sessions.get(id);
    if (!entry) return;
    entry.off();
    if (entry.timer) clearTimeout(entry.timer);
    entry.note?.close();
    sessions.delete(id);
  }

  /** Follows every running session and lets go of stopped ones. */
  function sync() {
    const running = new Set(daemon.sessions().filter(isRunning).map((m) => m.id));
    for (const id of sessions.keys()) if (!running.has(id)) forget(id);
    for (const id of running) {
      if (sessions.has(id)) continue;
      /** @type {{ followed: Followed, off: () => void, note: Notification | null, timer: ReturnType<typeof setTimeout> | null }} */
      const entry = { followed: follow(), off: () => {}, note: null, timer: null };
      sessions.set(id, entry);
      entry.off = daemon.subscribe(id, (event) => {
        noteEvent(entry.followed, event);
        const alert = alertFor(event, daemon.replayed(event));
        if (!alert) return;
        if (entry.timer) clearTimeout(entry.timer);
        entry.timer = setTimeout(() => {
          entry.timer = null;
          notify(id, alert);
        }, SETTLE_MS);
      });
    }
  }

  /** @param {string} id @param {Alert} alert */
  function notify(id, alert) {
    const entry = sessions.get(id);
    const meta = daemon.meta(id);
    if (!entry || !meta || !on || Notification.permission !== 'granted') return;
    if (daemon.unreadSince(meta.ompId) === null) return; // read already
    if (watching({ visible: document.visibilityState === 'visible', focused: document.hasFocus(), shown: shown() }, id)) return;
    const name = followedName(entry.followed);
    const note = new Notification(name ?? tildeHome(meta.cwd, home), { body: alertText(alert), tag: id });
    note.onclick = () => {
      window.focus();
      show(showRunning(meta, name));
      const since = daemon.unreadSince(meta.ompId);
      if (meta.ompId && since !== null) daemon.markRead(meta.ompId, since).catch(() => {});
      note.close();
    };
    note.onclose = () => {
      if (entry.note === note) entry.note = null;
    };
    entry.note = note;
  }

  /** Closes the notifications of conversations read since. */
  function closeRead() {
    for (const [id, entry] of sessions) {
      if (entry.note && daemon.unreadSince(daemon.meta(id)?.ompId ?? null) === null) entry.note.close();
    }
  }

  const offSessions = daemon.onSessions(sync);
  const offUnread = daemon.onUnread(closeRead);
  // A restarted daemon's sessions are new ones: let go of the old ones' events first.
  const offReset = daemon.onReset(() => {
    for (const id of [...sessions.keys()]) forget(id);
  });
  sync();
  draw();

  return {
    root,
    destroy() {
      offSessions();
      offUnread();
      offReset();
      for (const id of [...sessions.keys()]) forget(id);
      root.remove();
    },
  };
}
