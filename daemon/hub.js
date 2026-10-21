/**
 * The daemon's omp sessions and the single ordered event log the browser replays.
 *
 * Every event for every session gets the next sequence number. A browser that reconnects
 * asks for events after the last one it saw; a fresh page gets the whole log. The log is
 * kept in memory for the daemon's lifetime (see RISKS.md, telemetry store growth).
 *
 * A session runs until the user stops it or the daemon exits: no window owns one, so closing
 * or switching a window never ends it.
 */
import { randomBytes } from 'node:crypto';
import { launchOmp } from './omp-session.js';
/** @import { SessionEvent, SessionMeta } from './wire.js' */
/** @import { OmpSession, SessionEventBody } from './omp-session.js' */

/**
 * @typedef {{
 *   bootId: string,
 *   create(options: { cwd: string, resume: string | null, fork: string | null }): SessionMeta,
 *   get(id: string): OmpSession | null,
 *   list(): SessionMeta[],
 *   writing(file: string): SessionMeta | null,
 *   since(seq: number): SessionEvent[],
 *   subscribe(fn: (event: SessionEvent) => void): () => void,
 *   closeAll(): Promise<void>,
 * }} Hub
 */

/**
 * @param {{ ompPath: string, now?: () => number, launch?: typeof launchOmp }} options
 * @returns {Hub}
 */
export function createHub({ ompPath, now = Date.now, launch = launchOmp }) {
  const bootId = randomBytes(6).toString('hex');
  /** @type {SessionEvent[]} */
  const log = [];
  /** @type {Map<string, OmpSession>} */
  const sessions = new Map();
  /** @type {Set<(event: SessionEvent) => void>} */
  const listeners = new Set();

  /** @param {string} session @param {SessionEventBody} body */
  function emit(session, body) {
    const event = /** @type {SessionEvent} */ ({ ...body, seq: log.length + 1, at: now(), session });
    log.push(event);
    for (const fn of listeners) fn(event);
  }

  return {
    bootId,
    create({ cwd, resume, fork }) {
      const id = `s_${randomBytes(4).toString('hex')}`;
      const session = launch({ id, cwd, resume, fork, ompPath, now, emit: (body) => emit(id, body) });
      sessions.set(id, session);
      return session.meta();
    },
    get: (id) => sessions.get(id) ?? null,
    list: () => [...sessions.values()].map((s) => s.meta()),
    // Two omp processes must never write one journal: resuming it twice, or archiving it under one.
    writing: (file) => [...sessions.values()].map((s) => s.meta()).find((m) => (m.status === 'starting' || m.status === 'ready') && m.sessionFile === file) ?? null,
    // Sequence numbers are 1-based log positions, so events after `seq` start at index `seq`.
    since: (seq) => log.slice(Math.max(0, seq)),
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    async closeAll() {
      await Promise.all([...sessions.values()].map((s) => s.close()));
    },
  };
}
