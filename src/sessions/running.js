/**
 * The daemon's running sessions as the Sessions window lists them, kept free of the DOM so
 * they can be tested: which sessions run, in what order, how each is doing, and what an omp
 * window is given to show one.
 *
 * A session runs from its launch until the user stops it or the daemon exits; windows only
 * show it. How it is doing is read from its own events, as an omp window reads them: its
 * name, whether a turn runs and whether it asks its user something from the transcript; and
 * from whether the user has read what it did (daemon/unread.js).
 */
import { applyEvent, conversationName, createTranscript } from '../omp/transcript.js';
/** @import { PastSession, SessionEvent, SessionMeta } from '../../daemon/wire.js' */
/** @import { LeafParams } from '../layout/grid-model.js' */
/** @import { Transcript } from '../omp/transcript.js' */

/** @typedef {'starting' | 'asking' | 'working' | 'done' | 'idle'} RunningState */
/** What the list follows of one running session. @typedef {{ transcript: Transcript }} Followed */

/** @param {SessionMeta} meta */
export const isRunning = (meta) => meta.status === 'starting' || meta.status === 'ready';

/**
 * The running sessions, newest first; only those in `directory` when one is given.
 * @param {readonly SessionMeta[]} metas @param {string | null} directory
 */
export const runningSessions = (metas, directory) =>
  metas.filter((m) => isRunning(m) && (!directory || m.cwd === directory)).sort((a, b) => b.startedAt - a.startedAt);

/** @returns {Followed} */
export const follow = () => ({ transcript: createTranscript() });

/** @param {Followed} followed @param {SessionEvent} event */
export function noteEvent(followed, event) {
  applyEvent(followed.transcript, event);
}

/**
 * How a running session is doing: still starting, asking its user something (a question or
 * an approval, read or not: it waits until they answer), working on a turn, done (it handed
 * the turn back and they have not read it yet), or idle.
 * @param {Followed} followed @param {SessionMeta} meta @param {boolean} unread
 * @returns {RunningState}
 */
export function runningState(followed, meta, unread) {
  if (meta.status === 'starting') return 'starting';
  if (followed.transcript.dialogs.length > 0) return 'asking';
  if (followed.transcript.streaming) return 'working';
  return unread ? 'done' : 'idle';
}

/** How each state reads in the list: a short word. @type {Readonly<Record<RunningState, string>>} */
export const STATE_LABELS = Object.freeze({ starting: 'starting', asking: 'needs you', working: 'working', done: 'done', idle: 'idle' });

/** What the session is called: its title, else its first prompt (as an omp window names it). @param {Followed} followed */
export const followedName = (followed) => conversationName(followed.transcript);

/**
 * The settings that make an omp window show running session `meta` (whatever it showed before).
 * @param {SessionMeta} meta @param {string | null} name @returns {LeafParams}
 */
export const showRunning = (meta, name) => ({ session: meta.id, cwd: meta.cwd, sessionFile: meta.sessionFile, name, resume: null, fork: null, prompt: null });

/**
 * The settings that make an omp window show past session `s`: resumed, or, when a running
 * session writes its journal, that one (the daemon answers the resume with it).
 * @param {PastSession} s @returns {LeafParams}
 */
export const showPast = (s) => ({ session: null, cwd: s.cwd, sessionFile: null, name: s.title, resume: s.file, fork: null, prompt: null });
