/**
 * The daemon's running sessions as the Sessions window lists them, kept free of the DOM so
 * they can be tested: which sessions run, in what order, how each is doing, and what an omp
 * window is given to show one.
 *
 * A session runs from its launch until the user stops it or the daemon exits; windows only
 * show it. How it is doing is read from its own events, as an omp window reads them: its
 * name and whether a turn runs from the transcript, whether it needs attention from what
 * awaits the user against what they have seen (`omp/activity.js`).
 */
import { applyEvent, conversationName, createTranscript } from '../omp/transcript.js';
import { awaitedAfter } from '../omp/activity.js';
/** @import { PastSession, SessionEvent, SessionMeta } from '../../daemon/wire.js' */
/** @import { LeafParams } from '../layout/grid-model.js' */
/** @import { Transcript } from '../omp/transcript.js' */

/** @typedef {'starting' | 'working' | 'idle' | 'attention'} RunningState */
/** What the list follows of one running session. @typedef {{ transcript: Transcript, awaitedAt: number }} Followed */

/** @param {SessionMeta} meta */
export const isRunning = (meta) => meta.status === 'starting' || meta.status === 'ready';

/**
 * The running sessions, newest first; only those in `directory` when one is given.
 * @param {readonly SessionMeta[]} metas @param {string | null} directory
 */
export const runningSessions = (metas, directory) =>
  metas.filter((m) => isRunning(m) && (!directory || m.cwd === directory)).sort((a, b) => b.startedAt - a.startedAt);

/** @returns {Followed} */
export const follow = () => ({ transcript: createTranscript(), awaitedAt: 0 });

/** @param {Followed} followed @param {SessionEvent} event */
export function noteEvent(followed, event) {
  applyEvent(followed.transcript, event);
  followed.awaitedAt = awaitedAfter(followed.awaitedAt, event);
}

/**
 * How a running session is doing: still starting, waiting on its user (it finished or asks
 * something they have not seen), working on a turn, or idle.
 * @param {Followed} followed @param {SessionMeta} meta @returns {RunningState}
 */
export function runningState(followed, meta) {
  if (meta.status === 'starting') return 'starting';
  if (followed.awaitedAt > meta.seenAt) return 'attention';
  return followed.transcript.streaming ? 'working' : 'idle';
}

/** How each state reads in the list: a short word. @type {Readonly<Record<RunningState, string>>} */
export const STATE_LABELS = Object.freeze({ starting: 'starting', working: 'working', idle: 'idle', attention: 'needs you' });

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
